use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use yx_detect::{probe_and_policy, HardwareProfile, PerformancePolicy};
use yx_media::{
    export_file_with_progress, export_timeline_with_progress, is_image_path, probe_media,
    ExportCodec, ExportFit, ExportFilter, ExportRequest, ExportSegment, MediaInfo,
    TimelineExportRequest, VideoEncoder,
};
use yx_proxy::{ProxyJob, ProxyManager};
use yx_timeline::{
    ClipId, EditCommand, EditMode, FilterKind, MediaRole, Timeline, TimelineEditor, TrackId,
    TrackKind, TrimEdge,
};
use uuid::Uuid;

struct AppState {
    editor: Mutex<TimelineEditor>,
    profile: Mutex<HardwareProfile>,
    policy: Mutex<PerformancePolicy>,
    proxies: Arc<ProxyManager>,
    /// ffprobe results keyed by canonical path — importing and dragging a file
    /// onto the timeline must not spawn repeated ffprobe subprocesses.
    probe_cache: Mutex<HashMap<PathBuf, MediaInfo>>,
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

#[tauri::command]
fn reprobe_hardware(state: State<'_, AppState>) -> BootInfo {
    let (profile, policy) = probe_and_policy();
    *state.profile.lock() = profile.clone();
    *state.policy.lock() = policy.clone();
    BootInfo {
        profile,
        policy,
        timeline: state.editor.lock().timeline().clone(),
    }
}

#[tauri::command]
fn import_media(path: String, state: State<'_, AppState>) -> Result<MediaInfo, String> {
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
#[tauri::command]
fn add_media_to_timeline(
    media_path: String,
    start: f64,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    place_media_on_timeline(&state, media_path, start)
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
    let mut editor = state.editor.lock();

    if info.has_video && info.has_audio {
        let video_track = editor
            .timeline()
            .first_track(TrackKind::Video)
            .ok_or_else(|| "no video track".to_string())?;
        let audio_track = editor
            .timeline()
            .first_track(TrackKind::Audio)
            .ok_or_else(|| "no audio track".to_string())?;
        editor
            .apply(EditCommand::AddAvPair {
                video_track_id: video_track,
                audio_track_id: audio_track,
                media_path: path,
                source_path: Some(source),
                start,
                in_point: 0.0,
                out_point,
            })
            .map_err(|e| e.to_string())?;
    } else if info.has_video {
        let video_track = editor
            .timeline()
            .first_track(TrackKind::Video)
            .ok_or_else(|| "no video track".to_string())?;
        editor
            .apply(EditCommand::AddClip {
                track_id: video_track,
                media_path: path,
                source_path: Some(source),
                start,
                in_point: 0.0,
                out_point,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .map_err(|e| e.to_string())?;
    } else if info.has_audio {
        // Voiceovers/overdubs: prefer the first audio track whose range at the
        // drop point is FREE, so they land exactly at the playhead instead of
        // stacking on top of existing music. Falls back to the first track.
        // First FREE audio track at the drop point; when every track is busy
        // (e.g. voiceover over a full music bed), add a fresh track instead
        // of stacking invisibly on top of existing clips.
        let mut audio_track = {
            let timeline = editor.timeline();
            let candidates: Vec<TrackId> = timeline
                .tracks
                .iter()
                .filter(|t| t.kind == TrackKind::Audio && !t.hidden && !t.locked)
                .map(|t| t.id)
                .collect();
            candidates
                .iter()
                .copied()
                .find(|tid| {
                    timeline
                        .tracks
                        .iter()
                        .find(|t| t.id == *tid)
                        .map(|t| {
                            t.clips.iter().all(|c| {
                                c.end() <= start + 1e-6 || c.start >= start + out_point - 1e-6
                            })
                        })
                        .unwrap_or(false)
                })
                .unwrap_or_default()
        };
        if audio_track.is_nil() {
            editor
                .apply(EditCommand::AddTrack { kind: TrackKind::Audio, name: None })
                .map_err(|e| e.to_string())?;
            audio_track = editor
                .timeline()
                .tracks
                .iter()
                .filter(|t| t.kind == TrackKind::Audio)
                .last()
                .map(|t| t.id)
                .ok_or_else(|| "no audio track".to_string())?;
        }
        editor
            .apply(EditCommand::AddClip {
                track_id: audio_track,
                media_path: path,
                source_path: Some(source),
                start,
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
        Some(s) => Some(s.parse::<TrackId>().map_err(|e| format!("bad track id: {e}"))?),
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
    let filter_id: Uuid = filter_id.parse().map_err(|e| format!("bad filter id: {e}"))?;
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
    let filter_id: Uuid = filter_id.parse().map_err(|e| format!("bad filter id: {e}"))?;
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
    let filter_id: Uuid = filter_id.parse().map_err(|e| format!("bad filter id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::RemoveFilter {
            clip_id,
            filter_id,
        })
        .map_err(|e| e.to_string())?;
    Ok(editor.timeline().clone())
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
/// ("Hear processed result") instead of an approximation.
#[tauri::command]
fn render_audio_preview(
    source: String,
    in_point: f64,
    duration: f64,
    filters: Vec<ExportFilter>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let _ = state;
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
}

/// Finalize a MediaRecorder take: write the raw bytes, then stream-copy
/// remux them through FFmpeg. Recorded webm files carry no duration metadata
/// (FFprobe reports N/A -> clips would import as 5s stubs); the remux
/// regenerates proper headers so the real length is known. Falls back to the
/// raw file if FFmpeg is unavailable.
fn finalize_media_recording(
    bytes: &[u8],
    ext: &str,
    prefix: &str,
) -> Result<PathBuf, String> {
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
#[tauri::command]
fn save_screen_recording(bytes: Vec<u8>, ext: String) -> Result<String, String> {
    let ext = match ext.to_ascii_lowercase().as_str() {
        "webm" | "mkv" | "mp4" => ext.to_ascii_lowercase(),
        _ => "webm".to_string(),
    };
    finalize_media_recording(&bytes, &ext, "screen").map(|p| p.display().to_string())
}

/// Persist a microphone recording (MediaRecorder bytes) and return its path
/// so the frontend can place it on the timeline like any imported audio.
#[tauri::command]
fn save_voiceover(bytes: Vec<u8>, ext: String) -> Result<String, String> {
    let ext = match ext.to_ascii_lowercase().as_str() {
        "webm" | "wav" | "ogg" | "m4a" | "mp3" => ext.to_ascii_lowercase(),
        _ => "webm".to_string(),
    };
    finalize_media_recording(&bytes, &ext, "voiceover").map(|p| p.display().to_string())
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
    // Video: first unmuted/visible track only (preserve prior overlay model).
    // Audio: all unmuted/visible tracks so FX on A2+ still export.
    let tracks: Vec<_> = timeline
        .tracks
        .iter()
        .filter(|t| t.kind == kind && !t.muted && !t.hidden && !t.clips.is_empty())
        .collect();

    let selected: Vec<_> = if kind == TrackKind::Video {
        tracks.into_iter().take(1).collect()
    } else {
        tracks
    };

    if selected.is_empty() {
        return Vec::new();
    }

    let mut clips: Vec<_> = selected
        .iter()
        .flat_map(|track| track.clips.iter())
        .filter(|c| c.out_point > c.in_point)
        .collect();
    clips.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    clips
        .into_iter()
        .map(|c| {
            let source = c
                .source_path
                .as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(&c.media_path));
            ExportSegment {
                path: proxies.original_path(source.as_path()),
                in_point: c.in_point,
                out_point: c.out_point,
                start: c.start.max(0.0),
                fade_in: c.fade_in.max(0.0),
                fade_out: c.fade_out.max(0.0),
                reverse: c.reverse,
                speed: c.clamped_speed(),
                is_image: is_image_path(&source),
                filters: c
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
                        }
                        .into(),
                        enabled: f.enabled,
                        params: f.params.clone(),
                    })
                    .collect(),
            }
        })
        .collect()
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
            output_path: PathBuf::from(output_path),
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
            export_timeline_with_progress(&req, &policy, duration_secs, |pct| {
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
            output_path: PathBuf::from(output_path),
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
            export_file_with_progress(&req, &policy, duration_secs, |pct| {
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
    let (profile, policy) = probe_and_policy();
    let cache = dirs_cache();
    let state = AppState {
        editor: Mutex::new(TimelineEditor::new()),
        profile: Mutex::new(profile),
        policy: Mutex::new(policy),
        proxies: Arc::new(ProxyManager::new(cache)),
        probe_cache: Mutex::new(HashMap::new()),
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
            debug_agent_log,
            reprobe_hardware,
            import_media,
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
            export_media,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Project YX");
}

fn dirs_cache() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("ProjectYX").join("proxy-cache")
}
