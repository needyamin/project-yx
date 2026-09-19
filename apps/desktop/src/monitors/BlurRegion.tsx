/**
 * Blur Region — monitor overlay + control panel for the `blurregion` filter.
 *
 * Lives inside the Project Monitor frame like the crop/magic tools. The
 * blurred preview is a canvas that mirrors the effective visual beneath it
 * (the key-canvas when BG keying is active, else the base video/image),
 * GPU-blurred with CSS `filter: blur()` and shaped/feathered by an in-frame
 * SVG mask — the same geometry model (source-normalized center/size +
 * rotation + feather band) the FFmpeg export bakes in via crop/gblur/geq.
 *
 * Interaction model (professional overlay, no screen-space hacks):
 * - geometry is stored normalized to the SOURCE frame, so the region tracks
 *   the content at any monitor size, aspect and fit mode;
 * - drag moves, 8 handles resize (Shift = proportional), a stem rotates;
 * - keyframes interpolate position/size/rotation/intensity/feather/opacity
 *   with the playhead (same clip-local clock the export uses);
 * - gestures only mutate local state; ONE engine commit happens per gesture
 *   (on pointer-up) — mouse movement never triggers IPC.
 */
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { usePlayheadTime } from "../playback/playbackClock";
import { mediaTimeForClip, type Clip } from "../timeline/types";
import {
  regionStateAt,
  removeRegionKeyframe,
  upsertRegionKeyframe,
  type BlurRegionKeyframe,
  type BlurShape,
  type RegionState,
} from "../effects/effects";
import type { ContentRect } from "./monitorGeometry";
import { applyTransformToMirrorCtx, type MirrorTransform } from "./monitorGeometry";

type Props = {
  clip: Clip;
  /** Preview src of the displayed clip (unused for drawing — the mirror
   * reads the live element — but kept for remount discipline). */
  src: string | null;
  isImage: boolean;
  /** Retained for future play-state-dependent behavior; the mirror canvas
   * runs off the live element, so it is not needed for sync. */
  playing?: boolean;
  frameSize: { w: number; h: number };
  /** Displayed content rect (fractions of the frame) for source mapping. */
  content: ContentRect;
  /** Natural size of the source media (kept for future resolution-aware
   * features; blur sigma is normalized to 1080p frame space). */
  mediaSize: { w: number; h: number } | null;
  /** Sub-rect of the source actually displayed (crop filter applied). */
  srcRect?: { left: number; top: number; right: number; bottom: number };
  params: Record<string, unknown>;
  toolOpen: boolean;
  busy: { phase: string; percent: number } | null;
  status: string | null;
  /** The effective visual beneath this overlay (key canvas when BG keying
   * is active, else the base video/image element). */
  getSourceEl: () =>
    | HTMLCanvasElement
    | HTMLVideoElement
    | HTMLImageElement
    | null;
  /** Live Transform filter of the base clip (read per frame so the mirrored
   * pixels follow transform gestures exactly like the preview element). */
  getMirrorTransform?: () => MirrorTransform | null;
  onCommit: (patch: Record<string, unknown>) => void;
  onTrack: () => void;
  onCancelTrack: () => void;
  onRemove: () => void;
  onDone: () => void;
};

const SHAPES: { id: BlurShape; label: string }[] = [
  { id: "rect", label: "▭" },
  { id: "rounded", label: "▢" },
  { id: "circle", label: "●" },
  { id: "ellipse", label: "◯" },
];

/** Region box in frame px. */
type Box = { cx: number; cy: number; rx: number; ry: number };

function regionBox(s: RegionState, frame: { w: number; h: number }, content: ContentRect): Box {
  return {
    cx: (content.x + s.x * content.w) * frame.w,
    cy: (content.y + s.y * content.h) * frame.h,
    rx: Math.max(4, (s.w / 2) * content.w * frame.w),
    ry: Math.max(4, (s.h / 2) * content.h * frame.h),
  };
}

function rotatePt(x: number, y: number, deg: number): [number, number] {
  const th = (deg * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  return [x * c - y * s, x * s + y * c];
}

function clampRegion(s: RegionState): RegionState {
  return {
    ...s,
    w: Math.max(0.02, Math.min(1.5, s.w)),
    h: Math.max(0.02, Math.min(1.5, s.h)),
    x: Math.max(-0.1, Math.min(1.1, s.x)),
    y: Math.max(-0.1, Math.min(1.1, s.y)),
    rotation: ((s.rotation + 540) % 360) - 180,
    intensity: Math.max(0, Math.min(1, s.intensity)),
    feather: Math.max(0, Math.min(0.5, s.feather)),
    opacity: Math.max(0.05, Math.min(1, s.opacity)),
  };
}

export function BlurRegionOverlay({
  clip,
  isImage,
  frameSize,
  content,
  srcRect,
  params,
  toolOpen,
  busy,
  status,
  getSourceEl,
  getMirrorTransform,
  onCommit,
  onTrack,
  onCancelTrack,
  onRemove,
  onDone,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [uid] = useState(() => `br${Math.random().toString(36).slice(2, 9)}`);

  // Playhead → clip-local source time (the clock the keyframes + export use).
  const playhead = usePlayheadTime();
  const localTime = Math.max(
    0,
    mediaTimeForClip(clip, playhead) - clip.in_point,
  );

  const keys: BlurRegionKeyframe[] = Array.isArray(params.keyframes)
    ? (params.keyframes as BlurRegionKeyframe[])
    : [];
  const state = regionStateAt(params, localTime);

  /** Optimistic slider echo (mirrors MagicRemove's pattern): committed
   * params lag the pointer by one IPC round-trip; without the echo the
   * controlled sliders snap back mid-drag. */
  const [echo, setEcho] = useState<Record<string, number | string>>({});
  useEffect(() => {
    setEcho((prev) => {
      if (!Object.keys(prev).length) return prev;
      const next: Record<string, number | string> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (params[k] !== v) next[k] = v;
      }
      return next;
    });
  }, [params]);
  const shown = echo.shape
    ? { ...state, shape: echo.shape as BlurShape }
    : state;
  const echoedIntensity = typeof echo.intensity === "number" ? echo.intensity : state.intensity;
  const echoedFeather = typeof echo.feather === "number" ? echo.feather : state.feather;
  const echoedOpacity = typeof echo.opacity === "number" ? echo.opacity : state.opacity;

  /** Live gesture draft (px-space interactions land here via rAF). */
  const [draft, setDraft] = useState<RegionState | null>(null);
  const draftRef = useRef<RegionState | null>(null);
  const rafRef = useRef(0);
  /** Clip-local time the draft was made at — gestures happen paused, but
   * the echo-clear below must not mistake a scrub for a stale draft. */
  const draftTimeRef = useRef(0);
  const localTimeRef = useRef(0);
  localTimeRef.current = localTime;

  const scheduleDraft = useCallback((next: RegionState) => {
    draftRef.current = next;
    draftTimeRef.current = localTimeRef.current;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        setDraft(draftRef.current ? { ...draftRef.current } : null);
      });
    }
  }, []);

  const current = draft ?? shown;

  /** Echo-clear (paramEcho pattern, generalized to geometry): the draft
   * stays visible after pointer-up until the committed params land and
   * match it — clearing immediately would snap the region back for the
   * duration of one IPC round-trip after every drag. */
  useEffect(() => {
    const d = draft;
    if (!d) return;
    if (localTime !== draftTimeRef.current) {
      // Playhead moved off the committed moment: the draft is stale.
      draftRef.current = null;
      setDraft(null);
      return;
    }
    const close = (a: number, b: number) => Math.abs(a - b) < 2e-3;
    if (
      close(shown.x, d.x) &&
      close(shown.y, d.y) &&
      close(shown.w, d.w) &&
      close(shown.h, d.h) &&
      close(shown.rotation, d.rotation) &&
      shown.shape === d.shape &&
      close(shown.intensity, d.intensity) &&
      close(shown.feather, d.feather) &&
      close(shown.opacity, d.opacity)
    ) {
      draftRef.current = null;
      setDraft(null);
    }
  }, [shown, draft, localTime]);

  /** Commit the current region state: full-params patch when static, a
   * keyframe upsert when animated. One invoke per gesture / slider settle. */
  const commitState = useCallback(
    (s: RegionState, patchKeys?: boolean) => {
      const c = clampRegion(s);
      if (keys.length > 0 || patchKeys === true) {
        onCommit({
          keyframes: upsertRegionKeyframe(keys, localTime, c),
        });
      } else {
        onCommit({
          x: c.x,
          y: c.y,
          w: c.w,
          h: c.h,
          rotation: c.rotation,
          shape: c.shape,
          cornerRadius: c.cornerRadius,
          intensity: c.intensity,
          feather: c.feather,
          opacity: c.opacity,
        });
      }
    },
    [keys, localTime, onCommit],
  );

  /* --- Preview mirror: draw the effective source into the region canvas --- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const targetW = Math.min(1600, Math.max(2, Math.round(content.w * frameSize.w)));
    const targetH = Math.min(1600, Math.max(2, Math.round(content.h * frameSize.h)));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    let raf = 0;
    const sr = srcRect ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const draw = () => {
      const el = getSourceEl();
      const ctx = canvas.getContext("2d");
      if (ctx && el) {
        try {
          const elW =
            el instanceof HTMLVideoElement
              ? el.videoWidth
              : el instanceof HTMLImageElement
                ? el.naturalWidth
                : el.width;
          const elH =
            el instanceof HTMLVideoElement
              ? el.videoHeight
              : el instanceof HTMLImageElement
                ? el.naturalHeight
                : el.height;
          if (elW > 0 && elH > 0) {
            const sx = sr.left * elW;
            const sy = sr.top * elH;
            const sw = Math.max(1, (1 - sr.left - sr.right) * elW);
            const sh = Math.max(1, (1 - sr.top - sr.bottom) * elH);
            // Mirror the base clip's live Transform filter so the blurred
            // pixels track the transformed preview beneath (the mask stays
            // fixed in frame space — the region was drawn there). Skipped
            // when mirroring the key canvas: its pixels already carry the
            // transform, so applying it again would double it.
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            applyTransformToMirrorCtx(
              ctx,
              canvas.width,
              canvas.height,
              el instanceof HTMLCanvasElement
                ? null
                : (getMirrorTransform?.() ?? null),
            );
            ctx.drawImage(el, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
          }
        } catch {
          /* element not ready this frame */
        }
      }
      raf = requestAnimationFrame(draw);
    };
    void draw();
    return () => cancelAnimationFrame(raf);
  }, [content.w, content.h, frameSize.w, frameSize.h, getSourceEl, getMirrorTransform, srcRect]);

  /* --- Gestures --- */

  const beginBodyDrag = (e: ReactPointerEvent) => {
    if (!toolOpen) return;
    e.preventDefault();
    e.stopPropagation();
    const base = { ...current };
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / (content.w * frameSize.w);
      const dy = (ev.clientY - startY) / (content.h * frameSize.h);
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 2) return;
      moved = true;
      scheduleDraft(clampRegion({ ...base, x: base.x + dx, y: base.y + dy }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const end = draftRef.current;
      if (moved && end) {
        const c = clampRegion(end);
        // Keep the draft on screen until the committed params echo back
        // (see the echo-clear effect) — never snap back mid-round-trip.
        draftRef.current = c;
        draftTimeRef.current = localTimeRef.current;
        setDraft(c);
        commitState(c);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  type HandleId = "tl" | "tr" | "bl" | "br" | "t" | "b" | "l" | "r";
  const HANDLES: { id: HandleId; hx: -1 | 0 | 1; hy: -1 | 0 | 1; cursor: string }[] = [
    { id: "tl", hx: -1, hy: -1, cursor: "nwse-resize" },
    { id: "tr", hx: 1, hy: -1, cursor: "nesw-resize" },
    { id: "bl", hx: -1, hy: 1, cursor: "nesw-resize" },
    { id: "br", hx: 1, hy: 1, cursor: "nwse-resize" },
    { id: "t", hx: 0, hy: -1, cursor: "ns-resize" },
    { id: "b", hx: 0, hy: 1, cursor: "ns-resize" },
    { id: "l", hx: -1, hy: 0, cursor: "ew-resize" },
    { id: "r", hx: 1, hy: 0, cursor: "ew-resize" },
  ];

  const beginHandleDrag = (e: ReactPointerEvent, h: { hx: -1 | 0 | 1; hy: -1 | 0 | 1 }) => {
    if (!toolOpen) return;
    e.preventDefault();
    e.stopPropagation();
    const base = { ...current };
    const box0 = regionBox(base, frameSize, content);
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 2) return;
      moved = true;
      // Pointer delta in frame px → rotate into the region's local space.
      const raw = { x: ev.clientX - startX, y: ev.clientY - startY };
      const [lx, ly] = rotatePt(raw.x, raw.y, -base.rotation);
      const scale = { x: content.w * frameSize.w, y: content.h * frameSize.h };
      let dwPx = h.hx === 1 ? lx : h.hx === -1 ? -lx : 0;
      let dhPx = h.hy === 1 ? ly : h.hy === -1 ? -ly : 0;
      const w0 = box0.rx * 2;
      const h0 = box0.ry * 2;
      const proportional = ev.shiftKey && h.hx !== 0 && h.hy !== 0;
      if (proportional) {
        const fx = (w0 + dwPx) / w0;
        const fy = (h0 + dhPx) / h0;
        const f = Math.max(fx, fy);
        dwPx = w0 * f - w0;
        dhPx = h0 * f - h0;
      }
      if (base.shape === "circle") {
        const size = Math.max(24, Math.max(w0 + dwPx, h0 + dhPx));
        dwPx = size - w0;
        dhPx = size - h0;
      }
      const wPx = Math.max(12, w0 + dwPx);
      const hPx = Math.max(12, h0 + dhPx);
      // Keep the opposite edge anchored: center shifts by half the local
      // size change, rotated back into frame space.
      const [scx, scy] = rotatePt((h.hx * (wPx - w0)) / 2, (h.hy * (hPx - h0)) / 2, base.rotation);
      scheduleDraft(
        clampRegion({
          ...base,
          w: wPx / scale.x,
          h: hPx / scale.y,
          x: (box0.cx + scx - content.x * frameSize.w) / (content.w * frameSize.w),
          y: (box0.cy + scy - content.y * frameSize.h) / (content.h * frameSize.h),
        }),
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const end = draftRef.current;
      if (moved && end) {
        const c = clampRegion(end);
        // Keep the draft on screen until the committed params echo back
        // (see the echo-clear effect) — never snap back mid-round-trip.
        draftRef.current = c;
        draftTimeRef.current = localTimeRef.current;
        setDraft(c);
        commitState(c);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const beginRotateDrag = (e: ReactPointerEvent) => {
    if (!toolOpen) return;
    e.preventDefault();
    e.stopPropagation();
    const base = { ...current };
    const box0 = regionBox(base, frameSize, content);
    const angle0 = Math.atan2(e.clientY - box0.cy, e.clientX - box0.cx);
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const a = Math.atan2(ev.clientY - box0.cy, ev.clientX - box0.cx);
      let deg = base.rotation + ((a - angle0) * 180) / Math.PI;
      // Snap within 2.5° of 15° steps.
      const snap = Math.round(deg / 15) * 15;
      if (Math.abs(deg - snap) < 2.5) deg = snap;
      scheduleDraft(clampRegion({ ...base, rotation: deg }));
      moved = true;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const end = draftRef.current;
      if (moved && end) {
        const c = clampRegion(end);
        // Keep the draft on screen until the committed params echo back
        // (see the echo-clear effect) — never snap back mid-round-trip.
        draftRef.current = c;
        draftTimeRef.current = localTimeRef.current;
        setDraft(c);
        commitState(c);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  /* --- Panel actions --- */

  const setParam = (key: string, value: number | string) => {
    setEcho((prev) => ({ ...prev, [key]: value }));
    if (typeof value === "number") {
      const s = clampRegion({ ...state, [key]: value });
      commitState(s);
    } else {
      // Shape: commit whole state (also fixes circle proportions).
      const s = clampRegion({
        ...state,
        shape: value as BlurShape,
        ...(value === "circle" ? { w: Math.max(state.w, state.h), h: Math.max(state.w, state.h) } : {}),
      });
      commitState(s);
    }
  };

  const hasKeys = keys.length > 0;
  const isVideo = !isImage;

  const box = regionBox(current, frameSize, content);
  const featherStd = Math.max(
    0.05,
    current.feather * 2 * Math.min(box.rx, box.ry) * 0.25,
  );
  // CSS blur = 2σ in display px; σ lives in 1080p-frame space (matching the
  // export fragment, which blurs the scaled frame).
  const displayPer1080 = (content.h * frameSize.h) / 1080;
  const blurPx = Math.max(0, 2 * (current.intensity * 25) * displayPer1080);

  return (
    <>
      {/* SVG mask defs: shape + feather in frame px (GPU-composited). */}
      <svg className="br-defs" aria-hidden width={frameSize.w} height={frameSize.h}>
        <defs>
          <filter id={`${uid}-soft`} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation={featherStd} />
          </filter>
          <mask id={`${uid}-mask`} maskUnits="userSpaceOnUse" x={0} y={0} width={frameSize.w} height={frameSize.h}>
            <g filter={`url(#${uid}-soft)`}>
              {current.shape === "ellipse" ? (
                <ellipse cx={box.cx} cy={box.cy} rx={box.rx} ry={box.ry} fill="#fff" fillOpacity={current.opacity} />
              ) : current.shape === "circle" ? (
                <circle cx={box.cx} cy={box.cy} r={Math.min(box.rx, box.ry)} fill="#fff" fillOpacity={current.opacity} />
              ) : (
                <rect
                  x={box.cx - box.rx}
                  y={box.cy - box.ry}
                  width={box.rx * 2}
                  height={box.ry * 2}
                  rx={current.shape === "rounded" ? Math.min(box.rx, box.ry) * 2 * current.cornerRadius : 0}
                  fill="#fff"
                  fillOpacity={current.opacity}
                  transform={`rotate(${current.rotation} ${box.cx} ${box.cy})`}
                />
              )}
            </g>
          </mask>
        </defs>
      </svg>
      {/* Blurred mirror of the effective visual, masked to the region. */}
      <canvas
        ref={canvasRef}
        className="blur-region-canvas"
        style={{
          left: `${(content.x * 100).toFixed(3)}%`,
          top: `${(content.y * 100).toFixed(3)}%`,
          width: `${(content.w * 100).toFixed(3)}%`,
          height: `${(content.h * 100).toFixed(3)}%`,
          filter: blurPx > 0.2 ? `blur(${blurPx.toFixed(2)}px)` : undefined,
          maskImage: `url(#${uid}-mask)`,
          WebkitMaskImage: `url(#${uid}-mask)`,
        }}
      />
      {toolOpen && (
        <>
          {/* Selection frame + handles */}
          <div
            className="br-frame"
            style={{
              left: box.cx - box.rx,
              top: box.cy - box.ry,
              width: box.rx * 2,
              height: box.ry * 2,
              transform: `rotate(${current.rotation}deg)`,
            }}
            onPointerDown={beginBodyDrag}
            onDoubleClick={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            title="Drag to move · handles to resize · stem to rotate"
          >
            {HANDLES.map((h) => (
              <div
                key={h.id}
                className={`crop-handle br-handle br-handle-${h.id}`}
                style={{
                  left: `calc(${((h.hx + 1) / 2) * 100}% - 6px)`,
                  top: `calc(${((h.hy + 1) / 2) * 100}% - 6px)`,
                  cursor: h.cursor,
                }}
                onPointerDown={(e) => beginHandleDrag(e, h)}
                title="Drag to resize (Shift = proportional)"
              />
            ))}
            <div
              className="br-rotate-stem"
              onPointerDown={beginRotateDrag}
              title="Drag to rotate"
            >
              <div className="br-rotate-knob" />
            </div>
          </div>
          {/* Control panel (magic-panel conventions) */}
          <div
            className="magic-panel br-panel"
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <div className="magic-row">
              <div className="magic-modes" role="group" aria-label="Region shape">
                {SHAPES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={current.shape === s.id ? "active" : ""}
                    title={`Shape: ${s.id}`}
                    onClick={() => setParam("shape", s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <label className="magic-slider">
                <span>Blur</span>
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.01}
                  value={echoedIntensity}
                  onChange={(e) => setParam("intensity", Number(e.target.value))}
                />
                <span className="magic-val">{Math.round(echoedIntensity * 100)}%</span>
              </label>
              <label className="magic-slider">
                <span>Feather</span>
                <input
                  type="range"
                  min={0}
                  max={0.5}
                  step={0.01}
                  value={echoedFeather}
                  onChange={(e) => setParam("feather", Number(e.target.value))}
                />
                <span className="magic-val">{Math.round(echoedFeather * 200)}%</span>
              </label>
              <label className="magic-slider">
                <span>Opacity</span>
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.01}
                  value={echoedOpacity}
                  onChange={(e) => setParam("opacity", Number(e.target.value))}
                />
                <span className="magic-val">{Math.round(echoedOpacity * 100)}%</span>
              </label>
            </div>
            <div className="magic-row">
              <div className="magic-actions">
                <button
                  type="button"
                  title="Add or update a keyframe at the playhead with the current region"
                onClick={() => {
                  const c = clampRegion(current);
                  draftRef.current = c;
                  draftTimeRef.current = localTimeRef.current;
                  setDraft(c);
                  commitState(c, true);
                }}
                >
                  ◆ Key @ playhead
                </button>
                <button
                  type="button"
                  disabled={!hasKeys}
                  title="Remove the nearest keyframe"
                  onClick={() =>
                    onCommit({ keyframes: removeRegionKeyframe(keys, localTime) })
                  }
                >
                  − Key
                </button>
                <button
                  type="button"
                  disabled={!hasKeys}
                  title="Clear all keyframes"
                  onClick={() => onCommit({ keyframes: [] })}
                >
                  Clear {hasKeys ? `(${keys.length})` : ""}
                </button>
                <button
                  type="button"
                  disabled={busy != null || !isVideo}
                  title="Auto-track this region across the clip (blur follows the subject)"
                  onClick={onTrack}
                >
                  ⟳ Auto Track
                </button>
                {busy && (
                  <button type="button" className="danger" onClick={onCancelTrack}>
                    Cancel
                  </button>
                )}
                <button
                  type="button"
                  className="danger"
                  title="Remove the blur region"
                  onClick={onRemove}
                >
                  Delete
                </button>
                <button type="button" className="done" onClick={onDone}>
                  Done
                </button>
              </div>
            </div>
            <div className="magic-row br-status">
              {busy
                ? `${busy.phase}… ${Math.round(busy.percent * 100)}%`
                : (status ??
                  (hasKeys
                    ? `Animated · ${keys.length} keyframes · edit moves the key at the playhead`
                    : "Drag the region · add keyframes to animate it"))}
            </div>
            {busy && (
              <div className="br-progress">
                <div style={{ width: `${Math.round(busy.percent * 100)}%` }} />
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

/** Memoized so monitor re-renders (drags elsewhere) skip reconciliation. */
export const BlurRegionOverlayMemo = memo(BlurRegionOverlay);
