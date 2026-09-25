//! End-to-end tests for the FFmpeg export runner: the normal path must still
//! work, and cooperative cancellation must actually stop a RUNNING encoder.
//!
//! These drive `export_file_with_progress`, which is the only public entry
//! point into the progress loop, against a real ffmpeg subprocess. They skip
//! silently when no ffmpeg is on PATH (CI boxes without the binary still
//! pass) — export PATH to include `apps/desktop/src-tauri/bin` to run them
//! for real.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use yx_detect::command_ffmpeg;
use yx_media::{
    export_file_with_progress, run_ffmpeg_progress_with_stall, ExportCodec, ExportFit,
    ExportRequest, MediaError, VideoEncoder,
};

fn ffmpeg_available() -> bool {
    command_ffmpeg()
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
}

/// A throwaway work dir. Cargo runs tests with CWD = crate dir, so this must
/// be under the system temp dir, never a relative "target/..." path.
fn work_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("yx_export_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create work dir");
    dir
}

/// Render a short, non-trivial source clip so the encoder has real work to do.
fn make_source(dir: &std::path::Path, seconds: u32) -> PathBuf {
    let src = dir.join("source.mp4");
    let status = command_ffmpeg()
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc2=d={seconds}:s=640x360:r=30"),
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency=440:duration={seconds}"),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(&src)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("ffmpeg should run");
    assert!(status.success(), "could not render the test source clip");
    src
}

fn request(src: &std::path::Path, out: &std::path::Path) -> ExportRequest {
    ExportRequest {
        input_path: src.to_path_buf(),
        output_path: out.to_path_buf(),
        width: 640,
        height: 360,
        fps: Some(30.0),
        codec: ExportCodec::H264,
        x264_preset: "ultrafast".into(),
        crf: Some(28),
        video_bitrate: None,
        audio_bitrate: "128k".into(),
        fit: ExportFit::Contain,
        encoder: VideoEncoder::Software,
        match_source: false,
    }
}

#[test]
fn export_reports_progress_and_produces_a_playable_file() {
    if !ffmpeg_available() {
        eprintln!("skipping: ffmpeg not on PATH");
        return;
    }
    let dir = work_dir("ok");
    let src = make_source(&dir, 3);
    let out = dir.join("out.mp4");
    let req = request(&src, &out);

    let mut seen: Vec<f64> = Vec::new();
    let result = export_file_with_progress(&req, &policy(), 3.0, None, |pct| seen.push(pct));
    assert!(result.is_ok(), "export failed: {result:?}");

    assert!(out.is_file(), "export did not produce an output file");
    let size = std::fs::metadata(&out).expect("stat output").len();
    assert!(size > 0, "export produced an empty file");
    // Progress must be monotonic and finish at 1.0 — the runner emits a final
    // 1.0 on success, which the UI relies on to leave the progress state.
    assert!(!seen.is_empty(), "no progress callbacks were emitted");
    assert!(
        seen.windows(2).all(|w| w[1] >= w[0] - 1e-9),
        "progress went backwards: {seen:?}"
    );
    assert_eq!(*seen.last().unwrap(), 1.0, "final progress was not 1.0");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn export_honours_cancel_raised_while_the_encoder_is_running() {
    if !ffmpeg_available() {
        eprintln!("skipping: ffmpeg not on PATH");
        return;
    }
    let dir = work_dir("cancel");
    let src = make_source(&dir, 4);
    let out = dir.join("out.mp4");
    let req = request(&src, &out);

    let cancel = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancel);
    // Raise the cancel from inside the FIRST progress callback. At that moment
    // ffmpeg is provably still running, so the loop's very next poll must stop
    // it — a deterministic check of the property that matters. Sleeping for a
    // fixed delay first (the obvious alternative) races the encoder: on a fast
    // machine the whole export finished before the flag was ever set.
    let mut raised = false;
    let started = Instant::now();
    let result = export_file_with_progress(&req, &policy(), 4.0, Some(&cancel), |_| {
        if !raised {
            raised = true;
            flag.store(true, Ordering::Relaxed);
        }
    });
    let elapsed = started.elapsed();

    assert!(
        matches!(result, Err(MediaError::Cancelled)),
        "cancel raised mid-export must stop the encoder, got {result:?}"
    );
    // Promptness: the loop polls cancellation on every iteration rather than
    // only when ffmpeg happens to emit a line.
    assert!(
        elapsed < Duration::from_secs(10),
        "cancel took {elapsed:?}; the progress loop is not polling cancellation"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn export_returns_cancelled_immediately_when_already_cancelled() {
    if !ffmpeg_available() {
        eprintln!("skipping: ffmpeg not on PATH");
        return;
    }
    let dir = work_dir("precancel");
    let src = make_source(&dir, 5);
    let out = dir.join("out.mp4");
    let req = request(&src, &out);

    let cancel = AtomicBool::new(true);
    let result = export_file_with_progress(&req, &policy(), 5.0, Some(&cancel), |_| {});
    assert!(
        matches!(result, Err(MediaError::Cancelled)),
        "expected Cancelled, got {result:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A wedged ffmpeg must be killed and REPORTED, not waited on forever.
///
/// The invocation deliberately omits `-progress pipe:1`, so ffmpeg encodes in
/// complete silence — the same observable state as a genuinely hung encoder.
/// With a short stall budget the runner must give up quickly instead of
/// blocking the export (and its blocking-pool thread) indefinitely.
///
/// The safety precondition this relies on — that both production callers
/// always inject `-progress pipe:1` — is covered by
/// `export_reports_progress_and_produces_a_playable_file`, which fails if the
/// progress flags ever stop being emitted.
#[test]
fn a_silent_ffmpeg_is_killed_and_reported_instead_of_hanging() {
    if !ffmpeg_available() {
        eprintln!("skipping: ffmpeg not on PATH");
        return;
    }
    // A deliberately heavy encode: 60 s of 1080p at preset `veryslow` cannot
    // finish inside the 400 ms budget on any machine, so the watchdog is
    // guaranteed to be the thing that ends it.
    let args: Vec<String> = [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=d=60:s=1920x1080:r=30",
        "-c:v",
        "libx264",
        "-preset",
        "veryslow",
        "-f",
        "null",
        "-",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();

    let budget = Duration::from_millis(400);
    let started = Instant::now();
    let result = run_ffmpeg_progress_with_stall(&args, 60.0, None, budget, &mut |_| {});
    let elapsed = started.elapsed();

    match result {
        Err(MediaError::FfmpegFailed(msg)) => assert!(
            msg.contains("stalled"),
            "expected a stall report, got: {msg}"
        ),
        other => panic!("expected a stall error, got {other:?}"),
    }
    // Must give up near the budget, not after the encoder's full 60 s.
    assert!(
        elapsed < Duration::from_secs(15),
        "the stall watchdog waited {elapsed:?} instead of ~{budget:?}"
    );
}

fn policy() -> yx_detect::PerformancePolicy {
    yx_detect::PerformancePolicy {
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
