//! FFmpeg-backed media I/O.
//!
//! Phase 1 uses the FFmpeg CLI so we do not need to link libav at build time.
//! In-process `ffmpeg-next` can be added later for frame-accurate scrubbing.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use thiserror::Error;
use yx_detect::{PerformancePolicy, PerformanceTier};

#[derive(Debug, Error)]
pub enum MediaError {
    #[error("ffmpeg is not available on PATH")]
    FfmpegMissing,
    #[error("ffprobe failed: {0}")]
    ProbeFailed(String),
    #[error("ffmpeg failed: {0}")]
    FfmpegFailed(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaInfo {
    pub path: String,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub has_audio: bool,
    pub has_video: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportCodec {
    H264,
    H265,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFit {
    /// Letterbox / pillarbox to exact size.
    Contain,
    /// Crop to fill the frame.
    Cover,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoEncoder {
    Auto,
    Software,
    Nvenc,
    Qsv,
    Amf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRequest {
    pub input_path: PathBuf,
    pub output_path: PathBuf,
    pub width: u32,
    pub height: u32,
    /// Target fps; `None` keeps source timing.
    pub fps: Option<f64>,
    pub codec: ExportCodec,
    /// x264/x265 software preset (ultrafast…veryslow).
    pub x264_preset: String,
    /// Constant rate factor when set (quality mode). Lower = better.
    pub crf: Option<u8>,
    /// Target video bitrate like "10M" when CRF is None.
    pub video_bitrate: Option<String>,
    pub audio_bitrate: String,
    pub fit: ExportFit,
    pub encoder: VideoEncoder,
    /// Keep source frame size (skip resize/pad/crop). Still forces even dims for yuv420p.
    pub match_source: bool,
}

impl ExportRequest {
    pub fn recommended(width: u32, height: u32, _tier: PerformanceTier) -> Self {
        Self {
            input_path: PathBuf::new(),
            output_path: PathBuf::new(),
            width,
            height,
            fps: None,
            codec: ExportCodec::H264,
            x264_preset: "slow".into(),
            crf: Some(15),
            video_bitrate: None,
            audio_bitrate: "320k".into(),
            fit: ExportFit::Contain,
            encoder: VideoEncoder::Software,
            match_source: true,
        }
    }
}

pub fn probe_media(path: &Path) -> Result<MediaInfo, MediaError> {
    ensure_ffmpeg()?;
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()?;

    if !output.status.success() {
        return Err(MediaError::ProbeFailed(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }

    let raw: FfprobeJson = serde_json::from_slice(&output.stdout)?;
    let mut info = MediaInfo {
        path: path.display().to_string(),
        duration: raw
            .format
            .as_ref()
            .and_then(|f| f.duration.as_ref())
            .and_then(|d| d.parse().ok())
            .unwrap_or(0.0),
        width: 0,
        height: 0,
        frame_rate: 30.0,
        video_codec: None,
        audio_codec: None,
        has_audio: false,
        has_video: false,
    };

    for stream in raw.streams.unwrap_or_default() {
        match stream.codec_type.as_deref() {
            Some("video") if !info.has_video => {
                info.has_video = true;
                info.width = stream.width.unwrap_or(0);
                info.height = stream.height.unwrap_or(0);
                info.video_codec = stream.codec_name;
                if let Some(rate) = stream.avg_frame_rate.as_deref() {
                    info.frame_rate = parse_fraction(rate).unwrap_or(30.0);
                }
                if info.duration <= 0.0 {
                    if let Some(d) = stream.duration.as_ref().and_then(|d| d.parse().ok()) {
                        info.duration = d;
                    }
                }
            }
            Some("audio") => {
                info.has_audio = true;
                info.audio_codec = stream.codec_name;
            }
            _ => {}
        }
    }

    Ok(info)
}

/// Build an FFmpeg CLI export command that prefers hardware encode when policy allows.
pub fn build_export_args(
    req: &ExportRequest,
    policy: &PerformancePolicy,
) -> Result<Vec<String>, MediaError> {
    ensure_ffmpeg()?;

    let mut filters: Vec<String> = Vec::new();

    if let Some(fps) = req.fps {
        if fps > 0.0 {
            filters.push(format!("fps={fps}"));
        }
    }

    if req.match_source {
        // Keep source size; only even dims for yuv420p (no pad/crop resize).
        filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2".into());
    } else {
        let w = req.width.max(2) & !1;
        let h = req.height.max(2) & !1;
        let scale = match req.fit {
            ExportFit::Contain => format!(
                "scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black"
            ),
            ExportFit::Cover => {
                format!("scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}")
            }
        };
        filters.push(scale);
    }

    filters.push("format=yuv420p".into());

    let mut args = vec![
        "-y".into(),
        "-i".into(),
        req.input_path.display().to_string(),
        "-vf".into(),
        filters.join(","),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        req.audio_bitrate.clone(),
        "-movflags".into(),
        "+faststart".into(),
    ];

    let use_hw = match req.encoder {
        VideoEncoder::Software => false,
        VideoEncoder::Nvenc | VideoEncoder::Qsv | VideoEncoder::Amf => true,
        VideoEncoder::Auto => policy.prefer_hw_encode,
    };

    let (vcodec, hw_preset) = match (&req.codec, &req.encoder, use_hw) {
        (ExportCodec::H265, VideoEncoder::Nvenc, _) | (ExportCodec::H265, VideoEncoder::Auto, true) => {
            ("hevc_nvenc", "p5")
        }
        (ExportCodec::H265, VideoEncoder::Qsv, _) => ("hevc_qsv", "slow"),
        (ExportCodec::H265, VideoEncoder::Amf, _) => ("hevc_amf", "quality"),
        (ExportCodec::H264, VideoEncoder::Nvenc, _) | (ExportCodec::H264, VideoEncoder::Auto, true) => {
            ("h264_nvenc", "p5")
        }
        (ExportCodec::H264, VideoEncoder::Qsv, _) => ("h264_qsv", "slow"),
        (ExportCodec::H264, VideoEncoder::Amf, _) => ("h264_amf", "quality"),
        (ExportCodec::H265, _, _) => ("libx265", ""),
        (ExportCodec::H264, _, _) => ("libx264", ""),
    };

    args.extend(["-c:v".into(), vcodec.into()]);

    let soft = vcodec.starts_with("libx");
    if soft {
        args.extend([
            "-preset".into(),
            req.x264_preset.clone(),
            "-threads".into(),
            policy.encode_threads.to_string(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]);
        if vcodec == "libx264" {
            args.extend(["-profile:v".into(), "high".into()]);
        }
        if let Some(crf) = req.crf {
            args.extend(["-crf".into(), crf.to_string()]);
        } else if let Some(br) = &req.video_bitrate {
            args.extend(["-b:v".into(), br.clone()]);
        } else {
            args.extend(["-b:v".into(), bitrate_for_height(req.height)]);
        }
    } else {
        // Hardware: constant-quality mode reduces blockiness vs fixed bitrate.
        if !hw_preset.is_empty() {
            args.extend(["-preset".into(), hw_preset.into()]);
        }
        if let Some(br) = &req.video_bitrate {
            args.extend(["-b:v".into(), br.clone()]);
        } else if let Some(crf) = req.crf {
            let cq = crf.clamp(10, 28);
            if vcodec.contains("nvenc") {
                args.extend([
                    "-rc".into(),
                    "vbr".into(),
                    "-cq".into(),
                    cq.to_string(),
                    "-b:v".into(),
                    "0".into(),
                ]);
            } else if vcodec.contains("qsv") {
                args.extend(["-global_quality".into(), cq.to_string()]);
            } else if vcodec.contains("amf") {
                args.extend([
                    "-rc".into(),
                    "cqp".into(),
                    "-qp_i".into(),
                    cq.to_string(),
                    "-qp_p".into(),
                    cq.to_string(),
                ]);
            } else {
                let base = bitrate_kbps_for_height(req.height.max(1080));
                let factor = match crf {
                    0..=14 => 1.8,
                    15..=18 => 1.4,
                    19..=22 => 1.1,
                    _ => 0.9,
                };
                args.extend(["-b:v".into(), format!("{}k", (base as f64 * factor) as u32)]);
            }
        } else {
            args.extend(["-b:v".into(), bitrate_for_height(req.height.max(1080))]);
        }
    }

    args.push(req.output_path.display().to_string());
    Ok(args)
}

fn inject_progress_flags(args: &mut Vec<String>) {
    // Before the final output path argument.
    if args.is_empty() {
        return;
    }
    let out = args.pop().unwrap();
    args.extend([
        "-nostdin".into(),
        "-nostats".into(),
        "-progress".into(),
        "pipe:1".into(),
    ]);
    args.push(out);
}

/// Run FFmpeg as a subprocess and report 0.0..=1.0 progress via `on_progress`.
pub fn export_file_with_progress<F>(
    req: &ExportRequest,
    policy: &PerformancePolicy,
    duration_secs: f64,
    mut on_progress: F,
) -> Result<(), MediaError>
where
    F: FnMut(f64),
{
    let mut args = build_export_args(req, policy)?;
    inject_progress_flags(&mut args);

    match run_ffmpeg_progress(&args, duration_secs, &mut on_progress) {
        Ok(()) => Ok(()),
        Err(err) => {
            let can_retry = matches!(
                req.encoder,
                VideoEncoder::Auto | VideoEncoder::Nvenc | VideoEncoder::Qsv | VideoEncoder::Amf
            );
            if !can_retry {
                return Err(err);
            }
            let mut soft_req = req.clone();
            soft_req.encoder = VideoEncoder::Software;
            let mut soft_args = build_export_args(&soft_req, policy)?;
            inject_progress_flags(&mut soft_args);
            on_progress(0.0);
            run_ffmpeg_progress(&soft_args, duration_secs, &mut on_progress)
        }
    }
}

pub fn export_file(req: &ExportRequest, policy: &PerformancePolicy) -> Result<(), MediaError> {
    let duration = probe_media(&req.input_path)
        .map(|i| i.duration)
        .unwrap_or(0.0);
    export_file_with_progress(req, policy, duration, |_| {})
}

fn run_ffmpeg_progress<F>(
    args: &[String],
    duration_secs: f64,
    on_progress: &mut F,
) -> Result<(), MediaError>
where
    F: FnMut(f64),
{
    use std::io::{BufRead, BufReader, Read};
    use std::process::{Command, Stdio};
    use std::thread;

    let mut child = Command::new("ffmpeg")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| MediaError::FfmpegFailed(e.to_string()))?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| MediaError::FfmpegFailed("missing ffmpeg stderr".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| MediaError::FfmpegFailed("missing ffmpeg stdout".into()))?;

    let stderr_handle = thread::spawn(move || {
        let mut buf = String::new();
        let mut r = stderr;
        let _ = r.read_to_string(&mut buf);
        buf
    });

    let reader = BufReader::new(stdout);
    let mut last_emit = -1.0_f64;
    for line in reader.lines().flatten() {
        if let Some(ms) = line.strip_prefix("out_time_ms=") {
            if let Ok(v) = ms.trim().parse::<f64>() {
                if duration_secs > 0.01 {
                    let pct = (v / 1_000_000.0 / duration_secs).clamp(0.0, 0.99);
                    if (pct - last_emit).abs() >= 0.005 {
                        last_emit = pct;
                        on_progress(pct);
                    }
                }
            }
        } else if line.starts_with("progress=end") {
            on_progress(1.0);
        }
    }

    let status = child
        .wait()
        .map_err(|e| MediaError::FfmpegFailed(e.to_string()))?;
    let stderr_text = stderr_handle.join().unwrap_or_default();

    if !status.success() {
        return Err(MediaError::FfmpegFailed(stderr_text.trim().to_string()));
    }
    on_progress(1.0);
    Ok(())
}

pub fn default_x264_preset(tier: PerformanceTier) -> &'static str {
    match tier {
        PerformanceTier::Potato | PerformanceTier::Low => "veryfast",
        PerformanceTier::Medium => "faster",
        PerformanceTier::High => "medium",
    }
}

fn bitrate_kbps_for_height(height: u32) -> u32 {
    match height {
        h if h >= 2160 => 45000,
        h if h >= 1440 => 20000,
        h if h >= 1080 => 10000,
        h if h >= 720 => 5000,
        _ => 2500,
    }
}

fn bitrate_for_height(height: u32) -> String {
    format!("{}k", bitrate_kbps_for_height(height))
}

fn ensure_ffmpeg() -> Result<(), MediaError> {
    let ok = Command::new("ffmpeg")
        .args(["-version"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(MediaError::FfmpegMissing)
    }
}

fn parse_fraction(s: &str) -> Option<f64> {
    if let Some((a, b)) = s.split_once('/') {
        let num: f64 = a.parse().ok()?;
        let den: f64 = b.parse().ok()?;
        if den == 0.0 {
            return None;
        }
        Some(num / den)
    } else {
        s.parse().ok()
    }
}

#[derive(Debug, Deserialize)]
struct FfprobeJson {
    format: Option<FfFormat>,
    streams: Option<Vec<FfStream>>,
}

#[derive(Debug, Deserialize)]
struct FfFormat {
    duration: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    duration: Option<String>,
}
