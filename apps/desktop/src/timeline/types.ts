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
  start: number;
  in_point: number;
  out_point: number;
  role: "video" | "audio";
  linked_clip_id: string | null;
  filters: { id: string; kind: string; enabled: boolean }[];
};

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

export function fileName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export function timelineDuration(timeline: Timeline, fallback = 10): number {
  const ends = timeline.tracks.flatMap((t) =>
    t.clips.map((c) => c.start + (c.out_point - c.in_point)),
  );
  if (ends.length === 0) return fallback;
  return Math.max(1, ...ends);
}

export function clipAtPlayhead(timeline: Timeline, playhead: number, kind: "video" | "audio") {
  for (const track of timeline.tracks) {
    if (track.kind !== kind || track.muted || track.hidden) continue;
    for (const clip of track.clips) {
      const end = clip.start + (clip.out_point - clip.in_point);
      if (playhead >= clip.start && playhead < end) {
        return { track, clip };
      }
    }
  }
  return null;
}
