//! Pure timeline model — no FFmpeg, no GPU, no filesystem I/O.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use thiserror::Error;
use uuid::Uuid;

pub type ClipId = Uuid;
pub type TrackId = Uuid;

#[derive(Debug, Error)]
pub enum TimelineError {
    #[error("track not found: {0}")]
    TrackNotFound(TrackId),
    #[error("clip not found: {0}")]
    ClipNotFound(ClipId),
    #[error("invalid range: in={in_point} out={out_point}")]
    InvalidRange { in_point: f64, out_point: f64 },
    #[error("track is locked")]
    TrackLocked,
    #[error("media type does not match track kind")]
    MediaTrackMismatch,
    #[error("cannot remove the last {0} track")]
    LastTrack(&'static str),
    #[error("nothing to undo")]
    NothingToUndo,
    #[error("nothing to redo")]
    NothingToRedo,
}

/// What stream(s) a media file contributes when placed on the timeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaRole {
    Video,
    Audio,
}

/// Timeline edit tool mode (Kdenlive-style insert / overwrite).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditMode {
    #[default]
    Normal,
    Insert,
    Overwrite,
}

/// Which edge of a clip a ripple trim targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrimEdge {
    Left,
    Right,
}

/// A named cue on the timeline ruler.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Marker {
    pub id: Uuid,
    pub time: f64,
    pub label: String,
}

/// A media reference placed on a track. Times are seconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Clip {
    pub id: ClipId,
    pub media_path: String,
    /// Position on the timeline (seconds).
    pub start: f64,
    /// Source in-point (seconds).
    pub in_point: f64,
    /// Source out-point (seconds), exclusive.
    pub out_point: f64,
    pub role: MediaRole,
    /// Linked partner clip (video↔audio). Kept in sync for move/trim/split.
    pub linked_clip_id: Option<ClipId>,
    pub filters: Vec<FilterInstance>,
}

impl Clip {
    pub fn duration(&self) -> f64 {
        (self.out_point - self.in_point).max(0.0)
    }

    pub fn end(&self) -> f64 {
        self.start + self.duration()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterInstance {
    pub id: Uuid,
    pub kind: FilterKind,
    pub enabled: bool,
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterKind {
    Exposure,
    Contrast,
    Lut,
    Crop,
    Fade,
    Text,
    /// Heavy filters — may be skipped in potato-tier preview.
    Blur,
    Denoise,
}

impl FilterKind {
    pub fn is_heavy(self) -> bool {
        matches!(self, Self::Blur | Self::Denoise | Self::Lut)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackKind {
    Video,
    Audio,
}

impl TrackKind {
    pub fn accepts(self, role: MediaRole) -> bool {
        matches!(
            (self, role),
            (TrackKind::Video, MediaRole::Video) | (TrackKind::Audio, MediaRole::Audio)
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: TrackId,
    pub name: String,
    pub kind: TrackKind,
    pub muted: bool,
    pub locked: bool,
    #[serde(default)]
    pub hidden: bool,
    pub clips: Vec<Clip>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Timeline {
    pub frame_rate: f64,
    pub width: u32,
    pub height: u32,
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub edit_mode: EditMode,
    #[serde(default)]
    pub markers: Vec<Marker>,
    #[serde(default)]
    pub zone_in: Option<f64>,
    #[serde(default)]
    pub zone_out: Option<f64>,
}

impl Default for Timeline {
    fn default() -> Self {
        Self::new_hd()
    }
}

impl Timeline {
    pub fn new_hd() -> Self {
        let mut tl = Self {
            frame_rate: 30.0,
            width: 1920,
            height: 1080,
            tracks: Vec::new(),
            edit_mode: EditMode::Normal,
            markers: Vec::new(),
            zone_in: None,
            zone_out: None,
        };
        tl.add_track("V1", TrackKind::Video);
        tl.add_track("V2", TrackKind::Video);
        tl.add_track("A1", TrackKind::Audio);
        tl.add_track("A2", TrackKind::Audio);
        tl
    }

    pub fn add_track(&mut self, name: &str, kind: TrackKind) -> TrackId {
        let id = Uuid::new_v4();
        let track = Track {
            id,
            name: name.to_string(),
            kind,
            muted: false,
            locked: false,
            hidden: false,
            clips: Vec::new(),
        };
        match kind {
            TrackKind::Video => {
                // Keep video tracks above audio tracks.
                let insert_at = self
                    .tracks
                    .iter()
                    .position(|t| t.kind == TrackKind::Audio)
                    .unwrap_or(self.tracks.len());
                self.tracks.insert(insert_at, track);
            }
            TrackKind::Audio => self.tracks.push(track),
        }
        id
    }

    pub fn first_track(&self, kind: TrackKind) -> Option<TrackId> {
        self.tracks.iter().find(|t| t.kind == kind).map(|t| t.id)
    }

    pub fn duration(&self) -> f64 {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .map(|c| c.end())
            .fold(0.0_f64, f64::max)
    }

    fn track_mut(&mut self, track_id: TrackId) -> Result<&mut Track, TimelineError> {
        self.tracks
            .iter_mut()
            .find(|t| t.id == track_id)
            .ok_or(TimelineError::TrackNotFound(track_id))
    }

    fn find_clip(&self, clip_id: ClipId) -> Result<(&Track, usize), TimelineError> {
        for track in &self.tracks {
            if let Some(idx) = track.clips.iter().position(|c| c.id == clip_id) {
                return Ok((track, idx));
            }
        }
        Err(TimelineError::ClipNotFound(clip_id))
    }

    fn find_clip_mut(&mut self, clip_id: ClipId) -> Result<(&mut Track, usize), TimelineError> {
        for track in &mut self.tracks {
            if let Some(idx) = track.clips.iter().position(|c| c.id == clip_id) {
                return Ok((track, idx));
            }
        }
        Err(TimelineError::ClipNotFound(clip_id))
    }

    fn sort_track(track: &mut Track) {
        track.clips.sort_by(|a, b| {
            a.start
                .partial_cmp(&b.start)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
}

/// Commands that mutate the timeline and support undo/redo via snapshots.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EditCommand {
    AddClip {
        track_id: TrackId,
        media_path: String,
        start: f64,
        in_point: f64,
        out_point: f64,
        role: MediaRole,
        linked_clip_id: Option<ClipId>,
    },
    /// Atomically add linked video + audio clips (one undo step).
    AddAvPair {
        video_track_id: TrackId,
        audio_track_id: TrackId,
        media_path: String,
        start: f64,
        in_point: f64,
        out_point: f64,
    },
    RemoveClip {
        clip_id: ClipId,
        /// Also remove the linked partner when true.
        remove_linked: bool,
    },
    /// Delete clip and shift later clips on the same track left.
    RippleDelete {
        clip_id: ClipId,
        remove_linked: bool,
    },
    TrimClip {
        clip_id: ClipId,
        in_point: f64,
        out_point: f64,
        /// When true, keep timeline start fixed and only change source range / duration.
        /// Left-edge trim also moves `start` so the right edge stays put unless ripple.
        keep_end: bool,
        sync_linked: bool,
    },
    MoveClip {
        clip_id: ClipId,
        new_start: f64,
        sync_linked: bool,
    },
    SplitClip {
        clip_id: ClipId,
        /// Absolute timeline time where the cut happens.
        at: f64,
        sync_linked: bool,
    },
    LinkClips {
        clip_a: ClipId,
        clip_b: ClipId,
    },
    UnlinkClip {
        clip_id: ClipId,
    },
    SetTrackMute {
        track_id: TrackId,
        muted: bool,
    },
    SetTrackLock {
        track_id: TrackId,
        locked: bool,
    },
    SetTrackHidden {
        track_id: TrackId,
        hidden: bool,
    },
    AddTrack {
        kind: TrackKind,
        name: Option<String>,
    },
    RemoveTrack {
        track_id: TrackId,
    },
    AddFilter {
        clip_id: ClipId,
        kind: FilterKind,
        params: serde_json::Value,
    },
    /// Slide source in/out by `delta` while keeping duration and timeline start fixed.
    SlipClip {
        clip_id: ClipId,
        delta: f64,
        sync_linked: bool,
    },
    /// Shift clips with `start >= at` by `delta` on one track, or all unlocked tracks.
    SpacerShift {
        track_id: Option<TrackId>,
        at: f64,
        delta: f64,
    },
    /// Trim an edge to an absolute timeline time and ripple following clips.
    RippleTrim {
        clip_id: ClipId,
        edge: TrimEdge,
        new_edge_time: f64,
        sync_linked: bool,
    },
    SetEditMode {
        mode: EditMode,
    },
    AddMarker {
        time: f64,
        label: String,
    },
    RemoveMarker {
        marker_id: Uuid,
    },
    SetZone {
        zone_in: Option<f64>,
        zone_out: Option<f64>,
    },
    /// Remove overlapping clip portions in `[zone_in, zone_out)`, leaving a gap.
    LiftZone,
    /// Lift the zone, then close the gap on all unlocked tracks.
    ExtractZone,
}

/// Result of applying a command that may create multiple clips.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditResult {
    pub primary_clip_id: Option<ClipId>,
    pub secondary_clip_id: Option<ClipId>,
}

/// Timeline + undo stack.
#[derive(Debug, Default)]
pub struct TimelineEditor {
    timeline: Timeline,
    undo: VecDeque<Timeline>,
    redo: VecDeque<Timeline>,
    max_history: usize,
}

impl TimelineEditor {
    pub fn new() -> Self {
        Self {
            timeline: Timeline::new_hd(),
            undo: VecDeque::new(),
            redo: VecDeque::new(),
            max_history: 100,
        }
    }

    pub fn timeline(&self) -> &Timeline {
        &self.timeline
    }

    pub fn apply(&mut self, cmd: EditCommand) -> Result<EditResult, TimelineError> {
        self.push_undo();
        self.redo.clear();
        let result = self.apply_inner(cmd);
        if result.is_err() {
            // Roll back the optimistic undo push.
            if let Some(prev) = self.undo.pop_back() {
                self.timeline = prev;
            }
        }
        result
    }

    fn apply_inner(&mut self, cmd: EditCommand) -> Result<EditResult, TimelineError> {
        match cmd {
            EditCommand::AddClip {
                track_id,
                media_path,
                start,
                in_point,
                out_point,
                role,
                linked_clip_id,
            } => {
                let id = self.insert_clip(
                    track_id,
                    media_path,
                    start,
                    in_point,
                    out_point,
                    role,
                    linked_clip_id,
                )?;
                Ok(EditResult {
                    primary_clip_id: Some(id),
                    secondary_clip_id: None,
                })
            }
            EditCommand::AddAvPair {
                video_track_id,
                audio_track_id,
                media_path,
                start,
                in_point,
                out_point,
            } => {
                let video_id = Uuid::new_v4();
                let audio_id = Uuid::new_v4();
                self.insert_clip_with_id(
                    video_track_id,
                    video_id,
                    media_path.clone(),
                    start,
                    in_point,
                    out_point,
                    MediaRole::Video,
                    Some(audio_id),
                )?;
                self.insert_clip_with_id(
                    audio_track_id,
                    audio_id,
                    media_path,
                    start,
                    in_point,
                    out_point,
                    MediaRole::Audio,
                    Some(video_id),
                )?;
                Ok(EditResult {
                    primary_clip_id: Some(video_id),
                    secondary_clip_id: Some(audio_id),
                })
            }
            EditCommand::RemoveClip {
                clip_id,
                remove_linked,
            } => {
                self.remove_clip_inner(clip_id, remove_linked)?;
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
            EditCommand::RippleDelete {
                clip_id,
                remove_linked,
            } => {
                let (track_id, start, dur, linked) = {
                    let (track, idx) = self.timeline.find_clip(clip_id)?;
                    if track.locked {
                        return Err(TimelineError::TrackLocked);
                    }
                    let clip = &track.clips[idx];
                    (track.id, clip.start, clip.duration(), clip.linked_clip_id)
                };
                self.remove_clip_inner(clip_id, false)?;
                self.shift_clips_after(track_id, start, -dur)?;
                if remove_linked {
                    if let Some(link) = linked {
                        if let Ok((ltrack, lidx)) = self.timeline.find_clip(link) {
                            let (ltid, lstart, ldur) =
                                (ltrack.id, ltrack.clips[lidx].start, ltrack.clips[lidx].duration());
                            let _ = self.remove_clip_inner(link, false);
                            let _ = self.shift_clips_after(ltid, lstart, -ldur);
                        }
                    }
                }
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
            EditCommand::TrimClip {
                clip_id,
                in_point,
                out_point,
                keep_end,
                sync_linked,
            } => {
                if out_point <= in_point {
                    return Err(TimelineError::InvalidRange {
                        in_point,
                        out_point,
                    });
                }
                let linked = {
                    let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
                    if track.locked {
                        return Err(TimelineError::TrackLocked);
                    }
                    let clip = &mut track.clips[idx];
                    let old_in = clip.in_point;
                    let old_out = clip.out_point;
                    let old_dur = clip.duration();
                    clip.in_point = in_point;
                    clip.out_point = out_point;
                    if keep_end {
                        // Left trim: push start forward so the right edge stays fixed.
                        let new_dur = clip.duration();
                        clip.start = (clip.start + (old_dur - new_dur)).max(0.0);
                    } else {
                        // Right trim or free trim: keep start; duration follows out-in.
                        let _ = (old_in, old_out);
                    }
                    clip.linked_clip_id
                };
                if sync_linked {
                    if let Some(link) = linked {
                        let _ = self.apply_trim_values(link, in_point, out_point, keep_end);
                    }
                }
                Ok(EditResult {
                    primary_clip_id: Some(clip_id),
                    secondary_clip_id: linked,
                })
            }
            EditCommand::MoveClip {
                clip_id,
                new_start,
                sync_linked,
            } => {
                // Insert/Overwrite move ripples are deferred for this phase.
                let linked = {
                    let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
                    if track.locked {
                        return Err(TimelineError::TrackLocked);
                    }
                    let linked = track.clips[idx].linked_clip_id;
                    track.clips[idx].start = new_start.max(0.0);
                    Timeline::sort_track(track);
                    linked
                };
                if sync_linked {
                    if let Some(link) = linked {
                        if let Ok((track, idx)) = self.timeline.find_clip_mut(link) {
                            if !track.locked {
                                track.clips[idx].start = new_start.max(0.0);
                                Timeline::sort_track(track);
                            }
                        }
                    }
                }
                Ok(EditResult {
                    primary_clip_id: Some(clip_id),
                    secondary_clip_id: linked,
                })
            }
            EditCommand::SplitClip {
                clip_id,
                at,
                sync_linked,
            } => {
                let (right_id, linked) = self.split_one(clip_id, at)?;
                let mut secondary = None;
                if sync_linked {
                    if let Some(link) = linked {
                        if let Ok((rid, _)) = self.split_one(link, at) {
                            // Re-link the right-hand pair.
                            if let Ok((t, i)) = self.timeline.find_clip_mut(right_id) {
                                t.clips[i].linked_clip_id = Some(rid);
                            }
                            if let Ok((t, i)) = self.timeline.find_clip_mut(rid) {
                                t.clips[i].linked_clip_id = Some(right_id);
                            }
                            secondary = Some(rid);
                        }
                    }
                }
                Ok(EditResult {
                    primary_clip_id: Some(right_id),
                    secondary_clip_id: secondary,
                })
            }
            EditCommand::LinkClips { clip_a, clip_b } => {
                {
                    let (t, i) = self.timeline.find_clip_mut(clip_a)?;
                    t.clips[i].linked_clip_id = Some(clip_b);
                }
                {
                    let (t, i) = self.timeline.find_clip_mut(clip_b)?;
                    t.clips[i].linked_clip_id = Some(clip_a);
                }
                Ok(EditResult {
                    primary_clip_id: Some(clip_a),
                    secondary_clip_id: Some(clip_b),
                })
            }
            EditCommand::UnlinkClip { clip_id } => {
                let linked = {
                    let (t, i) = self.timeline.find_clip_mut(clip_id)?;
                    let link = t.clips[i].linked_clip_id.take();
                    link
                };
                if let Some(link) = linked {
                    if let Ok((t, i)) = self.timeline.find_clip_mut(link) {
                        t.clips[i].linked_clip_id = None;
                    }
                }
                Ok(EditResult {
                    primary_clip_id: Some(clip_id),
                    secondary_clip_id: linked,
                })
            }
            EditCommand::SetTrackMute { track_id, muted } => {
                let track = self.timeline.track_mut(track_id)?;
                track.muted = muted;
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
            EditCommand::SetTrackLock { track_id, locked } => {
                let track = self.timeline.track_mut(track_id)?;
                track.locked = locked;
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
            EditCommand::SetTrackHidden { track_id, hidden } => {
                let track = self.timeline.track_mut(track_id)?;
                track.hidden = hidden;
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
            EditCommand::AddTrack { kind, name } => {
                let count = self
                    .timeline
                    .tracks
                    .iter()
                    .filter(|t| t.kind == kind)
                    .count()
                    + 1;
                let label = name.unwrap_or_else(|| match kind {
                    TrackKind::Video => format!("V{count}"),
                    TrackKind::Audio => format!("A{count}"),
                });
                self.timeline.add_track(&label, kind);
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
            EditCommand::RemoveTrack { track_id } => {
                let kind = {
                    let track = self
                        .timeline
                        .tracks
                        .iter()
                        .find(|t| t.id == track_id)
                        .ok_or(TimelineError::TrackNotFound(track_id))?;
                    if track.locked {
                        return Err(TimelineError::TrackLocked);
                    }
                    track.kind
                };
                let same_kind = self
                    .timeline
                    .tracks
                    .iter()
                    .filter(|t| t.kind == kind)
                    .count();
                if same_kind <= 1 {
                    return Err(TimelineError::LastTrack(match kind {
                        TrackKind::Video => "video",
                        TrackKind::Audio => "audio",
                    }));
                }
                let removed_links: Vec<ClipId> = self
                    .timeline
                    .tracks
                    .iter()
                    .find(|t| t.id == track_id)
                    .map(|t| {
                        t.clips
                            .iter()
                            .filter_map(|c| c.linked_clip_id)
                            .collect()
                    })
                    .unwrap_or_default();
                self.timeline.tracks.retain(|t| t.id != track_id);
                for link in removed_links {
                    if let Ok((track, idx)) = self.timeline.find_clip_mut(link) {
                        track.clips[idx].linked_clip_id = None;
                    }
                }
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
            EditCommand::AddFilter {
                clip_id,
                kind,
                params,
            } => {
                let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
                track.clips[idx].filters.push(FilterInstance {
                    id: Uuid::new_v4(),
                    kind,
                    enabled: true,
                    params,
                });
                Ok(EditResult {
                    primary_clip_id: Some(clip_id),
                    secondary_clip_id: None,
                })
            }
            EditCommand::SlipClip {
                clip_id,
                delta,
                sync_linked,
            } => {
                let linked = self.slip_one(clip_id, delta)?;
                if sync_linked {
                    if let Some(link) = linked {
                        let _ = self.slip_one(link, delta);
                    }
                }
                Ok(EditResult {
                    primary_clip_id: Some(clip_id),
                    secondary_clip_id: linked,
                })
            }
            EditCommand::SpacerShift {
                track_id,
                at,
                delta,
            } => {
                match track_id {
                    Some(tid) => {
                        let track = self.timeline.track_mut(tid)?;
                        if track.locked {
                            return Err(TimelineError::TrackLocked);
                        }
                        self.shift_clips_after(tid, at, delta)?;
                    }
                    None => {
                        let ids: Vec<TrackId> = self
                            .timeline
                            .tracks
                            .iter()
                            .filter(|t| !t.locked)
                            .map(|t| t.id)
                            .collect();
                        for tid in ids {
                            self.shift_clips_after(tid, at, delta)?;
                        }
                    }
                }
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
            EditCommand::RippleTrim {
                clip_id,
                edge,
                new_edge_time,
                sync_linked,
            } => {
                let linked = self.ripple_trim_one(clip_id, edge, new_edge_time)?;
                if sync_linked {
                    if let Some(link) = linked {
                        let _ = self.ripple_trim_one(link, edge, new_edge_time);
                    }
                }
                Ok(EditResult {
                    primary_clip_id: Some(clip_id),
                    secondary_clip_id: linked,
                })
            }
            EditCommand::SetEditMode { mode } => {
                self.timeline.edit_mode = mode;
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
            EditCommand::AddMarker { time, label } => {
                let id = Uuid::new_v4();
                self.timeline.markers.push(Marker { id, time, label });
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
            EditCommand::RemoveMarker { marker_id } => {
                self.timeline.markers.retain(|m| m.id != marker_id);
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
            EditCommand::SetZone { zone_in, zone_out } => {
                self.timeline.zone_in = zone_in;
                self.timeline.zone_out = zone_out;
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
            EditCommand::LiftZone => {
                self.lift_zone()?;
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
            EditCommand::ExtractZone => {
                self.extract_zone()?;
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
        }
    }

    fn insert_clip(
        &mut self,
        track_id: TrackId,
        media_path: String,
        start: f64,
        in_point: f64,
        out_point: f64,
        role: MediaRole,
        linked_clip_id: Option<ClipId>,
    ) -> Result<ClipId, TimelineError> {
        let id = Uuid::new_v4();
        self.insert_clip_with_id(
            track_id,
            id,
            media_path,
            start,
            in_point,
            out_point,
            role,
            linked_clip_id,
        )?;
        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_clip_with_id(
        &mut self,
        track_id: TrackId,
        id: ClipId,
        media_path: String,
        start: f64,
        in_point: f64,
        out_point: f64,
        role: MediaRole,
        linked_clip_id: Option<ClipId>,
    ) -> Result<(), TimelineError> {
        if out_point <= in_point {
            return Err(TimelineError::InvalidRange {
                in_point,
                out_point,
            });
        }
        let start = start.max(0.0);
        let dur = out_point - in_point;
        let mode = self.timeline.edit_mode;

        // Validate track before mutating overlaps / shifts.
        {
            let track = self.timeline.track_mut(track_id)?;
            if track.locked {
                return Err(TimelineError::TrackLocked);
            }
            if !track.kind.accepts(role) {
                return Err(TimelineError::MediaTrackMismatch);
            }
        }

        match mode {
            EditMode::Normal => {}
            EditMode::Insert => {
                self.shift_clips_after(track_id, start, dur)?;
            }
            EditMode::Overwrite => {
                self.overwrite_range(track_id, start, start + dur)?;
            }
        }

        let track = self.timeline.track_mut(track_id)?;
        track.clips.push(Clip {
            id,
            media_path,
            start,
            in_point,
            out_point,
            role,
            linked_clip_id,
            filters: Vec::new(),
        });
        Timeline::sort_track(track);
        Ok(())
    }

    fn remove_clip_inner(
        &mut self,
        clip_id: ClipId,
        remove_linked: bool,
    ) -> Result<(), TimelineError> {
        let linked = {
            let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
            if track.locked {
                return Err(TimelineError::TrackLocked);
            }
            let linked = track.clips[idx].linked_clip_id;
            track.clips.remove(idx);
            linked
        };
        if remove_linked {
            if let Some(link) = linked {
                if let Ok((track, idx)) = self.timeline.find_clip_mut(link) {
                    if !track.locked {
                        track.clips.remove(idx);
                    }
                }
            }
        } else if let Some(link) = linked {
            if let Ok((track, idx)) = self.timeline.find_clip_mut(link) {
                track.clips[idx].linked_clip_id = None;
            }
        }
        Ok(())
    }

    fn shift_clips_after(
        &mut self,
        track_id: TrackId,
        after: f64,
        delta: f64,
    ) -> Result<(), TimelineError> {
        let track = self.timeline.track_mut(track_id)?;
        for clip in &mut track.clips {
            if clip.start >= after - 1e-9 {
                clip.start = (clip.start + delta).max(0.0);
            }
        }
        Timeline::sort_track(track);
        Ok(())
    }

    fn apply_trim_values(
        &mut self,
        clip_id: ClipId,
        in_point: f64,
        out_point: f64,
        keep_end: bool,
    ) -> Result<(), TimelineError> {
        let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
        if track.locked {
            return Err(TimelineError::TrackLocked);
        }
        let clip = &mut track.clips[idx];
        let old_dur = clip.duration();
        clip.in_point = in_point;
        clip.out_point = out_point;
        if keep_end {
            let new_dur = clip.duration();
            clip.start = (clip.start + (old_dur - new_dur)).max(0.0);
        }
        Ok(())
    }

    fn slip_one(&mut self, clip_id: ClipId, delta: f64) -> Result<Option<ClipId>, TimelineError> {
        let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
        if track.locked {
            return Err(TimelineError::TrackLocked);
        }
        let clip = &mut track.clips[idx];
        let mut d = delta;
        if clip.in_point + d < 0.0 {
            d = -clip.in_point;
        }
        clip.in_point += d;
        clip.out_point += d;
        Ok(clip.linked_clip_id)
    }

    fn ripple_trim_one(
        &mut self,
        clip_id: ClipId,
        edge: TrimEdge,
        new_edge_time: f64,
    ) -> Result<Option<ClipId>, TimelineError> {
        // Right: trim out-point, then shift followers past the old end by duration delta.
        // Left: move start/in to the new edge, then shift this clip + followers so the
        // leading gap closes (clip settles back toward the original start).
        let (track_id, linked, shift_after, shift_delta) = {
            let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
            if track.locked {
                return Err(TimelineError::TrackLocked);
            }
            let track_id = track.id;
            let clip = &mut track.clips[idx];
            let old_start = clip.start;
            let old_end = clip.end();
            let old_dur = clip.duration();
            let linked = clip.linked_clip_id;

            match edge {
                TrimEdge::Right => {
                    let new_end = new_edge_time;
                    if new_end <= old_start {
                        return Err(TimelineError::InvalidRange {
                            in_point: old_start,
                            out_point: new_end,
                        });
                    }
                    clip.out_point = clip.in_point + (new_end - old_start);
                    let duration_delta = clip.duration() - old_dur;
                    (track_id, linked, old_end, duration_delta)
                }
                TrimEdge::Left => {
                    let mut new_start = new_edge_time.max(0.0);
                    let mut delta_start = new_start - old_start;
                    if clip.in_point + delta_start < 0.0 {
                        delta_start = -clip.in_point;
                        new_start = old_start + delta_start;
                    }
                    let new_in = clip.in_point + delta_start;
                    if new_in >= clip.out_point {
                        return Err(TimelineError::InvalidRange {
                            in_point: new_in,
                            out_point: clip.out_point,
                        });
                    }
                    clip.start = new_start;
                    clip.in_point = new_in;
                    let settle = old_start - new_start;
                    (track_id, linked, new_start, settle)
                }
            }
        };

        self.shift_clips_after(track_id, shift_after, shift_delta)?;
        Ok(linked)
    }

    /// Punch a hole in `[range_start, range_end)` on one track (split + delete middle).
    fn overwrite_range(
        &mut self,
        track_id: TrackId,
        range_start: f64,
        range_end: f64,
    ) -> Result<(), TimelineError> {
        if range_end <= range_start {
            return Ok(());
        }
        {
            let track = self.timeline.track_mut(track_id)?;
            if track.locked {
                return Err(TimelineError::TrackLocked);
            }
        }

        let overlapping: Vec<ClipId> = {
            let track = self
                .timeline
                .tracks
                .iter()
                .find(|t| t.id == track_id)
                .ok_or(TimelineError::TrackNotFound(track_id))?;
            track
                .clips
                .iter()
                .filter(|c| c.start < range_end - 1e-9 && c.end() > range_start + 1e-9)
                .map(|c| c.id)
                .collect()
        };

        for clip_id in overlapping {
            let Some((start, end, in_point, out_point)) = ({
                match self.timeline.find_clip(clip_id) {
                    Ok((track, idx)) => {
                        let c = &track.clips[idx];
                        Some((c.start, c.end(), c.in_point, c.out_point))
                    }
                    Err(_) => None,
                }
            }) else {
                continue;
            };

            if start >= range_start - 1e-9 && end <= range_end + 1e-9 {
                // Fully inside the range — remove.
                let _ = self.remove_clip_inner(clip_id, false);
            } else if start < range_start + 1e-9 && end > range_end - 1e-9 {
                // Spans the whole range — split at both edges, delete middle.
                let (mid_id, _) = self.split_one(clip_id, range_start)?;
                if range_end < end - 1e-9 {
                    let (_right_id, _) = self.split_one(mid_id, range_end)?;
                }
                let _ = self.remove_clip_inner(mid_id, false);
            } else if start < range_start + 1e-9 && end > range_start + 1e-9 {
                // Overlaps left: trim right edge to range_start.
                let new_out = in_point + (range_start - start);
                if new_out > in_point {
                    let _ = self.apply_trim_values(clip_id, in_point, new_out, false);
                } else {
                    let _ = self.remove_clip_inner(clip_id, false);
                }
            } else if start < range_end - 1e-9 && end > range_end - 1e-9 {
                // Overlaps right: trim left edge to range_end.
                let offset = range_end - start;
                let new_in = in_point + offset;
                if new_in < out_point {
                    let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
                    track.clips[idx].start = range_end;
                    track.clips[idx].in_point = new_in;
                    Timeline::sort_track(track);
                } else {
                    let _ = self.remove_clip_inner(clip_id, false);
                }
            }
        }
        Ok(())
    }

    fn zone_bounds(&self) -> Option<(f64, f64)> {
        match (self.timeline.zone_in, self.timeline.zone_out) {
            (Some(a), Some(b)) if b > a => Some((a, b)),
            _ => None,
        }
    }

    fn unlocked_track_ids(&self) -> Vec<TrackId> {
        self.timeline
            .tracks
            .iter()
            .filter(|t| !t.locked)
            .map(|t| t.id)
            .collect()
    }

    fn lift_zone(&mut self) -> Result<(), TimelineError> {
        let Some((zone_in, zone_out)) = self.zone_bounds() else {
            return Ok(());
        };
        for tid in self.unlocked_track_ids() {
            self.overwrite_range(tid, zone_in, zone_out)?;
        }
        Ok(())
    }

    fn extract_zone(&mut self) -> Result<(), TimelineError> {
        let Some((zone_in, zone_out)) = self.zone_bounds() else {
            return Ok(());
        };
        let zone_dur = zone_out - zone_in;
        self.lift_zone()?;
        for tid in self.unlocked_track_ids() {
            self.shift_clips_after(tid, zone_out, -zone_dur)?;
        }
        Ok(())
    }

    fn split_one(&mut self, clip_id: ClipId, at: f64) -> Result<(ClipId, Option<ClipId>), TimelineError> {
        let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
        if track.locked {
            return Err(TimelineError::TrackLocked);
        }
        let left = track.clips[idx].clone();
        if at <= left.start || at >= left.end() {
            return Err(TimelineError::InvalidRange {
                in_point: left.start,
                out_point: left.end(),
            });
        }
        let offset = at - left.start;
        let split_source = left.in_point + offset;
        track.clips[idx].out_point = split_source;
        // Left piece keeps link; right gets new id (relinked by caller if needed).
        track.clips[idx].linked_clip_id = left.linked_clip_id;
        let right = Clip {
            id: Uuid::new_v4(),
            media_path: left.media_path,
            start: at,
            in_point: split_source,
            out_point: left.out_point,
            role: left.role,
            linked_clip_id: None,
            filters: left.filters,
        };
        let right_id = right.id;
        let linked = left.linked_clip_id;
        track.clips.insert(idx + 1, right);
        Ok((right_id, linked))
    }

    pub fn undo(&mut self) -> Result<(), TimelineError> {
        let previous = self.undo.pop_back().ok_or(TimelineError::NothingToUndo)?;
        self.redo.push_back(self.timeline.clone());
        self.timeline = previous;
        Ok(())
    }

    pub fn redo(&mut self) -> Result<(), TimelineError> {
        let next = self.redo.pop_back().ok_or(TimelineError::NothingToRedo)?;
        self.undo.push_back(self.timeline.clone());
        self.timeline = next;
        Ok(())
    }

    fn push_undo(&mut self) {
        self.undo.push_back(self.timeline.clone());
        while self.undo.len() > self.max_history {
            self.undo.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_av_pair_links_clips() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let a1 = ed.timeline.first_track(TrackKind::Audio).unwrap();
        let res = ed
            .apply(EditCommand::AddAvPair {
                video_track_id: v1,
                audio_track_id: a1,
                media_path: "clip.mp4".into(),
                start: 0.0,
                in_point: 0.0,
                out_point: 10.0,
            })
            .unwrap();
        let vid = res.primary_clip_id.unwrap();
        let aid = res.secondary_clip_id.unwrap();
        let vclip = &ed.timeline.tracks[0].clips[0];
        let aclip = ed
            .timeline
            .tracks
            .iter()
            .find(|t| t.kind == TrackKind::Audio)
            .unwrap()
            .clips[0]
            .clone();
        assert_eq!(vclip.id, vid);
        assert_eq!(aclip.id, aid);
        assert_eq!(vclip.linked_clip_id, Some(aid));
        assert_eq!(aclip.linked_clip_id, Some(vid));
    }

    #[test]
    fn audio_only_rejects_video_track() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let err = ed
            .apply(EditCommand::AddClip {
                track_id: v1,
                media_path: "song.mp3".into(),
                start: 0.0,
                in_point: 0.0,
                out_point: 5.0,
                role: MediaRole::Audio,
                linked_clip_id: None,
            })
            .unwrap_err();
        assert!(matches!(err, TimelineError::MediaTrackMismatch));
    }

    #[test]
    fn move_syncs_linked() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let a1 = ed.timeline.first_track(TrackKind::Audio).unwrap();
        let res = ed
            .apply(EditCommand::AddAvPair {
                video_track_id: v1,
                audio_track_id: a1,
                media_path: "clip.mp4".into(),
                start: 0.0,
                in_point: 0.0,
                out_point: 8.0,
            })
            .unwrap();
        let vid = res.primary_clip_id.unwrap();
        ed.apply(EditCommand::MoveClip {
            clip_id: vid,
            new_start: 3.0,
            sync_linked: true,
        })
        .unwrap();
        assert!((ed.timeline.tracks[0].clips[0].start - 3.0).abs() < 1e-9);
        let a = ed
            .timeline
            .tracks
            .iter()
            .find(|t| t.kind == TrackKind::Audio)
            .unwrap();
        assert!((a.clips[0].start - 3.0).abs() < 1e-9);
    }

    #[test]
    fn split_and_undo() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let clip_id = ed
            .apply(EditCommand::AddClip {
                track_id: v1,
                media_path: "clip.mp4".into(),
                start: 0.0,
                in_point: 0.0,
                out_point: 10.0,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .unwrap()
            .primary_clip_id
            .unwrap();

        ed.apply(EditCommand::SplitClip {
            clip_id,
            at: 4.0,
            sync_linked: false,
        })
        .unwrap();
        assert_eq!(ed.timeline.tracks[0].clips.len(), 2);
        ed.undo().unwrap();
        assert_eq!(ed.timeline.tracks[0].clips.len(), 1);
    }

    #[test]
    fn slip_keeps_duration() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let clip_id = ed
            .apply(EditCommand::AddClip {
                track_id: v1,
                media_path: "clip.mp4".into(),
                start: 2.0,
                in_point: 1.0,
                out_point: 6.0,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .unwrap()
            .primary_clip_id
            .unwrap();

        ed.apply(EditCommand::SlipClip {
            clip_id,
            delta: 0.5,
            sync_linked: false,
        })
        .unwrap();

        let c = &ed.timeline.tracks[0].clips[0];
        assert!((c.start - 2.0).abs() < 1e-9);
        assert!((c.duration() - 5.0).abs() < 1e-9);
        assert!((c.in_point - 1.5).abs() < 1e-9);
        assert!((c.out_point - 6.5).abs() < 1e-9);

        // Clamp so in_point cannot go negative.
        ed.apply(EditCommand::SlipClip {
            clip_id,
            delta: -10.0,
            sync_linked: false,
        })
        .unwrap();
        let c = &ed.timeline.tracks[0].clips[0];
        assert!((c.in_point - 0.0).abs() < 1e-9);
        assert!((c.out_point - 5.0).abs() < 1e-9);
        assert!((c.start - 2.0).abs() < 1e-9);
    }

    #[test]
    fn spacer_shifts_later_clips() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "a.mp4".into(),
            start: 0.0,
            in_point: 0.0,
            out_point: 2.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "b.mp4".into(),
            start: 5.0,
            in_point: 0.0,
            out_point: 3.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "c.mp4".into(),
            start: 10.0,
            in_point: 0.0,
            out_point: 1.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();

        ed.apply(EditCommand::SpacerShift {
            track_id: Some(v1),
            at: 5.0,
            delta: 2.0,
        })
        .unwrap();

        let clips = &ed.timeline.tracks[0].clips;
        assert!((clips[0].start - 0.0).abs() < 1e-9);
        assert!((clips[1].start - 7.0).abs() < 1e-9);
        assert!((clips[2].start - 12.0).abs() < 1e-9);
    }

    #[test]
    fn ripple_trim_right_shifts_followers() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let first = ed
            .apply(EditCommand::AddClip {
                track_id: v1,
                media_path: "a.mp4".into(),
                start: 0.0,
                in_point: 0.0,
                out_point: 10.0,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .unwrap()
            .primary_clip_id
            .unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "b.mp4".into(),
            start: 10.0,
            in_point: 0.0,
            out_point: 4.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();

        ed.apply(EditCommand::RippleTrim {
            clip_id: first,
            edge: TrimEdge::Right,
            new_edge_time: 7.0,
            sync_linked: false,
        })
        .unwrap();

        let clips = &ed.timeline.tracks[0].clips;
        assert!((clips[0].end() - 7.0).abs() < 1e-9);
        assert!((clips[0].duration() - 7.0).abs() < 1e-9);
        assert!((clips[1].start - 7.0).abs() < 1e-9);
    }

    #[test]
    fn extract_zone_closes_gap() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "long.mp4".into(),
            start: 0.0,
            in_point: 0.0,
            out_point: 20.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();

        ed.apply(EditCommand::SetZone {
            zone_in: Some(5.0),
            zone_out: Some(12.0),
        })
        .unwrap();
        ed.apply(EditCommand::ExtractZone).unwrap();

        let clips = &ed.timeline.tracks[0].clips;
        assert_eq!(clips.len(), 2);
        assert!((clips[0].start - 0.0).abs() < 1e-9);
        assert!((clips[0].end() - 5.0).abs() < 1e-9);
        // Right piece closed the 7s gap: was at 12, now at 5.
        assert!((clips[1].start - 5.0).abs() < 1e-9);
        assert!((clips[1].end() - 13.0).abs() < 1e-9);
        assert!((ed.timeline.duration() - 13.0).abs() < 1e-9);
    }

    #[test]
    fn insert_mode_pushes_clips() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "existing.mp4".into(),
            start: 5.0,
            in_point: 0.0,
            out_point: 4.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();

        ed.apply(EditCommand::SetEditMode {
            mode: EditMode::Insert,
        })
        .unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "insert.mp4".into(),
            start: 5.0,
            in_point: 0.0,
            out_point: 3.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();

        let clips = &ed.timeline.tracks[0].clips;
        assert_eq!(clips.len(), 2);
        assert!((clips[0].start - 5.0).abs() < 1e-9);
        assert_eq!(clips[0].media_path, "insert.mp4");
        assert!((clips[1].start - 8.0).abs() < 1e-9);
        assert_eq!(clips[1].media_path, "existing.mp4");
    }

    #[test]
    fn remove_video_track_keeps_one() {
        let mut ed = TimelineEditor::new();
        let v_count = ed
            .timeline
            .tracks
            .iter()
            .filter(|t| t.kind == TrackKind::Video)
            .count();
        assert!(v_count >= 2);
        let v2 = ed.timeline.tracks.iter().find(|t| t.name == "V2").unwrap().id;
        ed.apply(EditCommand::RemoveTrack { track_id: v2 }).unwrap();
        assert_eq!(
            ed.timeline
                .tracks
                .iter()
                .filter(|t| t.kind == TrackKind::Video)
                .count(),
            v_count - 1
        );
        let last = ed.timeline.first_track(TrackKind::Video).unwrap();
        let err = ed
            .apply(EditCommand::RemoveTrack { track_id: last })
            .unwrap_err();
        assert!(matches!(err, TimelineError::LastTrack("video")));
    }
}
