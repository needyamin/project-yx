//! Smoke tests: run the region-blur / bgmask export fragments through a real
//! FFmpeg filtergraph (lavfi testsrc input) so graph syntax regressions are
//! caught at test time. Skips silently when no ffmpeg is on PATH — CI boxes
//! without the binary still pass.

use serde_json::json;
use std::path::PathBuf;
use yx_detect::command_ffmpeg;

fn ffmpeg_available() -> bool {
    command_ffmpeg()
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
}

/// Run `[0:v]<fragment>[out]` over a short lavfi clip. Null muxer: this test
/// validates the graph, not the container.
fn run_graph(fc: String) {
    let status = command_ffmpeg()
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=d=0.5:s=320x240:r=15",
            "-filter_complex",
            &format!("[0:v]{fc}[out]"),
            "-map",
            "[out]",
            "-t",
            "0.5",
            "-f",
            "null",
            "-",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("ffmpeg should run");
    assert!(
        status.success(),
        "ffmpeg rejected the generated filtergraph:\n{fc}"
    );
}

#[test]
fn region_blur_fragment_graph_is_valid() {
    if !ffmpeg_available() {
        return;
    }
    for params in [
        json!({
            "x": 0.5, "y": 0.5, "w": 0.4, "h": 0.3,
            "shape": "rect", "intensity": 0.5,
            "feather": 0.08, "opacity": 1.0
        }),
        json!({
            "x": 0.4, "y": 0.6, "w": 0.3, "h": 0.25,
            "rotation": 30.0, "shape": "rounded",
            "cornerRadius": 0.2,
            "intensity": 0.4, "feather": 0.1, "opacity": 0.8
        }),
        json!({
            "x": 0.5, "y": 0.5, "w": 0.35, "h": 0.2,
            "shape": "ellipse", "intensity": 0.7,
            "feather": 0.05, "opacity": 1.0
        }),
        json!({
            "x": 0.5, "y": 0.5, "w": 0.3, "h": 0.3,
            "shape": "rect", "intensity": 0.5,
            "feather": 0.08, "opacity": 1.0,
            "keyframes": [
                { "t": 0.0, "x": 0.3, "y": 0.4, "w": 0.25, "h": 0.2,
                  "rotation": 0.0, "intensity": 0.4, "feather": 0.08, "opacity": 1.0 },
                { "t": 0.5, "x": 0.6, "y": 0.6, "w": 0.3, "h": 0.3,
                  "rotation": 20.0, "intensity": 0.7, "feather": 0.05, "opacity": 0.9 }
            ]
        }),
    ] {
        let frag = yx_media::region::build_region_blur_fragment(&params, 320, 240, 0.5)
            .expect("fragment should build");
        run_graph(frag);
    }
}

#[test]
fn bgmask_fragment_graph_is_valid() {
    if !ffmpeg_available() {
        return;
    }
    // A source-resolution mask file (the UI writes these via save_bg_mask).
    let mask = std::env::temp_dir().join("yx-region-smoke-mask.png");
    let ok = command_ffmpeg()
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=white:s=320x240",
            "-frames:v",
            "1",
        ])
        .arg(&mask)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    assert!(ok, "could not create test mask png");

    let escaped = mask
        .display()
        .to_string()
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'");
    let chain = format!(
        "format=rgba[bgs0];movie='{escaped}',scale=320:240,format=gray,setsar=1[bgm0];[bgs0][bgm0]alphamerge"
    );
    run_graph(chain);
    let _ = PathBuf::new();
}
