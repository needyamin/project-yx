use parking_lot::Mutex;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use yx_detect::{probe_and_policy, HardwareProfile, PerformancePolicy};
use yx_media::{
    export_file_with_progress, probe_media, ExportCodec, ExportFit, ExportRequest, MediaInfo,
    VideoEncoder,
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
    let info = probe_media(PathBuf::from(&path).as_path()).map_err(|e| e.to_string())?;
    let policy = state.policy.lock().clone();
    let proxies = Arc::clone(&state.proxies);
    let source = PathBuf::from(&path);
    std::thread::spawn(move || {
        let _ = proxies.enqueue(source.as_path(), &policy);
    });
    Ok(info)
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
    let info = probe_media(PathBuf::from(&media_path).as_path()).map_err(|e| e.to_string())?;
    let out_point = if info.duration > 0.0 {
        info.duration
    } else {
        5.0
    };
    let path = playback_path(&state, &media_path);
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
                start,
                in_point: 0.0,
                out_point,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .map_err(|e| e.to_string())?;
    } else if info.has_audio {
        let audio_track = editor
            .timeline()
            .first_track(TrackKind::Audio)
            .ok_or_else(|| "no audio track".to_string())?;
        editor
            .apply(EditCommand::AddClip {
                track_id: audio_track,
                media_path: path,
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
    // Delegate to smart A/V routing.
    let info = probe_media(PathBuf::from(&media_path).as_path()).map_err(|e| e.to_string())?;
    let out_point = if info.duration > 0.0 {
        info.duration
    } else {
        5.0
    };
    let path = playback_path(&state, &media_path);
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
                start,
                in_point: 0.0,
                out_point,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .map_err(|e| e.to_string())?;
    } else if info.has_audio {
        let audio_track = editor
            .timeline()
            .first_track(TrackKind::Audio)
            .ok_or_else(|| "no audio track".to_string())?;
        editor
            .apply(EditCommand::AddClip {
                track_id: audio_track,
                media_path: path,
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
fn move_clip(
    clip_id: String,
    new_start: f64,
    sync_linked: bool,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::MoveClip {
            clip_id,
            new_start,
            sync_linked,
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
fn add_filter(
    clip_id: String,
    kind: String,
    state: State<'_, AppState>,
) -> Result<Timeline, String> {
    let clip_id: ClipId = clip_id.parse().map_err(|e| format!("bad clip id: {e}"))?;
    let kind = match kind.as_str() {
        "exposure" => FilterKind::Exposure,
        "contrast" => FilterKind::Contrast,
        "lut" => FilterKind::Lut,
        "crop" => FilterKind::Crop,
        "fade" => FilterKind::Fade,
        "text" => FilterKind::Text,
        "blur" => FilterKind::Blur,
        "denoise" => FilterKind::Denoise,
        other => return Err(format!("unknown filter: {other}")),
    };
    let mut editor = state.editor.lock();
    editor
        .apply(EditCommand::AddFilter {
            clip_id,
            kind,
            params: serde_json::json!({}),
        })
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgressPayload {
    percent: f64,
    phase: String,
}

#[tauri::command]
async fn export_media(
    app: AppHandle,
    input_path: String,
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
    let req = ExportRequest {
        input_path: PathBuf::from(&input_path),
        output_path: PathBuf::from(output_path),
        width,
        height,
        fps,
        codec,
        x264_preset: x264_preset.unwrap_or_else(|| "slow".to_string()),
        crf,
        video_bitrate,
        audio_bitrate: audio_bitrate.unwrap_or_else(|| "320k".into()),
        fit,
        encoder,
        match_source: match_source.unwrap_or(true),
    };

    let duration_secs = duration
        .filter(|d| *d > 0.0)
        .or_else(|| probe_media(std::path::Path::new(&input_path)).ok().map(|i| i.duration))
        .unwrap_or(0.0);

    let _ = app.emit(
        "export-progress",
        ExportProgressPayload {
            percent: 0.0,
            phase: "encoding".into(),
        },
    );

    let app_progress = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
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
    .map_err(|e| e.to_string())?;

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
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::tray::TrayIconBuilder;
                if let Some(icon) = app.default_window_icon().cloned() {
                    let _tray = TrayIconBuilder::new()
                        .icon(icon)
                        .tooltip("Project YX")
                        .build(app)?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_boot_info,
            get_timeline,
            reprobe_hardware,
            import_media,
            add_media_to_timeline,
            add_clip_to_track,
            move_clip,
            trim_clip,
            split_clip_at,
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
            set_edit_mode,
            slip_clip,
            spacer_shift,
            ripple_trim,
            add_marker,
            remove_marker,
            set_zone,
            lift_zone,
            extract_zone,
            undo,
            redo,
            list_proxies,
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
