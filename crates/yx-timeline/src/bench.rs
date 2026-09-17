//! Engine benchmarks — repeatable regression gates (run with `cargo test -p
//! yx-timeline --test-features -- --ignored --nocapture --test-threads=1`,
//! or just `cargo test -p yx-timeline bench -- --ignored --nocapture`).
//!
//! These measure the pure-model costs that sit behind every UI edit:
//! command application, the undo snapshot clone, and the serde_json
//! serialization that becomes the Tauri IPC payload. Budgets are generous
//! ceilings that catch order-of-magnitude regressions; the printed numbers
//! are the real evidence.

use super::*;
use std::time::{Duration, Instant};

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn build_project(n_pairs: usize) -> (TimelineEditor, Vec<ClipId>) {
    let mut ed = TimelineEditor::new();
    let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
    let a1 = ed.timeline.first_track(TrackKind::Audio).unwrap();
    let mut ids = Vec::with_capacity(n_pairs);
    for i in 0..n_pairs {
        let start = (i as f64) * 4.0;
        let res = ed
            .apply(EditCommand::AddAvPair {
                video_track_id: v1,
                audio_track_id: a1,
                media_path: format!("clip{i}.mp4"),
                source_path: None,
                start,
                in_point: 0.0,
                out_point: 4.0,
            })
            .unwrap();
        ids.push(res.primary_clip_id.unwrap());
    }
    (ed, ids)
}

fn report(name: &str, value_ms: f64, budget_ms: f64) {
    println!("{name:<44} {value_ms:8.3} ms   (budget {budget_ms:.1} ms)");
}

#[test]
#[ignore] // run explicitly: cargo test -p yx-timeline -- --ignored --nocapture
fn bench_engine_scale() {
    // Warm up allocator.
    let (mut ed_warm, warm_ids) = build_project(50);
    ed_warm.apply(EditCommand::MoveClip {
        clip_id: warm_ids[0],
        new_start: 0.0,
        sync_linked: true,
        target_track_id: None,
    })
    .unwrap();

    for &n in &[100usize, 500] {
        println!("=== project: {n} AV pairs (2 clips each) ===");
        let (mut ed, ids) = build_project(n);

        // --- single edit commands ---
        let t0 = Instant::now();
        for _ in 0..25 {
            ed.apply(EditCommand::MoveClip {
                clip_id: ids[n / 2],
                new_start: (n as f64) * 2.0,
                sync_linked: true,
                target_track_id: None,
            })
            .unwrap();
            ed.apply(EditCommand::MoveClip {
                clip_id: ids[n / 2],
                new_start: (n as f64 / 2.0) * 4.0,
                sync_linked: true,
                target_track_id: None,
            })
            .unwrap();
        }
        let per_op = ms(t0.elapsed()) / 50.0;
        report("move_clip (linked, round-trip)", per_op, 10.0);
        assert!(per_op < 10.0, "move regressed at {n} clips: {per_op}ms");

        let clip = ids[n / 2];
        let t0 = Instant::now();
        for i in 0..25 {
            ed.apply(EditCommand::TrimClip {
                clip_id: clip,
                in_point: (i as f64) * 0.01,
                out_point: 3.5 + (i as f64) * 0.01,
                keep_end: false,
                sync_linked: true,
            })
            .unwrap();
        }
        let per_op = ms(t0.elapsed()) / 25.0;
        report("trim_clip", per_op, 10.0);
        assert!(per_op < 10.0, "trim regressed at {n} clips: {per_op}ms");

        let t0 = Instant::now();
        for i in 0..25 {
            let at = (n as f64 / 2.0) * 4.0 + 1.0 + (i as f64) * 0.02;
            ed.apply(EditCommand::SplitClip {
                clip_id: clip,
                at,
                sync_linked: true,
            })
            .unwrap();
            ed.undo().unwrap();
        }
        let per_op = ms(t0.elapsed()) / 25.0;
        report("split + undo (one cycle)", per_op, 15.0);
        assert!(per_op < 15.0, "split regressed at {n} clips: {per_op}ms");

        // --- undo snapshot cost (deep clone behind every apply) ---
        let t0 = Instant::now();
        for _ in 0..100 {
            let snapshot = ed.timeline.clone();
            std::hint::black_box(&snapshot);
        }
        let per_clone = ms(t0.elapsed()) / 100.0;
        report("timeline clone (undo push cost)", per_clone, 8.0);
        assert!(per_clone < 8.0, "clone regressed at {n} clips: {per_clone}ms");

        // --- IPC payload serialization ---
        let t0 = Instant::now();
        for _ in 0..20 {
            let json = serde_json::to_string(&ed.timeline).unwrap();
            std::hint::black_box(&json);
        }
        let per_ser = ms(t0.elapsed()) / 20.0;
        let json = serde_json::to_string(&ed.timeline).unwrap();
        let kb = json.len() as f64 / 1024.0;
        report("serde serialize → IPC payload", per_ser, 30.0);
        println!("{:<44} {:8.1} KB   (payload size)", "IPC payload size", kb);
        assert!(per_ser < 30.0, "serialize regressed at {n} clips");

        // --- deserialize (frontend receive side of the same cost) ---
        let t0 = Instant::now();
        for _ in 0..20 {
            let back: Timeline = serde_json::from_str(&json).unwrap();
            std::hint::black_box(&back);
        }
        let per_de = ms(t0.elapsed()) / 20.0;
        report("serde deserialize (IPC receive)", per_de, 30.0);
        assert!(per_de < 30.0, "deserialize regressed at {n} clips");

        // --- validation ---
        let t0 = Instant::now();
        for _ in 0..100 {
            std::hint::black_box(ed.timeline.validate());
        }
        let per_val = ms(t0.elapsed()) / 100.0;
        report("timeline validate()", per_val, 5.0);

        // --- undo/redo storm ---
        let t0 = Instant::now();
        let steps = 50.min(ed.undo.len());
        for _ in 0..steps {
            ed.undo().unwrap();
        }
        for _ in 0..steps {
            ed.redo().unwrap();
        }
        let per_cycle = ms(t0.elapsed()) / (steps as f64);
        report("undo+redo step (avg)", per_cycle, 8.0);
        assert!(per_cycle < 8.0, "undo/redo regressed at {n} clips");
        println!();
    }
}
