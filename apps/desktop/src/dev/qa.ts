/**
 * Project Monitor region-tools QA harness (dev-only, served at /qa.html).
 *
 * Mounts the REAL App against the mock Tauri backend (same trick as
 * bench.ts) with ONE green-screen clip, and lets QA scenarios be selected
 * via the ?seed= query param so a page reload reproduces each boot state:
 *
 *   /qa.html            — one clean clip (tools opened through the real UI)
 *   /qa.html?seed=blur  — blurregion filter enabled at boot (autosave case)
 *   /qa.html?seed=all   — blurregion (animated) + chromakey at boot
 *   /qa.html?seed=overlap - V2 overlay clip covering V1 for 2s (PiP stack)
 *   /qa.html?seed=reverse - V1 clip plays backward (stepped reverse stepper)
 *   /qa.html?seed=reverse-overlap - V2 overlay is a reverse clip (stepped
 *                                   overlay follow; must NOT play forward)
 *   /qa.html?seed=speedcut - adjacent same-media clips at 1x then 2x (guards
 *                            the seamless same-media rate re-latch)
 *
 * When the pane is hidden, Chromium starves requestAnimationFrame and
 * ResizeObserver callbacks (they are frame-tied). The app's gestures and
 * layout measurement depend on them, so in that case the harness installs
 * timer-based shims of those two browser APIs — APP CODE IS UNTOUCHED.
 *
 * window.__qa exposes drive/inspect helpers. Errors are trapped and shown
 * in the #qa-errors overlay so a crashed GUI is visible in screenshots.
 *
 * Not part of the production bundle (vite only builds index.html).
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { installMockTauri } from "./mockTauri";
import { playbackClock } from "../playback/playbackClock";
import { isImagePath } from "../timeline/types";
import type { Clip } from "../timeline/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const w = window as unknown as { __errs: string[]; __qa: Record<string, any> };
w.__errs = [];
window.addEventListener("error", (e) =>
  w.__errs.push("ERR: " + String((e.error && e.error.stack) || e.message)),
);
window.addEventListener("unhandledrejection", (e) =>
  w.__errs.push("REJ: " + String((e.reason && e.reason.stack) || e.reason)),
);

/* --- hidden-pane shims (must be installed before the app loads) --- */
if (document.visibilityState === "hidden") {
  const pending = new Map<number, number>();
  let nextId = 1;
  window.requestAnimationFrame = ((cb: (t: number) => void) => {
    const id = nextId++;
    pending.set(
      id,
      window.setTimeout(() => {
        pending.delete(id);
        cb(performance.now());
      }, 16),
    );
    return id;
  }) as typeof requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => {
    const t = pending.get(id);
    if (t != null) {
      window.clearTimeout(t);
      pending.delete(id);
    }
  }) as typeof cancelAnimationFrame;

  window.ResizeObserver = class {
    private cb: ResizeObserverCallback;
    private targets = new Map<Element, { w: number; h: number }>();
    private timer: number;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      this.timer = window.setInterval(() => this.check(), 200);
    }
    observe(t: Element) {
      this.targets.set(t, { w: t.clientWidth, h: t.clientHeight });
    }
    unobserve(t: Element) {
      this.targets.delete(t);
    }
    disconnect() {
      this.targets.clear();
      window.clearInterval(this.timer);
    }
    private check() {
      for (const [t, prev] of [...this.targets]) {
        const cur = { w: t.clientWidth, h: t.clientHeight };
        if (cur.w !== prev.w || cur.h !== prev.h) {
          this.targets.set(t, cur);
          this.cb([], this as unknown as ResizeObserver);
        }
      }
    }
  } as unknown as typeof ResizeObserver;
}

const MEDIA_DIR = encodeURI("/@fs/Y:/Project YX/benchmark/media");
// ?media=cross serves the clip from a different origin (with ACAO:* like
// Tauri's asset protocol) so canvas-tainting behavior can be QA'd.
const MEDIA_URL =
  new URLSearchParams(location.search).get("media") === "cross"
    ? "http://localhost:1422/qa_green.mp4"
    : `${MEDIA_DIR}/qa_green_av.mp4`;

// Pre-seed state BEFORE the app boots — get_boot_info returns this
// timeline, reproducing "app reopens with filters from the last session".
const timeline = installMockTauri({ clips: 1, mediaUrls: [MEDIA_URL] });
const seed = new URLSearchParams(location.search).get("seed");
const clip = timeline.tracks[0].clips[0];
if (seed === "speed") {
  // ?seed=speed — 2× clip with linked audio: exercises the drift-lock path.
  clip.speed = 2;
  const linked = timeline.tracks[2].clips[0];
  if (linked) linked.speed = 2;
}
if (seed === "split") {
  // ?seed=split — one AV pair split at 2s: exercises the boundary continuation.
  const v0 = timeline.tracks[0].clips[0];
  const a0 = timeline.tracks[2].clips[0];
  const mk = (id: string, base: Clip, start: number, inP: number): Clip => ({
    ...base, id, start, in_point: inP, out_point: 4,
  });
  timeline.tracks[0].clips = [
    { ...v0, out_point: 2 },
    mk("v0b", v0, 2, 2),
  ];
  timeline.tracks[2].clips = [
    { ...a0, out_point: 2 },
    mk("a0b", a0, 2, 2),
  ];
  timeline.tracks[0].clips[1].linked_clip_id = "a0b";
  timeline.tracks[2].clips[1].linked_clip_id = "v0b";
}
/**
 * Dev-only QA seed for the "timeline lags when one clip goes under another"
 * report (2026-09-23). Boots the real App with a two-video-track project:
 * a base clip on V1 and an overlay clip on V2 overlapping it for 2s, plus
 * linked A/V audio. Reproduces the MonitorLayer stack (PiP preview path)
 * so playback/scrub over the overlap can be measured without real media.
 *
 *   /qa.html?seed=overlap
 *
 * The overlay uses the same media URL as the base (mock backend, honest
 * IPC cost); the point is the composite stack + clock plumbing, not decode.
 */
if (seed === "overlap") {
  // Second video track already exists in the mock (tracks[1] = "v2").
  const v0 = timeline.tracks[0].clips[0];
  const a0 = timeline.tracks[2].clips[0];
  // Base: V1 0..4s (unchanged). Overlay: V2 2..4s covers the second half.
  const overlay: Clip = {
    ...v0,
    id: "v0-overlap",
    start: 2,
    linked_clip_id: null,
    // Clone the filter array: a shallow spread would share it with the base
    // V1 clip, so pushing the Transform below also re-filtered the base.
    filters: [...(v0.filters ?? [])],
  };
  timeline.tracks[1].clips = [overlay];
  // Give the overlay a Transform filter (typical PiP intent) so the static
  // style path + imperative opacity path are both exercised.
  overlay.filters.push({
    id: "qa-overlap-tf",
    kind: "transform",
    enabled: true,
    params: { x: 0.4, y: 0.35, scale: 0.35, rotation: 0, opacity: 1 },
  });
  // Linked partner for the base so the live-drag preview path also runs.
  void a0;
}

if (seed === "reverse") {
  // ?seed=reverse - the base clip plays backward (stepped reverse stepper in
  // togglePlay): exercises the seeking guard + half-frame step threshold and
  // invariant 4 (the deliberate element pause must not end the session).
  clip.reverse = true;
}
if (seed === "reverse-overlap") {
  // ?seed=reverse-overlap - V2 overlay clip is reversed over the forward V1
  // clip: exercises the stepped overlay follow (a reverse layer must never be
  // play()ed forward, and must not jump 1-3s every self-heal tick).
  const v0 = timeline.tracks[0].clips[0];
  timeline.tracks[1].clips = [
    { ...v0, id: "v0-rev-overlay", reverse: true, linked_clip_id: null },
  ];
}
if (seed === "speedcut") {
  // ?seed=speedcut - adjacent SAME-media clips (continuous out->in) at 1x then
  // 2x: the seamless same-media boundary keeps the element rolling, so its
  // rate must be re-latched or the whole second clip runs at 1x while the
  // mapper divides by 2.
  const v0 = timeline.tracks[0].clips[0];
  timeline.tracks[0].clips = [
    { ...v0, id: "v0a", out_point: 2, speed: 1 },
    { ...v0, id: "v0b", start: 2, in_point: 2, out_point: 4, speed: 2 },
  ];
}
if (!isImagePath(clip.media_path)) {
  if (seed === "blur" || seed === "all") {
    clip.filters.push({
      id: "qa-blur",
      kind: "blurregion",
      enabled: true,
      params: {
        x: 0.5,
        y: 0.5,
        w: 0.3,
        h: 0.3,
        rotation: 0,
        shape: "rect",
        cornerRadius: 0.15,
        intensity: 0.6,
        feather: 0.08,
        opacity: 1,
        keyframes:
          seed === "all"
            ? [
                { t: 0, x: 0.3, y: 0.5, w: 0.25, h: 0.25, rotation: 0, intensity: 0.6, feather: 0.08, opacity: 1 },
                { t: 2, x: 0.7, y: 0.5, w: 0.25, h: 0.25, rotation: 20, intensity: 0.6, feather: 0.08, opacity: 1 },
              ]
            : [],
      },
    });
  }
  if (seed === "chroma" || seed === "all") {
    clip.filters.push({
      id: "qa-chroma",
      kind: "chromakey",
      enabled: true,
      params: { color: "#00b140", similarity: 0.28, blend: 0.08, spill: 0 },
    });
  }
}

const host = document.getElementById("app") as HTMLDivElement;
const { default: App } = await import("../App");
ReactDOM.createRoot(host).render(React.createElement(App));

/* ---------------- QA drive/inspect helpers ---------------- */

function projectFrame(): HTMLElement {
  const f = Array.from(document.querySelectorAll(".monitor-frame")).find((x) =>
    x.closest(".project-monitor"),
  );
  if (!f) throw new Error("project monitor frame not found");
  return f as HTMLElement;
}

function firePointer(el: Element, type: string, x: number, y: number) {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      pointerId: 1,
      isPrimary: true,
    }),
  );
}

/** Drag from the center of `el` by (dx, dy) in px through window listeners,
 * coalesced across rAFs exactly like the app gestures run. */
async function dragEl(el: Element, dx: number, dy: number, steps = 6) {
  const r = el.getBoundingClientRect();
  const sx = r.left + r.width / 2;
  const sy = r.top + r.height / 2;
  firePointer(el, "pointerdown", sx, sy);
  const raf = () => new Promise<void>((res) => requestAnimationFrame(() => res()));
  for (let i = 1; i <= steps; i++) {
    firePointer(window as unknown as Element, "pointermove", sx + (dx * i) / steps, sy + (dy * i) / steps);
    await raf();
  }
  firePointer(window as unknown as Element, "pointerup", sx + dx, sy + dy);
  await raf();
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

w.__qa = {
  /** Seek the authoritative clock AND the monitor video element. */
  seek(t: number) {
    playbackClock.publish(t, true);
    const v = projectFrame().querySelector(".monitor-video") as HTMLVideoElement;
    if (v && Number.isFinite(v.duration)) {
      v.currentTime = Math.max(0, Math.min(t, v.duration - 0.05));
    }
  },
  /** Authoritative playhead (seconds) — sample it to verify playback. */
  clock(): number {
    return playbackClock.get();
  },
  /** Whether the app considers itself playing. */
  playing(): boolean {
    return !!document.querySelector(".transport-play.active, [class*='playing']");
  },
  /** Timeline state snapshot: per-track clip ranges (start–end) + media. */
  timelineState() {
    return Array.from(document.querySelectorAll(".tl-lane[data-track-id]")).map(
      (lane) => ({
        id: (lane as HTMLElement).dataset.trackId,
        clips: Array.from(lane.querySelectorAll(".tl-clip")).map((c) => ({
          id: (c as HTMLElement).dataset.clipId,
          left: (c as HTMLElement).style.left,
          width: (c as HTMLElement).style.width,
        })),
      }),
    );
  },
  /** Open the timeline context menu on a clip / lane / ruler and click an
   * item by (localized) label text. */
  async ctxMenu(where: "clip" | "lane" | "ruler", label: string) {
    let target: Element | null = null;
    if (where === "clip") {
      target = document.querySelector(".tl-clip");
    } else if (where === "lane") {
      target = document.querySelector(".tl-lane[data-track-id]");
    } else {
      target = document.querySelector(".tl-ruler");
    }
    if (!target) return { error: `${where} not found` };
    const r = target.getBoundingClientRect();
    const opts: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      clientX: r.left + Math.min(80, r.width / 2),
      clientY: r.top + r.height / 2,
    };
    target.dispatchEvent(new MouseEvent("contextmenu", opts));
    await sleep(120);
    const items = Array.from(document.querySelectorAll(".tl-context-menu .tl-ctx-item"));
    const found = items.find((b) => b.textContent?.includes(label));
    if (!found) {
      return {
        error: `item "${label}" not found`,
        items: items.map((b) => b.textContent?.trim()),
      };
    }
    (found as HTMLElement).click();
    await sleep(300);
    return { ok: true, label };
  },
  errs(): string[] {
    return [...w.__errs];
  },
  /** The blur region selection frame in frame-relative px (null = closed). */
  blurBox(): { cx: number; cy: number; w: number; h: number; rot: string } | null {
    const frame = projectFrame();
    const el = frame.querySelector(".br-frame") as HTMLElement | null;
    if (!el) return null;
    const fr = frame.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      cx: +(r.left - fr.left + r.width / 2).toFixed(1),
      cy: +(r.top - fr.top + r.height / 2).toFixed(1),
      w: +r.width.toFixed(1),
      h: +r.height.toFixed(1),
      rot: el.style.transform,
    };
  },
  /** Drag the blur region body by (dx, dy) px and report the box after the
   * commit round-trip has settled (or null while the tool is closed). */
  async dragBlur(dx: number, dy: number) {
    const frame = projectFrame();
    const el = frame.querySelector(".br-frame");
    if (!el) return { error: "br-frame not found (tool closed?)" };
    const before = this.blurBox();
    await dragEl(el, dx, dy);
    await sleep(250); // IPC round-trip + echo-clear
    return { before, after: this.blurBox(), errs: w.__errs.length };
  },
  /** Resize via the bottom-right handle. */
  async resizeBlur(dx: number, dy: number) {
    const frame = projectFrame();
    const el = frame.querySelector(".br-handle-br");
    if (!el) return { error: "handle not found" };
    await dragEl(el, dx, dy);
    await sleep(250);
    return { after: this.blurBox(), errs: w.__errs.length };
  },
  /** Alpha stats of the keyed preview canvas (bg removal verification). */
  keyAlpha() {
    const c = projectFrame().querySelector(
      ".key-preview-canvas",
    ) as HTMLCanvasElement | null;
    if (!c) return { error: "no key canvas" };
    const ctx = c.getContext("2d");
    if (!ctx) return { error: "no ctx" };
    const corners = [
      [2, 2],
      [c.width - 3, 2],
      [2, c.height - 3],
      [c.width - 3, c.height - 3],
      [c.width >> 1, c.height >> 1],
    ];
    const px = corners.map(([x, y]) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return { x, y, a: d[3], rgb: [d[0], d[1], d[2]] };
    });
    return { size: [c.width, c.height], px };
  },
  /** Open a monitor toolbar tool through the real UI. */
  async clickTool(label: string) {
    const btns = Array.from(document.querySelectorAll(".monitor-tools button"));
    const b = btns.find((x) => x.textContent?.includes(label));
    if (!b) return { error: `tool button "${label}" not found` };
    (b as HTMLElement).click();
    await sleep(250); // add_filter round-trip
    return { ok: true, errs: w.__errs.length };
  },
  /** Transform-drag the base media by (dx, dy) and return the live mirror
   * transform of the overlay canvases (whether the keyed preview follows). */
  async dragMedia(dx: number, dy: number) {
    const frame = projectFrame();
    const v = frame.querySelector(".monitor-video") as HTMLVideoElement;
    const before = v.style.transform;
    await dragEl(v, dx, dy);
    await sleep(300);
    return { before, after: v.style.transform, errs: w.__errs.length };
  },
};
