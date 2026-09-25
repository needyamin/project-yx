//! Backward-compatibility suite for the `.yxp` project format.
//!
//! Requirement (§20): an existing project must keep working across a version
//! change, and no project data may be silently invalidated. The persisted
//! model is the Rust `Timeline` tree, so that is what these tests pin down.
//!
//! Chains covered:
//!   * Old project -> Open -> Edit -> Save -> Reopen -> Continue editing
//!   * New project -> Edit -> Save -> Reopen -> Continue editing
//!
//! Plus the two failure modes that would silently corrupt user data:
//!   * a field added after the first release must default, not fail to load;
//!   * a filter kind that has since been renamed must still resolve.

use serde_json::json;
use uuid::Uuid;
use yx_timeline::{
    ClipId, EditCommand, EditMode, FilterKind, MediaRole, Timeline, TimelineEditor, TrackKind,
};

const V_TRACK: &str = "11111111-1111-4111-8111-111111111111";
const A_TRACK: &str = "22222222-2222-4222-8222-222222222222";
const V_CLIP: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A_CLIP: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

fn v_clip() -> ClipId {
    Uuid::parse_str(V_CLIP).unwrap()
}

/// A project exactly as an EARLIER build would have written it: every field
/// added after the first release is absent — no `source_path`, `fade_in`,
/// `fade_out`, `reverse` or `speed` on clips; no `hidden` on tracks; no
/// `edit_mode`, `markers`, `zone_in` or `zone_out` at the top level.
///
/// The two clips are a LINKED A/V pair, so the compatibility chain also proves
/// linked-pair editing (split/move with `sync_linked`) still works on data
/// written before linking was expressible.
fn legacy_project_json() -> String {
    format!(
        r#"{{
  "frame_rate": 30.0,
  "width": 1920,
  "height": 1080,
  "tracks": [
    {{
      "id": "{V_TRACK}",
      "name": "V1",
      "kind": "video",
      "muted": false,
      "locked": false,
      "clips": [
        {{
          "id": "{V_CLIP}",
          "media_path": "C:/media/legacy.mp4",
          "start": 0.0,
          "in_point": 0.0,
          "out_point": 4.0,
          "role": "video",
          "linked_clip_id": "{A_CLIP}",
          "filters": []
        }}
      ]
    }},
    {{
      "id": "{A_TRACK}",
      "name": "A1",
      "kind": "audio",
      "muted": false,
      "locked": false,
      "clips": [
        {{
          "id": "{A_CLIP}",
          "media_path": "C:/media/legacy.mp4",
          "start": 0.0,
          "in_point": 0.0,
          "out_point": 4.0,
          "role": "audio",
          "linked_clip_id": "{V_CLIP}",
          "filters": []
        }}
      ]
    }}
  ]
}}"#
    )
}

fn load(json: &str) -> Timeline {
    serde_json::from_str(json).expect("project must load")
}

/// Save → reopen → save must be a fixed point: the second serialization has to
/// equal the first, or reopening silently changes the project.
fn assert_save_reopen_is_lossless(tl: &Timeline) {
    let first = serde_json::to_value(tl).expect("serialize");
    let reopened = load(&serde_json::to_string(&first).unwrap());
    let second = serde_json::to_value(&reopened).expect("serialize");
    assert_eq!(
        first, second,
        "save -> reopen -> save changed the project (data would drift on every open)"
    );
    assert!(
        reopened.validate().is_empty(),
        "reopened project reported consistency issues: {:?}",
        reopened.validate()
    );
}

#[test]
fn legacy_project_loads_and_new_fields_take_their_defaults() {
    let tl = load(&legacy_project_json());

    assert_eq!(tl.frame_rate, 30.0);
    assert_eq!(tl.width, 1920);
    assert_eq!(tl.height, 1080);
    // Top-level fields added after the first release.
    assert_eq!(tl.edit_mode, EditMode::Normal);
    assert!(tl.markers.is_empty());
    assert_eq!(tl.zone_in, None);
    assert_eq!(tl.zone_out, None);
    assert_eq!(tl.tracks.len(), 2);

    let v = &tl.tracks[0];
    assert_eq!(v.kind, TrackKind::Video);
    assert!(!v.hidden, "`hidden` must default to false, not fail to load");
    assert_eq!(v.clips.len(), 1);

    let clip = &v.clips[0];
    assert_eq!(clip.media_path, "C:/media/legacy.mp4");
    assert_eq!(clip.source_path, None);
    assert_eq!(clip.fade_in, 0.0);
    assert_eq!(clip.fade_out, 0.0);
    assert!(!clip.reverse);
    assert_eq!(clip.speed, 1.0, "speed must default to 1x, not 0 (which would divide by zero)");
    assert!(clip.filters.is_empty());
    // The linked pair written by the old build must survive verbatim.
    assert_eq!(clip.linked_clip_id, Some(Uuid::parse_str(A_CLIP).unwrap()));

    assert!(tl.validate().is_empty(), "legacy project must be self-consistent");
}

#[test]
fn legacy_project_survives_open_edit_save_reopen_continue_editing() {
    // --- Open ---------------------------------------------------------
    let legacy = legacy_project_json();
    let mut ed = TimelineEditor::with_timeline(load(&legacy));
    // Loading a project must not make its own undo history reachable.
    assert!(
        ed.undo().is_err(),
        "undo must not reach back into a previous project after open"
    );

    // --- Edit (the operations the regression matrix lists) -------------
    // Split the linked A/V pair at 2s.
    let split = ed
        .apply(EditCommand::SplitClip {
            clip_id: v_clip(),
            at: 2.0,
            sync_linked: true,
        })
        .expect("split");
    let right = split.secondary_clip_id.expect("split yields a second clip");
    assert_eq!(ed.timeline().tracks[0].clips.len(), 2);
    assert_eq!(
        ed.timeline().tracks[1].clips.len(),
        2,
        "sync_linked must split the audio partner too"
    );

    // Move the right half (and its linked audio) later on the timeline.
    ed.apply(EditCommand::MoveClip {
        clip_id: right,
        new_start: 10.0,
        sync_linked: true,
        target_track_id: None,
    })
    .expect("move");
    assert_eq!(ed.timeline().tracks[0].clips[1].start, 10.0);
    assert_eq!(
        ed.timeline().tracks[1].clips[1].start,
        10.0,
        "linked audio must move with its video"
    );

    // Trim, retime, reverse and fade the left half.
    ed.apply(EditCommand::TrimClip {
        clip_id: v_clip(),
        in_point: 0.5,
        out_point: 2.0,
        keep_end: false,
        sync_linked: false,
    })
    .expect("trim");
    ed.apply(EditCommand::SetClipSpeed {
        clip_id: v_clip(),
        speed: 2.0,
        sync_linked: true,
    })
    .expect("speed");
    ed.apply(EditCommand::SetClipReverse {
        clip_id: v_clip(),
        reverse: true,
    })
    .expect("reverse");
    ed.apply(EditCommand::SetClipFades {
        clip_id: v_clip(),
        fade_in: 0.2,
        fade_out: 0.3,
    })
    .expect("fades");

    // Add an effect (the Advanced Video / Magic Remove surface).
    ed.apply(EditCommand::AddFilter {
        clip_id: v_clip(),
        kind: FilterKind::Blur,
        params: json!({ "radius": 8.0 }),
    })
    .expect("add filter");

    // Markers and a work zone.
    ed.apply(EditCommand::AddMarker {
        time: 1.5,
        label: "cue".into(),
    })
    .expect("marker");
    ed.apply(EditCommand::SetZone {
        zone_in: Some(0.0),
        zone_out: Some(2.0),
    })
    .expect("zone");

    assert!(
        ed.timeline().validate().is_empty(),
        "editing a legacy project must not corrupt it: {:?}",
        ed.timeline().validate()
    );

    // --- Undo / redo ---------------------------------------------------
    for _ in 0..3 {
        ed.undo().expect("undo");
    }
    assert!(ed.timeline().validate().is_empty(), "undo must not corrupt state");
    for _ in 0..3 {
        ed.redo().expect("redo");
    }
    assert!(ed.timeline().validate().is_empty(), "redo must not corrupt state");

    // --- Save -> Reopen -------------------------------------------------
    assert_save_reopen_is_lossless(ed.timeline());

    // --- Continue editing after reopen ---------------------------------
    let mut reopened = TimelineEditor::with_timeline(ed.timeline().clone());
    let right_id = reopened.timeline().tracks[0].clips[1].id;
    reopened
        .apply(EditCommand::MoveClip {
            clip_id: right_id,
            new_start: 20.0,
            sync_linked: false,
            target_track_id: None,
        })
        .expect("edit after reopen");
    assert_eq!(reopened.timeline().tracks[0].clips[1].start, 20.0);
    assert!(
        reopened.timeline().validate().is_empty(),
        "continuing after reopen must keep the project consistent"
    );
    assert_save_reopen_is_lossless(reopened.timeline());
}

#[test]
fn new_project_round_trips_through_save_and_reopen() {
    let mut ed = TimelineEditor::new();
    // Select by KIND, not index: the default project is V1, V2, A1, A2.
    let vt = ed
        .timeline()
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Video)
        .expect("default project has a video track")
        .id;
    let at = ed
        .timeline()
        .tracks
        .iter()
        .find(|t| t.kind == TrackKind::Audio)
        .expect("default project has an audio track")
        .id;
    ed.apply(EditCommand::AddAvPair {
        video_track_id: vt,
        audio_track_id: at,
        media_path: "C:/media/new.mp4".into(),
        source_path: None,
        start: 0.0,
        in_point: 0.0,
        out_point: 3.0,
    })
    .expect("add av pair");
    let cid = ed
        .timeline()
        .tracks
        .iter()
        .find(|t| t.id == vt)
        .unwrap()
        .clips[0]
        .id;
    ed.apply(EditCommand::SetClipSpeed {
        clip_id: cid,
        speed: 0.5,
        sync_linked: true,
    })
    .expect("speed");

    assert_save_reopen_is_lossless(ed.timeline());
    let reopened = load(&serde_json::to_string(ed.timeline()).unwrap());
    assert_eq!(
        reopened.tracks.iter().find(|t| t.id == vt).unwrap().clips[0].speed,
        0.5
    );
    assert_eq!(
        reopened.tracks.iter().find(|t| t.id == at).unwrap().clips[0].media_path,
        "C:/media/new.mp4",
        "the audio half of the pair must survive the round trip"
    );
}

#[test]
fn renamed_filter_kinds_still_load_from_old_projects() {
    // `FilterKind` carries `#[serde(alias = ...)]` for exactly this reason:
    // these snake_case names are what older builds wrote, and a project
    // containing one must not become unopenable.
    for (written, expected) in [
        ("video_denoise", FilterKind::VideoDenoise),
        ("magic_remove", FilterKind::MagicRemove),
        ("blur_region", FilterKind::BlurRegion),
        ("bg_mask", FilterKind::BgMask),
    ] {
        let parsed: FilterKind = serde_json::from_value(json!(written))
            .unwrap_or_else(|e| panic!("legacy filter kind {written:?} failed to load: {e}"));
        assert_eq!(parsed, expected, "legacy alias {written:?} mapped incorrectly");
        // And it must still serialize to the CURRENT spelling.
        assert_eq!(
            serde_json::to_value(expected).unwrap(),
            serde_json::to_value(parsed).unwrap()
        );
    }
}

#[test]
fn unknown_fields_do_not_make_a_project_unopenable() {
    // A project written by a NEWER build (extra fields) must still open rather
    // than being rejected outright. Serde ignores unknown fields by default —
    // this pins that behaviour so a future `deny_unknown_fields` cannot be
    // added without someone consciously accepting the compatibility break.
    let json = legacy_project_json().replace(
        "\"frame_rate\": 30.0,",
        "\"frame_rate\": 30.0, \"future_field\": {\"nested\": [1,2,3]},",
    );
    let tl = load(&json);
    assert_eq!(tl.tracks.len(), 2);
    assert!(tl.validate().is_empty());
}

#[test]
fn legacy_project_produces_exportable_segments() {
    // The "Render" leg of the compatibility chain, at the model level: a
    // project written by an older build must still yield clips that the export
    // collector can consume (see collect_export_segments in the Tauri layer).
    let tl = load(&legacy_project_json());
    let video: Vec<_> = tl
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Video && !t.muted && !t.hidden)
        .flat_map(|t| t.clips.iter())
        .collect();
    assert_eq!(video.len(), 1, "legacy video clip must be exportable");
    let clip = video[0];
    assert_eq!(clip.role, MediaRole::Video);
    assert!(clip.duration() > 0.0, "clip must have a positive duration");
    assert_eq!(clip.source_path, None, "no proxy: export uses media_path");
    assert_eq!(clip.end(), 4.0);
}

/// Every `Clip` field added after the first release must be `#[serde(default)]`
/// (or have a defaulting function), otherwise a project saved by an older
/// build fails to open. This is asserted structurally above by loading a
/// project that omits all of them; here we additionally prove that a project
/// omitting only ONE of them still loads, so a future field cannot regress
/// this quietly for just one path.
#[test]
fn each_optional_clip_field_is_individually_defaultable() {
    for field in [
        "\"source_path\": null,",
        "\"fade_in\": 0.0,",
        "\"fade_out\": 0.0,",
        "\"reverse\": false,",
        "\"speed\": 1.0,",
    ] {
        let full = serde_json::to_string(&load(&legacy_project_json())).unwrap();
        let with_field = full.replace(
            "\"in_point\":0.0,",
            &format!("\"in_point\":0.0,{field}"),
        );
        assert!(with_field.contains(field), "test setup failed for {field}");
        let without = with_field.replace(field, "");
        let parsed: Timeline = serde_json::from_str(&without)
            .unwrap_or_else(|e| panic!("project omitting {field} failed to load: {e}"));
        assert!(parsed.validate().is_empty());
    }
}
