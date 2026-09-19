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
    #[error("cannot link: need one video and one audio clip")]
    InvalidLink,
    #[error("no zone set")]
    NoZone,
    #[error("no gap at that position")]
    NoGap,
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

/// Timeline edit tool mode (style insert / overwrite).
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
    /// Original source file for export (when `media_path` is a proxy).
    #[serde(default)]
    pub source_path: Option<String>,
    /// Position on the timeline (seconds).
    pub start: f64,
    /// Source in-point (seconds).
    pub in_point: f64,
    /// Source out-point (seconds), exclusive.
    pub out_point: f64,
    pub role: MediaRole,
    /// Linked partner clip (video↔audio). Kept in sync for move/trim/split.
    pub linked_clip_id: Option<ClipId>,
    /// Fade-in duration from clip start (seconds).
    #[serde(default)]
    pub fade_in: f64,
    /// Fade-out duration before clip end (seconds).
    #[serde(default)]
    pub fade_out: f64,
    /// Play media backward within in/out (video export uses FFmpeg `reverse`).
    #[serde(default)]
    pub reverse: bool,
    /// Playback rate (1.0 = normal). Timeline duration is `(out-in)/speed`.
    #[serde(default = "default_clip_speed")]
    pub speed: f64,
    pub filters: Vec<FilterInstance>,
}

fn default_clip_speed() -> f64 {
    1.0
}

impl Clip {
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

    /// Clamp fade_in/fade_out so they fit within clip duration.
    pub fn clamp_fades(&mut self) {
        let dur = self.duration();
        self.fade_in = self.fade_in.max(0.0).min(dur);
        self.fade_out = self.fade_out.max(0.0).min(dur);
        if self.fade_in + self.fade_out > dur {
            // Prefer keeping fade_in; shrink fade_out.
            self.fade_out = (dur - self.fade_in).max(0.0);
        }
    }

    /// Linear gain 0..1 at an absolute timeline time.
    pub fn fade_gain_at(&self, time: f64) -> f64 {
        let local = time - self.start;
        let dur = self.duration();
        if local < 0.0 || local >= dur {
            return 0.0;
        }
        let mut g = 1.0;
        if self.fade_in > 1e-6 && local < self.fade_in {
            g = (local / self.fade_in).clamp(0.0, 1.0);
        }
        if self.fade_out > 1e-6 && local > dur - self.fade_out {
            let out_g = ((dur - local) / self.fade_out).clamp(0.0, 1.0);
            g = g.min(out_g);
        }
        g
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
    Transform,
    Crop,
    Exposure,
    Contrast,
    Saturation,
    Blur,
    Flip,
    Chromakey,
    Volume,
    Equalizer,
    Compressor,
    Highpass,
    Lowpass,
    Gate,
    /// Audio broadband noise reduction (FFmpeg afftdn).
    Denoise,
    Limiter,
    Reverb,
    Invert,
    Pitch,
    /// Legacy / deferred stubs (kept for serde compatibility).
    Lut,
    Fade,
    Text,
    // Daily-use color/quality effects (FFmpeg: colortemperature, hue,
    // vignette, unsharp, hqdn3d, deshake, lut3d, loudnorm).
    Temperature,
    Hue,
    Vignette,
    Sharpen,
    // Serialized as "vdenoise" to match the frontend catalog id; the alias
    // keeps timelines saved with the old snake_case name loading.
    #[serde(rename = "vdenoise", alias = "video_denoise")]
    VideoDenoise,
    Stabilize,
    Lut3d,
    Normalize,
    /// Cross dissolve with the previous clip on the same track.
    Transition,
    /// De-esser: tames harsh "s" sounds in voice.
    Deesser,
    /// Magic Remove / AI Eraser: brush mask + auto tracking + background
    /// reconstruction rendered to a non-destructive sidecar clip.
    // Serialized as "magicremove" to match the frontend kind string; the
    // alias keeps timelines saved with the old snake_case name loading.
    #[serde(rename = "magicremove", alias = "magic_remove")]
    MagicRemove,
    /// Region blur (Blur tool): a movable/resizable/rotatable region with a
    /// shape (rect / rounded / circle / ellipse), blur intensity, feather and
    /// opacity, optionally animated through keyframes stored in params.
    #[serde(rename = "blurregion", alias = "blur_region")]
    BlurRegion,
    /// Background mask removal (BG Key tool): manual select-area removal with
    /// rect/ellipse/lasso shapes, feather, invert and add/subtract modes.
    /// The composited alpha mask is rasterized by the UI into a PNG
    /// (maskPath) so export and preview always share the exact same mask.
    #[serde(rename = "bgmask", alias = "bg_mask")]
    BgMask,
    Dream,
    Magic,
    Shake,
    Wiggle,
    Bounce,
    Zoompulse,
    Zoomin,
    Spin,
    Motionblur,
    Rgbsplit,
    Glitch,
    Flash,
    Pulse,
    Glow,
    Neon,
    Vhs,
    Cinematic,
}

impl FilterKind {
    pub fn is_heavy(self) -> bool {
        matches!(
            self,
            Self::Blur
                | Self::Denoise
                | Self::Lut
                | Self::Chromakey
                | Self::VideoDenoise
                | Self::Stabilize
                | Self::Lut3d
                | Self::MagicRemove
                | Self::BlurRegion
                | Self::BgMask
        )
    }

    pub fn default_params(self) -> serde_json::Value {
        match self {
            Self::Transform => serde_json::json!({
                "x": 0.0,
                "y": 0.0,
                "scale": 1.0,
                "rotation": 0.0,
                "opacity": 1.0
            }),
            Self::Crop => serde_json::json!({
                "left": 0.0,
                "top": 0.0,
                "right": 0.0,
                "bottom": 0.0
            }),
            Self::Exposure => serde_json::json!({ "amount": 0.0 }),
            Self::Contrast => serde_json::json!({ "amount": 1.0 }),
            Self::Saturation => serde_json::json!({ "amount": 1.0 }),
            Self::Blur => serde_json::json!({ "radius": 0.0 }),
            Self::Flip => serde_json::json!({ "horizontal": false, "vertical": false }),
            Self::Chromakey => serde_json::json!({
                "color": "#00ff00",
                "similarity": 0.3,
                "blend": 0.1
            }),
            Self::Volume => serde_json::json!({ "gain": 1.0 }),
            Self::Equalizer => serde_json::json!({
                "bass": 0.0,
                "mid": 0.0,
                "treble": 0.0
            }),
            Self::Compressor => serde_json::json!({
                "threshold": -20.0,
                "ratio": 4.0,
                "attack": 20.0,
                "release": 250.0
            }),
            Self::Highpass => serde_json::json!({ "freq": 120.0 }),
            Self::Lowpass => serde_json::json!({ "freq": 12000.0 }),
            Self::Gate => serde_json::json!({
                "threshold": -40.0,
                "ratio": 10.0,
                "attack": 10.0,
                "release": 100.0
            }),
            Self::Denoise => serde_json::json!({ "nf": -25.0, "nr": 12.0 }),
            Self::Limiter => serde_json::json!({ "limit": 0.95 }),
            Self::Reverb => serde_json::json!({ "delay": 40.0, "decay": 0.3 }),
            Self::Invert => serde_json::json!({}),
            Self::Pitch => serde_json::json!({ "semitones": 0.0, "preset": "custom" }),
            Self::Lut | Self::Fade => serde_json::json!({}),
            Self::Text => serde_json::json!({
                "text": "Your title",
                "size": 6.0,
                "color": "#ffffff",
                "x": 0.0,
                "y": 0.55,
                "box": true
            }),
            Self::Temperature => serde_json::json!({ "kelvin": 6500.0 }),
            Self::Hue => serde_json::json!({ "degrees": 0.0 }),
            Self::Vignette => serde_json::json!({ "amount": 0.5 }),
            Self::Sharpen => serde_json::json!({ "amount": 0.8 }),
            Self::VideoDenoise => serde_json::json!({ "amount": 4.0 }),
            Self::Stabilize => serde_json::json!({ "strength": 64.0 }),
            Self::Lut3d => serde_json::json!({ "path": "" }),
            Self::Normalize => serde_json::json!({ "target": -16.0 }),
            Self::Transition => serde_json::json!({ "kind": "dissolve", "duration": 0.5 }),
            Self::Deesser => serde_json::json!({ "amount": 0.5 }),
            Self::MagicRemove => serde_json::json!({
                "strokes": [],
                "keyframes": [],
                "anchorTime": 0.0,
                // Brush radius / feather / expand as fractions of frame height.
                "brushSize": 0.025,
                "feather": 0.008,
                "expand": 0.004,
                "trackingAccuracy": "medium",
                "removalStrength": 100.0,
                "status": "idle",
                "renderKey": "",
                "resultPath": ""
            }),
            // Region geometry is normalized to the SOURCE frame (center x/y +
            // full width/height as fractions, rotation in degrees); intensity
            // 0..1 maps to a gaussian sigma, feather is a fraction of the
            // region's min dimension. Keyframes store the same fields sampled
            // at clip-local source times (see build_video_effect_chain).
            Self::BlurRegion => serde_json::json!({
                "x": 0.5,
                "y": 0.5,
                "w": 0.3,
                "h": 0.3,
                "rotation": 0.0,
                "shape": "rect",
                "cornerRadius": 0.15,
                "intensity": 0.5,
                "feather": 0.08,
                "opacity": 1.0,
                "keyframes": []
            }),
            Self::BgMask => serde_json::json!({
                "shapes": [],
                "feather": 0.01,
                "invert": false,
                "maskPath": "",
                "maskKey": ""
            }),
            Self::Dream => serde_json::json!({ "intensity": 0.5, "duration": 0.0 }),
            Self::Magic => serde_json::json!({ "intensity": 0.3, "speed": 0.25, "duration": 0.0 }),
            Self::Shake => {
                serde_json::json!({ "intensity": 0.06, "speed": 8.0, "direction": "both", "duration": 0.0 })
            }
            Self::Wiggle => {
                serde_json::json!({ "intensity": 0.03, "speed": 20.0, "duration": 0.0 })
            }
            Self::Bounce => serde_json::json!({ "intensity": 0.08, "speed": 2.0, "duration": 0.0 }),
            Self::Zoompulse => {
                serde_json::json!({ "intensity": 0.15, "speed": 2.0, "duration": 0.0 })
            }
            Self::Zoomin => {
                serde_json::json!({ "intensity": 0.3, "duration": 5.0, "direction": "in" })
            }
            Self::Spin => serde_json::json!({ "speed": 0.25, "duration": 3.0, "direction": "cw" }),
            Self::Motionblur => serde_json::json!({ "intensity": 2.0, "duration": 0.0 }),
            Self::Rgbsplit => {
                serde_json::json!({ "intensity": 6.0, "direction": "horizontal", "duration": 0.0 })
            }
            Self::Glitch => serde_json::json!({ "intensity": 8.0, "speed": 2.0, "duration": 0.0 }),
            Self::Flash => serde_json::json!({ "intensity": 0.25, "speed": 2.0, "duration": 0.0 }),
            Self::Pulse => serde_json::json!({ "intensity": 0.12, "speed": 2.0, "duration": 0.0 }),
            Self::Glow => serde_json::json!({ "intensity": 0.6, "duration": 0.0 }),
            Self::Neon => serde_json::json!({ "intensity": 0.5, "speed": 0.25, "duration": 0.0 }),
            Self::Vhs => serde_json::json!({ "intensity": 5.0, "duration": 0.0 }),
            Self::Cinematic => serde_json::json!({ "intensity": 0.5, "duration": 0.0 }),
        }
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
        #[serde(default)]
        source_path: Option<String>,
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
        #[serde(default)]
        source_path: Option<String>,
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
        /// When set, relocate the clip to this track (same kind required).
        target_track_id: Option<TrackId>,
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
    /// Cross dissolve with the previous clip on the same track: overlaps this
    /// clip left by up to `duration` seconds and attaches a Transition filter.
    AddTransition {
        clip_id: ClipId,
        duration: f64,
    },
    UpdateFilter {
        clip_id: ClipId,
        filter_id: Uuid,
        params: serde_json::Value,
    },
    SetFilterEnabled {
        clip_id: ClipId,
        filter_id: Uuid,
        enabled: bool,
    },
    RemoveFilter {
        clip_id: ClipId,
        filter_id: Uuid,
    },
    /// Set style fade-in / fade-out durations (seconds).
    SetClipFades {
        clip_id: ClipId,
        fade_in: f64,
        fade_out: f64,
    },
    /// Toggle reverse playback for a clip (video picture; export uses FFmpeg reverse).
    SetClipReverse {
        clip_id: ClipId,
        reverse: bool,
    },
    /// Set playback speed (0.25–4.0). Retimes timeline duration to `(out-in)/speed`.
    SetClipSpeed {
        clip_id: ClipId,
        speed: f64,
    },
    /// Slide source in/out by `delta` while keeping duration and timeline start fixed.
    SlipClip {
        clip_id: ClipId,
        delta: f64,
        sync_linked: bool,
    },
    /// Shift clips with `start >= at` by `delta` on one track, or all unlocked tracks.
    /// Negative deltas are clamped so clips cannot overlap earlier ones.
    SpacerShift {
        track_id: Option<TrackId>,
        at: f64,
        delta: f64,
    },
    /// Close the empty gap under `at` (spacer remover) on one track or all unlocked tracks.
    CloseGap {
        track_id: Option<TrackId>,
        at: f64,
    },
    /// Pack clips left from `from`, removing all gaps (space / gap fill).
    RemoveGaps {
        track_id: Option<TrackId>,
        from: f64,
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

    /// Adopt an externally loaded project (save file). The undo history is
    /// cleared — undo must never reach back into a different project.
    pub fn with_timeline(timeline: Timeline) -> Self {
        Self {
            timeline,
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
                source_path,
                start,
                in_point,
                out_point,
                role,
                linked_clip_id,
            } => {
                let id = self.insert_clip(
                    track_id,
                    media_path,
                    source_path,
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
                source_path,
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
                    source_path.clone(),
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
                    source_path,
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
                            let (ltid, lstart, ldur) = (
                                ltrack.id,
                                ltrack.clips[lidx].start,
                                ltrack.clips[lidx].duration(),
                            );
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
                    clip.clamp_fades();
                    clip.linked_clip_id
                };
                if sync_linked {
                    if let Some(link) = linked {
                        self.apply_trim_values(link, in_point, out_point, keep_end)?;
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
                target_track_id,
            } => {
                let (src_track_id, linked) = {
                    let (track, idx) = self.timeline.find_clip(clip_id)?;
                    (track.id, track.clips[idx].linked_clip_id)
                };
                let (dest_track_id, _linked, placed) =
                    self.move_clip_one(clip_id, new_start, target_track_id)?;
                if sync_linked {
                    if let Some(link) = linked {
                        if dest_track_id != src_track_id {
                            // Cross-track: keep the A/V pair lockstep by moving
                            // the partner to the index-mapped track of its kind.
                            match self.mapped_partner_track(dest_track_id, link) {
                                Some(mapped) => {
                                    self.relocate_clip_absolute(link, mapped, placed)?;
                                }
                                None => {
                                    self.set_clip_start_absolute(link, placed)?;
                                }
                            }
                        } else {
                            self.set_clip_start_absolute(link, placed)?;
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
                if clip_a == clip_b {
                    return Err(TimelineError::InvalidLink);
                }
                let (role_a, prev_a, track_a) = {
                    let (t, i) = self.timeline.find_clip(clip_a)?;
                    (t.clips[i].role, t.clips[i].linked_clip_id, t.id)
                };
                let (role_b, prev_b, track_b) = {
                    let (t, i) = self.timeline.find_clip(clip_b)?;
                    (t.clips[i].role, t.clips[i].linked_clip_id, t.id)
                };
                if track_a == track_b {
                    return Err(TimelineError::InvalidLink);
                }
                let ok = matches!(
                    (role_a, role_b),
                    (MediaRole::Video, MediaRole::Audio) | (MediaRole::Audio, MediaRole::Video)
                );
                if !ok {
                    return Err(TimelineError::InvalidLink);
                }
                // Clear previous partners.
                for prev in [prev_a, prev_b].into_iter().flatten() {
                    if prev != clip_a && prev != clip_b {
                        if let Ok((t, i)) = self.timeline.find_clip_mut(prev) {
                            t.clips[i].linked_clip_id = None;
                        }
                    }
                }
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
                    .map(|t| t.clips.iter().filter_map(|c| c.linked_clip_id).collect())
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
            EditCommand::AddTransition { clip_id, duration } => {
                let (track, idx) = self.timeline.find_clip(clip_id)?;
                if track.locked {
                    return Err(TimelineError::TrackLocked);
                }
                if idx == 0 {
                    return Err(TimelineError::NoGap);
                }
                let prev = &track.clips[idx - 1];
                let clip = &track.clips[idx];
                let prev_dur = prev.duration();
                let clip_dur = clip.duration();
                let overlap = duration
                    .max(0.05)
                    .min(prev_dur * 0.4)
                    .min(clip_dur * 0.4)
                    .min((clip.start - prev.start).max(0.05));
                if overlap < 0.05 {
                    return Err(TimelineError::NoGap);
                }
                let new_start = (clip.start - overlap).max(prev.start + 0.05);
                let actual = clip.start - new_start;

                // Re-borrow mutably and apply.
                let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
                let clip = &mut track.clips[idx];
                clip.start = new_start;
                clip.filters.push(FilterInstance {
                    id: Uuid::new_v4(),
                    kind: FilterKind::Transition,
                    enabled: true,
                    params: serde_json::json!({
                        "kind": "dissolve",
                        "duration": (actual * 100.0).round() / 100.0
                    }),
                });
                Timeline::sort_track(track);
                Ok(EditResult {
                    primary_clip_id: Some(clip_id),
                    secondary_clip_id: None,
                })
            }
            EditCommand::AddFilter {
                clip_id,
                kind,
                params,
            } => {
                let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
                if track.locked {
                    return Err(TimelineError::TrackLocked);
                }
                let mut merged = kind.default_params();
                if let (Some(obj), Some(def)) = (params.as_object(), merged.as_object_mut()) {
                    for (k, v) in obj {
                        def.insert(k.clone(), v.clone());
                    }
                }
                track.clips[idx].filters.push(FilterInstance {
                    id: Uuid::new_v4(),
                    kind,
                    enabled: true,
                    params: merged,
                });
                Ok(EditResult {
                    primary_clip_id: Some(clip_id),
                    secondary_clip_id: None,
                })
            }
            EditCommand::UpdateFilter {
                clip_id,
                filter_id,
                params,
            } => {
                let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
                if track.locked {
                    return Err(TimelineError::TrackLocked);
                }
                let clip = &mut track.clips[idx];
                let Some(f) = clip.filters.iter_mut().find(|f| f.id == filter_id) else {
                    return Err(TimelineError::ClipNotFound(clip_id));
                };
                if let (Some(incoming), Some(existing)) =
                    (params.as_object(), f.params.as_object_mut())
                {
                    for (k, v) in incoming {
                        existing.insert(k.clone(), v.clone());
                    }
                } else {
                    f.params = params;
                }
                Ok(EditResult {
                    primary_clip_id: Some(clip_id),
                    secondary_clip_id: None,
                })
            }
            EditCommand::SetFilterEnabled {
                clip_id,
                filter_id,
                enabled,
            } => {
                let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
                if track.locked {
                    return Err(TimelineError::TrackLocked);
                }
                let clip = &mut track.clips[idx];
                let Some(f) = clip.filters.iter_mut().find(|f| f.id == filter_id) else {
                    return Err(TimelineError::ClipNotFound(clip_id));
                };
                f.enabled = enabled;
                Ok(EditResult {
                    primary_clip_id: Some(clip_id),
                    secondary_clip_id: None,
                })
            }
            EditCommand::RemoveFilter { clip_id, filter_id } => {
                let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
                if track.locked {
                    return Err(TimelineError::TrackLocked);
                }
                track.clips[idx].filters.retain(|f| f.id != filter_id);
                Ok(EditResult {
                    primary_clip_id: Some(clip_id),
                    secondary_clip_id: None,
                })
            }
            EditCommand::SetClipFades {
                clip_id,
                fade_in,
                fade_out,
            } => {
                let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
                if track.locked {
                    return Err(TimelineError::TrackLocked);
                }
                let clip = &mut track.clips[idx];
                clip.fade_in = fade_in;
                clip.fade_out = fade_out;
                clip.clamp_fades();
                Ok(EditResult {
                    primary_clip_id: Some(clip_id),
                    secondary_clip_id: None,
                })
            }
            EditCommand::SetClipReverse { clip_id, reverse } => {
                let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
                if track.locked {
                    return Err(TimelineError::TrackLocked);
                }
                track.clips[idx].reverse = reverse;
                Ok(EditResult {
                    primary_clip_id: Some(clip_id),
                    secondary_clip_id: None,
                })
            }
            EditCommand::SetClipSpeed { clip_id, speed } => {
                let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
                if track.locked {
                    return Err(TimelineError::TrackLocked);
                }
                let clip = &mut track.clips[idx];
                clip.speed = if speed.is_finite() {
                    speed.clamp(0.25, 4.0)
                } else {
                    1.0
                };
                clip.clamp_fades();
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
                        self.slip_one(link, delta)?;
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
                        let clamped = Self::clamp_spacer_delta(track, at, delta);
                        if clamped.abs() > 1e-9 {
                            self.shift_clips_after(tid, at, clamped)?;
                        }
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
                            let track = self
                                .timeline
                                .tracks
                                .iter()
                                .find(|t| t.id == tid)
                                .ok_or(TimelineError::TrackNotFound(tid))?;
                            let clamped = Self::clamp_spacer_delta(track, at, delta);
                            if clamped.abs() > 1e-9 {
                                self.shift_clips_after(tid, at, clamped)?;
                            }
                        }
                    }
                }
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
            EditCommand::CloseGap { track_id, at } => {
                match track_id {
                    Some(tid) => {
                        self.close_gap_on_track(tid, at)?;
                    }
                    None => {
                        let ids = self.unlocked_track_ids();
                        let mut closed = false;
                        let mut last_err = TimelineError::NoGap;
                        for tid in ids {
                            match self.close_gap_on_track(tid, at) {
                                Ok(()) => closed = true,
                                Err(TimelineError::NoGap) => {}
                                Err(e) => last_err = e,
                            }
                        }
                        if !closed {
                            return Err(last_err);
                        }
                    }
                }
                Ok(EditResult {
                    primary_clip_id: None,
                    secondary_clip_id: None,
                })
            }
            EditCommand::RemoveGaps { track_id, from } => {
                match track_id {
                    Some(tid) => self.remove_gaps_on_track(tid, from)?,
                    None => {
                        for tid in self.unlocked_track_ids() {
                            self.remove_gaps_on_track(tid, from)?;
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
                        self.ripple_trim_one(link, edge, new_edge_time)?;
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
        source_path: Option<String>,
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
            source_path,
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
        source_path: Option<String>,
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
            source_path,
            start,
            in_point,
            out_point,
            role,
            linked_clip_id,
            fade_in: 0.0,
            fade_out: 0.0,
            reverse: false,
            speed: 1.0,
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

    /// How much empty space sits under `at` (between previous clip end and next start).
    fn gap_bounds_on_track(track: &Track, at: f64) -> Option<(f64, f64)> {
        let mut clips: Vec<&Clip> = track.clips.iter().collect();
        clips.sort_by(|a, b| {
            a.start
                .partial_cmp(&b.start)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut prev_end = 0.0_f64;
        for clip in clips {
            if at + 1e-9 < clip.start && at + 1e-9 >= prev_end {
                if clip.start - prev_end > 1e-6 {
                    return Some((prev_end, clip.start));
                }
            }
            if at + 1e-9 >= clip.start && at < clip.end() - 1e-9 {
                // Inside a clip — no removable gap at this point.
                return None;
            }
            prev_end = prev_end.max(clip.end());
        }
        None
    }

    fn clamp_spacer_delta(track: &Track, at: f64, delta: f64) -> f64 {
        if delta >= 0.0 {
            return delta;
        }
        let Some((gap_start, gap_end)) = Self::gap_bounds_on_track(track, at) else {
            return 0.0;
        };
        let avail = (gap_end - gap_start).max(0.0);
        delta.max(-avail)
    }

    fn close_gap_on_track(&mut self, track_id: TrackId, at: f64) -> Result<(), TimelineError> {
        let (gap_start, gap_end) = {
            let track = self
                .timeline
                .tracks
                .iter()
                .find(|t| t.id == track_id)
                .ok_or(TimelineError::TrackNotFound(track_id))?;
            if track.locked {
                return Err(TimelineError::TrackLocked);
            }
            Self::gap_bounds_on_track(track, at).ok_or(TimelineError::NoGap)?
        };
        let gap = gap_end - gap_start;
        if gap <= 1e-6 {
            return Err(TimelineError::NoGap);
        }
        self.shift_clips_after(track_id, gap_end, -gap)?;
        Ok(())
    }

    fn remove_gaps_on_track(&mut self, track_id: TrackId, from: f64) -> Result<(), TimelineError> {
        let track = self.timeline.track_mut(track_id)?;
        if track.locked {
            return Err(TimelineError::TrackLocked);
        }
        Timeline::sort_track(track);
        let from = from.max(0.0);
        // Cursor starts at `from`, but never before the end of clips that finish before `from`.
        let mut cursor = from;
        for clip in track.clips.iter() {
            if clip.end() <= from + 1e-9 {
                cursor = cursor.max(clip.end());
            }
        }
        for clip in track.clips.iter_mut() {
            if clip.start + 1e-9 < from {
                continue;
            }
            let dur = clip.duration();
            clip.start = cursor;
            cursor = clip.start + dur;
        }
        Timeline::sort_track(track);
        Ok(())
    }

    /// Move one clip, respecting edit mode so pieces do not stack on top of each other.
    /// Returns `(track_id, linked_id, resolved_start)`.
    fn move_clip_one(
        &mut self,
        clip_id: ClipId,
        new_start: f64,
        target_track_id: Option<TrackId>,
    ) -> Result<(TrackId, Option<ClipId>, f64), TimelineError> {
        let mode = self.timeline.edit_mode;
        let (track_id, linked, dur, old_start, clip_snapshot, clip_kind) = {
            let (track, idx) = self.timeline.find_clip(clip_id)?;
            if track.locked {
                return Err(TimelineError::TrackLocked);
            }
            let clip = track.clips[idx].clone();
            (
                track.id,
                clip.linked_clip_id,
                clip.duration(),
                clip.start,
                clip,
                track.kind,
            )
        };

        // Resolve the destination track (cross-track moves keep the clip kind).
        let dest_track_id = match target_track_id {
            Some(dest) if dest != track_id => {
                let dest_track = self
                    .timeline
                    .tracks
                    .iter()
                    .find(|t| t.id == dest)
                    .ok_or(TimelineError::TrackNotFound(dest))?;
                if dest_track.kind != clip_kind {
                    return Err(TimelineError::MediaTrackMismatch);
                }
                if dest_track.locked {
                    return Err(TimelineError::TrackLocked);
                }
                if dest_track.hidden {
                    return Err(TimelineError::TrackLocked);
                }
                dest
            }
            _ => track_id,
        };
        let same_track = dest_track_id == track_id;

        let desired = new_start.max(0.0);
        if same_track && (desired - old_start).abs() < 1e-9 {
            return Ok((track_id, linked, old_start));
        }

        // Lift the clip off the track first so collision logic ignores it.
        {
            let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
            track.clips.remove(idx);
        }

        let placed = match mode {
            EditMode::Normal => {
                let mut obstacles: Vec<(f64, f64)> = Vec::new();
                if let Some(track) = self.timeline.tracks.iter().find(|t| t.id == dest_track_id) {
                    obstacles.extend(track.clips.iter().map(|c| (c.start, c.end())));
                }
                if let Some(link) = linked {
                    if let Ok((partner_track, _)) = self.timeline.find_clip(link) {
                        obstacles.extend(
                            partner_track
                                .clips
                                .iter()
                                .filter(|c| c.id != link)
                                .map(|c| (c.start, c.end())),
                        );
                    }
                }
                self.resolve_non_overlapping_start_for_obstacles(desired, dur, &obstacles)
            }
            EditMode::Insert => {
                if same_track {
                    // Close the hole left behind, then open space at the drop point.
                    if desired > old_start {
                        // Moving right: close old hole, then push at destination.
                        self.shift_clips_after(track_id, old_start + 1e-9, -dur)?;
                        self.shift_clips_after(dest_track_id, desired, dur)?;
                        desired
                    } else {
                        // Moving left: push at destination first, then close old hole
                        // (old hole index shifts by +dur for clips that were after old_start).
                        self.shift_clips_after(dest_track_id, desired, dur)?;
                        self.shift_clips_after(track_id, old_start + dur + 1e-9, -dur)?;
                        desired
                    }
                } else {
                    // Cross-track: close the hole on the source, open space on the destination.
                    self.shift_clips_after(track_id, old_start + 1e-9, -dur)?;
                    self.shift_clips_after(dest_track_id, desired, dur)?;
                    desired
                }
            }
            EditMode::Overwrite => {
                self.overwrite_range(dest_track_id, desired, desired + dur)?;
                desired
            }
        };

        let track = self.timeline.track_mut(dest_track_id)?;
        track.clips.push(Clip {
            start: placed,
            ..clip_snapshot
        });
        Timeline::sort_track(track);
        Ok((dest_track_id, linked, placed))
    }

    /// Track of the partner's kind occupying the same row position as
    /// `dest_track_id` (V1↔A1, V2↔A2, …). Returns None when no usable match.
    fn mapped_partner_track(
        &self,
        dest_track_id: TrackId,
        partner_clip_id: ClipId,
    ) -> Option<TrackId> {
        let dest_track = self
            .timeline
            .tracks
            .iter()
            .find(|t| t.id == dest_track_id)?;
        let partner_track = self.timeline.find_clip(partner_clip_id).ok()?.0;
        if partner_track.kind == dest_track.kind {
            return None;
        }
        let kind_index = self
            .timeline
            .tracks
            .iter()
            .filter(|t| t.kind == dest_track.kind)
            .position(|t| t.id == dest_track_id)?;
        let mapped = self
            .timeline
            .tracks
            .iter()
            .filter(|t| t.kind == partner_track.kind)
            .nth(kind_index)?;
        if mapped.locked || mapped.hidden {
            return None;
        }
        Some(mapped.id)
    }

    /// Force a clip onto an absolute timeline start on a (possibly different)
    /// track, preserving A/V sync. Overlaps are not resolved (pair moves keep
    /// lockstep like `set_clip_start_absolute`).
    fn relocate_clip_absolute(
        &mut self,
        clip_id: ClipId,
        dest_track_id: TrackId,
        start: f64,
    ) -> Result<(), TimelineError> {
        let (src_track_id, kind) = {
            let (track, _idx) = self.timeline.find_clip(clip_id)?;
            (track.id, track.kind)
        };
        if src_track_id == dest_track_id {
            self.set_clip_start_absolute(clip_id, start)?;
            return Ok(());
        }
        let dest_track = self
            .timeline
            .tracks
            .iter()
            .find(|t| t.id == dest_track_id)
            .ok_or(TimelineError::TrackNotFound(dest_track_id))?;
        if dest_track.kind != kind {
            return Err(TimelineError::MediaTrackMismatch);
        }
        if dest_track.locked || dest_track.hidden {
            return Err(TimelineError::TrackLocked);
        }
        let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
        let clip = track.clips.remove(idx);
        let dest_track = self.timeline.track_mut(dest_track_id)?;
        dest_track.clips.push(Clip {
            start: start.max(0.0),
            ..clip
        });
        Timeline::sort_track(dest_track);
        Ok(())
    }

    /// Force a clip onto an absolute timeline start (used for linked A/V sync).
    fn set_clip_start_absolute(
        &mut self,
        clip_id: ClipId,
        start: f64,
    ) -> Result<(), TimelineError> {
        let (track, idx) = self.timeline.find_clip_mut(clip_id)?;
        if track.locked {
            return Err(TimelineError::TrackLocked);
        }
        track.clips[idx].start = start.max(0.0);
        Timeline::sort_track(track);
        Ok(())
    }

    /// Find a start time near `desired` where `[start, start+dur)` does not overlap obstacles
    /// and fits completely in a valid free space interval (gap).
    fn resolve_non_overlapping_start_for_obstacles(
        &self,
        desired: f64,
        dur: f64,
        obstacles: &[(f64, f64)],
    ) -> f64 {
        let target = desired.max(0.0);
        if obstacles.is_empty() || dur <= 0.001 {
            return target;
        }

        let mut intervals: Vec<(f64, f64)> = obstacles
            .iter()
            .filter(|(s, e)| *e - *s > 0.001)
            .map(|(s, e)| (s.max(0.0), e.max(0.0)))
            .collect();
        intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

        if intervals.is_empty() {
            return target;
        }

        let mut merged: Vec<(f64, f64)> = Vec::new();
        for curr in intervals {
            if let Some(prev) = merged.last_mut() {
                if curr.0 <= prev.1 + 0.001 {
                    prev.1 = prev.1.max(curr.1);
                    continue;
                }
            }
            merged.push(curr);
        }

        let mut valid_ranges: Vec<(f64, f64)> = Vec::new();

        if merged[0].0 >= dur - 0.001 {
            valid_ranges.push((0.0, merged[0].0 - dur));
        }

        for i in 0..merged.len().saturating_sub(1) {
            let gap_start = merged[i].1;
            let gap_end = merged[i + 1].0;
            if gap_end - gap_start >= dur - 0.001 {
                valid_ranges.push((gap_start, gap_end - dur));
            }
        }

        let last_end = merged[merged.len() - 1].1;
        valid_ranges.push((last_end, f64::INFINITY));

        for (min, max) in &valid_ranges {
            if target >= *min - 0.001 && target <= *max + 0.001 {
                return target.clamp(*min, *max);
            }
        }

        let mut best_candidate = valid_ranges[0].0;
        let mut best_dist = f64::INFINITY;
        for (min, max) in &valid_ranges {
            let candidate = target.clamp(*min, *max);
            let dist = (candidate - target).abs();
            if dist < best_dist {
                best_dist = dist;
                best_candidate = candidate;
            }
        }

        best_candidate.max(0.0)
    }

    /// Find a start time near `desired` where `[start, start+dur)` does not overlap others.
    #[allow(dead_code)]
    pub fn resolve_non_overlapping_start(
        &self,
        track_id: TrackId,
        desired: f64,
        dur: f64,
    ) -> Result<f64, TimelineError> {
        let track = self
            .timeline
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .ok_or(TimelineError::TrackNotFound(track_id))?;
        let obstacles: Vec<(f64, f64)> = track.clips.iter().map(|c| (c.start, c.end())).collect();
        Ok(self.resolve_non_overlapping_start_for_obstacles(desired, dur, &obstacles))
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
        clip.clamp_fades();
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

        // Clamp fades after duration change.
        if let Ok((track, idx)) = self.timeline.find_clip_mut(clip_id) {
            track.clips[idx].clamp_fades();
        }

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
            return Err(TimelineError::NoZone);
        };
        for tid in self.unlocked_track_ids() {
            self.overwrite_range(tid, zone_in, zone_out)?;
        }
        Ok(())
    }

    fn extract_zone(&mut self) -> Result<(), TimelineError> {
        let Some((zone_in, zone_out)) = self.zone_bounds() else {
            return Err(TimelineError::NoZone);
        };
        let zone_dur = zone_out - zone_in;
        // Clear zone temporarily so nested lift doesn't fail — we already validated.
        for tid in self.unlocked_track_ids() {
            self.overwrite_range(tid, zone_in, zone_out)?;
        }
        for tid in self.unlocked_track_ids() {
            self.shift_clips_after(tid, zone_out, -zone_dur)?;
        }
        Ok(())
    }

    fn split_one(
        &mut self,
        clip_id: ClipId,
        at: f64,
    ) -> Result<(ClipId, Option<ClipId>), TimelineError> {
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
        let speed = left.clamped_speed();
        let split_source = left.in_point + offset * speed;
        let left_dur = offset;
        let right_dur = (left.duration() - offset).max(0.0);
        // Left keeps fade_in; right keeps fade_out; clear the fade that no longer applies.
        track.clips[idx].out_point = split_source;
        track.clips[idx].linked_clip_id = left.linked_clip_id;
        track.clips[idx].fade_in = left.fade_in.min(left_dur);
        track.clips[idx].fade_out = 0.0;
        track.clips[idx].clamp_fades();
        let right = Clip {
            id: Uuid::new_v4(),
            media_path: left.media_path,
            source_path: left.source_path,
            start: at,
            in_point: split_source,
            out_point: left.out_point,
            role: left.role,
            linked_clip_id: None,
            fade_in: 0.0,
            fade_out: left.fade_out.min(right_dur),
            reverse: left.reverse,
            speed: left.speed,
            filters: left.filters,
        };
        let right_id = right.id;
        let linked = left.linked_clip_id;
        track.clips.insert(idx + 1, right);
        Ok((right_id, linked))
    }

    /// Re-point every clip referencing `from` to `to` (e.g. hot-swap an
    /// original file to its finished proxy). Not undoable — playback plumbing
    /// only; the edit intent does not change.
    pub fn swap_media_path(&mut self, from: &str, to: &str) -> usize {
        let mut count = 0;
        for track in &mut self.timeline.tracks {
            for clip in &mut track.clips {
                if clip.media_path == from {
                    clip.media_path = to.to_string();
                    count += 1;
                }
            }
        }
        count
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

impl Timeline {
    /// Consistency validation (timeline invariants that must never be
    /// silently violated). Returns human-readable problems; empty = valid.
    /// Exercised after edit storms in tests and exposed to the frontend for
    /// diagnostics.
    pub fn validate(&self) -> Vec<String> {
        let mut issues = Vec::new();
        let mut clip_ids: std::collections::HashSet<ClipId> = std::collections::HashSet::new();
        let mut track_ids: std::collections::HashSet<TrackId> = std::collections::HashSet::new();
        for track in &self.tracks {
            if !track_ids.insert(track.id) {
                issues.push(format!("duplicate track id {}", track.id));
            }
            for clip in &track.clips {
                if !clip_ids.insert(clip.id) {
                    issues.push(format!("duplicate clip id {}", clip.id));
                }
                let name = &clip.media_path;
                if !(clip.start.is_finite()
                    && clip.in_point.is_finite()
                    && clip.out_point.is_finite()
                    && clip.speed.is_finite())
                {
                    issues.push(format!("clip {name}: non-finite timing"));
                    continue;
                }
                if clip.out_point <= clip.in_point {
                    issues.push(format!(
                        "clip {name}: invalid range in={} out={}",
                        clip.in_point, clip.out_point
                    ));
                }
                if clip.start < 0.0 {
                    issues.push(format!("clip {name}: negative start {}", clip.start));
                }
                if clip.duration() <= 0.0 {
                    issues.push(format!("clip {name}: non-positive timeline duration"));
                }
            }
        }
        // Link integrity: partner must exist, link must be mutual, roles must differ.
        for track in &self.tracks {
            for clip in &track.clips {
                let Some(link) = clip.linked_clip_id else {
                    continue;
                };
                let partner = self
                    .tracks
                    .iter()
                    .flat_map(|t| t.clips.iter())
                    .find(|c| c.id == link);
                match partner {
                    None => {
                        issues.push(format!(
                            "clip {}: linked partner {link} does not exist",
                            clip.media_path
                        ));
                    }
                    Some(p) => {
                        if p.linked_clip_id != Some(clip.id) {
                            issues.push(format!(
                                "clip {}: link to {link} is not mutual",
                                clip.media_path
                            ));
                        }
                        if p.role == clip.role {
                            issues.push(format!(
                                "clip {}: linked to same-role clip",
                                clip.media_path
                            ));
                        }
                    }
                }
            }
        }
        issues
    }
}

#[cfg(test)]
mod bench;

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
                source_path: None,
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
                source_path: None,
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
    fn move_does_not_overlap_in_normal_mode() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let left = ed
            .apply(EditCommand::AddClip {
                track_id: v1,
                media_path: "a.mp4".into(),
                source_path: None,
                start: 0.0,
                in_point: 0.0,
                out_point: 5.0,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .unwrap()
            .primary_clip_id
            .unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "b.mp4".into(),
            source_path: None,
            start: 5.0,
            in_point: 0.0,
            out_point: 5.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();

        // Drag left piece onto the right piece — should snap beside it, not stack.
        ed.apply(EditCommand::MoveClip {
            clip_id: left,
            new_start: 7.0,
            sync_linked: false,
            target_track_id: None,
        })
        .unwrap();

        let clips = &ed.timeline.tracks[0].clips;
        assert_eq!(clips.len(), 2);
        let a = clips.iter().find(|c| c.media_path == "a.mp4").unwrap();
        let b = clips.iter().find(|c| c.media_path == "b.mp4").unwrap();
        assert!(
            a.end() <= b.start + 1e-6 || b.end() <= a.start + 1e-6,
            "clips overlap: a=[{}, {}) b=[{}, {})",
            a.start,
            a.end(),
            b.start,
            b.end()
        );
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
                source_path: None,
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
            target_track_id: None,
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

    /// Every command behind the toolbar "More" menu, exercised end to end.
    #[test]
    fn more_menu_commands_end_to_end() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let a1 = ed.timeline.first_track(TrackKind::Audio).unwrap();

        // Content: two AV pairs with a gap between them.
        let r1 = ed
            .apply(EditCommand::AddAvPair {
                video_track_id: v1,
                audio_track_id: a1,
                media_path: "a.mp4".into(),
                source_path: None,
                start: 0.0,
                in_point: 0.0,
                out_point: 4.0,
            })
            .unwrap();
        ed.apply(EditCommand::AddAvPair {
            video_track_id: v1,
            audio_track_id: a1,
            media_path: "b.mp4".into(),
            source_path: None,
            start: 6.0,
            in_point: 0.0,
            out_point: 10.0,
        })
        .unwrap();

        // --- Edit mode switching ---
        for mode in [EditMode::Normal, EditMode::Insert, EditMode::Overwrite] {
            ed.apply(EditCommand::SetEditMode { mode }).unwrap();
            assert_eq!(ed.timeline.edit_mode, mode);
        }
        ed.apply(EditCommand::SetEditMode {
            mode: EditMode::Normal,
        })
        .unwrap();

        // --- Zone in / out ---
        ed.apply(EditCommand::SetZone {
            zone_in: Some(1.0),
            zone_out: Some(8.0),
        })
        .unwrap();
        assert_eq!(ed.timeline.zone_in, Some(1.0));
        assert_eq!(ed.timeline.zone_out, Some(8.0));

        // --- Marker ---
        ed.apply(EditCommand::AddMarker {
            time: 2.0,
            label: "M1".into(),
        })
        .unwrap();
        assert_eq!(ed.timeline.markers.len(), 1);

        // --- Link / Unlink A/V ---
        let vid = r1.primary_clip_id.unwrap();
        let aud = r1.secondary_clip_id.unwrap();
        ed.apply(EditCommand::UnlinkClip { clip_id: vid }).unwrap();
        ed.apply(EditCommand::LinkClips {
            clip_a: vid,
            clip_b: aud,
        })
        .unwrap();

        // --- Close gap at 4s (all tracks): clip B should move to 4.0 ---
        ed.apply(EditCommand::CloseGap {
            track_id: None,
            at: 4.5,
        })
        .unwrap();
        let v1_clip_b = ed
            .timeline
            .tracks
            .iter()
            .find(|t| t.id == v1)
            .unwrap()
            .clips
            .iter()
            .find(|c| c.media_path == "b.mp4")
            .unwrap();
        assert!(
            (v1_clip_b.start - 4.0).abs() < 1e-6,
            "gap should close, b at {}",
            v1_clip_b.start
        );

        // --- Ripple delete clip A (video) — B shifts back to 0 ---
        ed.apply(EditCommand::RippleDelete {
            clip_id: vid,
            remove_linked: true,
        })
        .unwrap();
        let v1 = ed.timeline.tracks.iter().find(|t| t.id == v1).unwrap();
        assert!(
            v1.clips.iter().all(|c| c.id != vid),
            "ripple-deleted clip must be gone"
        );
        let a_track = ed
            .timeline
            .tracks
            .iter()
            .find(|t| t.kind == TrackKind::Audio)
            .unwrap();
        let b_start_after = a_track
            .clips
            .iter()
            .find(|c| c.media_path == "b.mp4")
            .map(|c| c.start)
            .unwrap();
        assert!(
            b_start_after < 1.0,
            "followers ripple back, b at {}",
            b_start_after
        );

        // --- Undo everything still works after the chain ---
        assert!(ed.undo().is_ok());
    }

    #[test]
    fn move_clip_to_track_moves_within_kind() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let v2 = ed
            .apply(EditCommand::AddTrack {
                kind: TrackKind::Video,
                name: None,
            })
            .unwrap();
        let _ = v2;
        let clip_id = ed
            .apply(EditCommand::AddClip {
                track_id: v1,
                media_path: "clip.mp4".into(),
                source_path: None,
                start: 2.0,
                in_point: 0.0,
                out_point: 5.0,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .unwrap()
            .primary_clip_id
            .unwrap();
        let v2_id = ed
            .timeline
            .tracks
            .iter()
            .find(|t| t.kind == TrackKind::Video && t.id != v1)
            .unwrap()
            .id;
        ed.apply(EditCommand::MoveClip {
            clip_id,
            new_start: 4.0,
            sync_linked: false,
            target_track_id: Some(v2_id),
        })
        .unwrap();
        // Gone from the source track…
        assert!(ed
            .timeline
            .tracks
            .iter()
            .find(|t| t.id == v1)
            .unwrap()
            .clips
            .is_empty());
        // …and present on the destination track at the requested start.
        let dest = ed.timeline.tracks.iter().find(|t| t.id == v2_id).unwrap();
        assert_eq!(dest.clips.len(), 1);
        assert!((dest.clips[0].start - 4.0).abs() < 1e-9);
    }

    #[test]
    fn move_cross_track_syncs_linked_pair() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let a1 = ed.timeline.first_track(TrackKind::Audio).unwrap();
        ed.apply(EditCommand::AddTrack {
            kind: TrackKind::Video,
            name: None,
        })
        .unwrap();
        ed.apply(EditCommand::AddTrack {
            kind: TrackKind::Audio,
            name: None,
        })
        .unwrap();
        let res = ed
            .apply(EditCommand::AddAvPair {
                video_track_id: v1,
                audio_track_id: a1,
                media_path: "clip.mp4".into(),
                source_path: None,
                start: 0.0,
                in_point: 0.0,
                out_point: 8.0,
            })
            .unwrap();
        let vid = res.primary_clip_id.unwrap();
        let v2_id = ed
            .timeline
            .tracks
            .iter()
            .filter(|t| t.kind == TrackKind::Video)
            .nth(1)
            .unwrap()
            .id;
        let a2_id = ed
            .timeline
            .tracks
            .iter()
            .filter(|t| t.kind == TrackKind::Audio)
            .nth(1)
            .unwrap()
            .id;
        ed.apply(EditCommand::MoveClip {
            clip_id: vid,
            new_start: 2.0,
            sync_linked: true,
            target_track_id: Some(v2_id),
        })
        .unwrap();
        let v2 = ed.timeline.tracks.iter().find(|t| t.id == v2_id).unwrap();
        let a2 = ed.timeline.tracks.iter().find(|t| t.id == a2_id).unwrap();
        assert_eq!(v2.clips.len(), 1);
        assert_eq!(a2.clips.len(), 1);
        assert!((v2.clips[0].start - 2.0).abs() < 1e-9);
        // Partner stays in lockstep on the mapped track.
        assert!((a2.clips[0].start - 2.0).abs() < 1e-9);
        assert_eq!(a2.clips[0].linked_clip_id, Some(vid));
    }

    #[test]
    fn split_and_undo() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let clip_id = ed
            .apply(EditCommand::AddClip {
                track_id: v1,
                media_path: "clip.mp4".into(),
                source_path: None,
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
                source_path: None,
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
            source_path: None,
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
            source_path: None,
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
            source_path: None,
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
                source_path: None,
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
            source_path: None,
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
            source_path: None,
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
            source_path: None,
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
            source_path: None,
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
        let v2 = ed
            .timeline
            .tracks
            .iter()
            .find(|t| t.name == "V2")
            .unwrap()
            .id;
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

    #[test]
    fn link_unlink_opposite_roles() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let a1 = ed.timeline.first_track(TrackKind::Audio).unwrap();
        let vid = ed
            .apply(EditCommand::AddClip {
                track_id: v1,
                media_path: "v.mp4".into(),
                source_path: Some("orig.mp4".into()),
                start: 0.0,
                in_point: 0.0,
                out_point: 5.0,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .unwrap()
            .primary_clip_id
            .unwrap();
        let aid = ed
            .apply(EditCommand::AddClip {
                track_id: a1,
                media_path: "v.mp4".into(),
                source_path: Some("orig.mp4".into()),
                start: 0.0,
                in_point: 0.0,
                out_point: 5.0,
                role: MediaRole::Audio,
                linked_clip_id: None,
            })
            .unwrap()
            .primary_clip_id
            .unwrap();

        ed.apply(EditCommand::LinkClips {
            clip_a: vid,
            clip_b: aid,
        })
        .unwrap();
        assert_eq!(ed.timeline.tracks[0].clips[0].linked_clip_id, Some(aid));
        let audio = ed
            .timeline
            .tracks
            .iter()
            .find(|t| t.kind == TrackKind::Audio)
            .unwrap();
        assert_eq!(audio.clips[0].linked_clip_id, Some(vid));
        assert_eq!(
            ed.timeline.tracks[0].clips[0].source_path.as_deref(),
            Some("orig.mp4")
        );

        ed.apply(EditCommand::UnlinkClip { clip_id: vid }).unwrap();
        assert!(ed.timeline.tracks[0].clips[0].linked_clip_id.is_none());
        let audio = ed
            .timeline
            .tracks
            .iter()
            .find(|t| t.kind == TrackKind::Audio)
            .unwrap();
        assert!(audio.clips[0].linked_clip_id.is_none());
    }

    #[test]
    fn link_rejects_same_role_and_same_track() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let a = ed
            .apply(EditCommand::AddClip {
                track_id: v1,
                media_path: "a.mp4".into(),
                source_path: None,
                start: 0.0,
                in_point: 0.0,
                out_point: 2.0,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .unwrap()
            .primary_clip_id
            .unwrap();
        let b = ed
            .apply(EditCommand::AddClip {
                track_id: v1,
                media_path: "b.mp4".into(),
                source_path: None,
                start: 2.0,
                in_point: 0.0,
                out_point: 2.0,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .unwrap()
            .primary_clip_id
            .unwrap();
        let err = ed
            .apply(EditCommand::LinkClips {
                clip_a: a,
                clip_b: b,
            })
            .unwrap_err();
        assert!(matches!(err, TimelineError::InvalidLink));
    }

    #[test]
    fn split_syncs_linked_pair() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let a1 = ed.timeline.first_track(TrackKind::Audio).unwrap();
        let res = ed
            .apply(EditCommand::AddAvPair {
                video_track_id: v1,
                audio_track_id: a1,
                media_path: "pair.mp4".into(),
                source_path: None,
                start: 0.0,
                in_point: 0.0,
                out_point: 10.0,
            })
            .unwrap();
        let vid = res.primary_clip_id.unwrap();
        ed.apply(EditCommand::SplitClip {
            clip_id: vid,
            at: 4.0,
            sync_linked: true,
        })
        .unwrap();
        assert_eq!(ed.timeline.tracks[0].clips.len(), 2);
        let audio = ed
            .timeline
            .tracks
            .iter()
            .find(|t| t.kind == TrackKind::Audio)
            .unwrap();
        assert_eq!(audio.clips.len(), 2);
        // Right-hand pair re-linked.
        let v_right = &ed.timeline.tracks[0].clips[1];
        let a_right = &audio.clips[1];
        assert_eq!(v_right.linked_clip_id, Some(a_right.id));
        assert_eq!(a_right.linked_clip_id, Some(v_right.id));
    }

    #[test]
    fn lift_and_extract_empty_zone_are_noop_errors() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "x.mp4".into(),
            source_path: None,
            start: 0.0,
            in_point: 0.0,
            out_point: 5.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();
        let before = ed.timeline.clone();
        assert!(matches!(
            ed.apply(EditCommand::LiftZone).unwrap_err(),
            TimelineError::NoZone
        ));
        assert_eq!(
            ed.timeline.tracks[0].clips.len(),
            before.tracks[0].clips.len()
        );
        assert!(
            (ed.timeline.tracks[0].clips[0].start - before.tracks[0].clips[0].start).abs() < 1e-9
        );

        assert!(matches!(
            ed.apply(EditCommand::ExtractZone).unwrap_err(),
            TimelineError::NoZone
        ));
        assert_eq!(ed.timeline.tracks[0].clips.len(), 1);
    }

    #[test]
    fn lift_zone_leaves_gap() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "long.mp4".into(),
            source_path: None,
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
        ed.apply(EditCommand::LiftZone).unwrap();
        let clips = &ed.timeline.tracks[0].clips;
        assert_eq!(clips.len(), 2);
        assert!((clips[0].end() - 5.0).abs() < 1e-9);
        assert!((clips[1].start - 12.0).abs() < 1e-9);
    }

    #[test]
    fn ripple_delete_closes_gap_and_removes_linked() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let a1 = ed.timeline.first_track(TrackKind::Audio).unwrap();
        let res = ed
            .apply(EditCommand::AddAvPair {
                video_track_id: v1,
                audio_track_id: a1,
                media_path: "a.mp4".into(),
                source_path: None,
                start: 0.0,
                in_point: 0.0,
                out_point: 5.0,
            })
            .unwrap();
        let vid = res.primary_clip_id.unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "b.mp4".into(),
            source_path: None,
            start: 5.0,
            in_point: 0.0,
            out_point: 3.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();
        ed.apply(EditCommand::RippleDelete {
            clip_id: vid,
            remove_linked: true,
        })
        .unwrap();
        assert_eq!(ed.timeline.tracks[0].clips.len(), 1);
        assert!((ed.timeline.tracks[0].clips[0].start - 0.0).abs() < 1e-9);
        let audio = ed
            .timeline
            .tracks
            .iter()
            .find(|t| t.kind == TrackKind::Audio)
            .unwrap();
        assert!(audio.clips.is_empty());
    }

    #[test]
    fn track_mute_lock_hide_flags() {
        let mut ed = TimelineEditor::new();
        let a1 = ed.timeline.first_track(TrackKind::Audio).unwrap();
        ed.apply(EditCommand::SetTrackMute {
            track_id: a1,
            muted: true,
        })
        .unwrap();
        ed.apply(EditCommand::SetTrackLock {
            track_id: a1,
            locked: true,
        })
        .unwrap();
        ed.apply(EditCommand::SetTrackHidden {
            track_id: a1,
            hidden: true,
        })
        .unwrap();
        let track = ed.timeline.tracks.iter().find(|t| t.id == a1).unwrap();
        assert!(track.muted && track.locked && track.hidden);
    }

    #[test]
    fn cannot_delete_last_audio_track() {
        let mut ed = TimelineEditor::new();
        let audio_ids: Vec<_> = ed
            .timeline
            .tracks
            .iter()
            .filter(|t| t.kind == TrackKind::Audio)
            .map(|t| t.id)
            .collect();
        assert!(!audio_ids.is_empty());
        for id in &audio_ids[..audio_ids.len().saturating_sub(1)] {
            ed.apply(EditCommand::RemoveTrack { track_id: *id })
                .unwrap();
        }
        let last = ed.timeline.first_track(TrackKind::Audio).unwrap();
        let err = ed
            .apply(EditCommand::RemoveTrack { track_id: last })
            .unwrap_err();
        assert!(matches!(err, TimelineError::LastTrack("audio")));
    }

    #[test]
    fn spacer_negative_delta_clamps_without_overlap() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "a.mp4".into(),
            source_path: None,
            start: 0.0,
            in_point: 0.0,
            out_point: 4.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "b.mp4".into(),
            source_path: None,
            start: 6.0,
            in_point: 0.0,
            out_point: 2.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();
        // Drag spacer left inside the 2s gap — only remove available space.
        ed.apply(EditCommand::SpacerShift {
            track_id: Some(v1),
            at: 5.0,
            delta: -3.0,
        })
        .unwrap();
        let clips = &ed.timeline.tracks[0].clips;
        assert!((clips[0].start - 0.0).abs() < 1e-9);
        assert!((clips[1].start - 4.0).abs() < 1e-9);
        assert!(clips[1].start >= clips[0].end() - 1e-6);
    }

    #[test]
    fn close_gap_removes_space_at_playhead() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "a.mp4".into(),
            source_path: None,
            start: 0.0,
            in_point: 0.0,
            out_point: 3.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "b.mp4".into(),
            source_path: None,
            start: 8.0,
            in_point: 0.0,
            out_point: 2.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();
        ed.apply(EditCommand::CloseGap {
            track_id: Some(v1),
            at: 5.0,
        })
        .unwrap();
        let clips = &ed.timeline.tracks[0].clips;
        assert!((clips[1].start - 3.0).abs() < 1e-9);
        assert!(matches!(
            ed.apply(EditCommand::CloseGap {
                track_id: Some(v1),
                at: 1.0,
            })
            .unwrap_err(),
            TimelineError::NoGap
        ));
    }

    #[test]
    fn remove_gaps_packs_track_from_time() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "a.mp4".into(),
            source_path: None,
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
            source_path: None,
            start: 5.0,
            in_point: 0.0,
            out_point: 2.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();
        ed.apply(EditCommand::AddClip {
            track_id: v1,
            media_path: "c.mp4".into(),
            source_path: None,
            start: 10.0,
            in_point: 0.0,
            out_point: 1.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();
        ed.apply(EditCommand::RemoveGaps {
            track_id: Some(v1),
            from: 0.0,
        })
        .unwrap();
        let clips = &ed.timeline.tracks[0].clips;
        assert!((clips[0].start - 0.0).abs() < 1e-9);
        assert!((clips[1].start - 2.0).abs() < 1e-9);
        assert!((clips[2].start - 4.0).abs() < 1e-9);
    }

    #[test]
    fn overwrite_move_replaces_range() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let left = ed
            .apply(EditCommand::AddClip {
                track_id: v1,
                media_path: "a.mp4".into(),
                source_path: None,
                start: 0.0,
                in_point: 0.0,
                out_point: 10.0,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .unwrap()
            .primary_clip_id
            .unwrap();
        ed.apply(EditCommand::SetEditMode {
            mode: EditMode::Overwrite,
        })
        .unwrap();
        // Place a short clip via move onto the long one (overwrite punches hole).
        let short = ed
            .apply(EditCommand::AddClip {
                track_id: v1,
                media_path: "b.mp4".into(),
                source_path: None,
                start: 20.0,
                in_point: 0.0,
                out_point: 2.0,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .unwrap()
            .primary_clip_id
            .unwrap();
        ed.apply(EditCommand::MoveClip {
            clip_id: short,
            new_start: 4.0,
            sync_linked: false,
            target_track_id: None,
        })
        .unwrap();
        let _ = left;
        let clips = &ed.timeline.tracks[0].clips;
        assert!(clips
            .iter()
            .any(|c| c.media_path == "b.mp4" && (c.start - 4.0).abs() < 1e-6));
    }

    #[test]
    fn move_rejects_insufficient_space_and_avoids_overlap() {
        let mut ed = TimelineEditor::new();
        let track_id = ed.timeline.first_track(TrackKind::Video).unwrap();
        // Clip 1: [0.0, 5.0]
        ed.apply(EditCommand::AddClip {
            track_id,
            media_path: "c1.mp4".into(),
            source_path: None,
            start: 0.0,
            in_point: 0.0,
            out_point: 5.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();
        // Clip 2: [7.0, 12.0] (Gap is [5.0, 7.0], size = 2.0s)
        ed.apply(EditCommand::AddClip {
            track_id,
            media_path: "c2.mp4".into(),
            source_path: None,
            start: 7.0,
            in_point: 0.0,
            out_point: 5.0,
            role: MediaRole::Video,
            linked_clip_id: None,
        })
        .unwrap();
        // Clip 3: [20.0, 24.0], duration = 4.0s (Cannot fit in the 2.0s gap between 5.0 and 7.0)
        let c3 = ed
            .apply(EditCommand::AddClip {
                track_id,
                media_path: "c3.mp4".into(),
                source_path: None,
                start: 20.0,
                in_point: 0.0,
                out_point: 4.0,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .unwrap()
            .primary_clip_id
            .unwrap();

        // Try moving c3 into the 2s gap at desired = 5.5
        ed.apply(EditCommand::MoveClip {
            clip_id: c3,
            new_start: 5.5,
            sync_linked: false,
            target_track_id: None,
        })
        .unwrap();

        let track = ed
            .timeline
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .unwrap();
        let c3_placed = track.clips.iter().find(|c| c.id == c3).unwrap();
        // c3 duration is 4.0, gap [5.0, 7.0] is only 2.0.
        // It must NOT be placed inside [5.0, 7.0] or overlap [0, 5] or [7, 12]!
        assert!(c3_placed.start >= 12.0 - 1e-6);
        // Verify NO overlapping clips anywhere on the track:
        for i in 0..track.clips.len() {
            for j in (i + 1)..track.clips.len() {
                let a = &track.clips[i];
                let b = &track.clips[j];
                assert!(
                    a.end() <= b.start + 1e-6 || b.end() <= a.start + 1e-6,
                    "Clips {:?} and {:?} overlap!",
                    a,
                    b
                );
            }
        }
    }

    /// End-to-end edit matrix matching the manual smoke checklist (logic layer).
    #[test]
    fn manual_smoke_matrix_logic() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let a1 = ed.timeline.first_track(TrackKind::Audio).unwrap();

        // 1. Import AV → linked → Unlink → Link again
        let res = ed
            .apply(EditCommand::AddAvPair {
                video_track_id: v1,
                audio_track_id: a1,
                media_path: "smoke.mp4".into(),
                source_path: Some("C:/media/smoke.mp4".into()),
                start: 0.0,
                in_point: 0.0,
                out_point: 12.0,
            })
            .unwrap();
        let vid = res.primary_clip_id.unwrap();
        let aid = res.secondary_clip_id.unwrap();
        assert_eq!(ed.timeline.tracks[0].clips[0].linked_clip_id, Some(aid));
        ed.apply(EditCommand::UnlinkClip { clip_id: vid }).unwrap();
        assert!(ed.timeline.tracks[0].clips[0].linked_clip_id.is_none());
        ed.apply(EditCommand::LinkClips {
            clip_a: vid,
            clip_b: aid,
        })
        .unwrap();
        assert_eq!(ed.timeline.tracks[0].clips[0].linked_clip_id, Some(aid));

        // 2. Split (Ctrl+B path = SplitClip sync_linked)
        ed.apply(EditCommand::SplitClip {
            clip_id: vid,
            at: 4.0,
            sync_linked: true,
        })
        .unwrap();
        assert_eq!(ed.timeline.tracks[0].clips.len(), 2);
        let audio = ed
            .timeline
            .tracks
            .iter()
            .find(|t| t.kind == TrackKind::Audio)
            .unwrap();
        assert_eq!(audio.clips.len(), 2);

        // 3. Move linked pair stays aligned
        let left_v = ed.timeline.tracks[0].clips[0].id;
        ed.apply(EditCommand::MoveClip {
            clip_id: left_v,
            new_start: 1.0,
            sync_linked: true,
            target_track_id: None,
        })
        .unwrap();
        let v_start = ed.timeline.tracks[0].clips[0].start;
        let a_start = ed
            .timeline
            .tracks
            .iter()
            .find(|t| t.kind == TrackKind::Audio)
            .unwrap()
            .clips[0]
            .start;
        assert!((v_start - a_start).abs() < 1e-9);

        // 4. Slip / ripple / spacer / delete smoke
        let right_v = ed.timeline.tracks[0].clips[1].id;
        ed.apply(EditCommand::SlipClip {
            clip_id: right_v,
            delta: 0.25,
            sync_linked: true,
        })
        .unwrap();
        ed.apply(EditCommand::SpacerShift {
            track_id: Some(v1),
            at: 10.0,
            delta: 1.0,
        })
        .unwrap();

        // 5. Zone lift leaves gap; empty zone errors; extract closes gap
        ed.apply(EditCommand::SetZone {
            zone_in: Some(1.5),
            zone_out: Some(2.5),
        })
        .unwrap();
        ed.apply(EditCommand::LiftZone).unwrap();
        let after_lift = ed.timeline.tracks[0].clips.len();
        assert!(after_lift >= 2);
        ed.apply(EditCommand::SetZone {
            zone_in: None,
            zone_out: None,
        })
        .unwrap();
        assert!(matches!(
            ed.apply(EditCommand::ExtractZone).unwrap_err(),
            TimelineError::NoZone
        ));
        ed.apply(EditCommand::SetZone {
            zone_in: Some(8.0),
            zone_out: Some(9.0),
        })
        .unwrap();
        // May or may not hit clips depending on layout — still must not panic.
        let _ = ed.apply(EditCommand::ExtractZone);

        // 6. Mute A1
        ed.apply(EditCommand::SetTrackMute {
            track_id: a1,
            muted: true,
        })
        .unwrap();
        assert!(
            ed.timeline
                .tracks
                .iter()
                .find(|t| t.id == a1)
                .unwrap()
                .muted
        );

        // 7. Unlink → move audio later (export start gap scenario)
        let v_clip = ed.timeline.tracks[0].clips[0].id;
        if let Some(link) = ed.timeline.tracks[0].clips[0].linked_clip_id {
            let before = ed
                .timeline
                .tracks
                .iter()
                .find(|t| t.kind == TrackKind::Audio)
                .unwrap()
                .clips
                .iter()
                .find(|c| c.id == link)
                .map(|c| c.start)
                .unwrap_or(0.0);
            ed.apply(EditCommand::UnlinkClip { clip_id: v_clip })
                .unwrap();
            ed.apply(EditCommand::MoveClip {
                clip_id: link,
                new_start: before + 2.0,
                sync_linked: false,
                target_track_id: None,
            })
            .unwrap();
            let a = ed
                .timeline
                .tracks
                .iter()
                .find(|t| t.kind == TrackKind::Audio)
                .unwrap()
                .clips
                .iter()
                .find(|c| c.id == link)
                .unwrap();
            assert!(
                a.start > before + 0.5,
                "audio should move later for export gap; before={before} after={}",
                a.start
            );
        }

        // 8. Undo restores prior snapshot
        ed.undo().unwrap();
        ed.redo().unwrap();
    }

    #[test]
    fn set_clip_fades_clamps_and_split_preserves() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let res = ed
            .apply(EditCommand::AddClip {
                track_id: v1,
                media_path: "x.mp4".into(),
                source_path: None,
                start: 0.0,
                in_point: 0.0,
                out_point: 10.0,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .unwrap();
        let id = res.primary_clip_id.unwrap();
        ed.apply(EditCommand::SetClipFades {
            clip_id: id,
            fade_in: 2.0,
            fade_out: 3.0,
        })
        .unwrap();
        {
            let c = &ed.timeline.tracks[0].clips[0];
            assert!((c.fade_in - 2.0).abs() < 1e-9);
            assert!((c.fade_out - 3.0).abs() < 1e-9);
            assert!((c.fade_gain_at(1.0) - 0.5).abs() < 1e-6);
        }
        // Over-long fades clamp.
        ed.apply(EditCommand::SetClipFades {
            clip_id: id,
            fade_in: 8.0,
            fade_out: 8.0,
        })
        .unwrap();
        {
            let c = &ed.timeline.tracks[0].clips[0];
            assert!(c.fade_in + c.fade_out <= c.duration() + 1e-9);
        }
        ed.apply(EditCommand::SetClipFades {
            clip_id: id,
            fade_in: 1.0,
            fade_out: 2.0,
        })
        .unwrap();
        ed.apply(EditCommand::SplitClip {
            clip_id: id,
            at: 4.0,
            sync_linked: false,
        })
        .unwrap();
        let left = &ed.timeline.tracks[0].clips[0];
        let right = &ed.timeline.tracks[0].clips[1];
        assert!((left.fade_in - 1.0).abs() < 1e-9);
        assert!(left.fade_out.abs() < 1e-9);
        assert!(right.fade_in.abs() < 1e-9);
        assert!((right.fade_out - 2.0).abs() < 1e-9);
    }
}

/// --- Performance / scale / consistency ---------------------------------
#[cfg(test)]
mod scale_tests {
    use super::*;

    /// Build a project with `n` linked AV pairs spread over V1/A1, simulating a
    /// long editing session, and return (editor, video clip ids).
    fn build_stress(n: usize) -> (TimelineEditor, Vec<ClipId>) {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let a1 = ed.timeline.first_track(TrackKind::Audio).unwrap();
        let mut ids = Vec::with_capacity(n);
        for i in 0..n {
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

    #[test]
    fn stress_500_clips_split_move_trim_stay_valid() {
        let (mut ed, ids) = build_stress(500);
        // Split 100 clips (the razor storm case).
        for (i, id) in ids.iter().take(100).enumerate() {
            ed.apply(EditCommand::SplitClip {
                clip_id: *id,
                at: i as f64 * 4.0 + 2.0,
                sync_linked: true,
            })
            .unwrap();
        }
        assert!(ed.timeline.validate().is_empty(), "valid after splits");
        // Move 50 right-halves (no-ops via collision resolution must not corrupt).
        for (i, id) in ids.iter().take(50).enumerate() {
            let _ = ed.apply(EditCommand::MoveClip {
                clip_id: *id,
                new_start: i as f64 * 4.0 + 1.0,
                sync_linked: true,
                target_track_id: None,
            });
        }
        assert!(ed.timeline.validate().is_empty(), "valid after moves");
        // Trim 50.
        for (i, id) in ids.iter().skip(100).take(50).enumerate() {
            ed.apply(EditCommand::TrimClip {
                clip_id: *id,
                in_point: 0.5,
                out_point: 3.5,
                keep_end: false,
                sync_linked: true,
            })
            .unwrap();
        }
        assert!(ed.timeline.validate().is_empty(), "valid after trims");
        // Ripple delete 20.
        for id in ids.iter().skip(200).take(20) {
            let _ = ed.apply(EditCommand::RippleDelete {
                clip_id: *id,
                remove_linked: true,
            });
        }
        let issues = ed.timeline.validate();
        assert!(
            issues.is_empty(),
            "timeline corrupt after storm: {issues:?}"
        );
    }

    #[test]
    fn stress_undo_redo_roundtrip_preserves_content() {
        // 40 pairs + 40 splits = 80 undo entries, inside max_history (100).
        let (mut ed, ids) = build_stress(40);
        for (i, id) in ids.iter().enumerate() {
            ed.apply(EditCommand::SplitClip {
                clip_id: *id,
                at: i as f64 * 4.0 + 1.0,
                sync_linked: true,
            })
            .unwrap();
        }
        let after_edits = ed.timeline.clone();
        // Undo the splits, then redo them.
        for _ in 0..ids.len() {
            ed.undo().unwrap();
        }
        for _ in 0..ids.len() {
            ed.redo().unwrap();
        }
        assert!(
            ed.timeline.validate().is_empty(),
            "valid after undo/redo storm"
        );
        assert_eq!(
            ed.timeline.tracks[0].clips.len(),
            after_edits.tracks[0].clips.len()
        );
        assert!((ed.timeline.duration() - after_edits.duration()).abs() < 1e-9);
    }

    #[test]
    fn validation_detects_corruption() {
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let id = ed
            .apply(EditCommand::AddClip {
                track_id: v1,
                media_path: "a.mp4".into(),
                source_path: None,
                start: 0.0,
                in_point: 0.0,
                out_point: 5.0,
                role: MediaRole::Video,
                linked_clip_id: None,
            })
            .unwrap()
            .primary_clip_id
            .unwrap();
        assert!(ed.timeline.validate().is_empty());
        // Simulate corruption: dangling link + inverted range.
        ed.timeline.tracks[0].clips[0].linked_clip_id = Some(Uuid::new_v4());
        ed.timeline.tracks[0].clips[0].out_point = 0.0;
        let issues = ed.timeline.validate();
        assert!(issues.len() >= 2, "expected ≥2 issues, got {issues:?}");
        let _ = id;
    }

    #[test]
    fn repeated_split_100_is_cheap_and_linked() {
        // 100 progressive splits: each cut targets the right half (razor-dragging
        // down one long clip) and must keep the linked audio pair in lockstep.
        let mut ed = TimelineEditor::new();
        let v1 = ed.timeline.first_track(TrackKind::Video).unwrap();
        let a1 = ed.timeline.first_track(TrackKind::Audio).unwrap();
        let mut vid = ed
            .apply(EditCommand::AddAvPair {
                video_track_id: v1,
                audio_track_id: a1,
                media_path: "long.mp4".into(),
                source_path: None,
                start: 0.0,
                in_point: 0.0,
                out_point: 100.0,
            })
            .unwrap()
            .primary_clip_id
            .unwrap();
        for i in 1..100 {
            vid = ed
                .apply(EditCommand::SplitClip {
                    clip_id: vid,
                    at: i as f64,
                    sync_linked: true,
                })
                .unwrap()
                .primary_clip_id
                .unwrap();
        }
        let issues = ed.timeline.validate();
        assert!(issues.is_empty(), "valid after 99 splits: {issues:?}");
        let v_clips = &ed.timeline.tracks[0].clips;
        let a_clips = &ed.timeline.tracks[2].clips;
        assert_eq!(v_clips.len(), 100);
        assert_eq!(a_clips.len(), 100);
        for (v, a) in v_clips.iter().zip(a_clips.iter()) {
            assert!((v.start - a.start).abs() < 1e-9, "A/V pair desynced");
        }
    }
}
