use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use yx_detect::{probe_and_policy, HardwareProfile, PerformancePolicy};
use yx_media::magic::{MagicJob, MagicKeyframe};
use yx_media::{
    export_file_with_progress, export_timeline_with_progress, is_image_path, probe_media,
    ExportCodec, ExportFilter, ExportFit, ExportRequest, ExportSegment, MediaInfo,
    TimelineExportRequest, VideoEncoder,
};
use yx_proxy::{ProxyJob, ProxyManager};
use yx_timeline::{
    ClipId, EditCommand, EditMode, FilterKind, MediaRole, Timeline, TimelineEditor, TrackId,
    TrackKind, TrimEdge,
};

struct AppState {
    editor: Mutex<TimelineEditor>,
    profile: Mutex<HardwareProfile>,
    policy: Mutex<PerformancePolicy>,
    proxies: Arc<ProxyManager>,
    /// ffprobe results keyed by canonical path — importing and dragging a file
    /// onto the timeline must not spawn repeated ffprobe subprocesses.
    probe_cache: Mutex<HashMap<PathBuf, MediaInfo>>,
    /// Magic Remove: one heavy track/render at a time + cooperative cancel.
    magic_busy: Arc<AtomicBool>,
    magic_cancel: Arc<AtomicBool>,
    /// Export cooperative cancel — polled by the ffmpeg progress loop.
    export_cancel: Arc<AtomicBool>,
}

fn cached_probe(state: &AppState, path: &Path) -> Result<MediaInfo, String> {
    let key = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if let Some(info) = state.probe_cache.lock().get(&key) {
        return Ok(info.clone());
    }
    let info = probe_media(path).map_err(|e| e.to_string())?;
    state.probe_cache.lock().insert(key, info.clone());
    Ok(info)
}

#[derive(Serialize)]
struct BootInfo {
    profile: HardwareProfile,
    policy: PerformancePolicy,
    timeline: Timeline,
}

#[tauri::command]
fn get_boot_info(state: State<'_, AppState>) -> BootInfo {
    BootInfo {
        profile: state.profile.lock().clone(),
        policy: state.policy.lock().clone(),
        timeline: state.editor.lock().timeline().clone(),
    }
}

#[tauri::command]
fn get_timeline(state: State<'_, AppState>) -> Timeline {
    state.editor.lock().timeline().clone()
}

/// Timeline consistency diagnostics (never silently allow corrupt state):
/// empty result = the project model is valid.
#[tauri::command]
fn get_timeline_issues(state: State<'_, AppState>) -> Vec<String> {
    state.editor.lock().timeline().validate()
}

/* --- Project persistence ------------------------------------------------ */

/// Write the project atomically (tmp + rename) on a blocking thread so the
/// UI never waits on disk.
#[tauri::command]
async fn save_project(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let timeline = state.editor.lock().timeline().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let json = serde_json::to_string(&timeline).map_err(|e| e.to_string())?;
        let p = PathBuf::from(&path);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = p.with_extension("yxp.tmp");
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("save task failed: {e}"))?
}

/// Replace the in-memory project with a loaded file (undo history resets).
#[tauri::command]
async fn load_project(path: String, state: State<'_, AppState>) -> Result<Timeline, String> {
    let read = tauri::async_runtime::spawn_blocking(move || {
        std::fs::read_to_string(PathBuf::from(&path)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("load task failed: {e}"))??;
    let timeline: Timeline = serde_json::from_str(&read).map_err(|e| e.to_string())?;
    timeline.validate().iter().for_each(|issue| {
        tracing::warn!("loaded project issue: {issue}");
    });
    let mut editor = state.editor.lock();
    *editor = TimelineEditor::with_timeline(timeline.clone());
    Ok(timeline)
}

/// Start a fresh project: reset the in-memory timeline (undo history resets
/// with it).
#[tauri::command]
fn new_project(state: State<'_, AppState>) -> Timeline {
    let mut editor = state.editor.lock();
    *editor = TimelineEditor::new();
    editor.timeline().clone()
}

/// App data dir for derived state (cache sweeps live beside it):
/// %LOCALAPPDATA%/ProjectYX (falls back to $HOME/ProjectYX on Linux).
fn dirs_data() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("ProjectYX")
}

/// Hard caps for derived-media caches, swept LRU-by-mtime at startup.
/// thumbs: ~1 JPEG per 0.25 s scrub bucket per clip; magic-cache: full
/// sidecar MP4 renders (hundreds of MB each); audio-previews: WAV
/// (~10 MB/min). All are derivable from source media — deleting entries is
/// always safe. proxy-cache is deliberately NOT swept here: proxies are
/// expensive to regenerate and may be referenced by open projects; pruning
/// them needs a source-liveness check first.
const DERIVED_CACHE_CAPS: &[(&str, u64)] = &[
    ("thumbs", 200 << 20),
    ("magic-cache", 2 << 30),
    ("audio-previews", 512 << 20),
    // BG Key tool select-area masks (PNG alpha masks referenced by params).
    ("bg-mask", 64 << 20),
];

fn sweep_cache_dir(dir: &Path, max_bytes: u64, protected: &std::collections::HashSet<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total = 0u64;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        // Liveness: files referenced by the CURRENT engine timeline must
        // survive the sweep — deleting a magic-cache sidecar the open
        // project points at silently downgrades Magic Remove to the
        // original footage.
        if protected.contains(&p) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        total += meta.len();
        files.push((p, meta.len(), mtime));
    }
    if total <= max_bytes {
        return;
    }
    files.sort_by_key(|(_, _, mtime)| *mtime); // oldest first
    for (path, size, _) in files {
        if total <= max_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

/// Paths under the swept cache dirs that derived-cache deletion must never
/// touch. Source of liveness: the CURRENT engine timeline — every string in
/// it that resolves inside a swept cache dir is protected (magic-cache
/// sidecars, bg-mask PNGs the open project references).
fn collect_protected_cache_paths(
    timeline: Option<&Timeline>,
) -> std::collections::HashSet<PathBuf> {
    let mut protected = std::collections::HashSet::new();
    let Some(timeline) = timeline else {
        return protected;
    };
    let Ok(value) = serde_json::to_value(timeline) else {
        return protected;
    };
    let roots: Vec<PathBuf> = DERIVED_CACHE_CAPS
        .iter()
        .map(|(name, _)| dirs_data().join(name))
        .collect();
    fn walk(value: &serde_json::Value, out: &mut Vec<String>) {
        match value {
            serde_json::Value::String(s) => out.push(s.clone()),
            serde_json::Value::Array(items) => items.iter().for_each(|v| walk(v, out)),
            serde_json::Value::Object(map) => map.values().for_each(|v| walk(v, out)),
            _ => {}
        }
    }
    let mut strings = Vec::new();
    walk(&value, &mut strings);
    for s in strings {
        let p = PathBuf::from(&s);
        if roots.iter().any(|r| p.starts_with(r)) {
            protected.insert(p);
        }
    }
    protected
}

fn sweep_derived_caches(protected: &std::collections::HashSet<PathBuf>) {
    for (name, cap) in DERIVED_CACHE_CAPS {
        sweep_cache_dir(&dirs_cache().with_file_name(name), *cap, protected);
    }
}

/// Generate (or fetch from the disk cache) a small preview JPEG for the
/// timeline. Cache key = canonical path + file mtime + 0.25s time bucket,
/// so unchanged media never regenerates. Runs on the blocking pool — the
/// UI thread is never involved. Original media is used (never proxies) so
/// thumbnails stay valid when proxies finish.
#[tauri::command]
async fn get_media_thumbnail(
    source: String,
    time: f64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let src = PathBuf::from(&source);
    let src = state.proxies.original_path(&src);
    let bucket = (time.max(0.0) * 4.0).round() / 4.0;
    let key_src = src.canonicalize().unwrap_or_else(|_| src.clone());
    let mtime = std::fs::metadata(&key_src)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    key_src.display().to_string().hash(&mut hasher);
    mtime.hash(&mut hasher);
    format!("{bucket:.2}").hash(&mut hasher);
    let out = dirs_cache()
        .with_file_name("thumbs")
        .join(format!("thumb_{:016x}.jpg", hasher.finish()));

    if out.is_file() {
        return Ok(out.display().to_string());
    }

    let src_str = src.display().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(out.parent().unwrap_or(&out)).map_err(|e| e.to_string())?;
        if !out.is_file() {
            let tmp = out.with_extension("tmp.jpg");
            let status = yx_detect::command_ffmpeg()
                .args([
                    "-y",
                    "-ss",
                    &format!("{bucket:.3}"),
                    "-i",
                    &src_str,
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=192:-2",
                    "-q:v",
                    "5",
                    tmp.to_str().ok_or("bad tmp path")?,
                ])
                .output()
                .map_err(|e| e.to_string())?;
            if !status.status.success() {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!(
                    "thumbnail failed: {}",
                    String::from_utf8_lossy(&status.stderr)
                        .trim()
                        .chars()
                        .take(200)
                        .collect::<String>()
                ));
            }
            std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
        }
        Ok(out.display().to_string())
    })
    .await
    .map_err(|e| format!("thumbnail task failed: {e}"))?
}

/// Async: the hardware probe walks the filesystem and spawns an FFmpeg
/// subprocess (`ffmpeg -hwaccels`) — it must never block the UI thread.
#[tauri::command]
async fn reprobe_hardware(state: State<'_, AppState>) -> Result<BootInfo, String> {
    let (profile, policy) = tauri::async_runtime::spawn_blocking(probe_and_policy)
        .await
        .map_err(|e| format!("hardware probe task failed: {e}"))?;
    *state.profile.lock() = profile.clone();
    *state.policy.lock() = policy.clone();
    Ok(BootInfo {
        profile,
        policy,
        timeline: state.editor.lock().timeline().clone(),
    })
}

/// Async so the (cached) ffprobe inside never blocks the UI thread — a
/// synchronous probe freezes every window interaction for its duration.
#[tauri::command]
async fn import_media(path: String, state: State<'_, AppState>) -> Result<MediaInfo, String> {
    let info = cached_probe(&state, PathBuf::from(&path).as_path())?;
    let policy = state.policy.lock().clone();
    let proxies = Arc::clone(&state.proxies);
    let source = PathBuf::from(&path);
    // Queued on the background worker; completion is emitted via "proxy-ready".
    std::thread::spawn(move || {
        let _ = proxies.enqueue(source.as_path(), &policy);
    });
    Ok(info)
}

/// Read a UTF-8 text file (dropped onto the Project Monitor) for a title.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("Not a file: {}", path));
    }
    const MAX_BYTES: u64 = 256 * 1024;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err("Text file is too large (max 256 KB)".to_string());
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyReadyPayload {
    source_path: String,
    proxy_path: String,
}

/// Repoint every timeline clip playing `source_path` to its finished proxy.
#[tauri::command]
fn swap_timeline_media(
    source_path: String,
    proxy_path: String,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let mut editor = state.editor.lock();
    editor.swap_media_path(&source_path, &proxy_path);
    Ok(editor.timeline().clone())
}

fn playback_path(state: &AppState, media_path: &str) -> String {
    state
        .proxies
        .playback_path(PathBuf::from(media_path).as_path())
        .display()
        .to_string()
}

/// Route media onto the correct track(s): AV pair, video-only, or audio-only.
/// Async: probe + placement run off the UI thread so drops never stutter.
#[tauri::command]
async fn add_media_to_timeline(
    media_path: String,
    start: f64,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    place_media_on_timeline(&state, media_path, start)
}

/// First visible, unlocked track of `kind` whose time range at
/// [start, start + dur) is completely free — or `TrackId::nil()` when every
/// candidate is busy (the caller then adds a fresh track, style).
#[allow(dead_code)]
fn first_free_track(timeline: &Timeline, kind: TrackKind, start: f64, dur: f64) -> TrackId {
    let candidates: Vec<TrackId> = timeline
        .tracks
        .iter()
        .filter(|t| t.kind == kind && !t.hidden && !t.locked)
        .map(|t| t.id)
        .collect();
    candidates
        .into_iter()
        .find(|tid| {
            timeline
                .tracks
                .iter()
                .find(|t| t.id == *tid)
                .map(|t| {
                    t.clips
                        .iter()
                        .all(|c| c.end() <= start + 1e-6 || c.start >= start + dur - 1e-6)
                })
                .unwrap_or(false)
        })
        .unwrap_or_default()
}

fn place_media_on_timeline(
    state: &State<'_, AppState>,
    media_path: String,
    start: f64,
) -> Result<Timeline, String> {
    let info = cached_probe(state, PathBuf::from(&media_path).as_path())?;
    let is_still = is_image_path(Path::new(&media_path));
    // Images get a 5s still duration; animated GIFs keep their real length
    // when ffprobe reports a usable one.
    let out_point = if is_still && info.duration < 0.5 {
        5.0
    } else if info.duration > 0.0 {
        info.duration
    } else {
        5.0
    };
    let source = media_path.clone();
    let path = playback_path(state, &media_path);
    let mut actual_start = start;
    let mut editor = state.editor.lock();

    // Visual media: place on the same track at the end (or requested start if free).
    // Do not open multiple tracks when adding clips to the timeline.
    if info.has_video {
        let (primary_track, track_end) = {
            let timeline = editor.timeline();
            let primary = timeline
                .tracks
                .iter()
                .find(|t| t.kind == TrackKind::Video && !t.hidden && !t.locked);
            match primary {
                Some(t) => {
                    let end = t.clips.iter().map(|c| c.end()).fold(0.0, f64::max);
                    (t.id, end)
                }
                None => (TrackId::nil(), 0.0),
            }
        };

        let video_track = if primary_track.is_nil() {
            editor
                .apply(EditCommand::AddTrack {
                    kind: TrackKind::Video,
                    name: None,
                })
                .map_err(|e| e.to_string())?;
            editor
                .timeline()
                .tracks
                .iter()
                .filter(|t| t.kind == TrackKind::Video)
                .last()
                .map(|t| t.id)
                .ok_or_else(|| "no video track".to_string())?
        } else {
            let occupied = {
                let timeline = editor.timeline();
                timeline
                    .tracks
                    .iter()
                    .find(|t| t.id == primary_track)
                    .map(|t| {
                        t.clips.iter().any(|c| {
                            !(c.end() <= actual_start + 1e-6
                                || c.start >= actual_start + out_point - 1e-6)
                        })
                    })
                    .unwrap_or(false)
            };
            if occupied {
                actual_start = track_end;
            }
            primary_track
        };

        if info.has_audio {
            let primary_audio = {
                let timeline = editor.timeline();
                timeline
                    .tracks
                    .iter()
                    .find(|t| t.kind == TrackKind::Audio && !t.hidden && !t.locked)
                    .map(|t| t.id)
                    .unwrap_or_default()
            };
            let audio_track = if primary_audio.is_nil() {
                editor
                    .apply(EditCommand::AddTrack {
                        kind: TrackKind::Audio,
                        name: None,
                    })
                    .map_err(|e| e.to_string())?;
                editor
                    .timeline()
                    .tracks
                    .iter()
                    .filter(|t| t.kind == TrackKind::Audio)
                    .last()
                    .map(|t| t.id)
                    .ok_or_else(|| "no audio track".to_string())?
            } else {
                primary_audio
            };
            editor
                .apply(EditCommand::AddAvPair {
                    video_track_id: video_track,
                    audio_track_id: audio_track,
                    media_path: path,
                    source_path: Some(source),
                    start: actual_start,
                    in_point: 0.0,
                    out_point,
                })
                .map_err(|e| e.to_string())?;
        } else {
            editor
                .apply(EditCommand::AddClip {
                    track_id: video_track,
                    media_path: path,
                    source_path: Some(source),
                    start: actual_start,
                    in_point: 0.0,
                    out_point,
                    role: MediaRole::Video,
                    linked_clip_id: None,
                })
                .map_err(|e| e.to_string())?;
        }
    } else if info.has_audio {
        let (primary_audio, audio_end) = {
            let timeline = editor.timeline();
            let primary = timeline
                .tracks
                .iter()
                .find(|t| t.kind == TrackKind::Audio && !t.hidden && !t.locked);
            match primary {
                Some(t) => {
                    let end = t.clips.iter().map(|c| c.end()).fold(0.0, f64::max);
                    (t.id, end)
                }
                None => (TrackId::nil(), 0.0),
            }
        };
        let audio_track = if primary_audio.is_nil() {
            editor
                .apply(EditCommand::AddTrack {
                    kind: TrackKind::Audio,
                    name: None,
                })
                .map_err(|e| e.to_string())?;
            editor
                .timeline()
                .tracks
                .iter()
                .filter(|t| t.kind == TrackKind::Audio)
                .last()
                .map(|t| t.id)
                .ok_or_else(|| "no audio track".to_string())?
        } else {
            let occupied = {
                let timeline = editor.timeline();
                timeline
                    .tracks
                    .iter()
                    .find(|t| t.id == primary_audio)
                    .map(|t| {
                        t.clips.iter().any(|c| {
                            !(c.end() <= actual_start + 1e-6
                                || c.start >= actual_start + out_point - 1e-6)
                        })
                    })
                    .unwrap_or(false)
            };
            if occupied {
                actual_start = audio_end;
            }
            primary_audio
        };
        editor
            .apply(EditCommand::AddClip {
                track_id: audio_track,
                media_path: path,
                source_path: Some(source),
                start: actual_start,
                in_point: 0.0,
                out_point,
                role: MediaRole::Audio,
                linked_clip_id: None,
            })
            .map_err(|e| e.to_string())?;
    } else {
        return Err("file has no video or audio streams".into());
    }

    Ok(editor.timeline().clone())
}

#[tauri::command]
fn add_clip_to_track(
    track_id: String,
    media_path: String,
    start: f64,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let _ = track_id;
    place_media_on_timeline(&state, media_path, start)
}

#[tauri::command]
fn move_clip(
    clip_id: String,
    new_start: f64,
    sync_linked: bool,
    target_track_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let target_track_id = match target_track_id {
        Some(s) => Some(
            s.parse::<TrackId>()
                .map_err(|e| format!("bad track id: {e}"))?,
        ),
        None => None,
    };
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::MoveClip {
            clip_id,
            new_start,
            sync_linked,
            target_track_id,
        })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn trim_clip(
    clip_id: String,
    in_point: f64,
    out_point: f64,
    keep_end: bool,
    sync_linked: bool,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::TrimClip {
            clip_id,
            in_point,
            out_point,
            keep_end,
            sync_linked,
        })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn split_clip_at(
    clip_id: String,
    at: f64,
    sync_linked: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::SplitClip {
            clip_id,
            at,
            sync_linked: sync_linked.unwrap_or(true),
        })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

/// Cross dissolve: overlap the clip left over the previous one and attach a
/// Transition filter. Rendered as an alpha fade in the export overlay chain.
#[tauri::command]
fn add_transition(
    clip_id: String,
    duration: f64,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::AddTransition { clip_id, duration })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn remove_clip(
    clip_id: String,
    remove_linked: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::RemoveClip {
            clip_id,
            remove_linked: remove_linked.unwrap_or(true),
        })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn ripple_delete(
    clip_id: String,
    remove_linked: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::RippleDelete {
            clip_id,
            remove_linked: remove_linked.unwrap_or(true),
        })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn unlink_clip(clip_id: String, state: State<'_, AppState>) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::UnlinkClip { clip_id })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn link_clips(
    clip_a: String,
    clip_b: String,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_a: ClipId = clip_a.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let clip_b: ClipId = clip_b.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::LinkClips { clip_a, clip_b })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn set_track_mute(
    track_id: String,
    muted: bool,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let track_id: TrackId = track_id.parse().map_err(|e| format!("bad track id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::SetTrackMute { track_id, muted })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn set_track_lock(
    track_id: String,
    locked: bool,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let track_id: TrackId = track_id.parse().map_err(|e| format!("bad track id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::SetTrackLock { track_id, locked })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn add_track(kind: String, state: State<'_, AppState>) -> Result<Timeline, String> {
    let kind = match kind.as_str() {
        "video" => TrackKind::Video,
        "audio" => TrackKind::Audio,
        other => return Err(format!("unknown track kind: {other}")),
    };
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::AddTrack { kind, name: None })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn remove_track(track_id: String, state: State<'_, AppState>) -> Result<Timeline, String> {
    let track_id: TrackId = track_id.parse().map_err(|e| format!("bad track id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::RemoveTrack { track_id })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn debug_agent_log(line: String) -> Result<(), String> {
    // Dev-only scaffolding (writes to hardcoded source-tree paths): a no-op
    // in release builds — this must never ship debug file I/O.
    if !cfg!(debug_assertions) {
        return Ok(());
    }
    use std::io::Write;
    let mut paths = Vec::new();
    if let Ok(root) = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
    {
        paths.push(root.join("debug-75f279.log"));
    }
    paths.push(PathBuf::from(r"Y:\Project YX\debug-75f279.log"));
    paths.push(PathBuf::from(
        r"C:\Users\needy\.cursor\projects\y-Project-YX\debug-75f279.log",
    ));
    let mut last_err = String::from("no paths");
    for path in paths {
        match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            Ok(mut f) => {
                if let Err(e) = writeln!(f, "{line}") {
                    last_err = e.to_string();
                    continue;
                }
                return Ok(());
            }
            Err(e) => last_err = format!("{}: {e}", path.display()),
        }
    }
    Err(last_err)
}

#[tauri::command]
fn add_filter(
    clip_id: String,
    kind: String,
    params: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let kind = parse_filter_kind(&kind)?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::AddFilter {
            clip_id,
            kind,
            params: params.unwrap_or_else(|| serde_json::json!({})),
        })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn update_filter(
    clip_id: String,
    filter_id: String,
    params: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let filter_id: Uuid = filter_id
        .parse()
        .map_err(|e| format!("bad filter id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::UpdateFilter {
            clip_id,
            filter_id,
            params,
        })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn set_filter_enabled(
    clip_id: String,
    filter_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let filter_id: Uuid = filter_id
        .parse()
        .map_err(|e| format!("bad filter id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::SetFilterEnabled {
            clip_id,
            filter_id,
            enabled,
        })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn remove_filter(
    clip_id: String,
    filter_id: String,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let filter_id: Uuid = filter_id
        .parse()
        .map_err(|e| format!("bad filter id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::RemoveFilter { clip_id, filter_id })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MagicProgressPayload {
    percent: f64,
    phase: String,
}

fn emit_magic_progress(app: &AppHandle, percent: f64, phase: &str) {
    emit_progress_event(app, "magic-progress", percent, phase);
}

fn emit_progress_event(app: &AppHandle, event: &str, percent: f64, phase: &str) {
    let _ = app.emit(
        event,
        MagicProgressPayload {
            percent: (percent.clamp(0.0, 1.0) * 100.0).round() / 100.0,
            phase: phase.to_string(),
        },
    );
}

/// Auto-track the brushed mask region across the clip. Returns translation
/// keyframes (normalized offsets) that the UI stores back into filter params
/// so the user can inspect and manually correct them.
#[tauri::command]
async fn magic_remove_track(
    app: AppHandle,
    source: String,
    params: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    if state.magic_busy.swap(true, Ordering::SeqCst) {
        return Err("Another Magic Remove job is already running".into());
    }
    state.magic_cancel.store(false, Ordering::SeqCst);
    let cancel = state.magic_cancel.clone();
    let emit_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let job = MagicJob::from_params(Path::new(&source), &params, Vec::new())?;
        let kf = yx_media::magic::track_mask(&job, Some(&cancel), &|p, phase| {
            emit_magic_progress(&emit_app, p, phase);
        })?;
        Ok(serde_json::json!({ "keyframes": kf }))
    })
    .await
    .map_err(|e| format!("magic track task failed: {e}"));
    // Always reset BEFORE any early return — a stuck flag makes every
    // subsequent click fail instantly with nothing visible in the UI.
    state.magic_busy.store(false, Ordering::SeqCst);
    if result.is_ok() {
        let _ = app.emit(
            "magic-progress",
            MagicProgressPayload {
                percent: 1.0,
                phase: "done".into(),
            },
        );
    }
    result?
}

/// Render the inpainted sidecar clip (cached by source + mask + settings).
/// Returns the sidecar path for the frontend to store in `resultPath`.
#[tauri::command]
async fn magic_remove_render(
    app: AppHandle,
    source: String,
    params: serde_json::Value,
    keyframes: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if state.magic_busy.swap(true, Ordering::SeqCst) {
        return Err("Another Magic Remove job is already running".into());
    }
    state.magic_cancel.store(false, Ordering::SeqCst);
    let cancel = state.magic_cancel.clone();
    let emit_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let kfs: Vec<MagicKeyframe> = if keyframes.is_array() {
            serde_json::from_value(keyframes).unwrap_or_default()
        } else {
            Vec::new()
        };
        let job = MagicJob::from_params(Path::new(&source), &params, kfs)?;
        let dir = dirs_cache().with_file_name("magic-cache");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out = yx_media::magic::cache_path(&dir, &job);
        if !out.exists() {
            let tmp = out.with_extension("tmp.mp4");
            yx_media::magic::render_inpaint(&job, &tmp, Some(&cancel), &|p, phase| {
                emit_magic_progress(&emit_app, p, phase);
            })?;
            std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
        }
        Ok(out.display().to_string())
    })
    .await
    .map_err(|e| format!("magic render task failed: {e}"));
    state.magic_busy.store(false, Ordering::SeqCst);
    if result.is_ok() {
        let _ = app.emit(
            "magic-progress",
            MagicProgressPayload {
                percent: 1.0,
                phase: "done".into(),
            },
        );
    }
    result?
}

/// Cooperative cancel for the running Magic Remove track/render job.
#[tauri::command]
fn magic_remove_cancel(state: State<'_, AppState>) {
    state.magic_cancel.store(true, Ordering::SeqCst);
}

/// Blur tool auto-track: template-track the blur region's content across the
/// clip and return translation keyframes (normalized offsets from the anchor
/// position, clip-local times) for the UI to store as position keyframes.
/// Shares the magic job busy/cancel/progress plumbing — heavy background
/// jobs never run concurrently.
#[tauri::command]
async fn blur_region_track(
    app: AppHandle,
    source: String,
    region: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    if state.magic_busy.swap(true, Ordering::SeqCst) {
        return Err("Another tracking job is already running".into());
    }
    state.magic_cancel.store(false, Ordering::SeqCst);
    let cancel = state.magic_cancel.clone();
    let emit_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let scope_in = region
            .get("scopeIn")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let scope_out = region
            .get("scopeOut")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let params = yx_media::magic::RegionTrackParams {
            x: region.get("x").and_then(|v| v.as_f64()).unwrap_or(0.5),
            y: region.get("y").and_then(|v| v.as_f64()).unwrap_or(0.5),
            w: region.get("w").and_then(|v| v.as_f64()).unwrap_or(0.2),
            h: region.get("h").and_then(|v| v.as_f64()).unwrap_or(0.2),
            anchor_time: region
                .get("anchorTime")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0),
            scope_in,
            scope_out,
            accuracy: region
                .get("accuracy")
                .and_then(|v| v.as_str())
                .unwrap_or("medium")
                .to_string(),
        };
        let kf = yx_media::magic::track_region(
            Path::new(&source),
            &params,
            Some(&cancel),
            &|p, phase| emit_progress_event(&emit_app, "blur-progress", p, phase),
        )?;
        Ok(serde_json::json!({ "keyframes": kf }))
    })
    .await
    .map_err(|e| format!("blur track task failed: {e}"));
    state.magic_busy.store(false, Ordering::SeqCst);
    result?
}

/// Persist a BG Key select-area alpha mask (base64 PNG rasterized by the UI
/// from the shape list) into the derived cache. Export reads the file via
/// `movie=...` + `alphamerge`, so preview and export share the exact mask.
#[tauri::command]
fn save_bg_mask(data: String) -> Result<String, String> {
    fn b64_decode(s: &str) -> Option<Vec<u8>> {
        fn val(c: u8) -> Option<u32> {
            match c {
                b'A'..=b'Z' => Some((c - b'A') as u32),
                b'a'..=b'z' => Some((c - b'a') as u32 + 26),
                b'0'..=b'9' => Some((c - b'0') as u32 + 52),
                b'+' => Some(62),
                b'/' => Some(63),
                _ => None,
            }
        }
        let clean: Vec<u8> = s
            .bytes()
            .filter(|b| !b.is_ascii_whitespace())
            .skip_while(|b| *b != b',') // strip any data: URL prefix
            .skip(1)
            .collect();
        let clean: &[u8] = if clean.is_empty() {
            s.as_bytes()
        } else {
            &clean
        };
        let mut out = Vec::with_capacity(clean.len() / 4 * 3);
        for chunk in clean.chunks(4) {
            if chunk.len() < 2 {
                return None;
            }
            let mut acc = 0u32;
            let mut n = 0;
            for &c in chunk.iter() {
                if c == b'=' {
                    break;
                }
                acc = (acc << 6) | val(c)?;
                n += 1;
            }
            acc <<= 6 * (4 - chunk.iter().take_while(|&&c| c != b'=').count() as u32);
            out.push((acc >> 16) as u8);
            if n > 1 {
                out.push((acc >> 8) as u8);
            }
            if n > 2 {
                out.push(acc as u8);
            }
        }
        Some(out)
    }
    let bytes = b64_decode(&data).ok_or_else(|| "bad mask data".to_string())?;
    if bytes.len() < 8 {
        return Err("empty mask".into());
    }
    let dir = dirs_cache().with_file_name("bg-mask");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Content-hashed name: identical masks dedupe; the LRU sweep +
    // liveness protection handle cleanup.
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in &bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let path = dir.join(format!("mask_{hash:016x}.png"));
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

fn parse_filter_kind(kind: &str) -> Result<FilterKind, String> {
    Ok(match kind {
        "transform" => FilterKind::Transform,
        "crop" => FilterKind::Crop,
        "exposure" => FilterKind::Exposure,
        "contrast" => FilterKind::Contrast,
        "saturation" => FilterKind::Saturation,
        "blur" => FilterKind::Blur,
        "flip" => FilterKind::Flip,
        "chromakey" => FilterKind::Chromakey,
        "volume" => FilterKind::Volume,
        "equalizer" => FilterKind::Equalizer,
        "compressor" => FilterKind::Compressor,
        "highpass" => FilterKind::Highpass,
        "lowpass" => FilterKind::Lowpass,
        "gate" => FilterKind::Gate,
        "denoise" => FilterKind::Denoise,
        "limiter" => FilterKind::Limiter,
        "reverb" => FilterKind::Reverb,
        "invert" => FilterKind::Invert,
        "pitch" => FilterKind::Pitch,
        "lut" => FilterKind::Lut,
        "fade" => FilterKind::Fade,
        "text" => FilterKind::Text,
        "temperature" => FilterKind::Temperature,
        "hue" => FilterKind::Hue,
        "vignette" => FilterKind::Vignette,
        "sharpen" => FilterKind::Sharpen,
        "vdenoise" => FilterKind::VideoDenoise,
        "stabilize" => FilterKind::Stabilize,
        "lut3d" => FilterKind::Lut3d,
        "normalize" => FilterKind::Normalize,
        "transition" => FilterKind::Transition,
        "deesser" => FilterKind::Deesser,
        "magicremove" => FilterKind::MagicRemove,
        "blurregion" => FilterKind::BlurRegion,
        "bgmask" => FilterKind::BgMask,
        "dream" => FilterKind::Dream,
        "magic" => FilterKind::Magic,
        "shake" => FilterKind::Shake,
        "wiggle" => FilterKind::Wiggle,
        "bounce" => FilterKind::Bounce,
        "zoompulse" => FilterKind::Zoompulse,
        "zoomin" => FilterKind::Zoomin,
        "spin" => FilterKind::Spin,
        "motionblur" => FilterKind::Motionblur,
        "rgbsplit" => FilterKind::Rgbsplit,
        "glitch" => FilterKind::Glitch,
        "flash" => FilterKind::Flash,
        "pulse" => FilterKind::Pulse,
        "glow" => FilterKind::Glow,
        "neon" => FilterKind::Neon,
        "vhs" => FilterKind::Vhs,
        "cinematic" => FilterKind::Cinematic,
        other => return Err(format!("unknown filter: {other}")),
    })
}

#[tauri::command]
fn set_clip_fades(
    clip_id: String,
    fade_in: f64,
    fade_out: f64,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::SetClipFades {
            clip_id,
            fade_in,
            fade_out,
        })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn set_clip_reverse(
    clip_id: String,
    reverse: bool,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::SetClipReverse { clip_id, reverse })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn set_clip_speed(
    clip_id: String,
    speed: f64,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::SetClipSpeed { clip_id, speed })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn undo(state: State<'_, AppState>) -> Result<Timeline, String> {
    let mut editor = state.editor.lock();
    editor.undo().map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn redo(state: State<'_, AppState>) -> Result<Timeline, String> {
    let mut editor = state.editor.lock();
    editor.redo().map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn list_proxies(state: State<'_, AppState>) -> Vec<ProxyJob> {
    state.proxies.list()
}

/// Render a clip's audio through the FULL export effect chain into a wav
/// file, so the Advanced Audio Tools dialog can play the true export sound
/// ("Hear processed result") instead of an approximation. Async: the FFmpeg
/// audio render can take seconds — it must never block the UI thread.
#[tauri::command]
async fn render_audio_preview(
    source: String,
    in_point: f64,
    duration: f64,
    filters: Vec<ExportFilter>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let chain = yx_media::build_audio_effect_chain(&ExportSegment {
            path: PathBuf::from(&source),
            in_point,
            out_point: in_point + duration.max(0.2),
            start: 0.0,
            fade_in: 0.0,
            fade_out: 0.0,
            reverse: false,
            speed: 1.0,
            filters,
            is_image: false,
        });
        let dir = dirs_cache().with_file_name("audio-previews");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        source.hash(&mut hasher);
        format!("{in_point:.3}|{duration:.3}|{chain}").hash(&mut hasher);
        let out = dir.join(format!("preview_{:016x}.wav", hasher.finish()));

        if !out.exists() {
            let status = yx_detect::command_ffmpeg()
                .args([
                    "-ss",
                    &format!("{in_point:.3}"),
                    "-t",
                    &format!("{duration:.3}"),
                    "-i",
                    &source,
                    "-af",
                    &chain,
                    "-ar",
                    "44100",
                    "-ac",
                    "2",
                    "-threads",
                    "1",
                    out.to_str().ok_or("bad output path")?,
                ])
                .output()
                .map_err(|e| e.to_string())?;
            if !status.status.success() {
                return Err(format!(
                    "audio preview render failed: {}",
                    String::from_utf8_lossy(&status.stderr).trim()
                ));
            }
        }
        Ok(out.display().to_string())
    })
    .await
    .map_err(|e| format!("audio preview task failed: {e}"))?
}

/// Finalize a MediaRecorder take: write the raw bytes, then stream-copy
/// remux them through FFmpeg. Recorded webm files carry no duration metadata
/// (FFprobe reports N/A -> clips would import as 5s stubs); the remux
/// regenerates proper headers so the real length is known. Falls back to the
/// raw file if FFmpeg is unavailable.
fn finalize_media_recording(bytes: &[u8], ext: &str, prefix: &str) -> Result<PathBuf, String> {
    let dir = dirs_cache().with_file_name("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let raw = dir.join(format!("{prefix}_{nanos}_raw.{ext}"));
    std::fs::write(&raw, bytes).map_err(|e| e.to_string())?;
    let final_path = dir.join(format!("{prefix}_{nanos}.{ext}"));
    let status = yx_detect::command_ffmpeg()
        .args([
            "-y",
            "-i",
            raw.to_str().ok_or("bad raw path")?,
            "-c",
            "copy",
            final_path.to_str().ok_or("bad final path")?,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if status.status.success() {
        let _ = std::fs::remove_file(&raw);
    } else {
        std::fs::rename(&raw, &final_path).map_err(|e| e.to_string())?;
    }
    Ok(final_path)
}

/// Persist a screen recording (MediaRecorder webm bytes) and return its path
/// so the frontend can place it on the timeline as a normal video clip.
/// Async: writing + remuxing a large recording must not block the UI thread.
#[tauri::command]
async fn save_screen_recording(bytes: Vec<u8>, ext: String) -> Result<String, String> {
    let ext = match ext.to_ascii_lowercase().as_str() {
        "webm" | "mkv" | "mp4" => ext.to_ascii_lowercase(),
        _ => "webm".to_string(),
    };
    tauri::async_runtime::spawn_blocking(move || {
        finalize_media_recording(&bytes, &ext, "screen").map(|p| p.display().to_string())
    })
    .await
    .map_err(|e| format!("recording task failed: {e}"))?
}

/// Persist a microphone recording (MediaRecorder bytes) and return its path
/// so the frontend can place it on the timeline like any imported audio.
/// Async: writing + remuxing a large recording must not block the UI thread.
#[tauri::command]
async fn save_voiceover(bytes: Vec<u8>, ext: String) -> Result<String, String> {
    let ext = match ext.to_ascii_lowercase().as_str() {
        "webm" | "wav" | "ogg" | "m4a" | "mp3" => ext.to_ascii_lowercase(),
        _ => "webm".to_string(),
    };
    tauri::async_runtime::spawn_blocking(move || {
        finalize_media_recording(&bytes, &ext, "voiceover").map(|p| p.display().to_string())
    })
    .await
    .map_err(|e| format!("voiceover task failed: {e}"))?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgressPayload {
    percent: f64,
    phase: String,
}

fn collect_export_segments(
    timeline: &Timeline,
    kind: TrackKind,
    proxies: &ProxyManager,
) -> Vec<ExportSegment> {
    // Video: every visible track, in track order (first track = bottom layer,
    // later tracks composite on top = style overlays). Audio: all
    // unmuted/visible tracks so FX on A2+ still export.
    let tracks: Vec<_> = timeline
        .tracks
        .iter()
        .filter(|t| t.kind == kind && !t.muted && !t.hidden && !t.clips.is_empty())
        .collect();

    if tracks.is_empty() {
        return Vec::new();
    }

    // Order matters for the overlay chain: group by track (track order is
    // the stacking order), start-time order within each track.
    let clips: Vec<_> = tracks
        .iter()
        .flat_map(|track| {
            let mut clips: Vec<_> = track
                .clips
                .iter()
                .filter(|c| c.out_point > c.in_point)
                .collect();
            clips.sort_by(|a, b| {
                a.start
                    .partial_cmp(&b.start)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            clips
        })
        .collect();
    clips
        .into_iter()
        .map(|c| {
            let mut source = c
                .source_path
                .as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(&c.media_path));
            let mut filters: Vec<ExportFilter> = c
                .filters
                .iter()
                .map(|f| ExportFilter {
                    kind: match f.kind {
                        FilterKind::Transform => "transform",
                        FilterKind::Crop => "crop",
                        FilterKind::Exposure => "exposure",
                        FilterKind::Contrast => "contrast",
                        FilterKind::Saturation => "saturation",
                        FilterKind::Blur => "blur",
                        FilterKind::Flip => "flip",
                        FilterKind::Chromakey => "chromakey",
                        FilterKind::Volume => "volume",
                        FilterKind::Equalizer => "equalizer",
                        FilterKind::Compressor => "compressor",
                        FilterKind::Highpass => "highpass",
                        FilterKind::Lowpass => "lowpass",
                        FilterKind::Gate => "gate",
                        FilterKind::Denoise => "denoise",
                        FilterKind::Limiter => "limiter",
                        FilterKind::Reverb => "reverb",
                        FilterKind::Invert => "invert",
                        FilterKind::Pitch => "pitch",
                        FilterKind::Lut => "lut",
                        FilterKind::Fade => "fade",
                        FilterKind::Text => "text",
                        FilterKind::Temperature => "temperature",
                        FilterKind::Hue => "hue",
                        FilterKind::Vignette => "vignette",
                        FilterKind::Sharpen => "sharpen",
                        FilterKind::VideoDenoise => "vdenoise",
                        FilterKind::Stabilize => "stabilize",
                        FilterKind::Lut3d => "lut",
                        FilterKind::Normalize => "normalize",
                        FilterKind::Transition => "transition",
                        FilterKind::Deesser => "deesser",
                        FilterKind::MagicRemove => "magicremove",
                        FilterKind::BlurRegion => "blurregion",
                        FilterKind::BgMask => "bgmask",
                        FilterKind::Dream => "dream",
                        FilterKind::Magic => "magic",
                        FilterKind::Shake => "shake",
                        FilterKind::Wiggle => "wiggle",
                        FilterKind::Bounce => "bounce",
                        FilterKind::Zoompulse => "zoompulse",
                        FilterKind::Zoomin => "zoomin",
                        FilterKind::Spin => "spin",
                        FilterKind::Motionblur => "motionblur",
                        FilterKind::Rgbsplit => "rgbsplit",
                        FilterKind::Glitch => "glitch",
                        FilterKind::Flash => "flash",
                        FilterKind::Pulse => "pulse",
                        FilterKind::Glow => "glow",
                        FilterKind::Neon => "neon",
                        FilterKind::Vhs => "vhs",
                        FilterKind::Cinematic => "cinematic",
                    }
                    .into(),
                    enabled: f.enabled,
                    params: f.params.clone(),
                })
                .collect();
            // Magic Remove: the removal is baked into the pre-rendered sidecar
            // clip, so export reads its frames instead of the original and
            // the filter itself is dropped from the chain. Falls back to the
            // original when no render exists. Clip-scoped sidecars cover only
            // [scopeIn, scopeOut] of the source (sidecar t=0 == scopeIn): the
            // clip's used range must still be covered (a trim past the
            // rendered window falls back) and in/out shift into sidecar time.
            let mut magic_scope_shift = 0.0f64;
            if let Some(mr) = c
                .filters
                .iter()
                .find(|f| f.kind == FilterKind::MagicRemove && f.enabled)
            {
                if let Some(p) = mr.params.get("resultPath").and_then(|v| v.as_str()) {
                    if !p.is_empty() && Path::new(p).is_file() {
                        let sin = mr
                            .params
                            .get("scopeIn")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.0)
                            .max(0.0);
                        let sout = mr
                            .params
                            .get("scopeOut")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.0)
                            .max(0.0);
                        let scoped = sout > sin + 1e-3;
                        let covered =
                            !scoped || (c.in_point >= sin - 0.01 && c.out_point <= sout + 0.01);
                        if covered {
                            source = PathBuf::from(p);
                            if scoped {
                                magic_scope_shift = sin;
                            }
                            filters.retain(|f| f.kind != "magicremove");
                        }
                    }
                }
            }
            ExportSegment {
                path: proxies.original_path(source.as_path()),
                in_point: (c.in_point - magic_scope_shift).max(0.0),
                out_point: (c.out_point - magic_scope_shift).max(0.0),
                start: c.start.max(0.0),
                fade_in: c.fade_in.max(0.0),
                fade_out: c.fade_out.max(0.0),
                reverse: c.reverse,
                speed: c.clamped_speed(),
                is_image: is_image_path(&source),
                filters,
            }
        })
        .collect()
}

/// Cooperative export cancel: the ffmpeg child is killed on the next
/// progress line (~sub-second) and the partial output is discarded.
#[tauri::command]
fn cancel_export(state: State<'_, AppState>) {
    state.export_cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn export_media(
    app: AppHandle,
    input_path: Option<String>,
    output_path: String,
    width: u32,
    height: u32,
    fps: Option<f64>,
    codec: Option<String>,
    x264_preset: Option<String>,
    crf: Option<u8>,
    video_bitrate: Option<String>,
    audio_bitrate: Option<String>,
    fit: Option<String>,
    encoder: Option<String>,
    match_source: Option<bool>,
    duration: Option<f64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let policy = state.policy.lock().clone();
    state.export_cancel.store(false, Ordering::Relaxed);
    let cancel = Arc::clone(&state.export_cancel);
    let codec = match codec.as_deref().unwrap_or("h264") {
        "h265" | "hevc" => ExportCodec::H265,
        _ => ExportCodec::H264,
    };
    let fit = match fit.as_deref().unwrap_or("contain") {
        "cover" => ExportFit::Cover,
        _ => ExportFit::Contain,
    };
    let encoder = match encoder.as_deref().unwrap_or("software") {
        "auto" => VideoEncoder::Auto,
        "nvenc" => VideoEncoder::Nvenc,
        "qsv" => VideoEncoder::Qsv,
        "amf" => VideoEncoder::Amf,
        _ => VideoEncoder::Software,
    };
    let x264_preset = x264_preset.unwrap_or_else(|| "slow".to_string());
    let audio_bitrate = audio_bitrate.unwrap_or_else(|| "320k".into());
    let match_source = match_source.unwrap_or(true);

    let timeline = state.editor.lock().timeline().clone();
    let video_segs = collect_export_segments(&timeline, TrackKind::Video, &state.proxies);
    let audio_segs = collect_export_segments(&timeline, TrackKind::Audio, &state.proxies);
    let use_timeline = !video_segs.is_empty() || !audio_segs.is_empty();

    let _ = app.emit(
        "export-progress",
        ExportProgressPayload {
            percent: 0.0,
            phase: "encoding".into(),
        },
    );

    // Encode to a sibling tmp file and rename on success: a killed, crashed
    // or cancelled export must never leave a partial file at the user-chosen
    // path (a partial .mp4 there looks playable but is corrupt).
    let final_path = PathBuf::from(&output_path);
    let tmp_path = final_path.with_extension(format!(
        "yxtmp.{}",
        final_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("out")
    ));
    let _ = std::fs::remove_file(&tmp_path);

    let app_progress = app.clone();
    let result = if use_timeline {
        let seg_end: f64 = video_segs
            .iter()
            .map(ExportSegment::end)
            .chain(audio_segs.iter().map(ExportSegment::end))
            .fold(0.0_f64, f64::max);
        let duration_secs = duration
            .filter(|d| *d > 0.0)
            .unwrap_or_else(|| timeline.duration().max(seg_end));

        let req = TimelineExportRequest {
            video: video_segs,
            audio: audio_segs,
            output_path: tmp_path.clone(),
            width,
            height,
            fps,
            codec,
            x264_preset,
            crf,
            video_bitrate,
            audio_bitrate,
            fit,
            encoder,
            match_source,
        };

        tauri::async_runtime::spawn_blocking(move || {
            export_timeline_with_progress(&req, &policy, duration_secs, Some(&cancel), |pct| {
                let _ = app_progress.emit(
                    "export-progress",
                    ExportProgressPayload {
                        percent: pct,
                        phase: "encoding".into(),
                    },
                );
            })
        })
        .await
        .map_err(|e| e.to_string())?
    } else {
        let input_path = input_path.ok_or_else(|| {
            "nothing to export — add clips to the timeline or select a media file".to_string()
        })?;
        let req = ExportRequest {
            input_path: PathBuf::from(&input_path),
            output_path: tmp_path.clone(),
            width,
            height,
            fps,
            codec,
            x264_preset,
            crf,
            video_bitrate,
            audio_bitrate,
            fit,
            encoder,
            match_source,
        };

        let duration_secs = duration
            .filter(|d| *d > 0.0)
            .or_else(|| {
                probe_media(std::path::Path::new(&input_path))
                    .ok()
                    .map(|i| i.duration)
            })
            .unwrap_or(0.0);

        tauri::async_runtime::spawn_blocking(move || {
            export_file_with_progress(&req, &policy, duration_secs, Some(&cancel), |pct| {
                let _ = app_progress.emit(
                    "export-progress",
                    ExportProgressPayload {
                        percent: pct,
                        phase: "encoding".into(),
                    },
                );
            })
        })
        .await
        .map_err(|e| e.to_string())?
    };

    match result {
        Ok(()) => {
            // Promote the finished encode: rename over any previous export.
            let promote_tmp = tmp_path.clone();
            let promote = tauri::async_runtime::spawn_blocking(move || {
                if final_path.exists() {
                    std::fs::remove_file(&final_path).map_err(|e| e.to_string())?;
                }
                std::fs::rename(&promote_tmp, &final_path).map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| format!("export promote task failed: {e}"));
            match promote.and_then(|r| r) {
                Ok(()) => {
                    let _ = app.emit(
                        "export-progress",
                        ExportProgressPayload {
                            percent: 1.0,
                            phase: "done".into(),
                        },
                    );
                    Ok(())
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp_path);
                    let _ = app.emit(
                        "export-progress",
                        ExportProgressPayload {
                            percent: 0.0,
                            phase: "error".into(),
                        },
                    );
                    Err(e.to_string())
                }
            }
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_path);
            let _ = app.emit(
                "export-progress",
                ExportProgressPayload {
                    percent: 0.0,
                    phase: "error".into(),
                },
            );
            Err(e.to_string())
        }
    }
}

#[tauri::command]
fn set_edit_mode(mode: String, state: State<'_, AppState>) -> Result<Timeline, String> {
    let mode = match mode.as_str() {
        "normal" => EditMode::Normal,
        "insert" => EditMode::Insert,
        "overwrite" => EditMode::Overwrite,
        other => return Err(format!("unknown edit mode: {other}")),
    };
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::SetEditMode { mode })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn slip_clip(
    clip_id: String,
    delta: f64,
    sync_linked: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::SlipClip {
            clip_id,
            delta,
            sync_linked: sync_linked.unwrap_or(true),
        })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn spacer_shift(
    at: f64,
    delta: f64,
    track_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let track_id = match track_id {
        Some(s) => Some(s.parse().map_err(|e| format!("bad track id: {e}"))?),
        None => None,
    };
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::SpacerShift {
            track_id,
            at,
            delta,
        })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn close_gap(
    at: f64,
    track_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let track_id = match track_id {
        Some(s) => Some(s.parse().map_err(|e| format!("bad track id: {e}"))?),
        None => None,
    };
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::CloseGap { track_id, at })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn remove_gaps(
    from: f64,
    track_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let track_id = match track_id {
        Some(s) => Some(s.parse().map_err(|e| format!("bad track id: {e}"))?),
        None => None,
    };
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::RemoveGaps { track_id, from })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn ripple_trim(
    clip_id: String,
    edge: String,
    new_edge_time: f64,
    sync_linked: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let edge = match edge.as_str() {
        "left" => TrimEdge::Left,
        "right" => TrimEdge::Right,
        other => return Err(format!("unknown edge: {other}")),
    };
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::RippleTrim {
            clip_id,
            edge,
            new_edge_time,
            sync_linked: sync_linked.unwrap_or(true),
        })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn add_marker(time: f64, label: String, state: State<'_, AppState>) -> Result<Timeline, String> {
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::AddMarker { time, label })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn remove_marker(marker_id: String, state: State<'_, AppState>) -> Result<Timeline, String> {
    let marker_id = marker_id
        .parse()
        .map_err(|e| format!("bad marker id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::RemoveMarker { marker_id })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn set_zone(
    zone_in: Option<f64>,
    zone_out: Option<f64>,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::SetZone { zone_in, zone_out })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn lift_zone(state: State<'_, AppState>) -> Result<Timeline, String> {
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::LiftZone)
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn extract_zone(state: State<'_, AppState>) -> Result<Timeline, String> {
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::ExtractZone)
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[tauri::command]
fn set_track_hidden(
    track_id: String,
    hidden: bool,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let track_id: TrackId = track_id.parse().map_err(|e| format!("bad track id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::SetTrackHidden { track_id, hidden })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Bound derived-cache growth before anything generates new entries.
    // The engine is empty at this point (nothing is restored at boot — every
    // launch starts fresh), so there is nothing to protect yet.
    sweep_derived_caches(&std::collections::HashSet::new());
    let (profile, policy) = probe_and_policy();
    let cache = dirs_cache();
    let state = AppState {
        editor: Mutex::new(TimelineEditor::new()),
        profile: Mutex::new(profile),
        policy: Mutex::new(policy),
        proxies: Arc::new(ProxyManager::new(cache)),
        probe_cache: Mutex::new(HashMap::new()),
        magic_busy: Arc::new(AtomicBool::new(false)),
        magic_cancel: Arc::new(AtomicBool::new(false)),
        export_cancel: Arc::new(AtomicBool::new(false)),
    };

    // Notify the UI when background proxy transcodes finish so the timeline
    // can hot-swap from the original file to the proxy (registered in setup,
    // where the AppHandle is available).

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(state)
        .setup(|app| {
            let _ = debug_agent_log(
                "{\"sessionId\":\"75f279\",\"message\":\"yx-desktop setup\",\"hypothesisId\":\"H2\",\"timestamp\":0}"
                    .into(),
            );
            let state: tauri::State<AppState> = tauri::Manager::state(app);
            let handle = app.handle().clone();
            let proxies = Arc::clone(&state.proxies);
            // Long sessions scrub/import for hours; re-run the (cheap)
            // derived-cache sweep periodically so caches stay bounded without
            // waiting for a relaunch. Liveness comes from the LIVE engine
            // timeline: the open project's magic sidecars and bg-mask PNGs
            // must survive the sweep.
            let sweep_handle = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(600));
                let protected = tauri::Manager::try_state::<AppState>(&sweep_handle)
                    .map(|state| {
                        let timeline = state.editor.lock().timeline().clone();
                        collect_protected_cache_paths(Some(&timeline))
                    })
                    .unwrap_or_default();
                sweep_derived_caches(&protected);
            });
            proxies.set_notifier(Arc::new(move |job: &yx_proxy::ProxyJob| {
                if matches!(job.status, yx_proxy::ProxyStatus::Ready) {
                    let _ = handle.emit(
                        "proxy-ready",
                        ProxyReadyPayload {
                            source_path: job.source_path.display().to_string(),
                            proxy_path: job.proxy_path.display().to_string(),
                        },
                    );
                }
            }));
            #[cfg(desktop)]
            {
                use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
                use tauri::{Emitter, Manager};                use tauri_plugin_opener::OpenerExt;

                fn show_main(app: &tauri::AppHandle) {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }

                if let Some(icon) = app.default_window_icon().cloned() {
                    let show_i =
                        MenuItem::with_id(app, "show", "Show Project YX", true, None::<&str>)?;
                    let hide_i =
                        MenuItem::with_id(app, "hide", "Hide to tray", true, None::<&str>)?;
                    let updates_i = MenuItem::with_id(
                        app,
                        "check_updates",
                        "Check for Updates…",
                        true,
                        None::<&str>,
                    )?;
                    let docs_i =
                        MenuItem::with_id(app, "docs", "Documentation", true, None::<&str>)?;
                    let sep = PredefinedMenuItem::separator(app)?;
                    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                    let menu = Menu::with_items(
                        app,
                        &[&show_i, &hide_i, &updates_i, &docs_i, &sep, &quit_i],
                    )?;

                    let _tray = TrayIconBuilder::new()
                        .icon(icon)
                        .tooltip("Project YX")
                        .menu(&menu)
                        .show_menu_on_left_click(false)
                        .on_menu_event(|app, event| match event.id().as_ref() {
                            "show" => show_main(app),
                            "hide" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.hide();
                                }
                            }
                            "check_updates" => {
                                let _ = app.emit("tray-check-updates", ());
                            }
                            "docs" => {
                                let _ = app.opener().open_url(
                                    "https://github.com/needyamin/project-yx#readme",
                                    None::<&str>,
                                );
                            }
                            "quit" => {
                                app.exit(0);
                            }
                            _ => {}
                        })
                        .on_tray_icon_event(|tray, event| {
                            if let TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            } = event
                            {
                                show_main(tray.app_handle());
                            }
                        })
                        .build(app)?;
                }
                // Window starts hidden to avoid a blank flash; show from Rust so release
                // builds never depend solely on JS ACL / first-paint timing.
                if let Some(window) = app.get_webview_window("main") {
                    let win = window.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        let _ = win.show();
                        let _ = win.set_focus();
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_boot_info,
            get_timeline,
            get_timeline_issues,
            get_media_thumbnail,
            save_project,
            load_project,
            new_project,
            debug_agent_log,
            reprobe_hardware,
            import_media,
            read_text_file,
            swap_timeline_media,
            add_media_to_timeline,
            add_clip_to_track,
            move_clip,
            trim_clip,
            split_clip_at,
            add_transition,
            remove_clip,
            ripple_delete,
            unlink_clip,
            link_clips,
            set_track_mute,
            set_track_lock,
            set_track_hidden,
            add_track,
            remove_track,
            add_filter,
            update_filter,
            set_filter_enabled,
            remove_filter,
            set_clip_fades,
            set_clip_reverse,
            set_clip_speed,
            set_edit_mode,
            slip_clip,
            spacer_shift,
            close_gap,
            remove_gaps,
            ripple_trim,
            add_marker,
            remove_marker,
            set_zone,
            lift_zone,
            extract_zone,
            undo,
            redo,
            list_proxies,
            save_voiceover,
            save_screen_recording,
            render_audio_preview,
            cancel_export,
            export_media,
            magic_remove_track,
            magic_remove_render,
            magic_remove_cancel,
            blur_region_track,
            save_bg_mask,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Project YX")
        .run(|_app, _event| {});
}

fn dirs_cache() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("ProjectYX").join("proxy-cache")
}

#[cfg(test)]
mod cache_sweep_tests {
    use super::*;

    #[test]
    fn sweep_keeps_newest_files_under_cap() {
        let dir = std::env::temp_dir().join(format!("yx_sweep_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("old.bin");
        let new = dir.join("new.bin");
        std::fs::write(&old, vec![0u8; 100]).unwrap();
        std::fs::write(&new, vec![0u8; 100]).unwrap();
        // Force a distinct mtime (same-second writes can tie).
        let older = std::time::SystemTime::now() - std::time::Duration::from_secs(10);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&old)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(older))
            .unwrap();
        sweep_cache_dir(&dir, 150, &std::collections::HashSet::new());
        assert!(!old.exists(), "oldest file must be evicted first");
        assert!(new.exists(), "newest file must survive");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sweep_protects_live_files_even_when_over_cap() {
        let dir = std::env::temp_dir().join(format!("yx_sweep_live_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let live = dir.join("sidecar_render.mp4");
        let stale = dir.join("stale.bin");
        std::fs::write(&live, vec![0u8; 100]).unwrap();
        std::fs::write(&stale, vec![0u8; 100]).unwrap();
        let mut protected = std::collections::HashSet::new();
        protected.insert(live.clone());
        sweep_cache_dir(&dir, 50, &protected);
        assert!(live.exists(), "referenced sidecar must survive the sweep");
        assert!(!stale.exists(), "unprotected files still evicted");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sweep_noop_under_cap_and_missing_dir() {
        let missing = std::env::temp_dir().join("yx_sweep_missing_dir");
        sweep_cache_dir(&missing, 1 << 20, &std::collections::HashSet::new()); // must not panic
        let dir = std::env::temp_dir().join(format!("yx_sweep_ok_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.bin"), vec![0u8; 10]).unwrap();
        sweep_cache_dir(&dir, 1 << 20, &std::collections::HashSet::new());
        assert!(
            dir.join("a.bin").exists(),
            "under-cap sweep must not delete"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
