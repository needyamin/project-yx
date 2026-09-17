/**
 * Magic Remove / AI Eraser — monitor overlay + control panel.
 *
 * Lives inside the Project Monitor frame (like the crop tool): a canvas over
 * the video where the user brushes the element to remove, plus a compact
 * panel with brush/feather/expand/accuracy/strength controls and the
 * Auto Track → Remove pipeline buttons. The mask is stored as normalized
 * source-frame strokes inside the clip's `magicremove` filter params —
 * nothing destructive ever touches the media.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  magicOffsetAt,
  type MagicKeyframe,
  type MagicStroke,
} from "../effects/effects";
import type { ContentRect } from "./monitorGeometry";

type MagicParams = {
  strokes?: MagicStroke[];
  keyframes?: MagicKeyframe[];
  anchorTime?: number;
  brushSize?: number;
  feather?: number;
  expand?: number;
  trackingAccuracy?: string;
  removalStrength?: number;
};

type Props = {
  /** Monitor frame box in CSS px (canvas + panel sizing). */
  frameSize: { w: number; h: number };
  /** Displayed content rect (fractions of the frame) for the source mapping. */
  content: ContentRect;
  /** Magic Remove filter params on the target clip (null = none yet). */
  params: MagicParams | null;
  /** Media time of the clip under the playhead (the drawing anchor). */
  mediaTime: number;
  busy: { phase: string; percent: number } | null;
  status: string | null;
  onCommit: (patch: {
    strokes?: MagicStroke[];
    keyframes?: MagicKeyframe[];
    anchorTime?: number;
  }) => void;
  onParamChange: (patch: Record<string, unknown>) => void;
  onTrack: () => void;
  onRemove: () => void;
  onCancel: () => void;
  onDone: () => void;
};

type Mode = "brush" | "erase" | "adjust";

const ACCENTS = {
  fill: "rgba(183,106,240,0.40)",
  outline: "rgba(226,178,255,0.95)",
  eraseFill: "rgba(0,0,0,0.45)",
  eraseOutline: "rgba(255,120,120,0.9)",
};

function fmtPct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}

export function MagicRemoveOverlay({
  frameSize,
  content,
  params,
  mediaTime,
  busy,
  status,
  onCommit,
  onParamChange,
  onTrack,
  onRemove,
  onCancel,
  onDone,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const drawingRef = useRef(false);
  const adjustingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const strokesRef = useRef<MagicStroke[]>([]);
  const [mode, setMode] = useState<Mode>("brush");
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number } | null>(null);
  const [cursorOn, setCursorOn] = useState(false);

  const strokes = params?.strokes ?? [];
  const keyframes = params?.keyframes ?? [];
  const brushSize = params?.brushSize ?? 0.025;
  const accuracy = params?.trackingAccuracy ?? "medium";

  /** Optimistic guard: between a stroke commit and the backend round-trip
   * the `strokes` prop still lags behind; ignore it until it matches what we
   * committed so the just-drawn mask never flickers away. */
  const committedRef = useRef<string | null>(null);
  if (committedRef.current !== null) {
    if (JSON.stringify(strokes) === committedRef.current) {
      committedRef.current = null; // props caught up
      strokesRef.current = strokes;
    } else if (strokes.length < strokesRef.current.length) {
      // Stale lagging props (e.g. an earlier commit still in flight) —
      // keep showing the newer local strokes.
    } else {
      strokesRef.current = strokes;
    }
  } else {
    strokesRef.current = strokes;
  }
  const shownStrokes = strokesRef.current;
  const hasStrokes = shownStrokes.length > 0;
  const tracking = busy?.phase === "tracking";

  /** Mask offset at the current media time (from tracking keyframes). */
  const baseOffset = useMemo(() => magicOffsetAt(keyframes, mediaTime), [keyframes, mediaTime]);
  const offset = dragOffset
    ? { dx: baseOffset.dx + dragOffset.dx, dy: baseOffset.dy + dragOffset.dy }
    : baseOffset;

  /** Source-normalized point from a canvas-relative event. */
  const eventToSource = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const fx = (clientX - rect.left) / Math.max(1, rect.width);
      const fy = (clientY - rect.top) / Math.max(1, rect.height);
      return {
        x: Math.max(0, Math.min(1, (fx - content.x) / content.w)) - offset.dx,
        y: Math.max(0, Math.min(1, (fy - content.y) / content.h)) - offset.dy,
      };
    },
    [content, offset.dx, offset.dy],
  );

  /* --- Mask rendering --- */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || frameSize.w < 2 || frameSize.h < 2) return;
    if (canvas.width !== Math.round(frameSize.w) || canvas.height !== Math.round(frameSize.h)) {
      canvas.width = Math.round(frameSize.w);
      canvas.height = Math.round(frameSize.h);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const contentH = content.h * frameSize.h;
    const toPx = (p: [number, number]): [number, number] => [
      (content.x + (p[0] + offset.dx) * content.w) * frameSize.w,
      (content.y + (p[1] + offset.dy) * content.h) * frameSize.h,
    ];
    for (const s of strokesRef.current) {
      if (s.points.length === 0) continue;
      const r = Math.max(2, s.radius * contentH);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
      ctx.beginPath();
      const [x0, y0] = toPx(s.points[0]);
      ctx.moveTo(x0, y0);
      if (s.points.length === 1) {
        // Zero-length path with round cap still fills — nudge by a hair.
        ctx.lineTo(x0 + 0.01, y0);
      }
      for (let i = 1; i < s.points.length; i++) {
        const [x, y] = toPx(s.points[i]);
        ctx.lineTo(x, y);
      }
      ctx.lineWidth = r * 2;
      ctx.strokeStyle = s.erase ? "rgba(0,0,0,1)" : ACCENTS.fill;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }, [strokes, offset.dx, offset.dy, content, frameSize]);

  useEffect(() => {
    draw();
  }, [draw]);

  /* --- Pointer interaction --- */
  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (busy) return;
    e.preventDefault();
    e.stopPropagation();
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const src = eventToSource(e.clientX, e.clientY);

    if (mode === "adjust" && hasStrokes) {
      // Manual keyframe correction: drag the whole mask; the delta becomes a
      // manual keyframe at the current time on release.
      adjustingRef.current = true;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      setDragOffset({ dx: 0, dy: 0 });
      return;
    }

    drawingRef.current = true;
    const stroke: MagicStroke = {
      points: [[src.x, src.y]],
      radius: brushSize,
      erase: mode === "erase",
    };
    strokesRef.current = [...strokes, stroke];
    drawStrokeLive();
  }

  /** Live preview of the in-flight stroke without waiting for commit. */
  function drawStrokeLive() {
    draw();
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    // Brush cursor ring (direct style writes — no re-render per move).
    const cursor = cursorRef.current;
    const canvas = canvasRef.current;
    if (cursor && canvas) {
      const rect = canvas.getBoundingClientRect();
      const d = Math.max(8, brushSize * 2 * content.h * frameSize.h);
      cursor.style.width = `${d}px`;
      cursor.style.height = `${d}px`;
      cursor.style.transform = `translate(${e.clientX - rect.left - d / 2}px, ${e.clientY - rect.top - d / 2}px)`;
      cursor.style.borderStyle = mode === "erase" ? "dashed" : "solid";
      setCursorOn(true);
    }
    if (adjustingRef.current && dragStartRef.current) {
      const rect = canvas?.getBoundingClientRect();
      if (!rect) return;
      setDragOffset({
        dx: (e.clientX - dragStartRef.current.x) / Math.max(1, rect.width) / content.w,
        dy: (e.clientY - dragStartRef.current.y) / Math.max(1, rect.height) / content.h,
      });
      return;
    }
    if (!drawingRef.current) return;
    const src = eventToSource(e.clientX, e.clientY);
    const list = strokesRef.current;
    const last = list[list.length - 1];
    if (!last) return;
    const prev = last.points[last.points.length - 1];
    const minStep = Math.max(0.0015, last.radius * 0.25);
    if (prev && Math.hypot(src.x - prev[0], src.y - prev[1]) < minStep) return;
    last.points.push([src.x, src.y]);
    drawStrokeLive();
  }

  function onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    try {
      canvas?.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (adjustingRef.current) {
      adjustingRef.current = false;
      dragStartRef.current = null;
      const d = dragOffset;
      setDragOffset(null);
      if (d && (Math.abs(d.dx) > 1e-4 || Math.abs(d.dy) > 1e-4)) {
        // Upsert a manual keyframe at the current time: total offset =
        // tracked offset + drag delta. Replaces a manual keyframe that is
        // already at (nearly) this time.
        const t = mediaTime;
        const kept = keyframes.filter((k) => !(k.manual && Math.abs(k.t - t) < 0.08));
        onCommit({
          keyframes: [...kept, { t, dx: baseOffset.dx + d.dx, dy: baseOffset.dy + d.dy, manual: true }],
        });
      }
      return;
    }
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const next = strokesRef.current;
    const last = next[next.length - 1];
    if (!last) return;
    // First strokes anchor the mask: the stored coordinates are the anchor
    // frame's coordinates and tracking starts from this moment.
    strokesRef.current = next;
    committedRef.current = JSON.stringify(next);
    if (params?.anchorTime == null) {
      onCommit({ strokes: next, anchorTime: mediaTime, keyframes });
    } else {
      onCommit({ strokes: next });
    }
  }

  const accLabel = accuracy === "low" ? "Fast" : accuracy === "high" ? "Precise" : "Balanced";

  return (
    <>
      <canvas
        ref={canvasRef}
        className={`magic-canvas mode-${mode}`}
        style={{ cursor: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursorOn(false)}
        onPointerEnter={() => setCursorOn(true)}
        onDoubleClick={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      />
      <div ref={cursorRef} className={`magic-cursor ${cursorOn ? "on" : ""} mode-${mode}`} aria-hidden />
      <div
        className="magic-panel"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {busy ? (
          <div className="magic-progress-row">
            <span className="magic-phase">
              {tracking ? "Tracking mask" : "Reconstructing background"}…
            </span>
            <div className="magic-progress">
              <div
                className="magic-progress-fill"
                style={{ width: `${Math.round((busy.percent ?? 0) * 100)}%` }}
              />
            </div>
            <span className="magic-pct">{Math.round((busy.percent ?? 0) * 100)}%</span>
            <button type="button" className="magic-btn danger" onClick={onCancel}>
              Cancel
            </button>
            <div className="magic-status" style={{ flexBasis: "100%" }}>
              Every frame of the clip is processed — longer videos take longer. You
              can keep editing; the result appears on the monitor automatically.
            </div>
          </div>
        ) : (
          <>
            <div className="magic-row">
              <div className="magic-modes" role="group" aria-label="Mask mode">
                <button
                  type="button"
                  className={mode === "brush" ? "active" : ""}
                  title="Brush over the logo, text or object to remove"
                  onClick={() => setMode("brush")}
                >
                  Brush
                </button>
                <button
                  type="button"
                  className={mode === "erase" ? "active" : ""}
                  title="Erase parts of the mask"
                  onClick={() => setMode("erase")}
                >
                  Eraser
                </button>
                <button
                  type="button"
                  className={mode === "adjust" ? "active" : ""}
                  title="Drag the mask to correct tracking at this moment (adds a keyframe)"
                  onClick={() => setMode("adjust")}
                  disabled={!hasStrokes}
                >
                  Adjust
                </button>
              </div>
              <label className="magic-slider" title="Brush size (% of frame height)">
                <span>Size</span>
                <input
                  type="range"
                  min={5}
                  max={150}
                  value={Math.round(brushSize * 1000)}
                  onChange={(e) => onParamChange({ brushSize: Number(e.target.value) / 1000 })}
                />
                <span className="magic-val">{fmtPct(brushSize)}</span>
              </label>
              <label className="magic-slider" title="Mask edge softness">
                <span>Feather</span>
                <input
                  type="range"
                  min={0}
                  max={40}
                  value={Math.round((params?.feather ?? 0.008) * 1000)}
                  onChange={(e) => onParamChange({ feather: Number(e.target.value) / 1000 })}
                />
                <span className="magic-val">{fmtPct(params?.feather ?? 0.008)}</span>
              </label>
              <label className="magic-slider" title="Grow the mask to catch fringes">
                <span>Expand</span>
                <input
                  type="range"
                  min={0}
                  max={20}
                  value={Math.round((params?.expand ?? 0.004) * 1000)}
                  onChange={(e) => onParamChange({ expand: Number(e.target.value) / 1000 })}
                />
                <span className="magic-val">{fmtPct(params?.expand ?? 0.004)}</span>
              </label>
            </div>
            <div className="magic-row">
              <label className="magic-slider" title="Search window & keyframe density for auto tracking">
                <span>Tracking</span>
                <select
                  value={accuracy}
                  onChange={(e) => onParamChange({ trackingAccuracy: e.target.value })}
                >
                  <option value="low">Fast</option>
                  <option value="medium">Balanced</option>
                  <option value="high">Precise</option>
                </select>
                <span className="magic-val">{accLabel}</span>
              </label>
              <label className="magic-slider" title="Removal strength — blend of the reconstructed background">
                <span>Strength</span>
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={Math.round(params?.removalStrength ?? 100)}
                  onChange={(e) => onParamChange({ removalStrength: Number(e.target.value) })}
                />
                <span className="magic-val">{Math.round(params?.removalStrength ?? 100)}%</span>
              </label>
              <div className="magic-actions">
                <button
                  type="button"
                  className="magic-btn"
                  disabled={!hasStrokes}
                  title="Track this mask across the clip (follows motion)"
                  onClick={onTrack}
                >
                  Auto Track
                </button>
                <button
                  type="button"
                  className="magic-btn primary"
                  disabled={!hasStrokes}
                  title="Remove the selected content and rebuild the background"
                  onClick={onRemove}
                >
                  ✨ Remove
                </button>
                <button
                  type="button"
                  className="magic-btn danger"
                  disabled={!hasStrokes}
                  title="Clear the mask"
                  onClick={() => {
                    strokesRef.current = [];
                    committedRef.current = "[]";
                    onCommit({ strokes: [], keyframes: [] });
                  }}
                >
                  Clear
                </button>
                <button type="button" className="magic-btn" onClick={onDone}>
                  Done
                </button>
              </div>
            </div>
            {(status || !hasStrokes) && (
              <div className="magic-status">
                {status ??
                  "Brush over the watermark, logo or object — then Auto Track (if it moves) and Remove."}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
