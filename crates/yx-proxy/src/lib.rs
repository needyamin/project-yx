//! Background proxy transcode jobs.
//!
//! Editing uses proxies; export always prefers original media.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use thiserror::Error;
use uuid::Uuid;
use yx_detect::{command_ffmpeg, PerformancePolicy};
use yx_media::{probe_media, MediaError, MediaInfo};

#[derive(Debug, Error)]
pub enum ProxyError {
    #[error(transparent)]
    Media(#[from] MediaError),
    #[error("proxy job not found: {0}")]
    NotFound(Uuid),
    #[error("ffmpeg proxy failed: {0}")]
    Ffmpeg(String),
    #[error("proxy job cancelled")]
    Cancelled,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyStatus {
    Queued,
    Running,
    Ready,
    Failed,
    Cancelled,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyJob {
    pub id: Uuid,
    pub source_path: PathBuf,
    pub proxy_path: PathBuf,
    pub status: ProxyStatus,
    pub progress: f32,
    pub error: Option<String>,
    pub source_info: Option<MediaInfo>,
}

pub type ProxyNotifier = Arc<dyn Fn(&ProxyJob) + Send + Sync>;

#[derive(Default)]
pub struct ProxyManager {
    inner: Mutex<HashMap<Uuid, ProxyJob>>,
    cache_dir: PathBuf,
    queue_tx: Mutex<Option<mpsc::Sender<(Uuid, PerformancePolicy)>>>,
    notifier: Mutex<Option<ProxyNotifier>>,
    /// Cooperative cancel flags keyed by job id; polled by the worker while
    /// ffmpeg runs so a cancelled transcode's child is killed promptly.
    cancels: Mutex<HashMap<Uuid, Arc<AtomicBool>>>,
}

impl ProxyManager {
    pub fn new(cache_dir: impl Into<PathBuf>) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            cache_dir: cache_dir.into(),
            queue_tx: Mutex::new(None),
            notifier: Mutex::new(None),
            cancels: Mutex::new(HashMap::new()),
        }
    }

    /// Callback fired on the worker thread whenever a job reaches a terminal
    /// status (Ready / Failed / Skipped). Used to emit Tauri events.
    pub fn set_notifier(&self, f: ProxyNotifier) {
        *self.notifier.lock() = Some(f);
    }

    fn notify(&self, id: Uuid) {
        if let Some(job) = self.get(id) {
            if let Some(f) = self.notifier.lock().as_ref() {
                f(&job);
            }
        }
    }

    fn ensure_worker(self: &Arc<Self>) -> mpsc::Sender<(Uuid, PerformancePolicy)> {
        let mut guard = self.queue_tx.lock();
        if let Some(tx) = guard.as_ref() {
            return tx.clone();
        }
        let (tx, rx) = mpsc::channel::<(Uuid, PerformancePolicy)>();
        let manager = Arc::clone(self);
        // One worker => proxy encodes never run concurrently with each other,
        // so a batch import cannot saturate every core while the user edits.
        std::thread::spawn(move || {
            for (id, policy) in rx {
                let _ = manager.run_job(id, &policy);
                manager.notify(id);
            }
        });
        *guard = Some(tx.clone());
        tx
    }

    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }

    pub fn list(&self) -> Vec<ProxyJob> {
        self.inner.lock().values().cloned().collect()
    }

    pub fn get(&self, id: Uuid) -> Option<ProxyJob> {
        self.inner.lock().get(&id).cloned()
    }

    /// Queue a proxy. Returns existing job if the same source is already tracked.
    /// Transcoding runs on the background worker; this call does not block.
    pub fn enqueue(
        self: &Arc<Self>,
        source: &Path,
        policy: &PerformancePolicy,
    ) -> Result<ProxyJob, ProxyError> {
        std::fs::create_dir_all(&self.cache_dir)?;

        {
            let mut guard = self.inner.lock();
            if let Some(existing) = guard.values().find(|j| j.source_path == source) {
                // A previously failed/cancelled job must be retryable —
                // returning it stuck forever meant one transient ffmpeg
                // failure permanently disabled proxies for that source.
                if matches!(existing.status, ProxyStatus::Failed | ProxyStatus::Cancelled) {
                    let id = existing.id;
                    let job = guard.get_mut(&id).expect("existing job id");
                    job.status = ProxyStatus::Queued;
                    job.progress = 0.0;
                    job.error = None;
                    let requeued = job.clone();
                    let policy = policy.clone();
                    let tx = self.ensure_worker();
                    let _ = tx.send((id, policy));
                    return Ok(requeued);
                }
                return Ok(existing.clone());
            }
        }

        let info = probe_media(source)?;
        // Audio-only files and images never need proxies — edit the original.
        if !info.has_video || yx_media::is_image_path(source) {
            let id = Uuid::new_v4();
            let job = ProxyJob {
                id,
                source_path: source.to_path_buf(),
                proxy_path: source.to_path_buf(),
                status: ProxyStatus::Skipped,
                progress: 1.0,
                error: None,
                source_info: Some(info),
            };
            self.inner.lock().insert(id, job.clone());
            return Ok(job);
        }
        // Already small enough — edit the original.
        if info.height > 0 && info.height <= policy.proxy.height {
            let id = Uuid::new_v4();
            let job = ProxyJob {
                id,
                source_path: source.to_path_buf(),
                proxy_path: source.to_path_buf(),
                status: ProxyStatus::Skipped,
                progress: 1.0,
                error: None,
                source_info: Some(info),
            };
            self.inner.lock().insert(id, job.clone());
            return Ok(job);
        }

        let id = Uuid::new_v4();
        let proxy_path = self.cache_dir.join(format!("{id}.proxy.mp4"));
        let job = ProxyJob {
            id,
            source_path: source.to_path_buf(),
            proxy_path: proxy_path.clone(),
            status: ProxyStatus::Queued,
            progress: 0.0,
            error: None,
            source_info: Some(info),
        };
        self.inner.lock().insert(id, job.clone());

        let tx = self.ensure_worker();
        tx.send((id, policy.clone()))
            .map_err(|_| ProxyError::NotFound(id))?;
        Ok(job)
    }

    /// Request cooperative cancellation of a queued/running job. The worker
    /// kills the ffmpeg child and marks the job Cancelled.
    pub fn cancel(&self, id: Uuid) -> bool {
        if let Some(flag) = self.cancels.lock().get(&id) {
            flag.store(true, Ordering::Relaxed);
            return true;
        }
        false
    }

    fn run_job(&self, id: Uuid, policy: &PerformancePolicy) -> Result<(), ProxyError> {
        let (source, proxy_path) = {
            let mut guard = self.inner.lock();
            let job = guard.get_mut(&id).ok_or(ProxyError::NotFound(id))?;
            job.status = ProxyStatus::Running;
            job.progress = 0.05;
            (job.source_path.clone(), job.proxy_path.clone())
        };
        let cancel_flag = {
            let mut cancels = self.cancels.lock();
            let flag = cancels.remove(&id).unwrap_or_default();
            cancels.insert(id, Arc::clone(&flag));
            flag
        };

        let scale = format!(
            "scale=-2:{}:flags=fast_bilinear",
            policy.proxy.height
        );
        let bitrate = format!("{}k", policy.proxy.video_bitrate_kbps);
        let threads = policy.encode_threads.to_string();

        // Write to a sibling tmp file and rename on success: a killed or
        // failed transcode must never leave a corrupt file at the final
        // proxy path that playback_path() could hand to the compositor.
        let tmp_path = proxy_path.with_extension("mp4.tmp");
        let _ = std::fs::remove_file(&tmp_path);

        let mut child = KillOnDrop(
            command_ffmpeg()
                .args([
                    "-hide_banner",
                    "-nostats",
                    "-y",
                    "-i",
                    source.to_str().unwrap_or_default(),
                    "-vf",
                    &scale,
                    "-c:v",
                    "libx264",
                    "-preset",
                    "superfast",
                    "-threads",
                    &threads,
                    "-b:v",
                    &bitrate,
                    "-c:a",
                    "aac",
                    "-ac",
                    "2",
                    "-movflags",
                    "+faststart",
                    tmp_path.to_str().unwrap_or_default(),
                ])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .spawn()?,
        );

        // Drain stderr on its own thread: an unread pipe fills up and would
        // block ffmpeg mid-encode.
        let stderr_pipe = child.stderr.take();
        let stderr_handle = std::thread::spawn(move || {
            let mut buf = String::new();
            if let Some(mut s) = stderr_pipe {
                use std::io::Read;
                let _ = s.read_to_string(&mut buf);
            }
            buf
        });

        // Poll instead of wait() so cancellation kills the child promptly.
        let mut last_progress = 0.05_f32;
        let status = loop {
            if cancel_flag.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                self.finish_job(&id, &tmp_path, ProxyStatus::Cancelled, "cancelled".to_string());
                return Err(ProxyError::Cancelled);
            }
            match child.try_wait()? {
                Some(status) => break status,
                None => {
                    if let Ok(meta) = std::fs::metadata(&tmp_path) {
                        let pct = (meta.len() as f32 / 8_000_000.0).clamp(0.05, 0.95);
                        if pct > last_progress {
                            last_progress = pct;
                            if let Some(job) = self.inner.lock().get_mut(&id) {
                                job.progress = pct;
                            }
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
            }
        };
        self.cancels.lock().remove(&id);

        let mut guard = self.inner.lock();
        let job = guard.get_mut(&id).ok_or(ProxyError::NotFound(id))?;
        if status.success() {
            std::fs::rename(&tmp_path, &proxy_path)?;
            job.status = ProxyStatus::Ready;
            job.progress = 1.0;
            job.error = None;
            Ok(())
        } else {
            let err = stderr_handle.join().unwrap_or_default();
            let err = err.trim().to_string();
            let _ = std::fs::remove_file(&tmp_path);
            job.status = ProxyStatus::Failed;
            job.error = Some(err.clone());
            Err(ProxyError::Ffmpeg(err))
        }
    }

    fn finish_job(&self, id: &Uuid, tmp_path: &Path, status: ProxyStatus, error: String) {
        let _ = std::fs::remove_file(tmp_path);
        if let Some(job) = self.inner.lock().get_mut(id) {
            job.status = status;
            job.error = if error.is_empty() { None } else { Some(error) };
        }
    }

    /// Path the timeline should read for playback (proxy if ready, else source).
    pub fn playback_path(&self, source: &Path) -> PathBuf {
        let guard = self.inner.lock();
        guard
            .values()
            .find(|j| j.source_path == source && matches!(j.status, ProxyStatus::Ready | ProxyStatus::Skipped))
            .map(|j| j.proxy_path.clone())
            .unwrap_or_else(|| source.to_path_buf())
    }

    /// Resolve a timeline/playback path back to the original source for export.
    pub fn original_path(&self, path: &Path) -> PathBuf {
        let guard = self.inner.lock();
        if let Some(job) = guard.values().find(|j| j.proxy_path == path) {
            return job.source_path.clone();
        }
        if let Some(job) = guard.values().find(|j| j.source_path == path) {
            return job.source_path.clone();
        }
        path.to_path_buf()
    }
}

/// Shared handle for the Tauri app state.
pub type SharedProxyManager = Arc<ProxyManager>;

/// RAII guard that kills the ffmpeg child on drop: a panicking worker thread
/// or an unexpected error path must never leak a running encoder.
struct KillOnDrop(std::process::Child);
impl std::ops::Deref for KillOnDrop {
    type Target = std::process::Child;
    fn deref(&self) -> &std::process::Child {
        &self.0
    }
}
impl std::ops::DerefMut for KillOnDrop {
    fn deref_mut(&mut self) -> &mut std::process::Child {
        &mut self.0
    }
}
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_policy() -> PerformancePolicy {
        PerformancePolicy {
            tier: yx_detect::PerformanceTier::Medium,
            preview_scale: yx_detect::PreviewScale::Half,
            proxy: yx_detect::ProxyPreset {
                height: 720,
                video_bitrate_kbps: 6000,
            },
            encode_threads: 4,
            preview_allows_heavy_filters: true,
            prefer_hw_decode: false,
            prefer_hw_encode: false,
        }
    }

    #[test]
    fn enqueue_requeues_failed_job_without_duplicating() {
        let dir = std::env::temp_dir().join(format!("yx_proxy_requeue_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let manager = Arc::new(ProxyManager::new(&dir));
        let source = dir.join("source.mp4");
        let id = Uuid::new_v4();
        manager.inner.lock().insert(
            id,
            ProxyJob {
                id,
                source_path: source.clone(),
                proxy_path: dir.join(format!("{id}.proxy.mp4")),
                status: ProxyStatus::Failed,
                progress: 0.0,
                error: Some("transient ffmpeg failure".into()),
                source_info: None,
            },
        );
        // A failed proxy job must become retryable: the original bug returned
        // the failed job forever, permanently disabling proxies for a source
        // after one transient error.
        let job = manager
            .enqueue(&source, &test_policy())
            .expect("enqueue must requeue");
        assert_eq!(job.id, id);
        assert_eq!(job.status, ProxyStatus::Queued);
        assert!(job.error.is_none());
        let count = manager
            .inner
            .lock()
            .values()
            .filter(|j| j.source_path == source)
            .count();
        assert_eq!(count, 1, "requeue must reuse the existing job");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn enqueue_does_not_restart_ready_job() {
        let dir = std::env::temp_dir().join(format!("yx_proxy_ready_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let manager = Arc::new(ProxyManager::new(&dir));
        let source = dir.join("source.mp4");
        let id = Uuid::new_v4();
        manager.inner.lock().insert(
            id,
            ProxyJob {
                id,
                source_path: source.clone(),
                proxy_path: dir.join(format!("{id}.proxy.mp4")),
                status: ProxyStatus::Ready,
                progress: 1.0,
                error: None,
                source_info: None,
            },
        );
        let job = manager
            .enqueue(&source, &test_policy())
            .expect("enqueue must return existing job");
        assert_eq!(job.status, ProxyStatus::Ready);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_unknown_job_returns_false() {
        let manager = ProxyManager::new(std::env::temp_dir());
        assert!(!manager.cancel(Uuid::new_v4()));
    }

    #[test]
    fn playback_path_never_serves_failed_proxy() {
        let dir = std::env::temp_dir().join(format!("yx_proxy_playback_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let manager = ProxyManager::new(&dir);
        let source = dir.join("source.mp4");
        let proxy = dir.join("x.proxy.mp4");
        let id = Uuid::new_v4();
        manager.inner.lock().insert(
            id,
            ProxyJob {
                id,
                source_path: source.clone(),
                proxy_path: proxy.clone(),
                status: ProxyStatus::Failed,
                progress: 0.0,
                error: Some("boom".into()),
                source_info: None,
            },
        );
        assert_eq!(
            manager.playback_path(&source),
            source,
            "failed proxy must fall back to the original"
        );
        assert_eq!(manager.original_path(&proxy), source);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
