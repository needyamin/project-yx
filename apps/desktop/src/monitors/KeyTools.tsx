/**
 * BG Key — background removal workflow (chroma key + select-area removal).
 *
 * Two pieces:
 * - `KeyPreviewCanvas` is the live compositor for keyed content: it mirrors
 *   the base video/image element into a canvas, applies the chroma key
 *   (distance key + spill suppression) and/or the select-area alpha mask,
 *   and shows the transparent result. Processing runs on a downscaled
 *   offscreen buffer and only re-processes when the frame or parameters
 *   actually changed — dragging sliders never does per-event pixel work.
 * - `BackgroundKeyPanel` is the tool UI (mode tabs Chroma / Select Area,
 *   eyedropper hint, tolerance/softness/spill sliders, shape drawing with
 *   add/subtract + feather + invert).
 *
 * Everything lives in clip filter params (`chromakey` / `bgmask`) — fully
 * non-destructive, undoable, saved with the project.
 */
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { usePlayheadTime } from "../playback/playbackClock";
import {
  applyChromakeyToImageData,
  bgMaskRenderKey,
  rasterizeBgMask,
  type BgMaskShape,
} from "../effects/effects";
import type { ContentRect } from "./monitorGeometry";
import { applyTransformToMirrorCtx, type MirrorTransform } from "./monitorGeometry";

/* ------------------------------------------------------------------ */
/* Live keyed preview                                                  */
/* ------------------------------------------------------------------ */

export type KeyFilterState = {
  chroma: Record<string, unknown> | null;
  mask: Record<string, unknown> | null;
};

function str(p: Record<string, unknown>, k: string, d: string): string {
  const v = p[k];
  return typeof v === "string" && v ? v : d;
}
function num(p: Record<string, unknown>, k: string, d: number): number {
  const v = p[k];
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

export function KeyPreviewCanvas({
  isImage,
  playing,
  frameSize,
  content,
  mediaSize,
  filters,
  getDrawSource,
  elRef,
  srcRect,
  getMirrorTransform,
}: {
  isImage: boolean;
  playing: boolean;
  frameSize: { w: number; h: number };
  content: ContentRect;
  mediaSize: { w: number; h: number } | null;
  filters: KeyFilterState;
  getDrawSource: () => HTMLVideoElement | HTMLImageElement | null;
  /** Lets the blur-region overlay mirror the KEYED output. */
  elRef?: { current: HTMLCanvasElement | null };
  /** Sub-rect of the source actually displayed (crop filter applied). */
  srcRect?: { left: number; top: number; right: number; bottom: number };
  /** Live Transform filter of the base clip (read per frame so transform
   * gestures stay visible even though the base element is hidden). */
  getMirrorTransform?: () => MirrorTransform | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workRef = useRef<HTMLCanvasElement | null>(null);
  const sigRef = useRef("");
  /** True once the work buffer has processed real pixels — the keyed
   * display canvas stays transparent until then (never paints a blank
   * processed frame over nothing). */
  const processedRef = useRef(false);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const targetW = Math.max(2, Math.round(content.w * frameSize.w));
    const targetH = Math.max(2, Math.round(content.h * frameSize.h));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const sr = srcRect ?? { left: 0, top: 0, right: 0, bottom: 0 };
    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      const src = getDrawSource();
      if (!src) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const elW = src instanceof HTMLVideoElement ? src.videoWidth : src.naturalWidth;
      const elH = src instanceof HTMLVideoElement ? src.videoHeight : src.naturalHeight;
      const f = filtersRef.current;
      const keyed = !!(f.chroma || f.mask);

      // Mirror the base clip's live Transform filter so moving/scaling the
      // clip stays visible while the keyed preview is shown (the base
      // element itself is hidden behind this canvas).
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      applyTransformToMirrorCtx(
        ctx,
        canvas.width,
        canvas.height,
        getMirrorTransform?.() ?? null,
      );

      if (!keyed) {
        // Cheap copy every frame keeps the display in perfect sync with the
        // (visible) base element — including mid-drag slider changes.
        if (elW > 0 && elH > 0) {
          ctx.drawImage(
            src,
            sr.left * elW,
            sr.top * elH,
            Math.max(1, (1 - sr.left - sr.right) * elW),
            Math.max(1, (1 - sr.top - sr.bottom) * elH),
            0,
            0,
            canvas.width,
            canvas.height,
          );
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        return;
      }

      // Keyed path: paint ONLY the processed buffer. Drawing the raw source
      // underneath would show straight through the keyed alpha — the removed
      // background would stay fully visible, defeating the effect.
      const pw = Math.min(960, mediaSize?.w ?? canvas.width);
      const ph = Math.max(
        2,
        Math.round((pw * ((mediaSize?.h ?? canvas.height) / (mediaSize?.w ?? canvas.width))) || canvas.height),
      );
      let work = workRef.current;
      if (!work) {
        work = document.createElement("canvas");
        workRef.current = work;
      }
      if (work.width !== pw || work.height !== ph) {
        work.width = pw;
        work.height = ph;
      }
      const mediaT = (src as HTMLVideoElement).currentTime ?? 0;
      const ckey = f.chroma
        ? `${str(f.chroma, "color", "#00ff00")}|${num(f.chroma, "similarity", 0.3)}|${num(f.chroma, "blend", 0.1)}|${num(f.chroma, "spill", 0)}`
        : "";
      const mkey = f.mask ? bgMaskRenderKey(f.mask) : "";
      const sig = `${isImage ? "img" : mediaT.toFixed(3)}|${elW}x${elH}|${sr.left.toFixed(3)},${sr.top.toFixed(3)}|${ckey}|${mkey}`;
      // Only process once the video actually holds a decoded frame: a
      // process that ran pre-decode would bake a blank buffer AND record
      // the sig, so a paused preview would stay blank forever (the sig
      // never changes while parked on the same frame). Skipping the record
      // makes the next frame retry until real pixels exist.
      const hasFrame =
        !(src instanceof HTMLVideoElement) || src.readyState >= 2;
      if (hasFrame && sig !== sigRef.current) {
        sigRef.current = sig;
        processedRef.current = true;
        const wctx = work.getContext("2d", { willReadFrequently: true });
        if (!wctx) return;
        wctx.setTransform(1, 0, 0, 1, 0, 0);
        wctx.clearRect(0, 0, pw, ph);
        if (elW > 0 && elH > 0) {
          wctx.drawImage(
            src,
            sr.left * elW,
            sr.top * elH,
            Math.max(1, (1 - sr.left - sr.right) * elW),
            Math.max(1, (1 - sr.top - sr.bottom) * elH),
            0,
            0,
            pw,
            ph,
          );
        } else {
          wctx.drawImage(src, 0, 0, pw, ph);
        }
        if (f.chroma) {
          const img = wctx.getImageData(0, 0, pw, ph);
          applyChromakeyToImageData(
            img,
            str(f.chroma, "color", "#00ff00"),
            num(f.chroma, "similarity", 0.3),
            num(f.chroma, "blend", 0.1),
            num(f.chroma, "spill", 0),
          );
          wctx.putImageData(img, 0, 0);
        }
        if (f.mask) {
          const shapes = (Array.isArray(f.mask.shapes) ? f.mask.shapes : []) as BgMaskShape[];
          const maskCanvas = rasterizeBgMask(
            pw,
            ph,
            shapes,
            num(f.mask, "feather", 0.01),
            f.mask.invert === true,
          );
          if (maskCanvas) {
            wctx.globalCompositeOperation = "destination-in";
            wctx.drawImage(maskCanvas, 0, 0, pw, ph);
            wctx.globalCompositeOperation = "source-over";
          }
        }
      }
      if (processedRef.current) {
        ctx.drawImage(work, 0, 0, canvas.width, canvas.height);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    };
    void render();
    return () => cancelAnimationFrame(raf);
  }, [content.w, content.h, frameSize.w, frameSize.h, mediaSize, getDrawSource, getMirrorTransform, isImage, srcRect]);

  // While paused, redraw promptly after seeks (the cheap copy path above
  // already handles it; this just prunes stale sig so processing re-runs).
  const playhead = usePlayheadTime();
  useEffect(() => {
    if (!playing) sigRef.current = "";
  }, [playhead, playing]);

  // Publish the element so the blur overlay can composite the keyed frame.
  useEffect(() => {
    if (elRef) elRef.current = canvasRef.current;
    return () => {
      if (elRef) elRef.current = null;
    };
  }, [elRef]);

  return (
    <canvas
      ref={canvasRef}
      className="key-preview-canvas"
      style={{
        left: `${(content.x * 100).toFixed(3)}%`,
        top: `${(content.y * 100).toFixed(3)}%`,
        width: `${(content.w * 100).toFixed(3)}%`,
        height: `${(content.h * 100).toFixed(3)}%`,
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Select-area drawing overlay                                         */
/* ------------------------------------------------------------------ */

type Draft =
  | { kind: "box"; type: "rect" | "ellipse"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "lasso"; points: [number, number][] };

/** Shape drawing surface (fractions of the SOURCE media). Committed shapes
 * show as outlines; the new shape previews while dragging. */
function AreaDrawSurface({
  content,
  frameSize,
  shapeType,
  mode,
  shapes,
  onAdd,
}: {
  content: ContentRect;
  frameSize: { w: number; h: number };
  shapeType: "rect" | "ellipse" | "lasso";
  mode: "add" | "sub";
  shapes: BgMaskShape[];
  onAdd: (s: BgMaskShape) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const rafRef = useRef(0);
  const [uid] = useState(() => `bg${Math.random().toString(36).slice(2, 8)}`);

  const toFrac = (clientX: number, clientY: number) => {
    const frame = (document.getElementById(`${uid}-surface`) as HTMLElement | null)?.closest(
      ".monitor-frame",
    ) as HTMLElement | null;
    if (!frame) return { x: 0.5, y: 0.5 };
    const r = frame.getBoundingClientRect();
    const fx = (clientX - r.left) / Math.max(1, r.width);
    const fy = (clientY - r.top) / Math.max(1, r.height);
    return {
      x: Math.max(0, Math.min(1, (fx - content.x) / content.w)),
      y: Math.max(0, Math.min(1, (fy - content.y) / content.h)),
    };
  };

  const schedule = (d: Draft | null) => {
    draftRef.current = d;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        setDraft(draftRef.current);
      });
    }
  };

  const onDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const p = toFrac(e.clientX, e.clientY);
    if (shapeType === "lasso") {
      schedule({ kind: "lasso", points: [[p.x, p.y]] });
    } else {
      schedule({ kind: "box", type: shapeType, x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    }
    const onMove = (ev: PointerEvent) => {
      const q = toFrac(ev.clientX, ev.clientY);
      const d = draftRef.current;
      if (!d) return;
      if (d.kind === "box") {
        schedule({ ...d, x1: q.x, y1: q.y });
      } else {
        const pts = d.points;
        const last = pts[pts.length - 1];
        if (Math.hypot(q.x - last[0], q.y - last[1]) > 0.008) {
          schedule({ kind: "lasso", points: [...pts, [q.x, q.y]] });
        }
      }
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const d = draftRef.current;
      draftRef.current = null;
      setDraft(null);
      if (!d) return;
      if (d.kind === "box") {
        const x0 = Math.min(d.x0, d.x1);
        const x1 = Math.max(d.x0, d.x1);
        const y0 = Math.min(d.y0, d.y1);
        const y1 = Math.max(d.y0, d.y1);
        if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return;
        onAdd({
          id: `s${Date.now().toString(36)}`,
          type: d.type,
          mode,
          x: (x0 + x1) / 2,
          y: (y0 + y1) / 2,
          w: x1 - x0,
          h: y1 - y0,
        });
      } else if (d.points.length > 2) {
        const q = toFrac(ev.clientX, ev.clientY);
        onAdd({
          id: `s${Date.now().toString(36)}`,
          type: "lasso",
          mode,
          points: [...d.points, [q.x, q.y]],
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // Convert shapes to an SVG path in frame px for the outline rendering.
  const pathOf = (s: BgMaskShape): string => {
    const W = content.w * frameSize.w;
    const H = content.h * frameSize.h;
    const ox = content.x * frameSize.w;
    const oy = content.y * frameSize.h;
    const px = (v: number) => ox + v * W;
    const py = (v: number) => oy + v * H;
    if (s.type === "rect") {
      const x = px((s.x ?? 0) - (s.w ?? 0) / 2);
      const y = py((s.y ?? 0) - (s.h ?? 0) / 2);
      return `M${x} ${y}h${(s.w ?? 0) * W}v${(s.h ?? 0) * H}h-${(s.w ?? 0) * W}Z`;
    }
    if (s.type === "ellipse") {
      return ""; // rendered as <ellipse>
    }
    if (s.points?.length) {
      return (
        `M${px(s.points[0][0])} ${py(s.points[0][1])}` +
        s.points.slice(1).map(([x, y]) => `L${px(x)} ${py(y)}`).join("") +
        "Z"
      );
    }
    return "";
  };

  return (
    <div
      id={`${uid}-surface`}
      className={`bg-draw-surface ${mode === "sub" ? "subtract" : ""}`}
      onPointerDown={onDown}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      title={`Drag to ${shapeType === "lasso" ? "draw a freeform area" : `select a ${shapeType}`} (${mode === "add" ? "remove" : "restore"})`}
    >
      <svg className="bg-draw-svg" width={frameSize.w} height={frameSize.h} aria-hidden>
        {shapes.map((s) =>
          s.type === "ellipse" ? (
            <ellipse
              key={s.id}
              cx={content.x * frameSize.w + (s.x ?? 0) * content.w * frameSize.w}
              cy={content.y * frameSize.h + (s.y ?? 0) * content.h * frameSize.h}
              rx={Math.max(1, ((s.w ?? 0) * content.w * frameSize.w) / 2)}
              ry={Math.max(1, ((s.h ?? 0) * content.h * frameSize.h) / 2)}
              className={`bg-shape ${s.mode === "sub" ? "sub" : ""}`}
            />
          ) : (
            <path key={s.id} d={pathOf(s)} className={`bg-shape ${s.mode === "sub" ? "sub" : ""}`} />
          ),
        )}
        {draft?.kind === "box" && (
          <rect
            x={(content.x + Math.min(draft.x0, draft.x1) * content.w) * frameSize.w}
            y={(content.y + Math.min(draft.y0, draft.y1) * content.h) * frameSize.h}
            width={Math.abs(draft.x1 - draft.x0) * content.w * frameSize.w}
            height={Math.abs(draft.y1 - draft.y0) * content.h * frameSize.h}
            className={`bg-draft ${mode}`}
          />
        )}
        {draft?.kind === "lasso" && (
          <path
            d={
              `M${(content.x + draft.points[0][0] * content.w) * frameSize.w} ${(content.y + draft.points[0][1] * content.h) * frameSize.h}` +
              draft.points
                .slice(1)
                .map(
                  ([x, y]) =>
                    `L${(content.x + x * content.w) * frameSize.w} ${(content.y + y * content.h) * frameSize.h}`,
                )
                .join("")
            }
            className={`bg-draft ${mode}`}
          />
        )}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tool panel                                                          */
/* ------------------------------------------------------------------ */

export type KeyToolMode = "chroma" | "area";

export function BackgroundKeyPanel({
  mode,
  onMode,
  chroma,
  mask,
  content,
  frameSize,
  onChromaChange,
  onMaskChange,
  onDone,
}: {
  mode: KeyToolMode;
  onMode: (m: KeyToolMode) => void;
  chroma: Record<string, unknown> | null;
  mask: Record<string, unknown> | null;
  content: ContentRect;
  frameSize: { w: number; h: number };
  onChromaChange: (patch: Record<string, unknown>) => void;
  onMaskChange: (patch: Record<string, unknown>) => void;
  onDone: () => void;
}) {
  // Optimistic echoes (same pattern as the other monitor tools).
  const [echo, setEcho] = useState<Record<string, number | string>>({});
  useEffect(() => {
    setEcho((prev) => {
      if (!Object.keys(prev).length) return prev;
      const c = chroma ?? {};
      const next: Record<string, number | string> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (c[k] !== v) next[k] = v;
      }
      return next;
    });
  }, [chroma]);
  const val = (k: string, d: number): number =>
    typeof echo[k] === "number"
      ? (echo[k] as number)
      : chroma
        ? num(chroma, k, d)
        : d;

  const [shapeType, setShapeType] = useState<"rect" | "ellipse" | "lasso">("rect");
  const [drawMode, setDrawMode] = useState<"add" | "sub">("add");
  const shapes: BgMaskShape[] = Array.isArray(mask?.shapes)
    ? (mask?.shapes as BgMaskShape[])
    : [];

  const setNum = (k: string, v: number) => {
    setEcho((prev) => ({ ...prev, [k]: v }));
    onChromaChange({ [k]: v });
  };

  return (
    <>
      {mode === "area" && mask && (
        <AreaDrawSurface
          content={content}
          frameSize={frameSize}
          shapeType={shapeType}
          mode={drawMode}
          shapes={shapes}
          onAdd={(s) =>
            onMaskChange({
              shapes: [...shapes, s],
              maskPath: "",
              maskKey: "",
            })
          }
        />
      )}
      <div
        className="magic-panel bg-panel"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="magic-row">
          <div className="magic-modes" role="group" aria-label="Key method">
            <button
              type="button"
              className={mode === "chroma" ? "active" : ""}
              onClick={() => onMode("chroma")}
              title="Key out a solid background color (green screen style)"
            >
              ◆ Chroma Key
            </button>
            <button
              type="button"
              className={mode === "area" ? "active" : ""}
              onClick={() => onMode("area")}
              title="Select areas to remove by hand (rectangle / ellipse / freeform)"
            >
              ▭ Select Area
            </button>
          </div>
          {mode === "chroma" && chroma && (
            <>
              <label className="magic-slider" title="Pick the background color from the monitor">
                <span>Color</span>
                <input
                  type="color"
                  value={str(chroma, "color", "#00ff00")}
                  onChange={(e) => onChromaChange({ color: e.target.value })}
                />
                <span className="bg-hint">click the monitor to pick</span>
              </label>
              <label className="magic-slider">
                <span>Tolerance</span>
                <input
                  type="range"
                  min={0.01}
                  max={1}
                  step={0.01}
                  value={val("similarity", 0.3)}
                  onChange={(e) => setNum("similarity", Number(e.target.value))}
                />
                <span className="magic-val">{Math.round(val("similarity", 0.3) * 100)}%</span>
              </label>
              <label className="magic-slider">
                <span>Softness</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={val("blend", 0.1)}
                  onChange={(e) => setNum("blend", Number(e.target.value))}
                />
                <span className="magic-val">{Math.round(val("blend", 0.1) * 100)}%</span>
              </label>
              <label className="magic-slider">
                <span>Spill</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={val("spill", 0)}
                  onChange={(e) => setNum("spill", Number(e.target.value))}
                />
                <span className="magic-val">{Math.round(val("spill", 0) * 100)}%</span>
              </label>
            </>
          )}
          {mode === "area" && mask && (
            <>
              <div className="magic-modes" role="group" aria-label="Selection shape">
                {(
                  [
                    ["rect", "▭ Rect"],
                    ["ellipse", "◯ Ellipse"],
                    ["lasso", "✎ Lasso"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={shapeType === id ? "active" : ""}
                    onClick={() => setShapeType(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="magic-modes" role="group" aria-label="Add or subtract">
                <button
                  type="button"
                  className={drawMode === "add" ? "active" : ""}
                  onClick={() => setDrawMode("add")}
                  title="Remove the selected area"
                >
                  − Remove
                </button>
                <button
                  type="button"
                  className={drawMode === "sub" ? "active" : ""}
                  onClick={() => setDrawMode("sub")}
                  title="Restore the selected area (subtract from removal)"
                >
                  + Restore
                </button>
              </div>
              <label className="magic-slider">
                <span>Feather</span>
                <input
                  type="range"
                  min={0}
                  max={0.08}
                  step={0.002}
                  value={typeof echo.feather === "number" ? echo.feather : num(mask, "feather", 0.01)}
                  onChange={(e) => {
                    setEcho((prev) => ({ ...prev, feather: Number(e.target.value) }));
                    onMaskChange({ feather: Number(e.target.value) });
                  }}
                />
                <span className="magic-val">
                  {Math.round(num(mask, "feather", 0.01) * 1000) / 10}%
                </span>
              </label>
              <label className="magic-slider" title="Invert: keep only the selected areas">
                <span>
                  <input
                    type="checkbox"
                    checked={mask.invert === true}
                    onChange={(e) => onMaskChange({ invert: e.target.checked })}
                  />{" "}
                  Invert
                </span>
              </label>
            </>
          )}
          <div className="magic-actions">
            {mode === "area" && (
              <button
                type="button"
                disabled={!shapes.length}
                onClick={() => onMaskChange({ shapes: [], maskPath: "", maskKey: "" })}
                title="Clear all selected areas"
              >
                Clear {shapes.length ? `(${shapes.length})` : ""}
              </button>
            )}
            <button type="button" className="done" onClick={onDone}>
              Done
            </button>
          </div>
        </div>
        <div className="magic-row bg-status">
          {mode === "chroma"
            ? "Click a background color in the monitor, then tune Tolerance / Softness / Spill — preview is live."
            : shapes.length
              ? `${shapes.length} area${shapes.length > 1 ? "s" : ""} — draw more, or press Done. Original image stays untouched.`
              : "Drag on the monitor to select the area to remove."}
        </div>
      </div>
    </>
  );
}
