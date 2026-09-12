export type PerformanceTier = "potato" | "low" | "medium" | "high";

export type HardwareProfile = {
  logical_cpus: number;
  physical_cpus: number;
  total_memory_mb: number;
  has_discrete_gpu: boolean;
  hw_decode: string[];
  hw_encode: string[];
  ffmpeg_available: boolean;
};

export type PerformancePolicy = {
  tier: PerformanceTier;
  preview_scale: string;
  proxy: { height: number; video_bitrate_kbps: number };
  encode_threads: number;
  preview_allows_heavy_filters: boolean;
  prefer_hw_decode: boolean;
  prefer_hw_encode: boolean;
};

export type Clip = {
  id: string;
  media_path: string;
  /** Original file for export when media_path is a proxy. */
  source_path?: string | null;
  start: number;
  in_point: number;
  out_point: number;
  role: "video" | "audio";
  linked_clip_id: string | null;
  /** Fade-in duration from clip start (seconds). */
  fade_in?: number;
  /** Fade-out duration before clip end (seconds). */
  fade_out?: number;
  /** Play media backward within in/out (video export). */
  reverse?: boolean;
  /** Playback rate (1 = normal). Timeline length is (out-in)/speed. */
  speed?: number;
  filters: { id: string; kind: string; enabled: boolean; params?: Record<string, unknown> }[];
};

/** Timeline duration for a clip, accounting for speed. */
export function clipTimelineDuration(
  clip: Pick<Clip, "in_point" | "out_point" | "speed">,
): number {
  const media = Math.max(0, (clip.out_point ?? 0) - (clip.in_point ?? 0));
  const raw = clip.speed ?? 1;
  const speed = Number.isFinite(raw) ? Math.min(4, Math.max(0.25, raw)) : 1;
  return media / speed;
}

/** Linear 0..1 gain at timeline time for clip fades. */
export function clipFadeGain(
  clip: Pick<Clip, "start" | "in_point" | "out_point" | "fade_in" | "fade_out" | "speed">,
  time: number,
): number {
  const dur = clipTimelineDuration(clip);
  const local = time - clip.start;
  if (local < 0 || local >= dur) return 0;
  const fadeIn = Math.max(0, clip.fade_in ?? 0);
  const fadeOut = Math.max(0, clip.fade_out ?? 0);
  let g = 1;
  if (fadeIn > 1e-6 && local < fadeIn) g = Math.min(g, local / fadeIn);
  if (fadeOut > 1e-6 && local > dur - fadeOut) {
    g = Math.min(g, (dur - local) / fadeOut);
  }
  return Math.max(0, Math.min(1, g));
}

export type Track = {
  id: string;
  name: string;
  kind: "video" | "audio";
  muted: boolean;
  locked: boolean;
  hidden?: boolean;
  clips: Clip[];
};

export type TimelineMarker = {
  id: string;
  time: number;
  label: string;
};

export type EditMode = "normal" | "insert" | "overwrite";

export type Timeline = {
  frame_rate: number;
  width: number;
  height: number;
  tracks: Track[];
  edit_mode: EditMode;
  markers: TimelineMarker[];
  zone_in: number | null;
  zone_out: number | null;
};

export type BootInfo = {
  profile: HardwareProfile;
  policy: PerformancePolicy;
  timeline: Timeline;
};

export type MediaInfo = {
  path: string;
  duration: number;
  width: number;
  height: number;
  frame_rate: number;
  video_codec: string | null;
  audio_codec: string | null;
  has_audio: boolean;
  has_video: boolean;
};

export type LibraryItem = MediaInfo & { id: string; name: string };

export type TimelineTool = "select" | "razor" | "spacer" | "slip" | "ripple";

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds || 0);
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 10);
  return `${m}:${String(rem).padStart(2, "0")}.${ms}`;
}

/** Ruler labels: drop tenths when step ≥ 1s; emphasize minute scale. */
export function formatRulerTime(seconds: number, stepSec: number): string {
  const s = Math.max(0, seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = Math.floor(s % 60);
  if (stepSec >= 3600) {
    return `${h}:${String(m).padStart(2, "0")}:00`;
  }
  if (stepSec >= 60) {
    const totalMin = Math.floor(s / 60);
    return `${totalMin}:00`;
  }
  if (stepSec >= 1) {
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
    }
    return `${m}:${String(rem).padStart(2, "0")}`;
  }
  const tenths = Math.floor((s % 1) * 10);
  return `${m}:${String(rem).padStart(2, "0")}.${tenths}`;
}

export function fileName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export function timelineDuration(timeline: Timeline, fallback = 10): number {
  const ends = timeline.tracks.flatMap((t) =>
    t.clips.map((c) => c.start + clipTimelineDuration(c)),
  );
  if (ends.length === 0) return fallback;
  return Math.max(1, ...ends);
}

export function clipAtPlayhead(timeline: Timeline, playhead: number, kind: "video" | "audio") {
  for (const track of timeline.tracks) {
    if (track.kind !== kind || track.muted || track.hidden) continue;
    for (const clip of track.clips) {
      const end = clip.start + clipTimelineDuration(clip);
      if (playhead >= clip.start && playhead < end) {
        return { track, clip };
      }
    }
  }
  return null;
}

/** Next clip on a track of `kind` whose start is at/after `time` (sequence playback). */
export function nextClipAfter(timeline: Timeline, time: number, kind: "video" | "audio") {
  let best: { track: Track; clip: Clip } | null = null;
  for (const track of timeline.tracks) {
    if (track.kind !== kind || track.muted || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.start >= time - 0.001) {
        if (!best || clip.start < best.clip.start) {
          best = { track, clip };
        }
      }
    }
  }
  return best;
}

function sameMedia(a: Clip, b: Clip): boolean {
  if (a.media_path === b.media_path) return true;
  if (a.source_path && b.source_path && a.source_path === b.source_path) return true;
  if (a.source_path && a.source_path === b.media_path) return true;
  if (b.source_path && b.source_path === a.media_path) return true;
  return fileName(a.media_path) === fileName(b.media_path);
}

/** Partner for Link A/V: opposite role under playhead, else same media on unlocked track. */
export function findLinkPartner(
  timeline: Timeline,
  clip: Clip,
  playhead: number,
): Clip | null {
  const wantKind = clip.role === "video" ? "audio" : "video";
  for (const track of timeline.tracks) {
    if (track.kind !== wantKind || track.locked) continue;
    for (const c of track.clips) {
      const end = c.start + clipTimelineDuration(c);
      if (playhead >= c.start && playhead < end) return c;
    }
  }
  for (const track of timeline.tracks) {
    if (track.kind !== wantKind || track.locked) continue;
    const match = track.clips.find((c) => sameMedia(c, clip));
    if (match) return match;
  }
  return null;
}
