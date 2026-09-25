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

/** Still image / animated GIF extensions importable as visual clips. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];

/** True when the media file previews as an image (`<img>`), not a `<video>`. */
export function isImagePath(path: string | null | undefined): boolean {
  if (!path) return false;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.includes(ext);
}

/** Media-file time for timeline position t within a clip (handles speed + reverse). */
export function mediaTimeForClip(
  clip: { start: number; in_point: number; out_point: number; reverse?: boolean; speed?: number },
  t: number,
): number {
  const raw = clip.speed ?? 1;
  const speed = Number.isFinite(raw) ? Math.min(4, Math.max(0.25, raw)) : 1;
  const local = t - clip.start;
  const media = clip.reverse
    ? clip.out_point - local * speed
    : clip.in_point + local * speed;
  return Math.max(clip.in_point, Math.min(media, clip.out_point - 0.01));
}

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
  /** Container reports disagreeing nominal/average video rates (VFR). Such
   * sources cannot be indexed by frame number — map time, not frames. */
  is_variable_frame_rate: boolean;
};

export type LibraryItem = MediaInfo & { id: string; name: string };

export type TimelineTool = "select" | "razor" | "spacer" | "slip" | "ripple";

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = Math.floor(s % 60);
  const hundredths = Math.floor((s % 1) * 100);
  const hPrefix = h > 0 ? `${h}:` : "";
  const mStr = h > 0 ? String(m).padStart(2, "0") : String(m);
  const sStr = String(rem).padStart(2, "0");
  const cStr = String(hundredths).padStart(2, "0");
  return `${hPrefix}${mStr}:${sStr}.${cStr}`;
}

/** Ruler labels: format cleanly based on step size down to milliseconds. */
export function formatRulerTime(seconds: number, stepSec: number): string {
  const s = Math.max(0, seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = Math.floor(s % 60);
  const hPrefix = h > 0 ? `${h}:` : "";
  const mStr = h > 0 ? String(m).padStart(2, "0") : String(m);
  const sStr = String(rem).padStart(2, "0");

  if (stepSec >= 3600) {
    return `${hPrefix}${mStr}:00:00`;
  }
  if (stepSec >= 60) {
    return `${hPrefix}${mStr}:${sStr}`;
  }
  if (stepSec >= 1) {
    return `${hPrefix}${mStr}:${sStr}`;
  }
  if (stepSec >= 0.1) {
    const tenths = Math.floor((s % 1) * 10);
    return `${hPrefix}${mStr}:${sStr}.${tenths}`;
  }
  const hundredths = Math.floor(Number(((s % 1) * 100).toFixed(2)));
  return `${hPrefix}${mStr}:${sStr}.${String(hundredths).padStart(2, "0")}`;
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

/** The clip under the playhead that drives the main preview: the
 * BOTTOM-MOST visual layer (first video track = base of the composite;
 * within a track, the earliest-starting clip). Overlays on higher tracks
 * composite above it — see videoStackAtPlayhead. */
export function clipAtPlayhead(timeline: Timeline, playhead: number, kind: "video" | "audio") {
  for (const track of timeline.tracks) {
    if (track.kind !== kind || track.muted || track.hidden) continue;
    let best: Clip | null = null;
    for (const clip of track.clips) {
      const end = clip.start + clipTimelineDuration(clip);
      if (playhead >= clip.start && playhead < end) {
        if (!best || clip.start < best.start) best = clip;
      }
    }
    if (best) return { track, clip: best };
  }
  return null;
}

/** All video clips under the playhead ordered BOTTOM → TOP (compositing
 * order, matching the export overlay chain): tracks in array order, clips
 * within a track by start time. */
export function videoStackAtPlayhead(
  timeline: Timeline,
  playhead: number,
): { track: Track; clip: Clip }[] {
  const out: { track: Track; clip: Clip }[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "video" || track.muted || track.hidden) continue;
    const hits = track.clips
      .filter((c) => {
        const end = c.start + clipTimelineDuration(c);
        return playhead >= c.start && playhead < end;
      })
      .sort((a, b) => a.start - b.start);
    for (const clip of hits) out.push({ track, clip });
  }
  return out;
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

export type Obstacle = { start: number; duration: number };

/** Obstacle tagged with its owning clip id. Panels build SHARED per-track
 * lists once per timeline change; each drag filters out self/partner once
 * per gesture instead of the panel materializing per-clip copies (O(n²)). */
export type IndexedObstacle = Obstacle & { id: string };

/**
 * Nearest value in a SORTED array to `t`, within `threshold` — or null.
 * Binary search: snapping must stay O(log n) even with hundreds of clips.
 */
export function nearestInSorted(
  sorted: number[],
  t: number,
  threshold: number,
): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  let best: number | null = null;
  let bestDist = threshold;
  // lo is the lower bound (first value >= t); only it and its predecessor
  // can be the nearest element.
  for (let idx = lo - 1; idx <= lo; idx++) {
    if (idx < 0 || idx >= n) continue;
    const d = Math.abs(sorted[idx] - t);
    if (d < bestDist) {
      bestDist = d;
      best = sorted[idx];
    }
  }
  return best;
}

/**
 * Find a start time near `desired` where `[start, start+dur)` does not overlap any obstacles
 * and fits completely in a valid free space interval (gap).
 *
 * If a gap is smaller than `dur`, the clip will NOT be allowed to be placed inside it,
 * preventing any invalid overlapping or truncated placements.
 */
export function resolveNonOverlappingStart(
  desired: number,
  dur: number,
  obstacles: Obstacle[],
): number {
  const target = Math.max(0, desired);
  if (!obstacles || obstacles.length === 0 || dur <= 0.001) {
    return target;
  }

  // 1. Filter and merge overlapping/touching obstacles into disjoint intervals [start, end]
  const intervals: { start: number; end: number }[] = obstacles
    .filter((o) => o.duration > 0.001)
    .map((o) => ({
      start: Math.max(0, o.start),
      end: Math.max(0, o.start + o.duration),
    }))
    .sort((a, b) => a.start - b.start);

  if (intervals.length === 0) {
    return target;
  }

  const merged: { start: number; end: number }[] = [];
  for (const curr of intervals) {
    const prev = merged[merged.length - 1];
    if (prev && curr.start <= prev.end + 0.001) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push({ start: curr.start, end: curr.end });
    }
  }

  // 2. Compute valid free slots [gapStart, gapEnd] where gapEnd - gapStart >= dur
  // Allowed start range in slot is [validMin, validMax] where validMin = gapStart, validMax = gapEnd - dur.
  type ValidRange = { min: number; max: number };
  const validRanges: ValidRange[] = [];

  // Slot before first obstacle (from 0 to first obstacle start)
  if (merged[0].start >= dur - 0.001) {
    validRanges.push({ min: 0, max: merged[0].start - dur });
  }

  // Slots between adjacent obstacles
  for (let i = 0; i < merged.length - 1; i++) {
    const gapStart = merged[i].end;
    const gapEnd = merged[i + 1].start;
    if (gapEnd - gapStart >= dur - 0.001) {
      validRanges.push({ min: gapStart, max: gapEnd - dur });
    }
  }

  // Slot after last obstacle (to Infinity)
  const lastEnd = merged[merged.length - 1].end;
  validRanges.push({ min: lastEnd, max: Infinity });

  // 3. Find the best placement:
  // If target is inside any valid range, target is 100% valid!
  for (const range of validRanges) {
    if (target >= range.min - 0.001 && target <= range.max + 0.001) {
      return Math.max(range.min, Math.min(range.max, target));
    }
  }

  // If target falls in an occupied region or insufficient gap,
  // find the closest valid start across all valid ranges.
  let bestCandidate = validRanges[0].min;
  let bestDist = Infinity;

  for (const range of validRanges) {
    const candidate = Math.max(range.min, Math.min(range.max, target));
    const dist = Math.abs(candidate - target);
    if (dist < bestDist) {
      bestDist = dist;
      bestCandidate = candidate;
    }
  }

  return Math.max(0, bestCandidate);
}

