//! Background proxy transcode jobs.
//!
//! Editing uses proxies; export always prefers original media.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use thiserror::Error;
use uuid::Uuid;
use yx_detect::PerformancePolicy;
use yx_media::{probe_media, MediaError, MediaInfo};

#[derive(Debug, Error)]
pub enum ProxyError {
    #[error(transparent)]
    Media(#[from] MediaError),
    #[error("proxy job not found: {0}")]
    NotFound(Uuid),
    #[error("ffmpeg proxy failed: {0}")]
    Ffmpeg(String),
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

#[derive(Debug, Default)]
pub struct ProxyManager {
    inner: Mutex<HashMap<Uuid, ProxyJob>>,
    cache_dir: PathBuf,
}

impl ProxyManager {
    pub fn new(cache_dir: impl Into<PathBuf>) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            cache_dir: cache_dir.into(),
        }
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
    pub fn enqueue(
        &self,
        source: &Path,
        policy: &PerformancePolicy,
    ) -> Result<ProxyJob, ProxyError> {
        std::fs::create_dir_all(&self.cache_dir)?;

        {
            let guard = self.inner.lock();
            if let Some(existing) = guard.values().find(|j| j.source_path == source) {
                return Ok(existing.clone());
            }
        }

        let info = probe_media(source)?;
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

        // Run synchronously for MVP; desktop app will spawn a worker thread.
        self.run_job(id, policy)?;
        self.get(id).ok_or(ProxyError::NotFound(id))
    }

    pub fn run_job(&self, id: Uuid, policy: &PerformancePolicy) -> Result<(), ProxyError> {
        let (source, proxy_path) = {
            let mut guard = self.inner.lock();
            let job = guard.get_mut(&id).ok_or(ProxyError::NotFound(id))?;
            job.status = ProxyStatus::Running;
            job.progress = 0.05;
            (job.source_path.clone(), job.proxy_path.clone())
        };

        let scale = format!(
            "scale=-2:{}:flags=fast_bilinear",
            policy.proxy.height
        );
        let bitrate = format!("{}k", policy.proxy.video_bitrate_kbps);
        let threads = policy.encode_threads.to_string();

        let output = Command::new("ffmpeg")
            .args([
                "-y",
                "-i",
                source.to_str().unwrap_or_default(),
                "-vf",
                &scale,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
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
                proxy_path.to_str().unwrap_or_default(),
            ])
            .output()?;

        let mut guard = self.inner.lock();
        let job = guard.get_mut(&id).ok_or(ProxyError::NotFound(id))?;
        if output.status.success() {
            job.status = ProxyStatus::Ready;
            job.progress = 1.0;
            job.error = None;
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            job.status = ProxyStatus::Failed;
            job.error = Some(err.clone());
            Err(ProxyError::Ffmpeg(err))
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
