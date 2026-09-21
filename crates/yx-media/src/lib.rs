//! FFmpeg-backed media I/O.
//!
//! Phase 1 uses the FFmpeg CLI so we do not need to link libav at build time.
//! In-process `ffmpeg-next` can be added later for frame-accurate scrubbing.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;
use yx_detect::{command_ffmpeg, command_ffprobe, PerformancePolicy, PerformanceTier};

#[derive(Debug, Error)]
pub enum MediaError {
    #[error("ffmpeg is not available on PATH")]
    FfmpegMissing,
    #[error("ffprobe failed: {0}")]
    ProbeFailed(String),
    #[error("ffmpeg failed: {0}")]
    FfmpegFailed(String),
    #[error("cancelled")]
    Cancelled,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

pub mod magic;
pub mod region;

/// Label uniquer for branching filter_complex fragments (bgmask etc.) —
/// labels are graph-global across all clip fragments.
static FRAG_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportCodec {
    H264,
    H265,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFit {
    /// Letterbox / pillarbox to exact size.
    Contain,
    /// Crop to fill the frame.
    Cover,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
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

/// One trimmed media segment on the edited timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportSegment {
    pub path: PathBuf,
    pub in_point: f64,
    pub out_point: f64,
    /// Absolute timeline position (seconds) where this segment begins.
    #[serde(default)]
    pub start: f64,
    /// Fade-in duration from segment start (seconds).
    #[serde(default)]
    pub fade_in: f64,
    /// Fade-out duration before segment end (seconds).
    #[serde(default)]
    pub fade_out: f64,
    /// Play segment media backward (FFmpeg `reverse` after trim / setpts).
    #[serde(default)]
    pub reverse: bool,
    /// Playback rate (1.0 = normal). Timeline/export duration is `(out-in)/speed`.
    #[serde(default = "default_export_speed")]
    pub speed: f64,
    /// Ordered effect stack copied from the clip (WYSIWYG with preview).
    #[serde(default)]
    pub filters: Vec<ExportFilter>,
    /// Still image (png/jpg/webp/bmp/gif): decoded with `-loop 1 -t dur`.
    #[serde(default)]
    pub is_image: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportFilter {
    pub kind: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub params: serde_json::Value,
}

fn default_true() -> bool {
    true
}

fn default_export_speed() -> f64 {
    1.0
}

impl ExportSegment {
    pub fn clamped_speed(&self) -> f64 {
        if self.speed.is_finite() {
            self.speed.clamp(0.25, 4.0)
        } else {
            1.0
        }
    }

    pub fn duration(&self) -> f64 {
        let media = (self.out_point - self.in_point).max(0.0);
        media / self.clamped_speed()
    }

    pub fn end(&self) -> f64 {
        self.start + self.duration()
    }
}

/// Build FFmpeg video filter pieces (no labels) from the effect stack + fades.
/// Applied after decode trim, before setpts/overlay.
/// Resolve a usable TrueType font for FFmpeg `drawtext` and escape it for a
/// filtergraph string. Windows fonts need `:` escaped inside filters.
fn resolve_fontfile() -> Option<String> {
    let candidates = [
        r"C:\Windows\Fonts\arial.ttf".to_string(),
        r"C:\Windows\Fonts\segoeui.ttf".to_string(),
        r"C:\Windows\Fonts\calibri.ttf".to_string(),
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf".to_string(),
        "/usr/share/fonts/truetype/freefont/FreeSans.ttf".to_string(),
        "/System/Library/Fonts/Supplemental/Arial.ttf".to_string(),
    ];
    candidates
        .iter()
        .find(|c| std::path::Path::new(c).is_file())
        .map(|c| c.replace('\\', "/").replace(':', "\\:"))
}

/// Escape a drawtext text payload for a filtergraph string.
fn escape_drawtext(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace('\'', "\\\'")
        .replace('%', "\\%")
}

/// Normalize a frontend color (#RRGGBB, #RRGGBBAA, or a named color) to an
/// FFmpeg color string.
fn ffmpeg_color(v: &str, default: &str) -> String {
    let v = v.trim();
    if v.is_empty() {
        return default.to_string();
    }
    match v.strip_prefix('#') {
        Some(hex) => format!("#{hex}"),
        None => v.to_string(),
    }
}

pub fn build_video_effect_chain(seg: &ExportSegment, frame_w: u32, frame_h: u32) -> String {
    let mut parts: Vec<String> = Vec::new();
    let fw = frame_w.max(2) as f64;
    let fh = frame_h.max(2) as f64;

    for f in &seg.filters {
        if !f.enabled {
            continue;
        }
        let p = &f.params;
        match f.kind.as_str() {
            "crop" => {
                let left = num(p, "left", 0.0).clamp(0.0, 0.49);
                let top = num(p, "top", 0.0).clamp(0.0, 0.49);
                let right = num(p, "right", 0.0).clamp(0.0, 0.49);
                let bottom = num(p, "bottom", 0.0).clamp(0.0, 0.49);
                if left + right + top + bottom > 1e-6 {
                    let w = (1.0 - left - right).max(0.02);
                    let h = (1.0 - top - bottom).max(0.02);
                    // Crop the source to the selected region, then scale it to
                    // FIT the output canvas preserving the region's own aspect
                    // (orientation-aware: a vertical crop stays vertical, a
                    // horizontal crop stays horizontal — never stretched),
                    // centered on a black canvas.
                    parts.push(format!(
                        "crop=iw*{w:.6}:ih*{h:.6}:iw*{left:.6}:ih*{top:.6},scale={fw}:{fh}:force_original_aspect_ratio=decrease:flags=lanczos,pad={fw}:{fh}:(ow-iw)/2:(oh-ih)/2:color=black",
                        fw = frame_w.max(2) & !1,
                        fh = frame_h.max(2) & !1,
                    ));
                }
            }
            "exposure" => {
                let amount = num(p, "amount", 0.0).clamp(-1.0, 1.0);
                if amount.abs() > 1e-4 {
                    // Map -1..1 → brightness-ish for eq
                    parts.push(format!("eq=brightness={amount:.4}"));
                }
            }
            "contrast" => {
                let amount = num(p, "amount", 1.0).clamp(0.0, 3.0);
                if (amount - 1.0).abs() > 1e-4 {
                    parts.push(format!("eq=contrast={amount:.4}"));
                }
            }
            "saturation" => {
                let amount = num(p, "amount", 1.0).clamp(0.0, 3.0);
                if (amount - 1.0).abs() > 1e-4 {
                    parts.push(format!("eq=saturation={amount:.4}"));
                }
            }
            "blur" => {
                let radius = num(p, "radius", 0.0).clamp(0.0, 40.0);
                if radius > 0.05 {
                    let r = radius.round().max(1.0) as i32;
                    parts.push(format!("boxblur={r}:{r}"));
                }
            }
            "flip" => {
                if bool_p(p, "horizontal", false) {
                    parts.push("hflip".into());
                }
                if bool_p(p, "vertical", false) {
                    parts.push("vflip".into());
                }
            }
            "temperature" => {
                let kelvin = num(p, "kelvin", 6500.0).clamp(1500.0, 40000.0);
                if (kelvin - 6500.0).abs() > 1.0 {
                    parts.push(format!("colortemperature=temperature={kelvin:.0}"));
                }
            }
            "hue" => {
                let degrees = num(p, "degrees", 0.0).clamp(-180.0, 180.0);
                if degrees.abs() > 0.05 {
                    parts.push(format!("hue=h={degrees:.2}"));
                }
            }
            "vignette" => {
                let amount = num(p, "amount", 0.0).clamp(0.0, 1.0);
                if amount > 0.01 {
                    // FFmpeg vignette angle: PI/5 default; stronger angle = darker.
                    let angle = 0.2 + amount * 1.0;
                    parts.push(format!("vignette=angle=PI*{angle:.3}/5"));
                }
            }
            "sharpen" => {
                let amount = num(p, "amount", 0.0).clamp(0.0, 3.0);
                if amount > 0.01 {
                    parts.push(format!("unsharp=5:5:{amount:.3}:5:5:0.0"));
                }
            }
            "vdenoise" => {
                let amount = num(p, "amount", 0.0).clamp(0.0, 10.0);
                if amount > 0.01 {
                    let amount2 = amount * 0.75;
                    parts.push(format!("hqdn3d={amount:.1}:{amount2:.1}:6:4.5"));
                }
            }
            "stabilize" => {
                let strength = num(p, "strength", 0.0).clamp(0.0, 256.0);
                if strength > 1.0 {
                    let rx = strength.clamp(16.0, 256.0) as i32;
                    parts.push(format!("deshake=rx={rx}:ry={rx}:edge=mirror"));
                }
            }
            "lut" | "lut3d" => {
                let lut_path = p
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !lut_path.is_empty() {
                    let escaped = lut_path
                        .replace('\\', "/")
                        .replace(':', "\\:")
                        .replace('\'', "\\'");
                    parts.push(format!("lut3d=file='{escaped}'"));
                }
            }
            "text" => {
                let text = p.get("text").and_then(|v| v.as_str()).unwrap_or("");
                if !text.trim().is_empty() {
                    let font = resolve_fontfile()
                        .unwrap_or_else(|| "C\\:/Windows/Fonts/arial.ttf".to_string());
                    let size_pct = num(p, "size", 6.0).clamp(1.0, 30.0);
                    let color = p
                        .get("color")
                        .and_then(|v| v.as_str())
                        .unwrap_or("#ffffff")
                        .trim_start_matches('#')
                        .to_string();
                    let x = num(p, "x", 0.0).clamp(-1.0, 1.0);
                    let y = num(p, "y", 0.0).clamp(-1.0, 1.0);
                    let boxed = bool_p(p, "box", true);
                    let payload = escape_drawtext(text);
                    let mut dt = format!(
                        "drawtext=fontfile='{font}':text='{payload}':fontsize='h*{size_pct:.2}/100':fontcolor=#{color}:x='(w/2)-(tw/2)+({x:.4}*w/2)':y='(h/2)-(th/2)+({y:.4}*h/2)'"
                    );
                    if boxed {
                        let boxcolor = ffmpeg_color(
                            p.get("boxcolor")
                                .and_then(|v| v.as_str())
                                .unwrap_or("#00000073"),
                            "black@0.45",
                        );
                        let boxborderw =
                            num(p, "boxborderw", 14.0).clamp(0.0, 200.0).round() as i32;
                        dt.push_str(&format!(
                            ":box=1:boxcolor={boxcolor}:boxborderw={boxborderw}"
                        ));
                    }
                    let borderw = num(p, "borderw", 0.0).clamp(0.0, 60.0).round() as i32;
                    if borderw >= 1 {
                        let bordercolor = ffmpeg_color(
                            p.get("bordercolor")
                                .and_then(|v| v.as_str())
                                .unwrap_or("#000000"),
                            "black",
                        );
                        dt.push_str(&format!(":borderw={borderw}:bordercolor={bordercolor}"));
                    }
                    if bool_p(p, "shadow", true) {
                        dt.push_str(":shadowcolor=black@0.55:shadowx=4:shadowy=4");
                    }
                    parts.push(dt);
                }
            }
            "transition" => {
                let t_kind = p
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("dissolve")
                    .to_string();
                let dur = num(p, "duration", 0.5).clamp(0.1, 5.0);
                if t_kind == "dissolve" {
                    // Alpha fade-in over the overlap; the overlay chain blends
                    // this clip over the previous one = cross dissolve.
                    parts.push(format!("format=yuva420p,fade=t=in:st=0:d={dur:.3}:alpha=1"));
                }
            }
            "chromakey" => {
                let color = p
                    .get("color")
                    .and_then(|v| v.as_str())
                    .unwrap_or("0x00FF00");
                let hex = color.trim_start_matches('#');
                let similarity = num(p, "similarity", 0.3).clamp(0.01, 1.0);
                let blend = num(p, "blend", 0.1).clamp(0.0, 1.0);
                parts.push(format!(
                    "chromakey=0x{hex}:similarity={similarity:.4}:blend={blend:.4}"
                ));
                // Spill suppression (BG Key tool): despill the surviving
                // foreground with the dominant key channel.
                let spill = num(p, "spill", 0.0).clamp(0.0, 1.0);
                if spill > 0.01 {
                    let kr = u8::from_str_radix(hex.get(0..2).unwrap_or("00"), 16).unwrap_or(0);
                    let kg = u8::from_str_radix(hex.get(2..4).unwrap_or("ff"), 16).unwrap_or(255);
                    let kb = u8::from_str_radix(hex.get(4..6).unwrap_or("00"), 16).unwrap_or(0);
                    let despill_type = if kg >= kr && kg >= kb {
                        "green"
                    } else {
                        "blue"
                    };
                    parts.push(format!("despill=type={despill_type}:mix={spill:.4}"));
                }
            }
            "bgmask" => {
                // Select-area removal: the alpha mask (rect/ellipse/lasso
                // shapes with feather + invert, rasterized by the UI) ships as
                // a PNG so preview and export share the exact same mask.
                let mask_path = p
                    .get("maskPath")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !mask_path.is_empty() && Path::new(&mask_path).is_file() {
                    let escaped = mask_path
                        .replace('\\', "/")
                        .replace(':', "\\:")
                        .replace('\'', "\\'");
                    let k = FRAG_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    parts.push(format!(
                        "format=rgba[bgs{k}];movie='{escaped}',scale={fw:.0}:{fh:.0},format=gray,setsar=1[bgm{k}];[bgs{k}][bgm{k}]alphamerge"
                    ));
                }
            }
            "blurregion" => {
                if let Some(frag) = region::build_region_blur_fragment(
                    p,
                    frame_w.max(2) & !1,
                    frame_h.max(2) & !1,
                    seg.duration(),
                ) {
                    parts.push(frag);
                }
            }
            "transform" => {
                let scale = num(p, "scale", 1.0).clamp(0.05, 8.0);
                let rotation = num(p, "rotation", 0.0);
                let opacity = num(p, "opacity", 1.0).clamp(0.0, 1.0);
                let x = num(p, "x", 0.0); // normalized -1..1 offset of center
                let y = num(p, "y", 0.0);
                if (scale - 1.0).abs() > 1e-4 {
                    parts.push(format!("scale=iw*{scale:.6}:ih*{scale:.6}"));
                }
                let mut rgba = false;
                if rotation.abs() > 1e-3 {
                    // Alpha-aware so rotated corners stay transparent (PiP).
                    parts.push("format=rgba".into());
                    rgba = true;
                    parts.push(format!(
                        "rotate={rotation:.6}*PI/180:ow=rotw({rotation:.6}*PI/180):oh=roth({rotation:.6}*PI/180):c=0x00000000"
                    ));
                }
                // Pad/crop back to frame, positioning via the normalized
                // offset. Transparent padding keeps overlay layers (PiP)
                // compositable; on the base layer the padding is cropped or
                // blends over the black canvas — visually identical.
                if x.abs() > 1e-4
                    || y.abs() > 1e-4
                    || (scale - 1.0).abs() > 1e-4
                    || rotation.abs() > 1e-3
                {
                    let ox = (fw * x * 0.5) as i32;
                    let oy = (fh * y * 0.5) as i32;
                    if !rgba {
                        parts.push("format=rgba".into());
                    }
                    // Zoom (or rotation) can push the frame past the canvas,
                    // and pad errors out on oversized input ("Padded
                    // dimensions cannot be smaller than input dimensions").
                    // Clamp back to the canvas first; the pan offset rides on
                    // this crop when there is overflow and on the pad when
                    // the frame is smaller (zoom-out).
                    parts.push(format!(
                        "crop=w='min(iw,{fw})':h='min(ih,{fh})':x='max(0,min((iw-ow)/2-{ox},iw-ow))':y='max(0,min((ih-oh)/2-{oy},ih-oh))'"
                    ));
                    parts.push(format!(
                        "pad={fw}:{fh}:(ow-iw)/2+{ox}:(oh-ih)/2+{oy}:color=0x00000000"
                    ));
                    parts.push(format!("crop={fw}:{fh}"));
                }
                if opacity < 0.999 {
                    if !rgba {
                        parts.push("format=rgba".into());
                    }
                    parts.push(format!("colorchannelmixer=aa={opacity:.4}"));
                }
            }
            "dream" => {
                let intensity = num(p, "intensity", 0.5).clamp(0.0, 1.0);
                if intensity > 0.01 {
                    let b = intensity * 0.08;
                    let s = 1.0 + intensity * 0.25;
                    parts.push(format!("eq=brightness={b:.3}:saturation={s:.3}"));
                }
            }
            "magic" => {
                let intensity = num(p, "intensity", 0.3).clamp(0.0, 1.0);
                if intensity > 0.01 {
                    let deg = intensity * 120.0;
                    parts.push(format!("hue=h={deg:.1}"));
                }
            }
            "glow" => {
                let intensity = num(p, "intensity", 0.6).clamp(0.0, 1.0);
                if intensity > 0.01 {
                    let b = intensity * 0.12;
                    let c = 1.0 + intensity * 0.1;
                    parts.push(format!("eq=brightness={b:.3}:contrast={c:.3}"));
                }
            }
            "cinematic" => {
                let intensity = num(p, "intensity", 0.5).clamp(0.0, 1.0);
                if intensity > 0.01 {
                    let c = 1.0 + intensity * 0.2;
                    let s = (1.0 - intensity * 0.15).max(0.1);
                    parts.push(format!("eq=contrast={c:.3}:saturation={s:.3}"));
                }
            }
            "vhs" => {
                let intensity = num(p, "intensity", 5.0).clamp(0.0, 10.0);
                if intensity > 0.01 {
                    parts.push("eq=contrast=1.1:saturation=1.3:gamma_r=1.05:gamma_b=0.95".into());
                }
            }
            _ => {}
        }
    }

    // Speed then reverse (plan): setpts compresses/expands, reverse plays that buffer backward.
    let speed = seg.clamped_speed();
    if (speed - 1.0).abs() > 1e-4 {
        parts.push(format!("setpts=PTS/{speed:.6}"));
    }
    if seg.reverse {
        parts.push("reverse".into());
    }

    let fi = seg.fade_in.max(0.0);
    let fo = seg.fade_out.max(0.0);
    let dur = seg.duration();
    if fi > 1e-4 {
        parts.push(format!("fade=t=in:st=0:d={fi:.6}"));
    }
    if fo > 1e-4 && dur > fo {
        let st = (dur - fo).max(0.0);
        parts.push(format!("fade=t=out:st={st:.6}:d={fo:.6}"));
    }

    parts.join(",")
}

pub fn build_audio_effect_chain(seg: &ExportSegment) -> String {
    let mut parts: Vec<String> = Vec::new();
    for f in &seg.filters {
        if !f.enabled {
            continue;
        }
        match f.kind.as_str() {
            "volume" => {
                let gain = num(&f.params, "gain", 1.0).clamp(0.0, 4.0);
                if (gain - 1.0).abs() > 1e-4 {
                    parts.push(format!("volume={gain:.4}"));
                }
            }
            "equalizer" => {
                let bass = num(&f.params, "bass", 0.0).clamp(-12.0, 12.0);
                let mid = num(&f.params, "mid", 0.0).clamp(-12.0, 12.0);
                let treble = num(&f.params, "treble", 0.0).clamp(-12.0, 12.0);
                if bass.abs() > 0.05 {
                    parts.push(format!("equalizer=f=100:t=q:w=1:g={bass:.2}"));
                }
                if mid.abs() > 0.05 {
                    parts.push(format!("equalizer=f=1000:t=q:w=1:g={mid:.2}"));
                }
                if treble.abs() > 0.05 {
                    parts.push(format!("equalizer=f=8000:t=q:w=1:g={treble:.2}"));
                }
            }
            "compressor" => {
                let thr = num(&f.params, "threshold", -20.0);
                let ratio = num(&f.params, "ratio", 4.0).clamp(1.0, 20.0);
                let attack = num(&f.params, "attack", 20.0).clamp(1.0, 200.0);
                let release = num(&f.params, "release", 250.0).clamp(10.0, 2000.0);
                parts.push(format!(
                    "acompressor=threshold={thr:.1}dB:ratio={ratio:.2}:attack={attack:.1}:release={release:.1}"
                ));
            }
            "highpass" => {
                let freq = num(&f.params, "freq", 120.0).clamp(20.0, 8000.0);
                parts.push(format!("highpass=f={freq:.1}"));
            }
            "lowpass" => {
                let freq = num(&f.params, "freq", 12000.0).clamp(200.0, 20000.0);
                parts.push(format!("lowpass=f={freq:.1}"));
            }
            "gate" => {
                let thr = num(&f.params, "threshold", -40.0);
                let ratio = num(&f.params, "ratio", 10.0).clamp(1.0, 50.0);
                let attack = num(&f.params, "attack", 10.0).clamp(1.0, 200.0);
                let release = num(&f.params, "release", 100.0).clamp(10.0, 2000.0);
                parts.push(format!(
                    "agate=threshold={thr:.1}dB:ratio={ratio:.2}:attack={attack:.1}:release={release:.1}"
                ));
            }
            "denoise" => {
                let nf = num(&f.params, "nf", -25.0).clamp(-80.0, -20.0);
                let nr = num(&f.params, "nr", 12.0).clamp(0.01, 97.0);
                parts.push(format!("afftdn=nf={nf:.1}:nr={nr:.1}"));
            }
            "normalize" => {
                let target = num(&f.params, "target", -16.0).clamp(-30.0, -8.0);
                parts.push(format!("loudnorm=I={target:.1}:TP=-1.5:LRA=11"));
            }
            "deesser" => {
                let amount = num(&f.params, "amount", 0.0).clamp(0.0, 1.0);
                if amount > 0.01 {
                    parts.push(format!("deesser=i={amount:.2}"));
                }
            }
            "limiter" => {
                let limit = num(&f.params, "limit", 0.95).clamp(0.1, 1.0);
                parts.push(format!("alimiter=limit={limit:.3}:level=disabled"));
            }
            "reverb" => {
                let delay = num(&f.params, "delay", 40.0).clamp(1.0, 500.0);
                let decay = num(&f.params, "decay", 0.3).clamp(0.0, 0.9);
                parts.push(format!("aecho=0.8:0.9:{delay:.1}:{decay:.2}"));
            }
            "invert" => {
                parts.push("volume=-1".to_string());
            }
            "pitch" => {
                let st = num(&f.params, "semitones", 0.0).clamp(-12.0, 12.0);
                if st.abs() > 0.05 {
                    let factor = (2.0_f64).powf(st / 12.0);
                    let rate = 48000.0 * factor;
                    let mut tempo = 1.0 / factor;
                    let mut chain = format!("asetrate={rate:.4},aresample=48000");
                    while tempo > 2.0 + 1e-9 {
                        chain.push_str(",atempo=2.0");
                        tempo /= 2.0;
                    }
                    while tempo < 0.5 - 1e-9 {
                        chain.push_str(",atempo=0.5");
                        tempo /= 0.5;
                    }
                    chain.push_str(&format!(",atempo={tempo:.6}"));
                    parts.push(chain);
                }
            }
            _ => {}
        }
    }
    let speed = seg.clamped_speed();
    if (speed - 1.0).abs() > 1e-4 {
        let mut tempo = speed;
        while tempo > 2.0 + 1e-9 {
            parts.push("atempo=2.0".into());
            tempo /= 2.0;
        }
        while tempo < 0.5 - 1e-9 {
            parts.push("atempo=0.5".into());
            tempo /= 0.5;
        }
        if (tempo - 1.0).abs() > 1e-4 {
            parts.push(format!("atempo={tempo:.6}"));
        }
    }
    let fi = seg.fade_in.max(0.0);
    let fo = seg.fade_out.max(0.0);
    let dur = seg.duration();
    if fi > 1e-4 {
        parts.push(format!("afade=t=in:st=0:d={fi:.6}"));
    }
    if fo > 1e-4 && dur > fo {
        let st = (dur - fo).max(0.0);
        parts.push(format!("afade=t=out:st={st:.6}:d={fo:.6}"));
    }
    parts.join(",")
}

fn num(p: &serde_json::Value, key: &str, default: f64) -> f64 {
    p.get(key)
        .and_then(|v| v.as_f64().or_else(|| v.as_i64().map(|i| i as f64)))
        .unwrap_or(default)
}

fn bool_p(p: &serde_json::Value, key: &str, default: bool) -> bool {
    p.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

/// Export the assembled timeline (cuts / splits / trims), not a single source file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineExportRequest {
    pub video: Vec<ExportSegment>,
    pub audio: Vec<ExportSegment>,
    pub output_path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub fps: Option<f64>,
    pub codec: ExportCodec,
    pub x264_preset: String,
    pub crf: Option<u8>,
    pub video_bitrate: Option<String>,
    pub audio_bitrate: String,
    pub fit: ExportFit,
    pub encoder: VideoEncoder,
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

/// True when the file is a still/animated image handled via `<img>` preview
/// and `-loop 1` image inputs at export time.
pub fn is_image_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif")
    )
}

pub fn probe_media(path: &Path) -> Result<MediaInfo, MediaError> {
    ensure_ffmpeg()?;
    let output = command_ffprobe()
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

fn video_scale_chain(
    match_source: bool,
    width: u32,
    height: u32,
    fit: ExportFit,
    fps: Option<f64>,
    overlay: bool,
) -> String {
    let mut filters: Vec<String> = Vec::new();
    if let Some(fps) = fps {
        if fps > 0.0 {
            filters.push(format!("fps={fps}"));
        }
    }
    if overlay {
        // Overlay layers must keep transparent margins so the base shows
        // through: fit inside the frame, pad with transparent, force alpha.
        let w = width.max(2) & !1;
        let h = height.max(2) & !1;
        filters.push(format!(
            "scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba,setsar=1"
        ));
        return filters.join(",");
    }
    if match_source {
        filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2".into());
    } else {
        let w = width.max(2) & !1;
        let h = height.max(2) & !1;
        let scale = match fit {
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
    filters.push("setsar=1".into());
    filters.join(",")
}

fn append_encoder_args(
    args: &mut Vec<String>,
    codec: &ExportCodec,
    encoder: &VideoEncoder,
    x264_preset: &str,
    crf: Option<u8>,
    video_bitrate: &Option<String>,
    audio_bitrate: &str,
    height: u32,
    policy: &PerformancePolicy,
) {
    args.extend([
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        audio_bitrate.to_string(),
        "-movflags".into(),
        "+faststart".into(),
    ]);

    let use_hw = match encoder {
        VideoEncoder::Software => false,
        VideoEncoder::Nvenc | VideoEncoder::Qsv | VideoEncoder::Amf => true,
        VideoEncoder::Auto => policy.prefer_hw_encode,
    };

    let (vcodec, hw_preset) = match (codec, encoder, use_hw) {
        (ExportCodec::H265, VideoEncoder::Nvenc, _)
        | (ExportCodec::H265, VideoEncoder::Auto, true) => ("hevc_nvenc", "p5"),
        (ExportCodec::H265, VideoEncoder::Qsv, _) => ("hevc_qsv", "slow"),
        (ExportCodec::H265, VideoEncoder::Amf, _) => ("hevc_amf", "quality"),
        (ExportCodec::H264, VideoEncoder::Nvenc, _)
        | (ExportCodec::H264, VideoEncoder::Auto, true) => ("h264_nvenc", "p5"),
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
            x264_preset.to_string(),
            "-threads".into(),
            policy.encode_threads.to_string(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]);
        if vcodec == "libx264" {
            args.extend(["-profile:v".into(), "high".into()]);
        }
        if let Some(crf) = crf {
            args.extend(["-crf".into(), crf.to_string()]);
        } else if let Some(br) = video_bitrate {
            args.extend(["-b:v".into(), br.clone()]);
        } else {
            args.extend(["-b:v".into(), bitrate_for_height(height)]);
        }
    } else {
        if !hw_preset.is_empty() {
            args.extend(["-preset".into(), hw_preset.into()]);
        }
        if let Some(br) = video_bitrate {
            args.extend(["-b:v".into(), br.clone()]);
        } else if let Some(crf) = crf {
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
                let base = bitrate_kbps_for_height(height.max(1080));
                let factor = match crf {
                    0..=14 => 1.8,
                    15..=18 => 1.4,
                    19..=22 => 1.1,
                    _ => 0.9,
                };
                args.extend(["-b:v".into(), format!("{}k", (base as f64 * factor) as u32)]);
            }
        } else {
            args.extend(["-b:v".into(), bitrate_for_height(height.max(1080))]);
        }
    }
}

/// Build an FFmpeg CLI export command that prefers hardware encode when policy allows.
pub fn build_export_args(
    req: &ExportRequest,
    policy: &PerformancePolicy,
) -> Result<Vec<String>, MediaError> {
    ensure_ffmpeg()?;

    let vf = video_scale_chain(
        req.match_source,
        req.width,
        req.height,
        req.fit,
        req.fps,
        false,
    );

    let mut args = vec![
        "-y".into(),
        "-i".into(),
        req.input_path.display().to_string(),
        "-vf".into(),
        vf,
    ];

    append_encoder_args(
        &mut args,
        &req.codec,
        &req.encoder,
        &req.x264_preset,
        req.crf,
        &req.video_bitrate,
        &req.audio_bitrate,
        req.height,
        policy,
    );

    args.push(req.output_path.display().to_string());
    Ok(args)
}

/// Build FFmpeg args that place timeline segments at their starts, filling gaps
/// with black / silence so unlink+move stays in sync on export.
pub fn build_timeline_export_args(
    req: &TimelineExportRequest,
    policy: &PerformancePolicy,
) -> Result<Vec<String>, MediaError> {
    ensure_ffmpeg()?;

    if req.video.is_empty() && req.audio.is_empty() {
        return Err(MediaError::FfmpegFailed(
            "timeline has no clips to export".into(),
        ));
    }

    let mut args = vec!["-y".into()];

    for seg in &req.video {
        let dur = seg.duration();
        if dur <= 0.0 {
            return Err(MediaError::FfmpegFailed(
                "video segment has zero duration".into(),
            ));
        }
        if seg.is_image {
            // Still images (and looping GIFs) need an image input, not a seek.
            args.extend([
                "-loop".into(),
                "1".into(),
                "-t".into(),
                format!("{:.6}", dur),
                "-i".into(),
                seg.path.display().to_string(),
            ]);
        } else {
            args.extend([
                "-ss".into(),
                format!("{:.6}", seg.in_point.max(0.0)),
                "-t".into(),
                format!("{:.6}", dur),
                "-i".into(),
                seg.path.display().to_string(),
            ]);
        }
    }

    for seg in &req.audio {
        let dur = seg.duration();
        if dur <= 0.0 {
            return Err(MediaError::FfmpegFailed(
                "audio segment has zero duration".into(),
            ));
        }
        args.extend([
            "-ss".into(),
            format!("{:.6}", seg.in_point.max(0.0)),
            "-t".into(),
            format!("{:.6}", dur),
            "-i".into(),
            seg.path.display().to_string(),
        ]);
    }

    let v_count = req.video.len();
    let a_count = req.audio.len();
    let scale_base = video_scale_chain(
        req.match_source,
        req.width,
        req.height,
        req.fit,
        req.fps,
        false,
    );
    let scale_overlay = video_scale_chain(
        req.match_source,
        req.width,
        req.height,
        req.fit,
        req.fps,
        true,
    );
    let w = req.width.max(2) & !1;
    let h = req.height.max(2) & !1;

    let v_end = req
        .video
        .iter()
        .map(ExportSegment::end)
        .fold(0.0_f64, f64::max);
    let a_end = req
        .audio
        .iter()
        .map(ExportSegment::end)
        .fold(0.0_f64, f64::max);
    let total = v_end.max(a_end).max(0.001);

    let mut fc = String::new();

    // --- Video: black base + overlays at timeline starts ---
    if v_count > 0 {
        fc.push_str(&format!(
            "color=c=black:s={w}x{h}:d={total:.6},format=yuv420p,setsar=1,fps=30[vbase];"
        ));
        let mut prev = "vbase".to_string();
        for (i, seg) in req.video.iter().enumerate() {
            let out = if i + 1 == v_count {
                "vout".to_string()
            } else {
                format!("vbg{i}")
            };
            let effects = build_video_effect_chain(seg, w, h);
            // First video segment = bottom layer; the rest composite on top
            // with alpha so PiP overlays work.
            let scale = if i == 0 { &scale_base } else { &scale_overlay };
            let mut vchain = format!("[{i}:v]{scale}");
            if !effects.is_empty() {
                vchain.push(',');
                vchain.push_str(&effects);
            }
            vchain.push_str(&format!(
                ",setpts=PTS-STARTPTS+{start:.6}/TB[v{i}]",
                start = seg.start.max(0.0),
            ));
            fc.push_str(&format!(
                "{vchain};[{prev}][v{i}]overlay=eof_action=pass:shortest=0[{out}];",
                prev = prev,
                out = out,
            ));
            prev = out;
        }
    } else {
        fc.push_str(&format!(
            "color=c=black:s={w}x{h}:d={total:.6},format=yuv420p,setsar=1[vout];"
        ));
    }

    // --- Audio: silence base + delayed clips, then amix ---
    if a_count > 0 {
        fc.push_str(&format!(
            "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:{total:.6},asetpts=PTS-STARTPTS[abase];"
        ));
        for (i, seg) in req.audio.iter().enumerate() {
            let idx = v_count + i;
            let delay_ms = (seg.start.max(0.0) * 1000.0).round().max(0.0) as u64;
            let effects = build_audio_effect_chain(seg);
            let mut achain = format!(
                "[{idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS"
            );
            if !effects.is_empty() {
                achain.push(',');
                achain.push_str(&effects);
            }
            achain.push_str(&format!(
                ",adelay={delay_ms}|{delay_ms},apad=whole_dur={total:.6}[a{i}];"
            ));
            fc.push_str(&achain);
        }
        let n = a_count + 1;
        let mut labels = String::from("[abase]");
        for i in 0..a_count {
            labels.push_str(&format!("[a{i}]"));
        }
        fc.push_str(&format!(
            "{labels}amix=inputs={n}:duration=longest:dropout_transition=0:normalize=0,atrim=0:{total:.6},asetpts=PTS-STARTPTS[aout]"
        ));
    } else {
        fc.push_str(&format!(
            "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:{total:.6},asetpts=PTS-STARTPTS[aout]"
        ));
    }

    // Trim trailing semicolon on video-only branch before audio append.
    if fc.ends_with(';') && a_count == 0 {
        // video already ended with ; then we appended anullsrc — fine
    }

    args.extend([
        "-filter_complex".into(),
        fc,
        "-map".into(),
        "[vout]".into(),
        "-map".into(),
        "[aout]".into(),
        "-t".into(),
        format!("{total:.6}"),
    ]);

    append_encoder_args(
        &mut args,
        &req.codec,
        &req.encoder,
        &req.x264_preset,
        req.crf,
        &req.video_bitrate,
        &req.audio_bitrate,
        req.height,
        policy,
    );

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
/// `cancel` is polled between progress lines — when set, the child is killed
/// and `MediaError::Cancelled` is returned (never retried with software
/// fallback). The child is also killed if the handle drops on any error path.
pub fn export_file_with_progress<F>(
    req: &ExportRequest,
    policy: &PerformancePolicy,
    duration_secs: f64,
    cancel: Option<&std::sync::atomic::AtomicBool>,
    mut on_progress: F,
) -> Result<(), MediaError>
where
    F: FnMut(f64),
{
    let mut args = build_export_args(req, policy)?;
    inject_progress_flags(&mut args);

    match run_ffmpeg_progress(&args, duration_secs, cancel, &mut on_progress) {
        Ok(()) => Ok(()),
        Err(MediaError::Cancelled) => Err(MediaError::Cancelled),
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
            run_ffmpeg_progress(&soft_args, duration_secs, cancel, &mut on_progress)
        }
    }
}

pub fn export_timeline_with_progress<F>(
    req: &TimelineExportRequest,
    policy: &PerformancePolicy,
    duration_secs: f64,
    cancel: Option<&std::sync::atomic::AtomicBool>,
    mut on_progress: F,
) -> Result<(), MediaError>
where
    F: FnMut(f64),
{
    let mut args = build_timeline_export_args(req, policy)?;
    inject_progress_flags(&mut args);

    match run_ffmpeg_progress(&args, duration_secs, cancel, &mut on_progress) {
        Ok(()) => Ok(()),
        Err(MediaError::Cancelled) => Err(MediaError::Cancelled),
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
            let mut soft_args = build_timeline_export_args(&soft_req, policy)?;
            inject_progress_flags(&mut soft_args);
            on_progress(0.0);
            run_ffmpeg_progress(&soft_args, duration_secs, cancel, &mut on_progress)
        }
    }
}

pub fn export_file(req: &ExportRequest, policy: &PerformancePolicy) -> Result<(), MediaError> {
    let duration = probe_media(&req.input_path)
        .map(|i| i.duration)
        .unwrap_or(0.0);
    export_file_with_progress(req, policy, duration, None, |_| {})
}

/// RAII guard that kills the ffmpeg child on drop (same pattern as
/// magic.rs's FrameReader): error paths and cancellation must never leak a
/// running encoder process holding the output file open.
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

fn run_ffmpeg_progress<F>(
    args: &[String],
    duration_secs: f64,
    cancel: Option<&std::sync::atomic::AtomicBool>,
    on_progress: &mut F,
) -> Result<(), MediaError>
where
    F: FnMut(f64),
{
    use std::io::{BufRead, BufReader, Read};
    use std::process::Stdio;
    use std::sync::atomic::Ordering;
    use std::thread;

    // KillOnDrop guard: an early return (read error, cancel) must never leak
    // a running ffmpeg child holding the output file open. The guard is
    // disarmed after the explicit wait below.
    let mut child = KillOnDrop(
        command_ffmpeg()
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| MediaError::FfmpegFailed(e.to_string()))?,
    );

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
        if let Some(flag) = cancel {
            if flag.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(MediaError::Cancelled);
            }
        }
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
    let ok = command_ffmpeg()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_policy() -> PerformancePolicy {
        PerformancePolicy {
            tier: PerformanceTier::Medium,
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
    fn timeline_export_args_trim_and_concat() {
        if ensure_ffmpeg().is_err() {
            return;
        }
        let req = TimelineExportRequest {
            video: vec![
                ExportSegment {
                    is_image: false,
                    path: PathBuf::from("a.mp4"),
                    in_point: 0.0,
                    out_point: 2.5,
                    start: 0.0,
                    fade_in: 0.0,
                    fade_out: 0.0,
                    reverse: false,
                    speed: 1.0,
                    filters: vec![],
                },
                ExportSegment {
                    is_image: false,
                    path: PathBuf::from("a.mp4"),
                    in_point: 5.0,
                    out_point: 8.0,
                    start: 2.5,
                    fade_in: 0.0,
                    fade_out: 0.0,
                    reverse: false,
                    speed: 1.0,
                    filters: vec![],
                },
            ],
            audio: vec![
                ExportSegment {
                    is_image: false,
                    path: PathBuf::from("a.mp4"),
                    in_point: 0.0,
                    out_point: 2.5,
                    start: 0.0,
                    fade_in: 0.0,
                    fade_out: 0.0,
                    reverse: false,
                    speed: 1.0,
                    filters: vec![],
                },
                ExportSegment {
                    is_image: false,
                    path: PathBuf::from("a.mp4"),
                    in_point: 5.0,
                    out_point: 8.0,
                    start: 2.5,
                    fade_in: 0.0,
                    fade_out: 0.0,
                    reverse: false,
                    speed: 1.0,
                    filters: vec![],
                },
            ],
            output_path: PathBuf::from("out.mp4"),
            width: 1920,
            height: 1080,
            fps: None,
            codec: ExportCodec::H264,
            x264_preset: "fast".into(),
            crf: Some(18),
            video_bitrate: None,
            audio_bitrate: "192k".into(),
            fit: ExportFit::Contain,
            encoder: VideoEncoder::Software,
            match_source: true,
        };

        let args = build_timeline_export_args(&req, &test_policy()).expect("args");
        let joined = args.join(" ");
        assert!(joined.contains("-ss"));
        assert!(joined.contains("color=c=black"));
        assert!(joined.contains("overlay="));
        assert!(joined.contains("anullsrc"));
        assert!(joined.contains("adelay="));
        assert!(joined.contains("[vout]"));
        assert!(joined.contains("[aout]"));
        assert_eq!(args.last().map(String::as_str), Some("out.mp4"));
    }

    #[test]
    fn timeline_export_respects_audio_start_gap() {
        if ensure_ffmpeg().is_err() {
            return;
        }
        let req = TimelineExportRequest {
            video: vec![ExportSegment {
                is_image: false,
                path: PathBuf::from("v.mp4"),
                in_point: 0.0,
                out_point: 5.0,
                start: 0.0,
                fade_in: 0.0,
                fade_out: 0.0,
                reverse: false,
                speed: 1.0,
                filters: vec![],
            }],
            audio: vec![ExportSegment {
                is_image: false,
                path: PathBuf::from("a.mp4"),
                in_point: 0.0,
                out_point: 3.0,
                start: 2.0,
                fade_in: 0.0,
                fade_out: 0.0,
                reverse: false,
                speed: 1.0,
                filters: vec![],
            }],
            output_path: PathBuf::from("gap.mp4"),
            width: 1280,
            height: 720,
            fps: Some(30.0),
            codec: ExportCodec::H264,
            x264_preset: "ultrafast".into(),
            crf: Some(23),
            video_bitrate: None,
            audio_bitrate: "128k".into(),
            fit: ExportFit::Contain,
            encoder: VideoEncoder::Software,
            match_source: false,
        };
        let args = build_timeline_export_args(&req, &test_policy()).expect("args");
        let joined = args.join(" ");
        assert!(
            joined.contains("adelay=2000|2000"),
            "expected 2s audio delay: {joined}"
        );
        assert!(joined.contains("color=c=black"));
        assert!(joined.contains("amix="));
    }

    #[test]
    fn timeline_export_includes_fade_filters() {
        if ensure_ffmpeg().is_err() {
            return;
        }
        let req = TimelineExportRequest {
            video: vec![ExportSegment {
                is_image: false,
                path: PathBuf::from("v.mp4"),
                in_point: 0.0,
                out_point: 5.0,
                start: 0.0,
                fade_in: 0.5,
                fade_out: 1.0,
                reverse: false,
                speed: 1.0,
                filters: vec![],
            }],
            audio: vec![ExportSegment {
                is_image: false,
                path: PathBuf::from("a.mp4"),
                in_point: 0.0,
                out_point: 5.0,
                start: 0.0,
                fade_in: 0.25,
                fade_out: 0.75,
                reverse: false,
                speed: 1.0,
                filters: vec![],
            }],
            output_path: PathBuf::from("fade.mp4"),
            width: 1280,
            height: 720,
            fps: Some(30.0),
            codec: ExportCodec::H264,
            x264_preset: "ultrafast".into(),
            crf: Some(23),
            video_bitrate: None,
            audio_bitrate: "128k".into(),
            fit: ExportFit::Contain,
            encoder: VideoEncoder::Software,
            match_source: false,
        };
        let args = build_timeline_export_args(&req, &test_policy()).expect("args");
        let joined = args.join(" ");
        assert!(joined.contains("fade=t=in"), "{joined}");
        assert!(joined.contains("fade=t=out"), "{joined}");
        assert!(joined.contains("afade=t=in"), "{joined}");
        assert!(joined.contains("afade=t=out"), "{joined}");
    }

    #[test]
    fn effect_chain_includes_eq_blur_crop_key() {
        let seg = ExportSegment {
            is_image: false,
            path: PathBuf::from("v.mp4"),
            in_point: 0.0,
            out_point: 4.0,
            start: 0.0,
            fade_in: 0.0,
            fade_out: 0.0,
            reverse: false,
            speed: 1.0,
            filters: vec![
                ExportFilter {
                    kind: "crop".into(),
                    enabled: true,
                    params: serde_json::json!({"left":0.1,"top":0.1,"right":0.1,"bottom":0.1}),
                },
                ExportFilter {
                    kind: "exposure".into(),
                    enabled: true,
                    params: serde_json::json!({"amount":0.2}),
                },
                ExportFilter {
                    kind: "blur".into(),
                    enabled: true,
                    params: serde_json::json!({"radius":4.0}),
                },
                ExportFilter {
                    kind: "chromakey".into(),
                    enabled: true,
                    params: serde_json::json!({"color":"#00ff00","similarity":0.3,"blend":0.1}),
                },
            ],
        };
        let chain = build_video_effect_chain(&seg, 1920, 1080);
        assert!(chain.contains("crop="), "{chain}");
        assert!(chain.contains("eq=brightness"), "{chain}");
        assert!(chain.contains("boxblur="), "{chain}");
        assert!(chain.contains("chromakey="), "{chain}");
    }

    #[test]
    fn video_effect_chain_transform_zoom_clamps_before_pad() {
        // Zoom-in (>1) makes the frame larger than the canvas; pad errors on
        // oversized input, so a clamp crop must come first.
        let seg = ExportSegment {
            is_image: false,
            path: PathBuf::from("v.mp4"),
            in_point: 0.0,
            out_point: 4.0,
            start: 0.0,
            fade_in: 0.0,
            fade_out: 0.0,
            reverse: false,
            speed: 1.0,
            filters: vec![ExportFilter {
                kind: "transform".into(),
                enabled: true,
                params: serde_json::json!({"scale":1.4,"rotation":0.0,"opacity":1.0,"x":0.01,"y":-0.02}),
            }],
        };
        let chain = build_video_effect_chain(&seg, 1920, 1080);
        let clamp = chain
            .find("crop=w='min(iw,1920)'")
            .expect("clamp crop before pad");
        let pad = chain.find("pad=1920:1080").expect("pad");
        assert!(clamp < pad, "clamp crop must precede pad: {chain}");
    }

    #[test]
    fn video_effect_chain_includes_reverse() {
        let seg = ExportSegment {
            is_image: false,
            path: PathBuf::from("v.mp4"),
            in_point: 1.0,
            out_point: 3.0,
            start: 0.0,
            fade_in: 0.0,
            fade_out: 0.0,
            reverse: true,
            speed: 1.0,
            filters: vec![],
        };
        let chain = build_video_effect_chain(&seg, 1280, 720);
        assert!(chain.contains("reverse"), "{chain}");
    }

    #[test]
    fn video_effect_chain_includes_setpts_for_speed() {
        let seg = ExportSegment {
            is_image: false,
            path: PathBuf::from("v.mp4"),
            in_point: 0.0,
            out_point: 4.0,
            start: 0.0,
            fade_in: 0.0,
            fade_out: 0.0,
            reverse: false,
            speed: 2.0,
            filters: vec![],
        };
        assert!((seg.duration() - 2.0).abs() < 1e-9);
        let chain = build_video_effect_chain(&seg, 1280, 720);
        assert!(chain.contains("setpts=PTS/2"), "{chain}");
    }

    #[test]
    fn video_effect_chain_speed_then_reverse() {
        let seg = ExportSegment {
            is_image: false,
            path: PathBuf::from("v.mp4"),
            in_point: 0.0,
            out_point: 2.0,
            start: 0.0,
            fade_in: 0.0,
            fade_out: 0.0,
            reverse: true,
            speed: 2.0,
            filters: vec![],
        };
        let chain = build_video_effect_chain(&seg, 1280, 720);
        let setpts = chain.find("setpts=").expect("setpts");
        let rev = chain.find("reverse").expect("reverse");
        assert!(setpts < rev, "setpts before reverse: {chain}");
    }

    #[test]
    fn audio_effect_chain_includes_denoise_and_pitch() {
        let seg = ExportSegment {
            is_image: false,
            path: PathBuf::from("a.wav"),
            in_point: 0.0,
            out_point: 2.0,
            start: 0.0,
            fade_in: 0.0,
            fade_out: 0.0,
            reverse: false,
            speed: 1.0,
            filters: vec![
                ExportFilter {
                    kind: "denoise".into(),
                    enabled: true,
                    params: serde_json::json!({"nf": -25.0, "nr": 12.0}),
                },
                ExportFilter {
                    kind: "pitch".into(),
                    enabled: true,
                    params: serde_json::json!({"semitones": 3.0}),
                },
            ],
        };
        let chain = build_audio_effect_chain(&seg);
        assert!(chain.contains("afftdn="), "{chain}");
        assert!(chain.contains("nf=-25"), "{chain}");
        assert!(chain.contains("asetrate="), "{chain}");
        assert!(chain.contains("atempo="), "{chain}");
    }

    #[test]
    fn denoise_nf_clamped_to_ffmpeg_max() {
        let seg = ExportSegment {
            is_image: false,
            path: PathBuf::from("a.wav"),
            in_point: 0.0,
            out_point: 1.0,
            start: 0.0,
            fade_in: 0.0,
            fade_out: 0.0,
            reverse: false,
            speed: 1.0,
            filters: vec![ExportFilter {
                kind: "denoise".into(),
                enabled: true,
                params: serde_json::json!({"nf": -5.0, "nr": 10.0}),
            }],
        };
        let chain = build_audio_effect_chain(&seg);
        assert!(chain.contains("nf=-20"), "{chain}");
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
