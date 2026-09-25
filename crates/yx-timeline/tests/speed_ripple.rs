//! Smart-timeline regression suite: duration / speed / gap / overlap / ripple.
//!
//! A playback-rate change is a **duration** change, so it has to obey the same
//! rules as trim and move: it must not leave an accidental gap in ripple mode,
//! it must not silently overlap a neighbour in absolute-position mode, and a
//! linked A/V pair must change rate together or it desynchronises.
//!
//! Every test here corresponds to a defect that was reproducible before the
//! engine treated a speed change as a timeline operation. The pre-fix
//! behaviour, measured directly:
//!
//! * speed up in Insert mode   -> `A[0,2) B[2,4) C[6,8)` — a 2 s accidental gap
//! * speed down in Normal mode -> `A[0,2) B[2,10) C[6,8)` — B overlapped C and
//!   `apply()` returned `Ok`
//! * linked pair, video at 2x  -> `V[0,2) A[0,4)` — audio left at 1x
//! * `validate()` reported `[]` in all three cases, so nothing downstream
//!   could have noticed.

use serde_json::json;
use uuid::Uuid;
use yx_timeline::{
    Clip, ClipId, EditCommand, EditMode, FilterInstance, FilterKind, MediaRole, Timeline,
    TimelineEditor, TimelineError, TrackId, TrackKind,
};

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

fn add_clip(ed: &mut TimelineEditor, track: TrackId, name: &str, start: f64, dur: f64) -> ClipId {
    add_clip_as(ed, track, name, start, dur, MediaRole::Video)
}

fn add_clip_as(
    ed: &mut TimelineEditor,
    track: TrackId,
    name: &str,
    start: f64,
    dur: f64,
    role: MediaRole,
) -> ClipId {
    ed.apply(EditCommand::AddClip {
        track_id: track,
        media_path: name.into(),
        source_path: None,
        start,
        in_point: 0.0,
        out_point: dur,
        role,
        linked_clip_id: None,
    })
    .unwrap()
    .primary_clip_id
    .unwrap()
}

/// `A[0,2) B[2,6) C[6,8)` on the first video track.
///
/// `SetEditMode` is only issued for a non-default mode, so the last edit in the
/// history is always "add C" — which the undo tests rely on.
fn three_clips(mode: EditMode) -> (TimelineEditor, TrackId, ClipId, ClipId, ClipId) {
    let mut ed = TimelineEditor::new();
    let v1 = ed.timeline().first_track(TrackKind::Video).unwrap();
    let a = add_clip(&mut ed, v1, "A.mp4", 0.0, 2.0);
    let b = add_clip(&mut ed, v1, "B.mp4", 2.0, 4.0);
    let c = add_clip(&mut ed, v1, "C.mp4", 6.0, 2.0);
    if mode != EditMode::Normal {
        ed.apply(EditCommand::SetEditMode { mode }).unwrap();
    }
    (ed, v1, a, b, c)
}

fn clip(ed: &TimelineEditor, track: TrackId, id: ClipId) -> Clip {
    ed.timeline()
        .tracks
        .iter()
        .find(|t| t.id == track)
        .unwrap()
        .clips
        .iter()
        .find(|c| c.id == id)
        .unwrap()
        .clone()
}

fn span(c: &Clip) -> (f64, f64) {
    (c.start, c.end())
}

fn set_speed(
    ed: &mut TimelineEditor,
    id: ClipId,
    speed: f64,
    sync_linked: bool,
) -> Result<(), TimelineError> {
    ed.apply(EditCommand::SetClipSpeed {
        clip_id: id,
        speed,
        sync_linked,
    })
    .map(|_| ())
}

/// Two clips on one track that overlap on purpose (used to prove `validate()`
/// catches overlaps it is supposed to catch).
fn timeline_with_overlap(with_transition: bool) -> Timeline {
    let mut tl = Timeline::new_hd();
    let v1 = tl.first_track(TrackKind::Video).unwrap();
    let mk = |name: &str, start: f64, out: f64, filters: Vec<FilterInstance>| Clip {
        id: Uuid::new_v4(),
        media_path: name.into(),
        source_path: None,
        start,
        in_point: 0.0,
        out_point: out,
        role: MediaRole::Video,
        linked_clip_id: None,
        fade_in: 0.0,
        fade_out: 0.0,
        reverse: false,
        speed: 1.0,
        filters,
    };
    let transition = FilterInstance {
        id: Uuid::new_v4(),
        kind: FilterKind::Transition,
        enabled: true,
        params: json!({ "kind": "dissolve", "duration": 1.0 }),
    };
    let track = tl.tracks.iter_mut().find(|t| t.id == v1).unwrap();
    track.clips.push(mk("P.mp4", 0.0, 4.0, vec![]));
    // Q starts at 3.0 -> overlaps P by 1 s.
    track
        .clips
        .push(mk("Q.mp4", 3.0, 4.0, if with_transition { vec![transition] } else { vec![] }));
    tl
}

/* ------------------------------------------------------------------ */
/* §23 — a speed change is a duration edit                             */
/* ------------------------------------------------------------------ */

#[test]
fn speed_up_closes_the_gap_in_ripple_mode() {
    let (mut ed, v1, _a, b, c) = three_clips(EditMode::Insert);
    // B is 4 s of source; at 2x it becomes 2 s of timeline.
    set_speed(&mut ed, b, 2.0, false).expect("ripple mode must accept the change");

    assert_eq!(span(&clip(&ed, v1, b)), (2.0, 4.0));
    // The freed 2 s is closed up by rippling the follower left.
    assert_eq!(
        span(&clip(&ed, v1, c)).0,
        4.0,
        "C must ripple left to close the gap"
    );
    assert!(ed.timeline().validate().is_empty());
}

#[test]
fn speed_up_preserves_neighbour_positions_in_normal_mode() {
    let (mut ed, v1, _a, b, c) = three_clips(EditMode::Normal);
    set_speed(&mut ed, b, 2.0, false).expect("shrinking never collides");

    assert_eq!(span(&clip(&ed, v1, b)), (2.0, 4.0));
    // Absolute-position mode: the neighbour must NOT move. The resulting gap is
    // the user's layout, not corruption — §28 forbids closing it silently.
    assert_eq!(
        span(&clip(&ed, v1, c)).0,
        6.0,
        "C must stay put in Normal mode"
    );
    assert!(ed.timeline().validate().is_empty());
}

#[test]
fn speed_down_into_a_neighbour_is_rejected_in_normal_mode() {
    let (mut ed, v1, _a, b, _c) = three_clips(EditMode::Normal);
    let before = json!(ed.timeline());
    let before_c = span(&clip(&ed, v1, _c));

    // B is 4 s of source; at 0.5x it needs 8 s -> 2..10, colliding with C at 6.
    let err = set_speed(&mut ed, b, 0.5, false).expect_err("must not silently overlap");
    match err {
        TimelineError::Conflict(msg) => {
            assert!(msg.contains("C.mp4"), "conflict must name the clip: {msg}");
            assert!(msg.contains("Insert"), "conflict must say how to proceed: {msg}");
        }
        other => panic!("expected a Conflict, got {other:?}"),
    }

    // A rejected edit is a complete no-op, including the layout...
    assert_eq!(json!(ed.timeline()), before, "rejected edit changed the timeline");
    assert_eq!(span(&clip(&ed, v1, _c)), before_c);
    assert!(ed.timeline().validate().is_empty());
}

#[test]
fn a_rejected_speed_change_leaves_no_undo_step() {
    let (mut ed, _v1, _a, b, _c) = three_clips(EditMode::Normal);
    set_speed(&mut ed, b, 0.5, false).expect_err("rejected");

    // The rejected edit pushed a snapshot and rolled it back, so undo must now
    // revert the *previous* successful edit (adding C), not the rejection.
    ed.undo().expect("undo the last real edit");
    let names: Vec<&str> = ed
        .timeline()
        .tracks
        .iter()
        .flat_map(|t| t.clips.iter())
        .map(|c| c.media_path.as_str())
        .collect();
    assert!(
        !names.contains(&"C.mp4"),
        "undo after a rejected edit should have removed C, got {names:?}"
    );
}

#[test]
fn speed_down_pushes_followers_in_ripple_mode() {
    let (mut ed, v1, _a, b, c) = three_clips(EditMode::Insert);
    set_speed(&mut ed, b, 0.5, false).expect("ripple mode makes room");

    assert_eq!(span(&clip(&ed, v1, b)), (2.0, 10.0));
    // C is pushed right by the 4 s the clip grew.
    assert_eq!(span(&clip(&ed, v1, c)).0, 10.0, "C must be pushed right");
    assert!(ed.timeline().validate().is_empty());
}

#[test]
fn overwrite_mode_consumes_the_grown_range() {
    let (mut ed, v1, _a, b, c) = three_clips(EditMode::Overwrite);
    set_speed(&mut ed, b, 0.5, false).expect("overwrite mode consumes the range");

    assert_eq!(span(&clip(&ed, v1, b)), (2.0, 10.0));
    // C sat entirely inside the consumed [6, 10) range, so it is gone.
    let remaining: Vec<&str> = ed
        .timeline()
        .tracks
        .iter()
        .find(|t| t.id == v1)
        .unwrap()
        .clips
        .iter()
        .map(|c| c.media_path.as_str())
        .collect();
    assert!(
        !remaining.contains(&"C.mp4"),
        "overwrite mode should have consumed C, got {remaining:?}"
    );
    let _ = c;
    assert!(ed.timeline().validate().is_empty());
}

#[test]
fn speed_is_clamped_to_the_supported_range() {
    // Ripple mode so the extreme speeds are resolved rather than refused: a
    // 4 s clip at 0.25x needs 16 s, which would collide in absolute mode.
    let (mut ed, v1, _a, b, _c) = three_clips(EditMode::Insert);
    // Absurd speeds are clamped, never accepted as-is.
    set_speed(&mut ed, b, 99.0, false).unwrap();
    assert_eq!(clip(&ed, v1, b).speed, 4.0);
    set_speed(&mut ed, b, 0.001, false).unwrap();
    assert_eq!(clip(&ed, v1, b).speed, 0.25);
    set_speed(&mut ed, b, f64::NAN, false).unwrap();
    assert_eq!(clip(&ed, v1, b).speed, 1.0);
    assert!(ed.timeline().validate().is_empty());
}

/* ------------------------------------------------------------------ */
/* §25 — linked audio/video                                            */
/* ------------------------------------------------------------------ */

fn av_pair(speed_start: f64, dur: f64) -> (TimelineEditor, TrackId, TrackId, ClipId, ClipId) {
    let mut ed = TimelineEditor::new();
    let v1 = ed.timeline().first_track(TrackKind::Video).unwrap();
    let a1 = ed.timeline().first_track(TrackKind::Audio).unwrap();
    ed.apply(EditCommand::AddAvPair {
        video_track_id: v1,
        audio_track_id: a1,
        media_path: "pair.mp4".into(),
        source_path: None,
        start: speed_start,
        in_point: 0.0,
        out_point: dur,
    })
    .unwrap();
    let v = ed.timeline().tracks.iter().find(|t| t.id == v1).unwrap().clips[0].id;
    let a = ed.timeline().tracks.iter().find(|t| t.id == a1).unwrap().clips[0].id;
    (ed, v1, a1, v, a)
}

#[test]
fn speed_change_keeps_a_linked_av_pair_in_sync() {
    let (mut ed, v1, a1, v, a) = av_pair(0.0, 4.0);
    set_speed(&mut ed, v, 2.0, true).expect("speed the pair");

    let vc = clip(&ed, v1, v);
    let ac = clip(&ed, a1, a);
    assert_eq!(vc.speed, 2.0);
    assert_eq!(
        ac.speed, 2.0,
        "the linked audio must change rate with the video"
    );
    assert_eq!(
        (vc.start, vc.end()),
        (ac.start, ac.end()),
        "the pair must still occupy the same span"
    );
    assert!(ed.timeline().validate().is_empty());
}

#[test]
fn speed_change_can_leave_the_partner_alone_when_asked() {
    // Explicit opt-out (e.g. the user deliberately retimes one half).
    let (mut ed, v1, a1, v, a) = av_pair(0.0, 4.0);
    set_speed(&mut ed, v, 2.0, false).expect("unsynced speed");

    assert_eq!(clip(&ed, v1, v).speed, 2.0);
    assert_eq!(clip(&ed, a1, a).speed, 1.0, "partner must be untouched");
}

#[test]
fn a_locked_partner_track_refuses_the_synced_speed_change() {
    let (mut ed, _v1, a1, v, _a) = av_pair(0.0, 4.0);
    ed.apply(EditCommand::SetTrackLock {
        track_id: a1,
        locked: true,
    })
    .unwrap();

    let err = set_speed(&mut ed, v, 2.0, true).expect_err("locked partner must refuse");
    assert!(matches!(err, TimelineError::TrackLocked));
    // Nothing may have been applied to the video half either.
    assert_eq!(clip(&ed, _v1, v).speed, 1.0, "the pair must be all-or-nothing");
}

#[test]
fn speed_change_respects_a_locked_clip_track() {
    let (mut ed, v1, _a, b, _c) = three_clips(EditMode::Normal);
    ed.apply(EditCommand::SetTrackLock {
        track_id: v1,
        locked: true,
    })
    .unwrap();
    assert!(matches!(
        set_speed(&mut ed, b, 2.0, false),
        Err(TimelineError::TrackLocked)
    ));
}

/* ------------------------------------------------------------------ */
/* §29 — track-aware ripple                                            */
/* ------------------------------------------------------------------ */

#[test]
fn ripple_does_not_move_clips_on_other_tracks() {
    let (mut ed, v1, _a, b, _c) = three_clips(EditMode::Insert);
    let a1 = ed.timeline().first_track(TrackKind::Audio).unwrap();
    let music = add_clip_as(&mut ed, a1, "music.mp3", 0.0, 30.0, MediaRole::Audio);

    set_speed(&mut ed, b, 2.0, false).unwrap();

    // Only the edited track ripples: a background music bed must stay exactly
    // where the user placed it.
    let m = clip(&ed, a1, music);
    assert_eq!((m.start, m.end()), (0.0, 30.0), "music must not move");
    let _ = v1;
    assert!(ed.timeline().validate().is_empty());
}

/* ------------------------------------------------------------------ */
/* §30 — undo / redo / persistence                                     */
/* ------------------------------------------------------------------ */

#[test]
fn speed_change_is_exactly_undoable_and_redoable() {
    let (mut ed, _v1, _a, b, _c) = three_clips(EditMode::Insert);
    let before = json!(ed.timeline());

    set_speed(&mut ed, b, 2.0, false).unwrap();
    let after = json!(ed.timeline());
    assert_ne!(before, after);

    ed.undo().unwrap();
    assert_eq!(json!(ed.timeline()), before, "undo must restore exactly");

    ed.redo().unwrap();
    assert_eq!(json!(ed.timeline()), after, "redo must restore exactly");
    assert!(ed.timeline().validate().is_empty());
}

#[test]
fn speed_change_survives_save_and_reload() {
    let (mut ed, v1, _a, b, c) = three_clips(EditMode::Insert);
    set_speed(&mut ed, b, 2.0, false).unwrap();
    let saved = json!(ed.timeline());

    let reloaded: Timeline = serde_json::from_value(saved.clone()).expect("reload");
    assert_eq!(json!(&reloaded), saved, "reload must be lossless");
    assert!(reloaded.validate().is_empty());

    // Continuing to edit after a reload must still be consistent.
    let mut ed2 = TimelineEditor::with_timeline(reloaded);
    let b2 = ed2
        .timeline()
        .tracks
        .iter()
        .find(|t| t.id == v1)
        .unwrap()
        .clips
        .iter()
        .find(|c| c.media_path == "B.mp4")
        .unwrap()
        .id;
    set_speed(&mut ed2, b2, 4.0, false).unwrap();
    assert_eq!(span(&clip(&ed2, v1, b2)).1, 3.0);
    let _ = c;
    assert!(ed2.timeline().validate().is_empty());
}

/* ------------------------------------------------------------------ */
/* §27 / §30 — conflict detection and invariants                       */
/* ------------------------------------------------------------------ */

#[test]
fn validate_detects_an_overlap_without_a_transition() {
    let issues = timeline_with_overlap(false).validate();
    assert!(
        issues.iter().any(|i| i.contains("overlaps")),
        "an unjustified overlap must be reported, got {issues:?}"
    );
}

#[test]
fn a_transition_covered_overlap_is_legal() {
    // `AddTransition` deliberately slides a clip over its predecessor, so the
    // validator must not treat that as corruption — otherwise every real
    // transition would make the project uneditable.
    let issues = timeline_with_overlap(true).validate();
    assert!(issues.is_empty(), "a transition overlap is intentional: {issues:?}");
}

#[test]
fn a_manual_overlap_is_refused_by_the_engine() {
    // The invariant gate makes the model self-protecting: even an edit that
    // would create an unjustified overlap is rolled back.
    let mut ed = TimelineEditor::new();
    let v1 = ed.timeline().first_track(TrackKind::Video).unwrap();
    add_clip(&mut ed, v1, "P.mp4", 0.0, 4.0);

    let err = ed
        .apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "Q.mp4".into(),
            source_path: None,
            start: 3.0, // overlaps P
            in_point: 0.0,
            out_point: 4.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .expect_err("overlapping insert must be refused");
    assert!(
        matches!(err, TimelineError::InvalidResult(_)),
        "expected InvalidResult, got {err:?}"
    );
    assert_eq!(
        ed.timeline().tracks.iter().find(|t| t.id == v1).unwrap().clips.len(),
        1,
        "the refused clip must not have been added"
    );
    assert!(ed.timeline().validate().is_empty());
}

#[test]
fn extending_a_trim_into_a_neighbour_is_refused() {
    // Same invariant, reached through trim instead of speed.
    let (mut ed, v1, _a, b, _c) = three_clips(EditMode::Normal);
    let before = json!(ed.timeline());
    let err = ed
        .apply(EditCommand::TrimClip {
            clip_id: b,
            in_point: 0.0,
            out_point: 8.0, // 8 s from 2.0 -> collides with C at 6
            keep_end: false,
            sync_linked: false,
        })
        .expect_err("extending into C must be refused");
    assert!(matches!(err, TimelineError::InvalidResult(_)), "got {err:?}");
    assert_eq!(json!(ed.timeline()), before);
    let _ = v1;
}

/* ------------------------------------------------------------------ */
/* §26 — transitions                                                   */
/* ------------------------------------------------------------------ */

#[test]
fn transition_is_reclamped_when_its_clip_shrinks() {
    let mut ed = TimelineEditor::new();
    let v1 = ed.timeline().first_track(TrackKind::Video).unwrap();
    let _a = add_clip(&mut ed, v1, "A.mp4", 0.0, 4.0);
    let b = add_clip(&mut ed, v1, "B.mp4", 4.0, 8.0);
    ed.apply(EditCommand::AddTransition {
        clip_id: b,
        duration: 1.0,
    })
    .unwrap();

    let before = clip(&ed, v1, b);
    let t_before = transition_duration(&before).expect("transition created");
    assert!(t_before > 0.0);

    // Speed B up 8x: its 8 s of source becomes 1 s of timeline, far shorter
    // than the crossfade it carried.
    set_speed(&mut ed, b, 4.0, false).unwrap();

    let after = clip(&ed, v1, b);
    let t_after = transition_duration(&after).expect("transition still present");
    assert!(
        t_after <= after.duration() * 0.4 + 1e-6,
        "transition ({t_after}) must not outlive the clip it belongs to ({})",
        after.duration()
    );
    assert!(ed.timeline().validate().is_empty());
}

fn transition_duration(c: &Clip) -> Option<f64> {
    c.filters
        .iter()
        .find(|f| f.kind == FilterKind::Transition && f.enabled)
        .and_then(|f| f.params.get("duration"))
        .and_then(|v| v.as_f64())
}

/* ------------------------------------------------------------------ */
/* §31 — aggressive speed sweep                                        */
/* ------------------------------------------------------------------ */

#[test]
fn every_speed_leaves_a_valid_timeline_in_every_mode() {
    // 0.1x and 99x are included on purpose: they exercise the clamp.
    let speeds = [0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 4.0, 99.0];
    for mode in [EditMode::Normal, EditMode::Insert, EditMode::Overwrite] {
        for speed in speeds {
            for sync in [false, true] {
                let (mut ed, _v1, _a, b, _c) = three_clips(mode);
                let before = json!(ed.timeline());
                match set_speed(&mut ed, b, speed, sync) {
                    Ok(()) => {
                        let issues = ed.timeline().validate();
                        assert!(
                            issues.is_empty(),
                            "mode={mode:?} speed={speed} sync={sync} left an invalid timeline: {issues:?}"
                        );
                    }
                    Err(TimelineError::Conflict(_)) | Err(TimelineError::InvalidResult(_)) => {
                        // Refusing is fine; silently changing the timeline is not.
                        assert_eq!(
                            json!(ed.timeline()),
                            before,
                            "mode={mode:?} speed={speed} sync={sync}: a refused edit must be a no-op"
                        );
                    }
                    Err(other) => panic!("mode={mode:?} speed={speed}: unexpected {other:?}"),
                }
            }
        }
    }
}

#[test]
fn no_speed_sequence_can_ever_produce_an_overlap() {
    // Drive a longer edit chain per §31: speed -> speed -> trim -> move -> undo.
    for mode in [EditMode::Normal, EditMode::Insert] {
        let (mut ed, v1, _a, b, c) = three_clips(mode);
        for speed in [2.0, 0.5, 4.0, 0.25, 1.0] {
            let _ = set_speed(&mut ed, b, speed, false);
            assert!(
                ed.timeline().validate().is_empty(),
                "mode={mode:?} after speed {speed}: {:?}",
                ed.timeline().validate()
            );
        }
        // A move must still be legal afterwards.
        let _ = ed.apply(EditCommand::MoveClip {
            clip_id: c,
            new_start: 30.0,
            sync_linked: false,
            target_track_id: None,
        });
        assert!(ed.timeline().validate().is_empty());
        // And undo must unwind cleanly.
        while ed.undo().is_ok() {}
        assert!(ed.timeline().validate().is_empty());
        let _ = v1;
    }
}
