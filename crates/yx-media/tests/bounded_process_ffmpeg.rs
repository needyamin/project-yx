//! Regression tests for `run_bounded` — the deadline wrapper around one-shot
//! ffmpeg/ffprobe invocations.
//!
//! `Command::output()` waits forever, and every call site it replaces runs on
//! a thread the UI is waiting on (import probe, thumbnail, audio preview,
//! recording finalize). A wedged decoder or an unreadable path therefore
//! produced an operation that never finished and never explained itself.
//!
//! Skips silently when no ffmpeg is on PATH — export PATH to include
//! `apps/desktop/src-tauri/bin` to run these for real.

use std::time::{Duration, Instant};

use yx_detect::command_ffmpeg;
use yx_media::{run_bounded, MediaError};

fn ffmpeg_available() -> bool {
    command_ffmpeg()
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
}

#[test]
fn bounded_run_returns_output_for_a_fast_command() {
    if !ffmpeg_available() {
        eprintln!("skipping: ffmpeg not on PATH");
        return;
    }
    let mut cmd = command_ffmpeg();
    cmd.arg("-version");
    let out = run_bounded(&mut cmd, Duration::from_secs(30), "ffmpeg -version")
        .expect("a fast command must succeed");
    assert!(out.status.success());
    // The happy path must still hand back both streams — `-version` prints to
    // stdout, and callers that parse it would silently break if the reader
    // threads dropped their buffers.
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("ffmpeg version"),
        "stdout was not captured"
    );
}

#[test]
fn bounded_run_kills_a_command_that_overruns_its_deadline() {
    if !ffmpeg_available() {
        eprintln!("skipping: ffmpeg not on PATH");
        return;
    }
    // 60 s of 1080p at preset `veryslow` cannot finish inside 400 ms on any
    // machine, so the deadline is guaranteed to be what ends it.
    let mut cmd = command_ffmpeg();
    cmd.args([
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
    ]);
    let budget = Duration::from_millis(400);
    let started = Instant::now();
    let result = run_bounded(&mut cmd, budget, "slow encode");
    let elapsed = started.elapsed();

    match result {
        Err(MediaError::FfmpegFailed(msg)) => {
            assert!(msg.contains("did not finish"), "unexpected message: {msg}")
        }
        other => panic!("expected a deadline error, got {other:?}"),
    }
    // Must give up near the budget, not after the encoder's full 60 s.
    assert!(
        elapsed < Duration::from_secs(15),
        "the deadline was not enforced: waited {elapsed:?} for a {budget:?} budget"
    );
}

#[test]
fn bounded_run_reports_a_spawn_failure_instead_of_panicking() {
    // A missing binary must surface as an error (the UI shows it), never as a
    // panic that would take the whole command down.
    let mut cmd = std::process::Command::new("yx-definitely-not-a-real-binary-42");
    let result = run_bounded(&mut cmd, Duration::from_secs(5), "missing binary");
    assert!(
        matches!(result, Err(MediaError::FfmpegFailed(_))),
        "a spawn failure must be reported as FfmpegFailed, got {result:?}"
    );
}
