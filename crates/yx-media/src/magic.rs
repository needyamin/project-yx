//! Magic Remove / AI Eraser — brush-mask tracking + video inpainting.
//!
//! Pipeline (all FFmpeg CLI, no libav linking, mirroring the rest of yx-media):
//! 1. `track_mask` decodes grayscale proxy frames around the anchor, then
//!    template-tracks the brushed mask region forward/backward, emitting
//!    per-time translation keyframes (normalized offsets).
//! 2. `render_inpaint` decodes full-resolution RGB frames, rebuilds the
//!    feathered mask per frame from the strokes + keyframes, reconstructs the
//!    covered background (temporal samples from frames where the pixel was
//!    unmasked, with a boundary pull-in fallback), and encodes a sidecar clip.
//!
//! Everything is non-destructive: the source media is only ever read.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use yx_detect::command_ffmpeg;

use crate::{is_image_path, probe_media};

/// One brush pass over the monitor, in normalized source-frame coordinates
/// (`x` is a fraction of width, `y` of height; `radius` a fraction of height).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MagicStroke {
    pub points: Vec<[f64; 2]>,
    #[serde(default)]
    pub radius: f64,
    /// Eraser strokes carve back out of the mask.
    #[serde(default)]
    pub erase: bool,
}

/// Mask translation at time `t`: `dx`/`dy` are fractions of frame width/height
/// relative to the stroke coordinates (drawn at the anchor time, offset 0).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct MagicKeyframe {
    pub t: f64,
    pub dx: f64,
    pub dy: f64,
    #[serde(default)]
    pub manual: bool,
}

/// A fully-specified Magic Remove job (parsed from filter params).
#[derive(Debug, Clone)]
pub struct MagicJob {
    pub source: PathBuf,
    pub strokes: Vec<MagicStroke>,
    pub keyframes: Vec<MagicKeyframe>,
    /// Media time (seconds) where the strokes were drawn.
    pub anchor_time: f64,
    /// Edge softness, fraction of frame height.
    pub feather: f64,
    /// Mask dilation, fraction of frame height.
    pub expand: f64,
    /// "low" | "medium" | "high".
    pub accuracy: String,
    /// 0..1 blend of the reconstructed background over the original.
    pub strength: f64,
    /// Clip-scoped work window in source seconds: only this range of the
    /// media is tracked and rendered into the sidecar (sidecar t=0 is
    /// `scope_in`). `scope_out <= scope_in` means "whole media" — the shape
    /// legacy (unscoped) sidecars and params keep.
    pub scope_in: f64,
    pub scope_out: f64,
}

impl MagicJob {
    /// True when the job is bounded to a sub-range of the source media.
    pub fn is_scoped(&self) -> bool {
        self.scope_out > self.scope_in + 1e-3
    }

    /// Source-media seconds covered by the job (full duration when unscoped).
    fn window(&self, media_duration: f64) -> (f64, f64) {
        if self.is_scoped() {
            (self.scope_in, self.scope_out)
        } else {
            (0.0, media_duration)
        }
    }
}

impl MagicJob {
    pub fn from_params(
        source: &Path,
        params: &serde_json::Value,
        keyframes: Vec<MagicKeyframe>,
    ) -> Result<Self, String> {
        let strokes = params
            .get("strokes")
            .and_then(|v| serde_json::from_value::<Vec<MagicStroke>>(v.clone()).ok())
            .unwrap_or_default();
        if strokes.is_empty() {
            return Err("no mask strokes drawn".into());
        }
        let num = |k: &str, d: f64| -> f64 { params.get(k).and_then(|v| v.as_f64()).unwrap_or(d) };
        let accuracy = params
            .get("trackingAccuracy")
            .and_then(|v| v.as_str())
            .unwrap_or("medium")
            .to_string();
        let anchor_time = num("anchorTime", 0.0).max(0.0);
        // Clip-scoped work window (frontend stores the clip's in/out source
        // times). Degenerate ranges fall back to "whole media".
        let sin = num("scopeIn", 0.0).max(0.0);
        let sout = num("scopeOut", 0.0).max(0.0);
        let (scope_in, scope_out) = if sout > sin + 1e-3 {
            (sin, sout)
        } else {
            (0.0, 0.0)
        };
        Ok(Self {
            source: source.to_path_buf(),
            strokes,
            keyframes,
            anchor_time,
            feather: num("feather", 0.008).clamp(0.0, 0.05),
            expand: num("expand", 0.004).clamp(0.0, 0.02),
            accuracy,
            strength: num("removalStrength", 100.0).clamp(0.0, 100.0) / 100.0,
            scope_in,
            scope_out,
        })
    }

    /// Stable hash for the sidecar cache key.
    pub fn cache_hash(&self, include_keyframes: bool) -> u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        "magic_v3".hash(&mut h);
        self.source.display().to_string().hash(&mut h);
        for s in &self.strokes {
            for p in &s.points {
                ((p[0] * 4096.0).round() as i64).hash(&mut h);
                ((p[1] * 4096.0).round() as i64).hash(&mut h);
            }
            ((s.radius * 4096.0).round() as i64).hash(&mut h);
            s.erase.hash(&mut h);
        }
        if include_keyframes {
            for k in &self.keyframes {
                ((k.t * 1000.0).round() as i64).hash(&mut h);
                ((k.dx * 8192.0).round() as i64).hash(&mut h);
                ((k.dy * 8192.0).round() as i64).hash(&mut h);
            }
        }
        ((self.anchor_time * 1000.0).round() as i64).hash(&mut h);
        ((self.feather * 4096.0).round() as i64).hash(&mut h);
        ((self.expand * 4096.0).round() as i64).hash(&mut h);
        self.accuracy.hash(&mut h);
        ((self.strength * 100.0).round() as i64).hash(&mut h);
        // The scope bounds the rendered window, so it is part of the result
        // identity: same mask on a different clip range = a different sidecar.
        ((self.scope_in * 1000.0).round() as i64).hash(&mut h);
        ((self.scope_out * 1000.0).round() as i64).hash(&mut h);
        h.finish()
    }
}

fn cancelled(cancel: Option<&AtomicBool>) -> bool {
    cancel.map(|c| c.load(Ordering::Relaxed)).unwrap_or(false)
}

/* ------------------------------------------------------------------ */
/* Region tracking (Blur tool auto-track)                              */
/* ------------------------------------------------------------------ */

/// Blur tool auto-track input: the rectangular region (normalized center +
/// size) at the anchor, plus the clip-scoped source window.
#[derive(Debug, Clone)]
pub struct RegionTrackParams {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Clip-local source time where the region currently sits.
    pub anchor_time: f64,
    pub scope_in: f64,
    pub scope_out: f64,
    pub accuracy: String,
}

/// Template-track the content under a rectangular region across the clip
/// (same SAD machinery as the Magic Remove mask tracker) and return
/// translation keyframes — `dx`/`dy` are normalized offsets from the anchor
/// position, `t` is clip-local source time (0 = scope start). The caller
/// stores them as position keyframes `x = anchorX + dx, y = anchorY + dy`.
pub fn track_region(
    source: &Path,
    p: &RegionTrackParams,
    cancel: Option<&AtomicBool>,
    progress: &dyn Fn(f64, &str),
) -> Result<Vec<MagicKeyframe>, String> {
    if is_image_path(source) {
        return Ok(vec![]);
    }
    let info = probe_media(source).map_err(|e| e.to_string())?;
    if !info.has_video || info.width < 8 || info.height < 8 {
        return Err("source has no video track".into());
    }
    let fps = if info.frame_rate > 0.1 {
        info.frame_rate
    } else {
        30.0
    };
    let total = info.duration.max(0.1);
    let total_frames = ((total * fps).ceil() as i64).max(1);
    let scope_in = p.scope_in.max(0.0);
    let scope_out = if p.scope_out > scope_in + 1e-3 {
        p.scope_out.min(total)
    } else {
        total
    };
    let start_idx = ((scope_in * fps).floor() as i64).clamp(0, total_frames - 1);
    let end_idx = ((scope_out * fps).ceil() as i64).clamp(start_idx + 1, total_frames);
    let anchor_local = p.anchor_time.clamp(0.0, scope_out - scope_in);
    let anchor_abs = scope_in + anchor_local;
    let anchor_idx = ((anchor_abs * fps).round() as i64).clamp(start_idx, end_idx - 1);
    let (tw, th) = track_scale(info.width, info.height);
    let (radius, coarse) = search_window(&p.accuracy);
    let back_window: i64 = ((45.0 * fps).round() as i64)
        .min(anchor_idx - start_idx)
        .max(0);

    let mut reader = FrameReader::spawn(
        source,
        &["-ss", &format!("{anchor_abs:.3}")],
        "gray",
        Some((tw, th)),
    )?;
    let mut gray = Vec::new();
    if !reader.next_frame(&mut gray)? {
        return Err("could not decode anchor frame".into());
    }
    if cancelled(cancel) {
        return Err("cancelled".into());
    }

    // Template: pixels sampled on a stride inside the region rect (keeps the
    // SAD cost flat for huge regions) at the anchor frame.
    let tw_i = tw as usize;
    let th_i = th as usize;
    let x0 = ((p.x - p.w / 2.0).clamp(0.0, 1.0) * tw as f64).round() as usize;
    let y0 = ((p.y - p.h / 2.0).clamp(0.0, 1.0) * th as f64).round() as usize;
    let x1 = ((p.x + p.w / 2.0).clamp(0.0, 1.0) * tw as f64).round() as usize;
    let y1 = ((p.y + p.h / 2.0).clamp(0.0, 1.0) * th as f64).round() as usize;
    let rx = x1.saturating_sub(x0).max(2);
    let ry = y1.saturating_sub(y0).max(2);
    let stride = ((rx * ry) as f64 / 2500.0).sqrt().ceil().max(1.0) as usize;
    let mut pos: Vec<(usize, usize)> = Vec::new();
    let mut tpl: Vec<u8> = Vec::new();
    let mut y = y0;
    while y < y1.min(th_i) {
        let mut x = x0;
        while x < x1.min(tw_i) {
            pos.push((x, y));
            tpl.push(gray[y * tw_i + x]);
            x += stride;
        }
        y += stride;
    }
    if pos.len() < 24 {
        return Err("region is too small to track — make the blur region larger".into());
    }

    let mut offsets: HashMap<i64, (i64, i64)> = HashMap::new();
    offsets.insert(anchor_idx, (0, 0));

    // Forward pass (same confidence-refresh scheme as the mask tracker).
    let mut off = (0i64, 0i64);
    let mut idx = anchor_idx;
    let mut refresh = tpl.clone();
    let mut since_refresh = 0usize;
    while reader.next_frame(&mut gray)? {
        idx += 1;
        if cancelled(cancel) {
            return Err("cancelled".into());
        }
        off = track_step(&refresh, &pos, tw_i, th_i, &gray, off, radius, coarse);
        offsets.insert(idx, off);
        let cur_sad = sad_at(&refresh, &pos, tw_i, th_i, &gray, off.0, off.1);
        let conf = (pos.len() as u64) * 12;
        since_refresh += 1;
        if cur_sad < conf && since_refresh > (fps * 1.5).round() as usize {
            for (i, &(px, py)) in pos.iter().enumerate() {
                let nx = px as i64 + off.0;
                let ny = py as i64 + off.1;
                if nx >= 0 && ny >= 0 && nx < tw as i64 && ny < th as i64 {
                    refresh[i] = gray[ny as usize * tw_i + nx as usize];
                }
            }
            since_refresh = 0;
        }
        progress(
            ((idx - anchor_idx) as f64 / (end_idx - anchor_idx).max(1) as f64 * 0.5).min(0.5),
            "tracking",
        );
        if idx + 1 >= end_idx {
            break;
        }
    }
    let fwd_end = idx;
    drop(reader);

    // Backward pass over a bounded window (ring buffer of proxy frames).
    if back_window > 0 {
        let win_start_t = ((anchor_idx - back_window) as f64 / fps).max(0.0);
        let mut reader = FrameReader::spawn(
            source,
            &[
                "-ss",
                &format!("{win_start_t:.3}"),
                "-t",
                &format!("{:.3}", anchor_abs - win_start_t + 0.05),
            ],
            "gray",
            Some((tw, th)),
        )?;
        let mut ring: Vec<Vec<u8>> = Vec::with_capacity(back_window as usize + 1);
        let mut gray = Vec::new();
        while reader.next_frame(&mut gray)? {
            if cancelled(cancel) {
                return Err("cancelled".into());
            }
            ring.push(gray.clone());
            if ring.len() > (back_window + 1) as usize {
                ring.remove(0);
            }
        }
        drop(reader);
        let expected = (back_window + 1) as usize;
        while ring.len() > expected {
            ring.pop();
        }
        let mut off = (0i64, 0i64);
        let mut fi = anchor_idx;
        for frame in ring.iter().rev() {
            offsets.insert(fi, off);
            if fi == 0 {
                break;
            }
            fi -= 1;
            off = track_step(&tpl, &pos, tw_i, th_i, frame, off, radius, coarse);
        }
        if !ring.is_empty() {
            offsets.insert(fi, off);
        }
        progress(0.5, "tracking");
    }

    // Decimate to ~8 Hz, emit as clip-local times (scope start = 0).
    let sample_every = ((fps / 8.0).round() as i64).max(1);
    let mut kf: Vec<MagicKeyframe> = Vec::new();
    let mut sorted: Vec<(i64, (i64, i64))> = offsets.into_iter().collect();
    sorted.sort_by_key(|(i, _)| *i);
    for (i, (dx, dy)) in sorted.iter() {
        if *i % sample_every == 0 || *i == anchor_idx || *i == start_idx || *i == fwd_end {
            kf.push(MagicKeyframe {
                t: (*i as f64 / fps) - scope_in,
                dx: *dx as f64 / tw as f64,
                dy: *dy as f64 / th as f64,
                manual: false,
            });
        }
    }
    kf.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    kf.dedup_by(|a, b| (b.t - a.t).abs() < 1e-4);
    progress(1.0, "tracking");
    Ok(kf)
}

/* ------------------------------------------------------------------ */
/* Mask rasterization                                                  */
/* ------------------------------------------------------------------ */

fn stamp_circle(mask: &mut [bool], w: usize, h: usize, cx: f64, cy: f64, r: i64, val: bool) {
    if r <= 0 || w == 0 || h == 0 {
        return;
    }
    let x0 = (cx - r as f64).floor().max(0.0) as usize;
    let x1 = ((cx + r as f64).ceil() as usize).min(w - 1);
    let y0 = (cy - r as f64).floor().max(0.0) as usize;
    let y1 = ((cy + r as f64).ceil() as usize).min(h - 1);
    let r2 = (r as f64) * (r as f64);
    for y in y0..=y1 {
        let dy = y as f64 - cy;
        for x in x0..=x1 {
            let dx = x as f64 - cx;
            if dx * dx + dy * dy <= r2 {
                mask[y * w + x] = val;
            }
        }
    }
}

/// Rasterize strokes into a binary mask at the given size, translated by
/// (`dx`, `dy`) fractions of width/height.
pub fn rasterize_mask(strokes: &[MagicStroke], w: usize, h: usize, dx: f64, dy: f64) -> Vec<bool> {
    let mut mask = vec![false; w * h];
    for s in strokes {
        let r = ((s.radius.max(0.0015)) * h as f64).round() as i64;
        let stamp = |mask: &mut [bool], px: f64, py: f64| {
            stamp_circle(mask, w, h, px, py, r, !s.erase);
        };
        if s.points.len() == 1 {
            let p = s.points[0];
            stamp(&mut mask, (p[0] + dx) * w as f64, (p[1] + dy) * h as f64);
            continue;
        }
        // Stamp circles densely along the polyline so fast strokes stay solid.
        let step = (r as f64 * 0.4).max(1.0);
        for pair in s.points.windows(2) {
            let (ax, ay) = ((pair[0][0] + dx) * w as f64, (pair[0][1] + dy) * h as f64);
            let (bx, by) = ((pair[1][0] + dx) * w as f64, (pair[1][1] + dy) * h as f64);
            let len = ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
            let n = (len / step).ceil().max(1.0) as usize;
            for i in 0..=n {
                let f = i as f64 / n as f64;
                stamp(&mut mask, ax + (bx - ax) * f, ay + (by - ay) * f);
            }
        }
    }
    mask
}

/// Separable box blur on a u8 alpha buffer (radius in px).
fn blur_u8(src: &[u8], w: usize, h: usize, radius: usize) -> Vec<u8> {
    if radius == 0 || w == 0 || h == 0 {
        return src.to_vec();
    }
    let r = radius as i64;
    let mut tmp = vec![0u8; w * h];
    for y in 0..h {
        let row = y * w;
        for x in 0..w {
            let x0 = (x as i64 - r).max(0) as usize;
            let x1 = (x as i64 + r).min(w as i64 - 1) as usize;
            let count = (x1 - x0 + 1) as u32;
            let mut sum: u32 = 0;
            for k in x0..=x1 {
                sum += src[row + k] as u32;
            }
            tmp[row + x] = (sum / count) as u8;
        }
    }
    let mut out = vec![0u8; w * h];
    for x in 0..w {
        for y in 0..h {
            let y0 = (y as i64 - r).max(0) as usize;
            let y1 = (y as i64 + r).min(h as i64 - 1) as usize;
            let count = (y1 - y0 + 1) as u32;
            let mut sum: u32 = 0;
            for k in y0..=y1 {
                sum += tmp[k * w + x] as u32;
            }
            out[y * w + x] = (sum / count) as u8;
        }
    }
    out
}

fn dilate_bool(mask: &[bool], w: usize, h: usize, radius: usize) -> Vec<bool> {
    if radius == 0 {
        return mask.to_vec();
    }
    // Separable max filter.
    let mut tmp = mask.to_vec();
    for y in 0..h {
        let row = y * w;
        let row_v: Vec<bool> = tmp[row..row + w].to_vec();
        for x in 0..w {
            if row_v[x] {
                continue;
            }
            let x0 = x.saturating_sub(radius);
            let x1 = (x + radius).min(w - 1);
            if row_v[x0..=x1].iter().any(|v| *v) {
                tmp[row + x] = true;
            }
        }
    }
    // Seed the output from the horizontally-dilated buffer so the vertical
    // pass keeps those pixels too (true separable max).
    let mut out = tmp.clone();
    for x in 0..w {
        for y in 0..h {
            if tmp[y * w + x] {
                continue;
            }
            let y0 = y.saturating_sub(radius);
            let y1 = (y + radius).min(h - 1);
            if (y0..=y1).any(|yy| tmp[yy * w + x]) {
                out[y * w + x] = true;
            }
        }
    }
    out
}

/// Shift a single-channel plane by an integer pixel offset, leaving the
/// vacated border zeroed.
///
/// Written row-wise with `copy_from_slice` rather than a per-pixel loop.
/// The mask is re-shifted on EVERY frame whose tracked offset is non-zero —
/// i.e. the common case for a moving object — and the per-pixel version
/// measured **58 ms per buffer per frame at 4K** (116 ms for the alpha +
/// binary pair), which is more than the entire rest of the render. Rows are
/// contiguous, so a shift is one memmove per row.
///
/// Destination pixel (x, y) reads source (x - sx, y - sy), so only the
/// overlapping rectangle is copied and the rest stays zero.
fn shift_plane_into(src: &[u8], out: &mut [u8], w: usize, h: usize, sx: i64, sy: i64) {
    out.fill(0);
    if src.len() < w * h || out.len() < w * h {
        return;
    }
    let (wi, hi) = (w as i64, h as i64);
    let y0 = sy.max(0);
    let y1 = (sy + hi).min(hi);
    let x0 = sx.max(0);
    let x1 = (sx + wi).min(wi);
    if y1 <= y0 || x1 <= x0 {
        return; // shifted entirely out of frame
    }
    let len = (x1 - x0) as usize;
    let src_col = (x0 - sx) as usize;
    for y in y0..y1 {
        let srow = (y - sy) as usize;
        let d = y as usize * w + x0 as usize;
        let s = srow * w + src_col;
        out[d..d + len].copy_from_slice(&src[s..s + len]);
    }
}

/// `shift_plane_into` for the boolean mask. Same reasoning; `Vec<bool>` is a
/// bit-packed buffer, so the per-pixel version was even more branch-bound.
fn shift_plane_bool_into(src: &[bool], out: &mut [bool], w: usize, h: usize, sx: i64, sy: i64) {
    out.fill(false);
    if src.len() < w * h || out.len() < w * h {
        return;
    }
    let (wi, hi) = (w as i64, h as i64);
    let y0 = sy.max(0);
    let y1 = (sy + hi).min(hi);
    let x0 = sx.max(0);
    let x1 = (sx + wi).min(wi);
    if y1 <= y0 || x1 <= x0 {
        return;
    }
    let len = (x1 - x0) as usize;
    let src_col = (x0 - sx) as usize;
    for y in y0..y1 {
        let srow = (y - sy) as usize;
        let d = y as usize * w + x0 as usize;
        let s = srow * w + src_col;
        out[d..d + len].copy_from_slice(&src[s..s + len]);
    }
}

/* ------------------------------------------------------------------ */
/* Frame decoding helpers                                              */
/* ------------------------------------------------------------------ */

struct FrameReader {
    child: std::process::Child,
    stdout: std::process::ChildStdout,
    frame_bytes: usize,
}

impl FrameReader {
    fn spawn(
        src: &Path,
        input_opts: &[&str],
        pix_fmt: &str,
        scale: Option<(u32, u32)>,
    ) -> Result<Self, String> {
        let mut cmd = command_ffmpeg();
        // Input options (-ss/-t) must precede -i.
        if !input_opts.is_empty() {
            cmd.args(input_opts);
        }
        cmd.args(["-v", "error", "-nostdin", "-i"])
            .arg(src)
            .arg("-map")
            .arg("0:v:0");
        if let Some((tw, th)) = scale {
            cmd.args(["-vf", &format!("scale={tw}:{th}")]);
        }
        // `-nostdin` means ffmpeg is explicitly told NOT to read stdin, so
        // handing it a pipe we immediately close allocated a Windows named-pipe
        // instance for nothing — one per decode. Named pipes are a limited,
        // process-wide resource: burning them here is what makes a later
        // `CreateProcess` fail with "All pipe instances are busy", which
        // surfaces to the user as Magic Remove refusing to run on a second
        // clip. `null` gives ffmpeg the same immediate EOF with no pipe.
        cmd.args(["-f", "rawvideo", "-pix_fmt", pix_fmt, "pipe:1"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("ffmpeg decode spawn failed: {e}"))?;
        let stdout = child.stdout.take().ok_or("no ffmpeg stdout")?;
        let (tw, th) = scale.unwrap_or((0, 0));
        let frame_bytes = if scale.is_some() {
            (tw as usize) * (th as usize) * if pix_fmt == "gray" { 1 } else { 3 }
        } else {
            0
        };
        Ok(Self {
            child,
            stdout,
            frame_bytes,
        })
    }

    /// Read the next frame; `Ok(false)` at a CLEAN end of stream.
    fn next_frame(&mut self, buf: &mut Vec<u8>) -> Result<bool, String> {
        if self.frame_bytes == 0 {
            return Err("frame size unknown".into());
        }
        buf.resize(self.frame_bytes, 0);
        let mut filled = 0;
        while filled < self.frame_bytes {
            let n = self
                .stdout
                .read(&mut buf[filled..])
                .map_err(|e| format!("ffmpeg decode read failed: {e}"))?;
            if n == 0 {
                // EOF. `stderr` is nulled for the decoder, so the exit status
                // is the ONLY signal available — and without checking it a
                // decoder that died on corrupt media looked exactly like a
                // clean end of file. The render then produced a sidecar with
                // fewer frames than the clip has, i.e. a silently TRUNCATED
                // result the user would only notice as a frozen tail.
                return self.verify_exit().map(|()| false);
            }
            filled += n;
        }
        Ok(true)
    }

    /// Confirm the decoder actually succeeded after its stdout reached EOF.
    ///
    /// Called at most once per reader (the caller stops at the first EOF), and
    /// `Child::wait` caches the exit status, so the later `Drop` is harmless.
    fn verify_exit(&mut self) -> Result<(), String> {
        match self.child.wait() {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!(
                "ffmpeg decode failed ({status}) — the source is corrupt or unreadable"
            )),
            Err(e) => Err(format!("ffmpeg decode wait failed: {e}")),
        }
    }
}

impl Drop for FrameReader {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Track-scale size preserving aspect (max 480 on the long edge, even dims).
fn track_scale(w: u32, h: u32) -> (u32, u32) {
    let long = w.max(h) as f64;
    let s = (480.0 / long).min(1.0);
    (
        ((w as f64 * s).round() as u32).max(2) & !1,
        ((h as f64 * s).round() as u32).max(2) & !1,
    )
}

fn search_window(accuracy: &str) -> (i64, i64) {
    match accuracy {
        "low" => (12, 2),
        "high" => (40, 1),
        _ => (24, 2),
    }
}

/* ------------------------------------------------------------------ */
/* Tracking                                                            */
/* ------------------------------------------------------------------ */

/// Sum-of-absolute-differences of the template region between two gray frames.
fn sad_at(
    tpl: &[u8],
    pos: &[(usize, usize)],
    w: usize,
    h: usize,
    cur: &[u8],
    ox: i64,
    oy: i64,
) -> u64 {
    let mut acc: u64 = 0;
    for (i, &(px, py)) in pos.iter().enumerate() {
        let nx = px as i64 + ox;
        let ny = py as i64 + oy;
        if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
            acc += 255; // off-frame penalty
            continue;
        }
        let v = cur[ny as usize * w + nx as usize];
        acc += (v as i32 - tpl[i] as i32).unsigned_abs() as u64;
    }
    acc
}

/// Find the best translation of the template in `cur` around `prev_off`.
fn track_step(
    tpl: &[u8],
    pos: &[(usize, usize)],
    w: usize,
    h: usize,
    cur: &[u8],
    prev_off: (i64, i64),
    radius: i64,
    coarse_step: i64,
) -> (i64, i64) {
    // Coarse pass.
    let mut best = prev_off;
    let mut best_sad = u64::MAX;
    let mut oy = -radius;
    while oy <= radius {
        let mut ox = -radius;
        while ox <= radius {
            let sad = sad_at(tpl, pos, w, h, cur, prev_off.0 + ox, prev_off.1 + oy);
            if sad < best_sad {
                best_sad = sad;
                best = (prev_off.0 + ox, prev_off.1 + oy);
            }
            ox += coarse_step;
        }
        oy += coarse_step;
    }
    // Refine pass around the coarse best.
    let step = coarse_step.max(1);
    let mut refined = best;
    let mut oy = -step;
    while oy <= step {
        let mut ox = -step;
        while ox <= step {
            let sad = sad_at(tpl, pos, w, h, cur, best.0 + ox, best.1 + oy);
            if sad < best_sad {
                best_sad = sad;
                refined = (best.0 + ox, best.1 + oy);
            }
            ox += 1;
        }
        oy += 1;
    }
    refined
}

/// Template-track the mask from `anchor_time` across the whole clip.
///
/// Returns keyframes (normalized offsets) with ~8 Hz sampling plus boundary
/// extensions, ready for manual editing in the UI.
pub fn track_mask(
    job: &MagicJob,
    cancel: Option<&AtomicBool>,
    progress: &dyn Fn(f64, &str),
) -> Result<Vec<MagicKeyframe>, String> {
    if is_image_path(&job.source) {
        return Ok(vec![]);
    }
    let info = probe_media(&job.source).map_err(|e| e.to_string())?;
    if !info.has_video || info.width < 8 || info.height < 8 {
        return Err("source has no video track".into());
    }
    let fps = if info.frame_rate > 0.1 {
        info.frame_rate
    } else {
        30.0
    };
    let total_frames = ((info.duration.max(0.1) * fps).ceil() as i64).max(1);
    // Clip-scoped tracking: only walk frames inside the job's window.
    let (win_start_t, win_end_t) = job.window(info.duration.max(0.1));
    let start_idx = ((win_start_t * fps).floor() as i64).clamp(0, total_frames - 1);
    let end_idx = ((win_end_t * fps).ceil() as i64).clamp(start_idx + 1, total_frames);
    let anchor_idx = ((job.anchor_time * fps).round() as i64).clamp(start_idx, end_idx - 1);
    let (tw, th) = track_scale(info.width, info.height);
    let (radius, coarse) = search_window(&job.accuracy);
    // Bound the backward window so memory stays flat on long clips (~45 s)
    // and never walks before the scoped window start.
    let back_window: i64 = ((45.0 * fps).round() as i64)
        .min(anchor_idx - start_idx)
        .max(0);

    let mut reader = FrameReader::spawn(
        &job.source,
        &["-ss", &format!("{:.3}", job.anchor_time)],
        "gray",
        Some((tw, th)),
    )?;
    let mut gray = Vec::new();
    if !reader.next_frame(&mut gray)? {
        return Err("could not decode anchor frame".into());
    }
    if cancelled(cancel) {
        return Err("cancelled".into());
    }

    // Template: gray pixels under the mask at the anchor.
    let mask = rasterize_mask(&job.strokes, tw as usize, th as usize, 0.0, 0.0);
    let mut pos: Vec<(usize, usize)> = Vec::new();
    let mut tpl: Vec<u8> = Vec::new();
    for y in 0..th as usize {
        for x in 0..tw as usize {
            if mask[y * tw as usize + x] {
                pos.push((x, y));
                tpl.push(gray[y * tw as usize + x]);
            }
        }
    }
    if pos.len() < 24 {
        return Err("selected area is too small to track — brush a larger region".into());
    }

    let mut offsets: HashMap<i64, (i64, i64)> = HashMap::new();
    offsets.insert(anchor_idx, (0, 0));

    // Forward pass.
    let mut off = (0i64, 0i64);
    let mut idx = anchor_idx;
    let mut refresh: Vec<u8> = tpl.clone();
    let mut since_refresh = 0usize;
    while reader.next_frame(&mut gray)? {
        idx += 1;
        if cancelled(cancel) {
            return Err("cancelled".into());
        }
        off = track_step(
            &refresh,
            &pos,
            tw as usize,
            th as usize,
            &gray,
            off,
            radius,
            coarse,
        );
        offsets.insert(idx, off);
        // Periodic template refresh at the tracked position resists appearance
        // drift (lighting/rotation); only refresh on confident matches.
        let cur_sad = sad_at(
            &refresh,
            &pos,
            tw as usize,
            th as usize,
            &gray,
            off.0,
            off.1,
        );
        let conf = (pos.len() as u64) * 12;
        since_refresh += 1;
        if cur_sad < conf && since_refresh > (fps * 1.5).round() as usize {
            for (i, &(px, py)) in pos.iter().enumerate() {
                let nx = px as i64 + off.0;
                let ny = py as i64 + off.1;
                if nx >= 0 && ny >= 0 && nx < tw as i64 && ny < th as i64 {
                    refresh[i] = gray[ny as usize * tw as usize + nx as usize];
                }
            }
            since_refresh = 0;
        }
        let done = (idx - anchor_idx) as f64;
        progress(
            (done / (end_idx - anchor_idx).max(1) as f64 * 0.5).min(0.5),
            "tracking",
        );
        if idx - anchor_idx >= end_idx - anchor_idx {
            break;
        }
    }
    let fwd_end = idx;
    drop(reader);

    // Backward pass over a bounded window (ring buffer of proxy frames).
    if back_window > 0 {
        let win_start_t = ((anchor_idx - back_window) as f64 / fps).max(0.0);
        let mut reader = FrameReader::spawn(
            &job.source,
            &[
                "-ss",
                &format!("{win_start_t:.3}"),
                "-t",
                &format!("{:.3}", job.anchor_time - win_start_t + 0.05),
            ],
            "gray",
            Some((tw, th)),
        )?;
        let mut ring: Vec<Vec<u8>> = Vec::with_capacity(back_window as usize + 1);
        let mut gray = Vec::new();
        while reader.next_frame(&mut gray)? {
            if cancelled(cancel) {
                return Err("cancelled".into());
            }
            ring.push(gray.clone());
            if ring.len() > (back_window + 1) as usize {
                ring.remove(0);
            }
        }
        drop(reader);
        // Trim any overshoot past the anchor so the ring ends on it.
        let expected = (back_window + 1) as usize;
        while ring.len() > expected {
            ring.pop();
        }
        // Reverse over the ring ending at the anchor frame.
        let mut off = (0i64, 0i64);
        let mut fi = anchor_idx;
        for frame in ring.iter().rev() {
            // `frame` is anchor-(ring_len-1-k)…; only walk back while in range.
            offsets.insert(fi, off);
            if fi == 0 {
                break;
            }
            fi -= 1;
            // Track the template INTO the earlier frame from the current offset.
            off = track_step(
                &tpl,
                &pos,
                tw as usize,
                th as usize,
                frame,
                off,
                radius,
                coarse,
            );
        }
        // The last (earliest) frame's offset was computed but not yet stored.
        if !ring.is_empty() {
            offsets.insert(fi, off);
        }
        progress(0.5, "tracking");
    }

    // Decimate to ~8 Hz keyframes + constant extension to both ends.
    let sample_every = ((fps / 8.0).round() as i64).max(1);
    let mut kf: Vec<MagicKeyframe> = Vec::new();
    let mut sorted: Vec<(i64, (i64, i64))> = offsets.into_iter().collect();
    sorted.sort_by_key(|(i, _)| *i);
    for (i, (dx, dy)) in sorted.iter() {
        if *i % sample_every == 0 || *i == anchor_idx || *i == 0 || *i == fwd_end {
            kf.push(MagicKeyframe {
                t: *i as f64 / fps,
                dx: *dx as f64 / tw as f64,
                dy: *dy as f64 / th as f64,
                manual: false,
            });
        }
    }
    // Constant extensions outside the tracked range (the window start, not
    // necessarily media time 0 for clip-scoped jobs).
    if let Some(first) = sorted.first() {
        if first.0 > start_idx {
            kf.push(MagicKeyframe {
                t: start_idx as f64 / fps,
                dx: first.1 .0 as f64 / tw as f64,
                dy: first.1 .1 as f64 / th as f64,
                manual: false,
            });
        }
    }
    kf.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    kf.dedup_by(|a, b| (b.t - a.t).abs() < 1e-4);
    progress(1.0, "tracking");
    Ok(kf)
}

/* ------------------------------------------------------------------ */
/* Inpainting render                                                   */
/* ------------------------------------------------------------------ */

/// Piecewise-linear offset at media time `t` (normalized fractions).
pub fn offset_at(keyframes: &[MagicKeyframe], t: f64) -> (f64, f64) {
    if keyframes.is_empty() {
        return (0.0, 0.0);
    }
    let mut kfs: Vec<&MagicKeyframe> = keyframes.iter().collect();
    kfs.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    if t <= kfs[0].t {
        return (kfs[0].dx, kfs[0].dy);
    }
    if let Some(last) = kfs.last() {
        if t >= last.t {
            return (last.dx, last.dy);
        }
    }
    for pair in kfs.windows(2) {
        if t >= pair[0].t && t <= pair[1].t {
            let span = (pair[1].t - pair[0].t).max(1e-6);
            let f = (t - pair[0].t) / span;
            return (
                pair[0].dx + (pair[1].dx - pair[0].dx) * f,
                pair[0].dy + (pair[1].dy - pair[0].dy) * f,
            );
        }
    }
    (0.0, 0.0)
}

/// Pull-in fill for pixels with no temporal sample: average the nearest
/// unmasked colors along 8 rays (inverse-square weighted).
fn spatial_fill_pixel(
    frame: &[u8],
    binary: &[bool],
    w: usize,
    h: usize,
    x: usize,
    y: usize,
    max_dist: i64,
) -> [u8; 3] {
    let dirs = [
        (1i64, 0i64),
        (-1, 0),
        (0, 1),
        (0, -1),
        (1, 1),
        (1, -1),
        (-1, 1),
        (-1, -1),
    ];
    let mut acc = [0f64; 3];
    let mut wsum = 0f64;
    for &(dx, dy) in &dirs {
        let mut px = x as i64;
        let mut py = y as i64;
        let mut d = 0i64;
        let mut found = false;
        while d < max_dist {
            px += dx;
            py += dy;
            d += 1;
            if px < 0 || py < 0 || px >= w as i64 || py >= h as i64 {
                break;
            }
            let idx = py as usize * w + px as usize;
            if !binary[idx] {
                let o = idx * 3;
                let wgt = 1.0 / (d as f64 * d as f64);
                acc[0] += frame[o] as f64 * wgt;
                acc[1] += frame[o + 1] as f64 * wgt;
                acc[2] += frame[o + 2] as f64 * wgt;
                wsum += wgt;
                found = true;
                break;
            }
        }
        let _ = found;
    }
    if wsum > 0.0 {
        [
            (acc[0] / wsum).round().clamp(0.0, 255.0) as u8,
            (acc[1] / wsum).round().clamp(0.0, 255.0) as u8,
            (acc[2] / wsum).round().clamp(0.0, 255.0) as u8,
        ]
    } else {
        // Entire neighbourhood masked: hold the previous estimate if any.
        [0, 0, 0]
    }
}

/// Render the inpainted sidecar video for the full source clip.
/// Removes the partially-written output unless disarmed.
///
/// `render_inpaint` has several failure exits — user cancel, a decoder read
/// error, the encoder dying, a short write — and only ONE of them used to
/// clean up. A cancelled render therefore left a partial `.tmp.mp4` in the
/// derived cache (hundreds of MB of garbage the user cannot see or reclaim).
/// An RAII guard covers every path, including ones added later.
struct RemoveOnDrop<'a> {
    path: &'a Path,
    armed: bool,
}

impl Drop for RemoveOnDrop<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(self.path);
        }
    }
}

pub fn render_inpaint(
    job: &MagicJob,
    out: &Path,
    cancel: Option<&AtomicBool>,
    progress: &dyn Fn(f64, &str),
) -> Result<(), String> {
    let mut cleanup = RemoveOnDrop {
        path: out,
        armed: true,
    };
    let info = probe_media(&job.source).map_err(|e| e.to_string())?;
    if !info.has_video || info.width < 8 || info.height < 8 {
        return Err("source has no video track".into());
    }
    let w = info.width as usize;
    let h = info.height as usize;
    let fps = if info.frame_rate > 0.1 {
        info.frame_rate
    } else {
        30.0
    };
    // Clip-scoped render: decode only the job's window; the sidecar's t=0 is
    // the window start (frontend/export remap clip in/out by `scope_in`).
    let (win_start_t, win_end_t) = job.window(info.duration.max(0.1));
    let win_dur = (win_end_t - win_start_t).max(0.1);
    let total_frames = ((win_dur * fps).ceil() as usize).max(1);

    // Precompute the feathered alpha mask (offset 0) once; per-frame masks are
    // integer shifts of it (box blur is shift-invariant away from the border).
    let binary0 = rasterize_mask(&job.strokes, w, h, 0.0, 0.0);
    let expand_px = (job.expand * h as f64).round() as usize;
    let feather_px = (job.feather * h as f64).round() as usize;
    let dilated = dilate_bool(&binary0, w, h, expand_px);
    let mut alpha0: Vec<u8> = dilated
        .iter()
        .map(|v| if *v { 255u8 } else { 0u8 })
        .collect();
    if feather_px > 0 {
        let blurred = blur_u8(&alpha0, w, h, feather_px);
        // The core of the mask MUST remain 255 (100% removal).
        // The blurred fringe extends outward for a smooth boundary.
        for i in 0..alpha0.len() {
            alpha0[i] = if dilated[i] { 255 } else { blurred[i] };
        }
    }
    let binary_for_fill = dilated;
    if !binary_for_fill.iter().any(|v| *v) {
        return Err("no mask coverage — brush over the element to remove".into());
    }

    // Temporal background memory: latest color seen while unmasked.
    let mut bg: Vec<[u8; 3]> = vec![[0; 3]; w * h];
    let mut bg_age: Vec<u32> = vec![u32::MAX; w * h];
    let max_age = (fps * 1.2).round().max(8.0) as u32;

    // Small lookahead buffer so early frames can sample just-ahead unmasked
    // pixels (object edges leave the mask quickly).
    let frame_bytes = w * h * 3;
    let lookahead = ((50 * 1024 * 1024) / frame_bytes.max(1)).clamp(2, 12) as usize;

    let scoped = job.is_scoped();
    let mut input_opts: Vec<String> = Vec::new();
    if scoped {
        // A hair of padding on the tail so the last frame always decodes.
        input_opts.push("-ss".into());
        input_opts.push(format!("{win_start_t:.3}"));
        input_opts.push("-t".into());
        input_opts.push(format!("{:.3}", win_dur + 0.05));
    }
    let input_refs: Vec<&str> = input_opts.iter().map(|s| s.as_str()).collect();
    let mut reader = FrameReader::spawn(&job.source, &input_refs, "rgb24", None)?;
    reader.frame_bytes = frame_bytes;

    let mut enc = command_ffmpeg();
    enc.args([
        "-v",
        "error",
        "-nostdin",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        &format!("{}x{}", info.width, info.height),
        "-r",
        &format!("{fps:.6}"),
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-y",
    ])
    .arg(out)
    .stdin(Stdio::piped())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    let mut enc_child = crate::KillOnDrop(
        enc.spawn()
            .map_err(|e| format!("ffmpeg encode spawn failed: {e}"))?,
    );
    let mut enc_in = enc_child.stdin.take().ok_or("no ffmpeg stdin")?;

    let _frame: Vec<u8> = Vec::with_capacity(frame_bytes);
    let mut lookahead_buf: std::collections::VecDeque<Vec<u8>> = std::collections::VecDeque::new();
    let mut filled_lookahead = 0usize;
    // Prime the lookahead with the first frames.
    while filled_lookahead < lookahead {
        let mut b = Vec::with_capacity(frame_bytes);
        if !reader.next_frame(&mut b)? {
            break;
        }
        lookahead_buf.push_back(b);
        filled_lookahead += 1;
    }

    let strength = job.strength.clamp(0.0, 1.0);
    let max_dist = (w.max(h) as i64).max(64);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 8);
    // Row-aligned band size so every worker owns whole pixel rows.
    let total_px = w * h;
    let band = ((total_px + threads - 1) / threads).div_ceil(w) * w;
    // Reused across frames: allocating the shifted alpha + binary masks per
    // frame churned ~16 MB per frame at 4K (alpha u8 + bit-packed bool), which
    // is pure allocator/page-fault overhead on the hot path.
    let mut shifted: Vec<u8> = vec![0u8; total_px];
    let mut shifted_binary: Vec<bool> = vec![false; total_px];
    let mut fi: usize = 0;
    let write_err = |e: std::io::Error| format!("encode write failed: {e}");
    progress(0.0, "inpainting");

    while let Some(cur) = lookahead_buf.pop_front() {
        if cancelled(cancel) {
            let _ = enc_child.kill();
            let _ = enc_child.wait();
            return Err("cancelled".into());
        }
        // Keep the lookahead window full.
        if filled_lookahead >= lookahead {
            filled_lookahead -= 1;
        }
        let mut nxt = Vec::with_capacity(frame_bytes);
        let has_next = reader.next_frame(&mut nxt)?;
        if has_next {
            lookahead_buf.push_back(nxt);
            filled_lookahead += 1;
        }

        // Frame index is sidecar-relative; keyframes are source-absolute.
        let (fdx, fdy) = offset_at(&job.keyframes, win_start_t + fi as f64 / fps);
        let sx = (fdx * w as f64).round() as i64;
        let sy = (fdy * h as f64).round() as i64;
        // Shift into the reused buffers; only the zero-offset case can borrow
        // the precomputed masks directly.
        let (alpha, binary_ref): (&[u8], &[bool]) = if sx == 0 && sy == 0 {
            (&alpha0, &binary_for_fill)
        } else {
            shift_plane_into(&alpha0, &mut shifted, w, h, sx, sy);
            shift_plane_bool_into(&binary_for_fill, &mut shifted_binary, w, h, sx, sy);
            (&shifted, &shifted_binary)
        };

        let mut out_frame = cur.clone();
        // Pass 1 (parallel bands): update temporal memory where unmasked.
        std::thread::scope(|s| {
            let mut rest_bg: &mut [[u8; 3]] = &mut bg;
            let mut rest_age: &mut [u32] = &mut bg_age;
            let mut done = 0usize;
            while done < total_px {
                let take = band.min(total_px - done);
                let (b, b_rest) = rest_bg.split_at_mut(take);
                let (a, a_rest) = rest_age.split_at_mut(take);
                rest_bg = b_rest;
                rest_age = a_rest;
                let base = done;
                let cur = &*cur;
                let alpha = alpha;
                s.spawn(move || {
                    for (k, slot) in b.iter_mut().enumerate() {
                        let p = base + k;
                        if alpha[p] == 0 {
                            let o = p * 3;
                            *slot = [cur[o], cur[o + 1], cur[o + 2]];
                            a[k] = 0;
                        } else if a[k] != u32::MAX {
                            a[k] += 1;
                        }
                    }
                });
                done += take;
            }
        });
        // Pass 2 (parallel bands): fill masked pixels + composite.
        std::thread::scope(|s| {
            let mut rest_out: &mut [u8] = &mut out_frame;
            let mut done = 0usize;
            while done < total_px {
                let take = band.min(total_px - done);
                let (o_slice, o_rest) = rest_out.split_at_mut(take * 3);
                rest_out = o_rest;
                let base = done;
                let cur = &*cur;
                let alpha = alpha;
                let binary = binary_ref;
                let bg = &bg;
                let bg_age = &bg_age;
                s.spawn(move || {
                    for k in 0..take {
                        let p = base + k;
                        let av = alpha[p] as u32;
                        if av == 0 {
                            continue;
                        }
                        let o = p * 3;
                        let fill: [u8; 3] = if bg_age[p] <= max_age {
                            bg[p]
                        } else {
                            // No fresh temporal sample: pull color in from
                            // the mask boundary (small regions blend cleanly;
                            // large ones soften).
                            let fo = p * 3;
                            let mut est =
                                spatial_fill_pixel(cur, binary, w, h, p % w, p / w, max_dist);
                            if est == [0, 0, 0] {
                                est = [cur[fo], cur[fo + 1], cur[fo + 2]];
                            }
                            est
                        };
                        let af = (av as f64 / 255.0) * strength;
                        for c in 0..3 {
                            let orig = cur[o + c] as f64;
                            o_slice[k * 3 + c] = (orig * (1.0 - af) + fill[c] as f64 * af)
                                .round()
                                .clamp(0.0, 255.0)
                                as u8;
                        }
                    }
                });
                done += take;
            }
        });

        enc_in.write_all(&out_frame).map_err(write_err)?;
        fi += 1;
        // Frequent ticks: the UI must feel alive even on slow machines.
        if fi % 6 == 0 || fi >= total_frames {
            progress((fi as f64 / total_frames as f64).min(1.0), "inpainting");
        }
        if fi >= total_frames + 4 {
            break;
        }
    }
    drop(enc_in);
    let status = enc_child
        .wait()
        .map_err(|e| format!("encode wait failed: {e}"))?;
    if !status.success() {
        return Err("ffmpeg encode failed".into());
    }
    // Success: the caller renames this file into the cache.
    cleanup.armed = false;
    progress(1.0, "inpainting");
    Ok(())
}

/// Convenience: run tracking then render, returning keyframes too.
pub fn track_and_render(
    job: &MagicJob,
    out: &Path,
    cancel: Option<Arc<AtomicBool>>,
    progress: &dyn Fn(f64, &str),
) -> Result<Vec<MagicKeyframe>, String> {
    let kf = track_mask(job, cancel.as_deref(), &|p, phase| {
        progress(p * 0.35, phase)
    })?;
    let mut job2 = job.clone();
    job2.keyframes = kf.clone();
    render_inpaint(&job2, out, cancel.as_deref(), &|p, phase| {
        progress(0.35 + p * 0.65, phase)
    })?;
    Ok(kf)
}

/// Build the encoder side output path under `cache_dir` for a job.
pub fn cache_path(cache_dir: &Path, job: &MagicJob) -> PathBuf {
    let h = job.cache_hash(true);
    cache_dir.join(format!("magic_{h:016x}.mp4"))
}

/// Re-export nothing for now; errors are plain `String`s here.
pub type MagicError = String;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rasterize_stamps_and_erases() {
        let stroke = MagicStroke {
            points: vec![[0.5, 0.5]],
            radius: 0.1,
            erase: false,
        };
        let mask = rasterize_mask(&[stroke.clone()], 200, 100, 0.0, 0.0);
        // Center stamped, far corner untouched.
        assert!(mask[50 * 200 + 100]);
        assert!(!mask[0]);
        // Radius is a fraction of HEIGHT: ~10px vertical extent.
        assert!(mask[50 * 200 + 100 + 8]);
        assert!(!mask[50 * 200 + 100 + 15]);

        // Eraser strokes carve back out.
        let erase = MagicStroke {
            erase: true,
            ..stroke.clone()
        };
        let mask2 = rasterize_mask(&[stroke.clone(), erase.clone()], 200, 100, 0.0, 0.0);
        assert!(!mask2[50 * 200 + 100]);

        // Translation shifts the mask (dx fraction of width).
        let shifted = rasterize_mask(&[stroke], 200, 100, 0.25, 0.0);
        assert!(shifted[50 * 200 + 150]);
        assert!(!shifted[50 * 200 + 100]);
    }

    #[test]
    fn polyline_stroke_is_contiguous() {
        let s = MagicStroke {
            points: vec![[0.1, 0.5], [0.9, 0.5]],
            radius: 0.05,
            erase: false,
        };
        let mask = rasterize_mask(&[s], 400, 100, 0.0, 0.0);
        for x in (50..350).step_by(10) {
            assert!(mask[50 * 400 + x], "gap at x={x}");
        }
    }

    #[test]
    fn shift_buffer_moves_content() {
        // Exercises the production path (shift into a caller-owned buffer).
        let mut s = vec![0u8; 25];
        s[2 * 5 + 2] = 200;
        let mut out = vec![0u8; 25];
        shift_plane_into(&s, &mut out, 5, 5, 1, -1);
        assert_eq!(out[1 * 5 + 3], 200);
        assert_eq!(out[2 * 5 + 2], 0);
    }

    #[test]
    fn blur_spreads_alpha() {
        let mut a = vec![0u8; 25];
        a[12] = 255;
        let b = blur_u8(&a, 5, 5, 1);
        assert!(b[12] < 255);
        assert!(b[12 - 1] > 0);
        assert!(b[12 + 5] > 0);
    }

    #[test]
    fn dilate_grows_region() {
        let mut m = vec![false; 25];
        m[12] = true;
        let d = dilate_bool(&m, 5, 5, 1);
        assert!(d[12] && d[7] && d[17] && d[11] && d[13]);
        assert!(!d[0]);
    }

    #[test]
    fn offset_at_interpolates_and_clamps() {
        let kf = vec![
            MagicKeyframe {
                t: 0.0,
                dx: 0.0,
                dy: 0.0,
                manual: false,
            },
            MagicKeyframe {
                t: 2.0,
                dx: 0.1,
                dy: -0.2,
                manual: false,
            },
        ];
        assert_eq!(offset_at(&kf, 1.0), (0.05, -0.1));
        assert_eq!(offset_at(&kf, -5.0), (0.0, 0.0));
        assert_eq!(offset_at(&kf, 9.0), (0.1, -0.2));
        assert_eq!(offset_at(&[], 3.0), (0.0, 0.0));
    }

    #[test]
    fn cache_hash_changes_with_params() {
        let base = MagicJob {
            source: PathBuf::from("a.mp4"),
            strokes: vec![MagicStroke {
                points: vec![[0.1, 0.1]],
                radius: 0.02,
                erase: false,
            }],
            keyframes: vec![],
            anchor_time: 1.0,
            feather: 0.008,
            expand: 0.004,
            accuracy: "medium".into(),
            strength: 1.0,
            scope_in: 0.0,
            scope_out: 0.0,
        };
        let mut moved = base.clone();
        moved.strokes[0].points[0][0] += 0.01;
        assert_ne!(base.cache_hash(true), moved.cache_hash(true));
        let mut kf = base.clone();
        kf.keyframes.push(MagicKeyframe {
            t: 1.0,
            dx: 0.02,
            dy: 0.0,
            manual: false,
        });
        assert_ne!(base.cache_hash(true), kf.cache_hash(true));
    }

    #[test]
    fn job_from_params_parses_frontend_shape() {
        let params = serde_json::json!({
            "strokes": [{ "points": [[0.2, 0.3]], "radius": 0.03, "erase": false }],
            "anchorTime": 1.5,
            "feather": 0.01,
            "expand": 0.005,
            "trackingAccuracy": "high",
            "removalStrength": 80
        });
        let job = MagicJob::from_params(Path::new("v.mp4"), &params, vec![]).unwrap();
        assert_eq!(job.strokes.len(), 1);
        assert!((job.anchor_time - 1.5).abs() < 1e-9);
        assert_eq!(job.accuracy, "high");
        assert!((job.strength - 0.8).abs() < 1e-9);
        assert!(MagicJob::from_params(Path::new("v.mp4"), &serde_json::json!({}), vec![]).is_err());
    }

    #[test]
    fn scope_parses_and_degenerates_to_full_media() {
        let base = serde_json::json!({
            "strokes": [{ "points": [[0.5, 0.5]], "radius": 0.05, "erase": false }],
        });
        let unscoped = MagicJob::from_params(Path::new("v.mp4"), &base, vec![]).unwrap();
        assert!(!unscoped.is_scoped());
        let (s, e) = unscoped.window(120.0);
        assert_eq!((s, e), (0.0, 120.0));

        let scoped_params = serde_json::json!({
            "strokes": [{ "points": [[0.5, 0.5]], "radius": 0.05, "erase": false }],
            "scopeIn": 10.0,
            "scopeOut": 15.5
        });
        let scoped = MagicJob::from_params(Path::new("v.mp4"), &scoped_params, vec![]).unwrap();
        assert!(scoped.is_scoped());
        assert!((scoped.scope_in - 10.0).abs() < 1e-9);
        assert!((scoped.scope_out - 15.5).abs() < 1e-9);
        let (s, e) = scoped.window(120.0);
        assert!((s - 10.0).abs() < 1e-9 && (e - 15.5).abs() < 1e-9);

        // Inverted / degenerate ranges must not trip is_scoped.
        let inverted = MagicJob::from_params(
            Path::new("v.mp4"),
            &serde_json::json!({
                "strokes": [{ "points": [[0.5, 0.5]], "radius": 0.05, "erase": false }],
                "scopeIn": 9.0,
                "scopeOut": 9.0
            }),
            vec![],
        )
        .unwrap();
        assert!(!inverted.is_scoped());
    }

    #[test]
    fn cache_hash_changes_with_scope() {
        let base = MagicJob {
            source: PathBuf::from("a.mp4"),
            strokes: vec![MagicStroke {
                points: vec![[0.1, 0.1]],
                radius: 0.02,
                erase: false,
            }],
            keyframes: vec![],
            anchor_time: 1.0,
            feather: 0.008,
            expand: 0.004,
            accuracy: "medium".into(),
            strength: 1.0,
            scope_in: 0.0,
            scope_out: 0.0,
        };
        let mut scoped = base.clone();
        scoped.scope_in = 10.0;
        scoped.scope_out = 15.0;
        assert_ne!(base.cache_hash(true), scoped.cache_hash(true));
        // Same scope twice = stable key (cache hit across identical clips).
        assert_eq!(scoped.cache_hash(true), scoped.clone().cache_hash(true));
    }

    /// End-to-end proof that a scoped job only touches its window: generate a
    /// 10 s test clip, track+render with scope [2 s, 4 s], and measure the
    /// sidecar. Needs a reachable ffmpeg (e.g. the bundled one on PATH):
    /// `PATH="apps/desktop/src-tauri/bin:$PATH" cargo test -p yx-media \
    ///  scoped_job_renders_only_its_window -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn scoped_job_renders_only_its_window() {
        let dir = std::env::temp_dir().join(format!("yx_magic_scope_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src10s.mp4");
        let mut gen = command_ffmpeg();
        gen.args([
            "-v",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=duration=10:size=320x240:rate=30",
            "-pix_fmt",
            "yuv420p",
            "-y",
        ])
        .arg(&src);
        assert!(
            gen.status().expect("ffmpeg spawn").success(),
            "test media generation failed"
        );

        let mut job = MagicJob {
            source: src.clone(),
            strokes: vec![MagicStroke {
                points: vec![[0.5, 0.5]],
                radius: 0.08,
                erase: false,
            }],
            keyframes: vec![],
            anchor_time: 2.5,
            feather: 0.008,
            expand: 0.004,
            accuracy: "low".into(),
            strength: 1.0,
            scope_in: 2.0,
            scope_out: 4.0,
        };

        // Tracking stays inside the window (keyframe times are source-absolute).
        let kf = track_mask(&job, None, &|_, _| {}).unwrap();
        assert!(!kf.is_empty());
        let tmin = kf.iter().map(|k| k.t).fold(f64::INFINITY, f64::min);
        let tmax = kf.iter().map(|k| k.t).fold(f64::NEG_INFINITY, f64::max);
        assert!(tmin >= 2.0 - 1e-3, "tracked before window start: {tmin}");
        assert!(tmax <= 4.0 + 0.2, "tracked past window end: {tmax}");

        // The scoped sidecar covers only the ~2 s window, not the 10 s source.
        let out = dir.join("scoped.mp4");
        render_inpaint(&job, &out, None, &|_, _| {}).unwrap();
        let info = probe_media(&out)
            .map_err(|e| e.to_string())
            .expect("probe scoped sidecar");
        assert!(
            info.duration > 1.2 && info.duration < 3.2,
            "scoped sidecar should cover only the ~2 s window, got {:.2}s",
            info.duration
        );

        // Unscoped sanity: the same job without a scope covers the whole media.
        job.scope_in = 0.0;
        job.scope_out = 0.0;
        let full = dir.join("full.mp4");
        render_inpaint(&job, &full, None, &|_, _| {}).unwrap();
        let finfo = probe_media(&full)
            .map_err(|e| e.to_string())
            .expect("probe unscoped sidecar");
        assert!(
            finfo.duration > 8.5,
            "unscoped render should cover the full media, got {:.2}s",
            finfo.duration
        );

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&full);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Brute-force reference for the plane shift: destination (x, y) reads
    /// source (x - sx, y - sy), zero outside the overlap.
    fn reference_shift_u8(src: &[u8], w: usize, h: usize, sx: i64, sy: i64) -> Vec<u8> {
        let mut out = vec![0u8; w * h];
        for y in 0..h as i64 {
            for x in 0..w as i64 {
                let (nx, ny) = (x - sx, y - sy);
                if nx >= 0 && nx < w as i64 && ny >= 0 && ny < h as i64 {
                    out[y as usize * w + x as usize] = src[ny as usize * w + nx as usize];
                }
            }
        }
        out
    }

    fn reference_shift_bool(src: &[bool], w: usize, h: usize, sx: i64, sy: i64) -> Vec<bool> {
        let mut out = vec![false; w * h];
        for y in 0..h as i64 {
            for x in 0..w as i64 {
                let (nx, ny) = (x - sx, y - sy);
                if nx >= 0 && nx < w as i64 && ny >= 0 && ny < h as i64 {
                    out[y as usize * w + x as usize] = src[ny as usize * w + nx as usize];
                }
            }
        }
        out
    }

    /// The row-wise shift must be pixel-identical to the per-pixel reference
    /// for EVERY offset in and around the frame.
    ///
    /// The mask is shifted on every frame the tracked object moves, so a
    /// one-pixel error here is not a rounding detail — it silently offsets
    /// the removal region for the whole clip (the "mask drifting" class of
    /// bug). Sizes are deliberately odd: the boolean mask is bit-packed, so a
    /// row length that is not a multiple of 8 is where an indexing bug hides.
    #[test]
    fn shift_matches_reference_for_every_offset() {
        for (w, h) in [(1usize, 1usize), (7, 5), (8, 8), (9, 4), (16, 3), (13, 11)] {
            let src: Vec<u8> = (0..w * h).map(|i| ((i * 7 + 3) % 251) as u8).collect();
            let srcb: Vec<bool> = (0..w * h).map(|i| (i * 5 + 1) % 7 < 3).collect();
            let (wi, hi) = (w as i64, h as i64);
            for sx in -(wi + 2)..=(wi + 2) {
                for sy in -(hi + 2)..=(hi + 2) {
                    let want = reference_shift_u8(&src, w, h, sx, sy);
                    let mut got = vec![0u8; w * h];
                    shift_plane_into(&src, &mut got, w, h, sx, sy);
                    assert_eq!(got, want, "u8 shift mismatch w={w} h={h} sx={sx} sy={sy}");

                    let wantb = reference_shift_bool(&srcb, w, h, sx, sy);
                    let mut gotb = vec![false; w * h];
                    shift_plane_bool_into(&srcb, &mut gotb, w, h, sx, sy);
                    assert_eq!(gotb, wantb, "bool shift mismatch w={w} h={h} sx={sx} sy={sy}");
                }
            }
        }
    }

    /// Reusing one output buffer across frames must not leave residue from the
    /// previous shift — the render loop now keeps these buffers alive for the
    /// whole clip, so a missing clear would smear the old mask position into
    /// the new frame.
    #[test]
    fn reused_shift_buffers_leave_no_residue() {
        let (w, h) = (9usize, 7usize);
        let src: Vec<u8> = (0..w * h).map(|i| (i % 251) as u8).collect();
        let srcb: Vec<bool> = (0..w * h).map(|i| i % 3 == 0).collect();

        let mut buf = vec![0u8; w * h];
        let mut bufb = vec![false; w * h];

        // First shift writes a partial overlap.
        shift_plane_into(&src, &mut buf, w, h, 4, 3);
        shift_plane_bool_into(&srcb, &mut bufb, w, h, 4, 3);

        // A zero shift into the SAME buffers must reproduce the source exactly.
        shift_plane_into(&src, &mut buf, w, h, 0, 0);
        shift_plane_bool_into(&srcb, &mut bufb, w, h, 0, 0);
        assert_eq!(buf, src, "reused alpha buffer kept residue");
        assert_eq!(bufb, srcb, "reused binary buffer kept residue");

        // And shifting fully out of frame must clear, not keep, the content.
        shift_plane_into(&src, &mut buf, w, h, w as i64 + 5, 0);
        assert!(
            buf.iter().all(|v| *v == 0),
            "a fully out-of-frame shift must produce an empty mask"
        );
    }

    fn ffmpeg_available() -> bool {
        command_ffmpeg()
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
    }

    /// The cleanup guard itself: armed deletes, disarmed keeps.
    ///
    /// Deterministic and dependency-free — this is the exact mechanism the
    /// cancelled-render test below relies on, so it is worth pinning on its
    /// own. "Disarm on success" is the half that would silently destroy a
    /// finished render if it regressed.
    #[test]
    fn cleanup_guard_removes_armed_files_only() {
        let dir = std::env::temp_dir().join(format!("yx_guard_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let armed = dir.join("armed.tmp.mp4");
        std::fs::write(&armed, b"partial").unwrap();
        {
            let _guard = RemoveOnDrop {
                path: &armed,
                armed: true,
            };
        }
        assert!(!armed.exists(), "an armed guard must delete the file on drop");

        let kept = dir.join("kept.mp4");
        std::fs::write(&kept, b"finished").unwrap();
        {
            let mut guard = RemoveOnDrop {
                path: &kept,
                armed: true,
            };
            guard.armed = false; // success path
        }
        assert!(kept.exists(), "a disarmed guard must keep the file");

        // A guard whose path was never created must not panic.
        let missing = dir.join("never-written.mp4");
        {
            let _guard = RemoveOnDrop {
                path: &missing,
                armed: true,
            };
        }
        assert!(!missing.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A cancelled render must not leave its partial output behind.
    ///
    /// `render_inpaint` writes straight to the caller's path, and only its
    /// "encoder exited non-zero" branch used to delete it. Cancelling (the
    /// user pressing Cancel, or switching clips mid-render) returned from the
    /// frame loop *before* that cleanup, so every cancelled Magic Remove left
    /// a partial `.tmp.mp4` in the derived cache — invisible, unreclaimable,
    /// and up to hundreds of MB for a 4K clip.
    ///
    /// Cancelling up-front makes this deterministic: the guard has to hold on
    /// the very first loop iteration.
    #[test]
    fn cancelled_render_removes_its_partial_output() {
        if !ffmpeg_available() {
            eprintln!("skipping: ffmpeg not on PATH");
            return;
        }
        let dir = std::env::temp_dir().join(format!("yx_magic_cancel_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.mp4");
        let mut gen = command_ffmpeg();
        gen.args([
            "-v",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=duration=2:size=160x120:rate=15",
            "-pix_fmt",
            "yuv420p",
            "-y",
        ])
        .arg(&src);
        assert!(
            gen.status().expect("ffmpeg spawn").success(),
            "test media generation failed"
        );

        let job = MagicJob {
            source: src.clone(),
            strokes: vec![MagicStroke {
                points: vec![[0.5, 0.5]],
                radius: 0.1,
                erase: false,
            }],
            keyframes: vec![],
            anchor_time: 0.0,
            feather: 0.008,
            expand: 0.004,
            accuracy: "low".into(),
            strength: 1.0,
            scope_in: 0.0,
            scope_out: 0.0,
        };

        let out = dir.join("cancelled.tmp.mp4");
        let cancel = AtomicBool::new(true);
        let result = render_inpaint(&job, &out, Some(&cancel), &|_, _| {});
        assert!(result.is_err(), "a pre-cancelled render must report an error");
        assert!(
            !out.exists(),
            "a cancelled render left {} bytes of partial output behind",
            std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0)
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
