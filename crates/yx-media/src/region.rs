//! Region blur + background-mask export fragments.
//!
//! The Blur tool (`blurregion` filter) and the BG Key select-area tool
//! (`bgmask` filter) both need filter_complex fragments that cannot be
//! expressed as a plain linear chain (they branch: split / source / merge).
//! `build_video_effect_chain` embeds each fragment verbatim inside the
//! timeline `-filter_complex`, so fragments here must leave their final
//! output UNLABELED — the caller appends `,setpts=...[vN]` directly.
//!
//! Blur region design (WYSIWYG with the monitor preview):
//! - The region animates through keyframes stored in filter params (fields
//!   `x, y, w, h, rotation, intensity, feather, opacity`, all sampled at
//!   clip-local source times — the same clock the live preview uses).
//! - POSITION animates through FFmpeg per-frame expressions (`crop` and
//!   `overlay` x/y evaluate per frame, so tracked motion keeps the full
//!   keyframe rate and costs nothing per pixel). A static-size crop box
//!   follows the region center over a padded copy of the frame, which keeps
//!   the region centered inside the box — the alpha mask therefore has
//!   STATIC center coordinates and never clamps at frame edges.
//! - SIZE / ROTATION / FEATHER / OPACITY / INTENSITY animate inside the
//!   (region-sized) `geq` mask expression, resampled to at most
//!   [`MAX_MASK_KEYS`] samples so the nested-if expression stays small.
//! - The blur itself is one `gblur` at the maximum intensity sigma; the
//!   per-frame mix between sharp and blurred is the mask alpha
//!   (`intensity(t)/maxIntensity * opacity(t)`). With no keyframes that is
//!   exactly the requested blur; with animated intensity it crossfades,
//!   mirroring how the monitor preview composites the two layers.

use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

/// Upper bound for keyframe samples baked into the mask `geq` expression.
/// The mask only covers the region bounding box, so a linear keyframe scan
/// per pixel is negligible; tracker output (≈8 Hz) resamples down to this.
const MAX_MASK_KEYS: usize = 24;

/// Keyframe sample of one region field: `(time, value)`.
type Key = (f64, f64);

fn num_at(p: &Value, key: &str, d: f64) -> f64 {
    p.get(key).and_then(|v| v.as_f64()).unwrap_or(d)
}

fn str_at<'a>(p: &'a Value, key: &str, d: &'a str) -> &'a str {
    p.get(key).and_then(|v| v.as_str()).unwrap_or(d)
}

/// Piecewise-linear interpolation over sorted keys with constant extension.
pub fn sample(keys: &[Key], t: f64) -> f64 {
    if keys.is_empty() {
        return 0.0;
    }
    if t <= keys[0].0 {
        return keys[0].1;
    }
    if t >= keys[keys.len() - 1].0 {
        return keys[keys.len() - 1].1;
    }
    for i in 0..keys.len() - 1 {
        let (t0, v0) = keys[i];
        let (t1, v1) = keys[i + 1];
        if t >= t0 && t <= t1 {
            let span = (t1 - t0).max(1e-9);
            return v0 + (v1 - v0) * (t - t0) / span;
        }
    }
    keys[keys.len() - 1].1
}

/// Build an FFmpeg expression evaluating the piecewise-linear interpolation
/// of `keys` at the per-frame timestamp variable, constant-extended outside
/// the key range. Commas are safe because every use site single-quotes the
/// value. `var` is the timestamp variable name — capital `T` inside geq
/// expressions, lowercase `t` in crop/overlay x/y expressions.
pub fn key_expr(keys: &[Key], var: &str) -> String {
    let mut inner = format!("{:.6}", keys[keys.len() - 1].1);
    for i in (0..keys.len().saturating_sub(1)).rev() {
        let (t0, v0) = keys[i];
        let (t1, v1) = keys[i + 1];
        let span = (t1 - t0).max(1e-6);
        inner = format!(
            "if(lt({var},{t1:.6}),{v0:.6}+({v1:.6}-{v0:.6})*({var}-{t0:.6})/{span:.6},{inner})"
        );
    }
    format!("if(lt({var},{:.6}),{:.6},{inner})", keys[0].0, keys[0].1)
}

/// Resample keys to at most `max` samples (uniformly in time) — bounds the
/// mask expression size without visibly changing the animation.
fn resample(keys: &[Key], max: usize) -> Vec<Key> {
    if keys.len() <= max || keys.len() < 2 {
        return keys.to_vec();
    }
    let t0 = keys[0].0;
    let t1 = keys[keys.len() - 1].0;
    let step = (t1 - t0) / (max - 1) as f64;
    (0..max)
        .map(|i| {
            let t = (t0 + step * i as f64).min(t1);
            (t, sample(keys, t))
        })
        .collect()
}

fn keys_from(_params: &Value, kfs: &[Value], field: &str, fallback: f64) -> Vec<Key> {
    if kfs.is_empty() {
        return vec![(0.0, fallback)];
    }
    let mut keys: Vec<Key> = kfs
        .iter()
        .filter_map(|k| {
            let t = k.get("t").and_then(|v| v.as_f64())?;
            let v = k.get(field).and_then(|v| v.as_f64()).unwrap_or(fallback);
            Some((t.max(0.0), v))
        })
        .collect();
    if keys.is_empty() {
        return vec![(0.0, fallback)];
    }
    keys.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    keys.dedup_by(|a, b| (b.0 - a.0).abs() < 1e-6);
    keys
}

/// Axis-aligned bounding box (fractions of the frame) of the rotated region
/// `(x0, y0, w, h)`.
fn bbox_frac(x: f64, y: f64, w: f64, h: f64, rot_deg: f64) -> (f64, f64, f64, f64) {
    let th = rot_deg.abs().to_radians();
    let c = th.cos();
    let s = th.sin();
    let ex = (w * c + h * s) / 2.0;
    let ey = (w * s + h * c) / 2.0;
    (x - ex, y - ey, 2.0 * ex, 2.0 * ey)
}

fn even_px(v: f64) -> i64 {
    ((v.round() as i64) / 2 * 2).max(2)
}

static FRAGMENT_SEQ: AtomicU64 = AtomicU64::new(0);

/// Build the filter_complex fragment for a `blurregion` filter, or `None`
/// when the params are degenerate (zero intensity/opacity/size).
pub fn build_region_blur_fragment(
    params: &Value,
    frame_w: u32,
    frame_h: u32,
    duration: f64,
) -> Option<String> {
    let kfs: Vec<Value> = params
        .get("keyframes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let kx = keys_from(params, &kfs, "x", num_at(params, "x", 0.5));
    let ky = keys_from(params, &kfs, "y", num_at(params, "y", 0.5));
    let kw = resample(
        &keys_from(params, &kfs, "w", num_at(params, "w", 0.3)),
        MAX_MASK_KEYS,
    );
    let kh = resample(
        &keys_from(params, &kfs, "h", num_at(params, "h", 0.3)),
        MAX_MASK_KEYS,
    );
    let kr = resample(
        &keys_from(params, &kfs, "rotation", num_at(params, "rotation", 0.0)),
        MAX_MASK_KEYS,
    );
    let ki = resample(
        &keys_from(params, &kfs, "intensity", num_at(params, "intensity", 0.5)),
        MAX_MASK_KEYS,
    );
    let kfe = resample(
        &keys_from(params, &kfs, "feather", num_at(params, "feather", 0.08)),
        MAX_MASK_KEYS,
    );
    let kop = resample(
        &keys_from(params, &kfs, "opacity", num_at(params, "opacity", 1.0)),
        MAX_MASK_KEYS,
    );

    let shape = str_at(params, "shape", "rect").to_string();
    let corner = num_at(params, "cornerRadius", 0.15).clamp(0.0, 0.5);
    let max_intensity = ki.iter().fold(0.0_f64, |m, (_, v)| m.max(*v));
    let max_opacity = kop.iter().fold(0.0_f64, |m, (_, v)| m.max(*v));
    if max_intensity <= 1e-3 || max_opacity <= 1e-3 {
        return None;
    }
    if sample(&kw, 0.0) <= 1e-3 || sample(&kh, 0.0) <= 1e-3 {
        return None;
    }
    let fw = frame_w.max(2) as f64;
    let fh = frame_h.max(2) as f64;
    // Sigma lives in 1080p-frame space (the fragment runs on the scaled
    // frame), so intensity previews identically at any export resolution.
    let sigma = (max_intensity.clamp(0.02, 1.0) * 25.0 * (fh / 1080.0)).min(120.0);
    let dur = duration.max(0.04);

    // Static crop box: the maximum rotated bbox over all sampled times plus a
    // blur/feather margin (3σ + slack), so gblur never samples outside the box.
    let mut t_samples: Vec<f64> = kw.iter().map(|(t, _)| *t).collect();
    t_samples.push(0.0);
    t_samples.push(dur);
    let mut max_bw = 0.0_f64;
    let mut max_bh = 0.0_f64;
    for &t in &t_samples {
        let (_, _, bw, bh) = bbox_frac(
            sample(&kx, t),
            sample(&ky, t),
            sample(&kw, t),
            sample(&kh, t),
            sample(&kr, t),
        );
        max_bw = max_bw.max(bw);
        max_bh = max_bh.max(bh);
    }
    let margin = 6.0 * sigma + 16.0;
    let bw = (max_bw * fw).ceil() + margin;
    let bh = (max_bh * fh).ceil() + margin;
    let bw = (bw.min(fw) as i64).max(8) as f64;
    let bh = (bh.min(fh) as i64).max(8) as f64;
    let bw_i = even_px(bw).to_string();
    let bh_i = even_px(bh).to_string();
    let (bwx, bhx) = (
        bw_i.parse::<i64>().unwrap_or(8),
        bh_i.parse::<i64>().unwrap_or(8),
    );

    let k = FRAGMENT_SEQ.fetch_add(1, Ordering::Relaxed);
    let (o, b, m, a, am) = (
        format!("rbo{k}"),
        format!("rbb{k}"),
        format!("rbm{k}"),
        format!("rba{k}"),
        format!("rbam{k}"),
    );

    // Position expressions. Padded-frame coords for the crop (the pad offset
    // guarantees crop x/y stay in range), real-frame coords for the overlay.
    let pos_x = |extra: f64| -> String {
        if kx.len() == 1 {
            format!("{:.4}", kx[0].1 * fw + extra)
        } else {
            format!("{}*{fw:.2}+{extra:.2}", key_expr(&kx, "t"))
        }
    };
    let pos_y = |extra: f64| -> String {
        if ky.len() == 1 {
            format!("{:.4}", ky[0].1 * fh + extra)
        } else {
            format!("{}*{fh:.2}+{extra:.2}", key_expr(&ky, "t"))
        }
    };
    let crop_x = pos_x(bwx as f64 / 2.0);
    let crop_y = pos_y(bhx as f64 / 2.0);
    // Overlay goes back onto the PADDED main, so the crop returns to exactly
    // the padded coords it was taken from (pad offset already inside pos_x).
    let overlay_x = crop_x.clone();
    let overlay_y = crop_y.clone();

    // --- Alpha mask (region center is always at the crop-box center) ---
    let cx = bwx as f64 / 2.0;
    let cy = bhx as f64 / 2.0;
    let rx = if kw.len() == 1 {
        format!("{:.4}", kw[0].1 * fw / 2.0)
    } else {
        format!("{}*{fw:.2}/2", key_expr(&kw, "T"))
    };
    let ry = if kh.len() == 1 {
        format!("{:.4}", kh[0].1 * fh / 2.0)
    } else {
        format!("{}*{fh:.2}/2", key_expr(&kh, "T"))
    };
    let th = if kr.len() == 1 {
        format!("{:.6}", kr[0].1.to_radians())
    } else {
        format!("{}*PI/180", key_expr(&kr, "T"))
    };
    let alpha = if ki.len() == 1 && kop.len() == 1 {
        format!("{:.6}", (ki[0].1 / max_intensity) * kop[0].1)
    } else {
        let i_expr = if ki.len() == 1 {
            format!("{:.6}", ki[0].1)
        } else {
            key_expr(&ki, "T")
        };
        let o_expr = if kop.len() == 1 {
            format!("{:.6}", kop[0].1)
        } else {
            key_expr(&kop, "T")
        };
        format!("({i_expr})/{max_intensity:.6}*({o_expr})")
    };
    // Feather: a fraction of the region's min dimension, as a px band.
    let feather = if kfe.len() == 1 {
        format!("max(1,{:.4}*min({rx},{ry}))", kfe[0].1)
    } else {
        format!("max(1,{}*min({rx},{ry}))", key_expr(&kfe, "T"))
    };

    // Inverse-rotate the sample point into region space (u, v), then a signed
    // distance to the shape edge; coverage is a smoothstep over the feather
    // band. Registers avoid re-evaluating the rotation for u/v/qx/qy.
    let uv = format!(
        "st(0,{th});st(1,(X-{cx:.3})*cos(ld(0))+(Y-{cy:.3})*sin(ld(0)));\
         st(2,-(X-{cx:.3})*sin(ld(0))+(Y-{cy:.3})*cos(ld(0)))"
    );
    let sdf = if shape == "ellipse" || shape == "circle" {
        format!("st(3,(hypot(ld(1)/({rx}),ld(2)/({ry}))-1)*min({rx},{ry}))")
    } else {
        // Rounded-rect SDF; corner radius as a fraction of the min dimension.
        let r = format!("{:.4}", corner * fw.min(fh) / 2.0);
        format!(
            "st(3,hypot(max(abs(ld(1))-({rx})+{r},0),max(abs(ld(2))-({ry})+{r},0))\
             +min(max(abs(ld(1))-({rx})+{r},abs(ld(2))-({ry})+{r}),0)-{r})"
        )
    };
    // geq lum output is 0..255: scale the 0..1 coverage by 255.
    let lum = format!("{uv};{sdf};clip(0.5-ld(3)/max(1,{feather}),0,1)*255*{alpha}");

    // Blur/alpha track the padded frame: pad by a full crop box on every side
    // so the animated crop never clamps and always has real pixels to blur.
    let wp = fw + 2.0 * bwx as f64;
    let hp = fh + 2.0 * bhx as f64;

    Some(format!(
        "pad={wp:.0}:{hp:.0}:{bw_i}:{bh_i}:color=black,split[{o}][{b}];\
[{b}]crop={bw_i}:{bh_i}:x='{crop_x}':y='{crop_y}',gblur=sigma={sigma:.4},format=rgba[{a}];\
color=c=black:s={bw_i}x{bh_i}:d={:.6},format=gray,geq=lum='{lum}'[{m}];\
[{a}][{m}]alphamerge[{am}];\
[{o}][{am}]overlay=x='{overlay_x}':y='{overlay_y}',crop={fw:.0}:{fh:.0}:{bw_i}:{bh_i}",
        dur + 0.5,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sample_is_piecewise_linear_with_constant_extension() {
        let keys = [(0.0, 1.0), (1.0, 3.0), (2.0, 2.0)];
        assert_eq!(sample(&keys, -1.0), 1.0);
        assert_eq!(sample(&keys, 3.0), 2.0);
        assert_eq!(sample(&keys, 0.5), 2.0);
        assert_eq!(sample(&keys, 1.5), 2.5);
    }

    #[test]
    fn key_expr_interpolates_at_capital_t() {
        let e = key_expr(&[(0.0, 0.2), (1.0, 0.8)], "T");
        // Manually evaluate the expression at several T values.
        for (t, want) in [(-1.0, 0.2), (0.0, 0.2), (0.5, 0.5), (1.0, 0.8), (2.0, 0.8)] {
            let v = eval_expr(&e.replace('T', &format!("{t}")));
            assert!((v - want).abs() < 1e-6, "t={t} got {v} want {want}");
        }
    }

    /// Minimal FFmpeg-expression evaluator covering exactly the constructs
    /// `key_expr` emits: numbers, if(lt(a,b),x,y), + - * / and parens.
    fn eval_expr(s: &str) -> f64 {
        let s = s.trim();
        if s.starts_with("if(") {
            let inner = &s[3..s.len() - 1];
            let parts = split_top(inner, ',');
            assert_eq!(parts.len(), 3, "bad if: {s}");
            let cond = parts[0].trim();
            assert!(cond.starts_with("lt("), "cond: {cond}");
            let cb = &cond[3..cond.len() - 1];
            let (l, r) = cb.split_once(',').expect("lt needs two args");
            return if eval_expr(l) < eval_expr(r) {
                eval_expr(&parts[1])
            } else {
                eval_expr(&parts[2])
            };
        }
        // Addition/subtraction at top level (scan right-to-left for
        // left associativity).
        let chars: Vec<char> = s.chars().collect();
        let mut depth = 0i32;
        for i in (0..chars.len()).rev() {
            match chars[i] {
                ')' => depth += 1,
                '(' => depth -= 1,
                '+' | '-' if depth == 0 && i > 0 => {
                    if chars[i - 1].is_ascii_digit() || chars[i - 1] == ')' {
                        let l = eval_expr(&s[..i]);
                        let r = eval_expr(&s[i + 1..]);
                        return if chars[i] == '+' { l + r } else { l - r };
                    }
                }
                _ => {}
            }
        }
        // Multiplication/division.
        for i in 0..chars.len() {
            match chars[i] {
                '(' => depth += 1,
                ')' => depth -= 1,
                '*' | '/' if depth == 0 => {
                    let l = eval_expr(&s[..i]);
                    let r = eval_expr(&s[i + 1..]);
                    return if chars[i] == '*' { l * r } else { l / r };
                }
                _ => {}
            }
        }
        if s.starts_with('(') {
            return eval_expr(
                s.strip_prefix('(')
                    .and_then(|r| r.strip_suffix(')'))
                    .unwrap_or(s),
            );
        }
        s.parse()
            .unwrap_or_else(|_| panic!("cannot evaluate leaf: {s}"))
    }

    fn split_top(s: &str, sep: char) -> Vec<String> {
        let mut out = Vec::new();
        let mut depth = 0i32;
        let mut cur = String::new();
        for c in s.chars() {
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            if c == sep && depth == 0 {
                out.push(cur.clone());
                cur.clear();
            } else {
                cur.push(c);
            }
        }
        out.push(cur);
        out
    }

    #[test]
    fn static_fragment_is_wellformed() {
        let frag = build_region_blur_fragment(
            &json!({
                "x": 0.5, "y": 0.5, "w": 0.3, "h": 0.2,
                "rotation": 0.0, "shape": "rect",
                "intensity": 0.5, "feather": 0.08, "opacity": 1.0
            }),
            1920,
            1080,
            5.0,
        )
        .expect("static fragment");
        // No per-frame expressions needed for a static region.
        assert!(!frag.contains("lt(T,"), "static region must not emit T ifs");
        assert!(frag.contains("gblur=sigma="));
        assert!(frag.contains("alphamerge"));
        assert!(frag.starts_with("pad="));
        // Fragment must end unlabeled so the caller can append `,setpts=...`.
        assert!(!frag.trim_end().ends_with(']'));
    }

    #[test]
    fn keyframed_fragment_encodes_motion() {
        let frag = build_region_blur_fragment(
            &json!({
                "x": 0.5, "y": 0.5, "w": 0.3, "h": 0.2,
                "intensity": 0.5, "feather": 0.08, "opacity": 1.0,
                "keyframes": [
                    { "t": 0.0, "x": 0.3, "y": 0.4 },
                    { "t": 2.0, "x": 0.7, "y": 0.6 }
                ]
            }),
            1920,
            1080,
            3.0,
        )
        .expect("keyframed fragment");
        assert!(frag.contains("lt(T,"), "position must animate via T");
    }

    #[test]
    fn degenerate_params_produce_no_fragment() {
        let frag = build_region_blur_fragment(
            &json!({ "x": 0.5, "y": 0.5, "w": 0.3, "h": 0.2, "intensity": 0.0 }),
            1920,
            1080,
            5.0,
        );
        assert!(frag.is_none());
    }

    #[test]
    fn resample_bounds_expression_size() {
        let keys: Vec<Key> = (0..100).map(|i| (i as f64 * 0.1, i as f64)).collect();
        let r = resample(&keys, MAX_MASK_KEYS);
        assert_eq!(r.len(), MAX_MASK_KEYS);
        assert_eq!(r[0].0, 0.0);
        assert!((r[MAX_MASK_KEYS - 1].0 - 9.9).abs() < 1e-6);
    }
}
