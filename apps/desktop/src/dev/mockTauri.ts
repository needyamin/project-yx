/**
 * Dev-only mock Tauri backend for the benchmark harness (bench.html).
 *
 * Simulates the pieces of the Rust backend the UI needs, with honest IPC
 * cost: every timeline response is passed through JSON round-trip
 * (JSON.stringify → JSON.parse), which is the same magnitude of work as
 * serde serialization + deserialization across the real IPC boundary.
 * NOT included in production builds — imported only by src/dev/bench.ts.
 */
import type { Clip, Timeline } from "../timeline/types";

type MockClip = Clip & { role: "video" | "audio" };

export type BenchMedia = {
  key: string;
  url: string; // URL usable by <video>/<audio> in this environment
};

let callbackId = 0;

export function installMockTauri(opts: { clips: number; mediaUrls: string[] }): Timeline {
  const w = window as unknown as Record<string, unknown>;
  const mediaOf = (i: number) => opts.mediaUrls[i % opts.mediaUrls.length];

  const clip = (id: string, start: number, role: "video" | "audio", mediaIdx: number): MockClip => ({
    id,
    media_path: mediaOf(mediaIdx),
    source_path: null,
    start,
    in_point: 0,
    out_point: 4,
    role,
    linked_clip_id: null,
    fade_in: 0,
    fade_out: 0,
    reverse: false,
    speed: 1,
    filters: [],
  });

  const tracks: Timeline["tracks"] = [
    { id: "v1", name: "V1", kind: "video", muted: false, locked: false, hidden: false, clips: [] },
    { id: "v2", name: "V2", kind: "video", muted: false, locked: false, hidden: false, clips: [] },
    { id: "a1", name: "A1", kind: "audio", muted: false, locked: false, hidden: false, clips: [] },
    { id: "a2", name: "A2", kind: "audio", muted: false, locked: false, hidden: false, clips: [] },
  ];

  for (let i = 0; i < opts.clips; i++) {
    const start = (i * 4.5) % 3600;
    const vId = `v${i}`;
    const aId = `a${i}`;
    const v = clip(vId, start, "video", i);
    const a = clip(aId, start, "audio", i);
    v.linked_clip_id = aId;
    a.linked_clip_id = vId;
    tracks[0].clips.push(v);
    tracks[2].clips.push(a);
  }

  let timeline: Timeline = {
    frame_rate: 30,
    width: 1920,
    height: 1080,
    edit_mode: "normal",
    markers: [],
    zone_in: null,
    zone_out: null,
    tracks,
  };

  const undoStack: string[] = [];
  const redoStack: string[] = [];
  const pushUndo = () => {
    undoStack.push(JSON.stringify(timeline));
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  };
  const respond = (): Timeline => JSON.parse(JSON.stringify(timeline));
  const findClip = (id: string): { track: Timeline["tracks"][0]; clip: MockClip } | null => {
    for (const track of timeline.tracks) {
      const clip = track.clips.find((c) => c.id === id);
      if (clip) return { track, clip: clip as MockClip };
    }
    return null;
  };

  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    get_boot_info: async () => ({
      profile: {
        logical_cpus: navigator.hardwareConcurrency ?? 8,
        physical_cpus: Math.max(1, (navigator.hardwareConcurrency ?? 8) / 2),
        total_memory_mb: 16384,
        has_discrete_gpu: false,
        hw_decode: [],
        hw_encode: [],
        ffmpeg_available: true,
      },
      policy: {
        tier: "medium",
        preview_scale: "720p",
        proxy: { height: 540, video_bitrate_kbps: 1200 },
        encode_threads: 4,
        preview_allows_heavy_filters: false,
        prefer_hw_decode: false,
        prefer_hw_encode: false,
      },
      timeline: respond(),
    }),
    get_timeline: async () => respond(),
    move_clip: async (args) => {
      pushUndo();
      const hit = findClip(String(args.clipId));
      if (hit) {
        hit.clip.start = Number(args.newStart);
        if (args.syncLinked && hit.clip.linked_clip_id) {
          const partner = findClip(hit.clip.linked_clip_id);
          if (partner) partner.clip.start = Number(args.newStart);
        }
      }
      return respond();
    },
    trim_clip: async (args) => {
      pushUndo();
      const hit = findClip(String(args.clipId));
      if (hit) {
        hit.clip.in_point = Number(args.inPoint);
        hit.clip.out_point = Number(args.outPoint);
        if (args.syncLinked && hit.clip.linked_clip_id) {
          const partner = findClip(hit.clip.linked_clip_id);
          if (partner) {
            partner.clip.in_point = Number(args.inPoint);
            partner.clip.out_point = Number(args.outPoint);
          }
        }
      }
      return respond();
    },
    split_clip_at: async (args) => {
      pushUndo();
      const hit = findClip(String(args.clipId));
      if (hit) {
        const at = Number(args.at);
        if (at > hit.clip.start && at < hit.clip.start + (hit.clip.out_point - hit.clip.in_point)) {
          const right: MockClip = { ...hit.clip, id: `r${callbackId++}`, start: at, in_point: at };
          hit.clip.out_point = at;
          hit.track.clips.push(right);
          hit.track.clips.sort((a, b) => a.start - b.start);
          if (
            args.syncLinked &&
            hit.clip.linked_clip_id &&
            hit.track.kind !== (findClip(hit.clip.linked_clip_id)?.track.kind ?? hit.track.kind)
          ) {
            // Split the linked partner at the same timeline time and link the
            // right-hand pair (matches the engine's SplitClip behavior).
            const partner = findClip(hit.clip.linked_clip_id);
            if (partner && at > partner.clip.start && at < partner.clip.start + (partner.clip.out_point - partner.clip.in_point)) {
              const pRight: MockClip = {
                ...partner.clip,
                id: `r${callbackId++}`,
                start: at,
                in_point: at,
              };
              partner.clip.out_point = at;
              partner.clip.linked_clip_id = null;
              partner.track.clips.push(pRight);
              partner.track.clips.sort((a, b) => a.start - b.start);
              right.linked_clip_id = pRight.id;
              pRight.linked_clip_id = right.id;
            }
          }
        }
      }
      return respond();
    },
    remove_clip: async (args) => {
      pushUndo();
      const hit = findClip(String(args.clipId));
      if (hit) {
        const linked = hit.clip.linked_clip_id;
        hit.track.clips = hit.track.clips.filter((c) => c.id !== hit.clip.id);
        if (args.removeLinked !== false && linked) {
          const partner = findClip(linked);
          if (partner) partner.track.clips = partner.track.clips.filter((c) => c.id !== linked);
        }
      }
      return respond();
    },
    clear_timeline: async () => {
      pushUndo();
      for (const track of timeline.tracks) track.clips = [];
      return respond();
    },
    clear_track: async (args) => {
      pushUndo();
      const track = timeline.tracks.find((t) => t.id === String(args.trackId));
      if (track) track.clips = [];
      return respond();
    },
    add_filter: async (args) => {
      pushUndo();
      const hit = findClip(String(args.clipId));
      if (hit) {
        hit.clip.filters = [
          ...(hit.clip.filters ?? []),
          {
            id: `f${callbackId++}`,
            kind: String(args.kind),
            enabled: true,
            params: (args.params ?? {}) as Record<string, unknown>,
          },
        ];
      }
      return respond();
    },
    update_filter: async (args) => {
      pushUndo();
      const hit = findClip(String(args.clipId));
      const f = hit?.clip.filters?.find((x) => x.id === String(args.filterId));
      if (f) f.params = (args.params ?? {}) as Record<string, unknown>;
      return respond();
    },
    remove_filter: async (args) => {
      pushUndo();
      const hit = findClip(String(args.clipId));
      if (hit) hit.clip.filters = (hit.clip.filters ?? []).filter((x) => x.id !== String(args.filterId));
      return respond();
    },
    set_filter_enabled: async (args) => {
      const hit = findClip(String(args.clipId));
      const f = hit?.clip.filters?.find((x) => x.id === String(args.filterId));
      if (f) f.enabled = Boolean(args.enabled);
      return respond();
    },
    // Magic Remove pipeline (instant fakes — enough to drive the UI flow).
    magic_remove_track: async () => ({ keyframes: [] }),
    magic_remove_render: async () => opts.mediaUrls[1] ?? opts.mediaUrls[0] ?? "mock://magic.mp4",
    get_media_thumbnail: async (args) => {
      const key = `t${Math.round(Number(args.time) * 4)}`;
      const cacheKey = `${String(args.source)}|${key}`;
      const cached = (globalThis as unknown as { __thumbCache?: Map<string, string> }).__thumbCache;
      const store = cached ?? new Map<string, string>();
      (globalThis as unknown as { __thumbCache?: Map<string, string> }).__thumbCache = store;
      const hit = store.get(cacheKey);
      if (hit) return hit;
      const canvas = document.createElement("canvas");
      canvas.width = 192;
      canvas.height = 108;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#223";
      ctx.fillRect(0, 0, 192, 108);
      ctx.fillStyle = "#4af";
      ctx.fillRect(0, (Number(args.time) * 13) % 108, 192, 20);
      ctx.fillStyle = "#fff";
      ctx.font = "12px monospace";
      ctx.fillText(`${Number(args.time).toFixed(2)}s`, 8, 20);
      const data = canvas.toDataURL("image/jpeg", 0.7);
      store.set(cacheKey, data);
      return data;
    },
    undo: async () => {
      const prev = undoStack.pop();
      if (!prev) throw new Error("nothing to undo");
      redoStack.push(JSON.stringify(timeline));
      timeline = JSON.parse(prev);
      return respond();
    },
    redo: async () => {
      const next = redoStack.pop();
      if (!next) throw new Error("nothing to redo");
      undoStack.push(JSON.stringify(timeline));
      timeline = JSON.parse(next);
      return respond();
    },
  };

  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWebview: { label: "main", windowLabel: "main" },
      currentWindow: { label: "main" },
    },
    plugins: {},
    resources: {},
    transformCallback: () => ++callbackId,
    convertFileSrc: (p: string) => String(p),
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      const handler = handlers[cmd];
      if (handler) return handler(args);
      if (cmd === "plugin:event|listen" || cmd === "plugin:event|unlisten") return null;
      throw new Error(`bench mock: unhandled command ${cmd}`);
    },
  };
  return timeline;
}
