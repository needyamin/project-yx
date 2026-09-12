import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Clip, TimelineTool } from "./types";
import { clipTimelineDuration, fileName, formatTime } from "./types";
import type { TimelineView } from "./useTimelineView";

type Props = {
  clip: Clip;
  selected: boolean;
  tool: TimelineTool;
  view: TimelineView;
  locked: boolean;
  anchors: number[];
  /** Live start from parent while a linked partner is being dragged. */
  previewStart?: number | null;
  onSelect: () => void;
  onRazor: (at: number) => void;
  onMove: (newStart: number) => void;
  /** Notify parent during move so linked partners can preview lockstep. */
  onMoveDrag?: (phase: "start" | "move" | "end", start: number) => void;
  onTrim: (inPoint: number, outPoint: number, keepEnd: boolean) => void;
  onRippleTrim: (edge: "left" | "right", newEdgeTime: number) => void;
  onSlip: (delta: number) => void;
  onSetFades: (fadeIn: number, fadeOut: number) => void;
  onDragActive?: (active: boolean) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
};

type DragMode = "move" | "trim-left" | "trim-right" | "slip" | "fade-in" | "fade-out";

export function ClipBlock({
  clip,
  selected,
  tool,
  view,
  locked,
  anchors,
  previewStart = null,
  onSelect,
  onRazor,
  onMove,
  onMoveDrag,
  onTrim,
  onRippleTrim,
  onSlip,
  onSetFades,
  onDragActive,
  onContextMenu,
}: Props) {
  const [draft, setDraft] = useState<{
    start: number;
    in_point: number;
    out_point: number;
    fade_in: number;
    fade_out: number;
  } | null>(null);
  const draggingRef = useRef(false);

  // Local draft wins while this clip is dragged; otherwise linked partner preview.
  const start =
    draft?.start ??
    (previewStart != null ? previewStart : clip.start);
  const inPoint = draft?.in_point ?? clip.in_point;
  const outPoint = draft?.out_point ?? clip.out_point;
  const fadeIn = draft?.fade_in ?? clip.fade_in ?? 0;
  const fadeOut = draft?.fade_out ?? clip.fade_out ?? 0;
  const speedRaw = clip.speed ?? 1;
  const speed = Number.isFinite(speedRaw) ? Math.min(4, Math.max(0.25, speedRaw)) : 1;
  const dur = Math.max(0.05, (outPoint - inPoint) / speed);
  const left = view.timeToX(start);
  const width = Math.max(12, view.timeToX(dur));
  const previewing = !draft && previewStart != null;
  const fadeInPx = Math.min(width, view.timeToX(Math.max(0, fadeIn)));
  const fadeOutPx = Math.min(width, view.timeToX(Math.max(0, fadeOut)));

  function beginDrag(e: ReactPointerEvent, mode: DragMode) {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect();

    if (tool === "razor") {
      const rect = (e.currentTarget as HTMLElement)
        .closest(".tl-clip")
        ?.getBoundingClientRect();
      const x = rect ? e.clientX - rect.left : e.nativeEvent.offsetX;
      const at = start + x / view.pxPerSec;
      onRazor(Math.max(start + 0.05, Math.min(start + dur - 0.05, at)));
      return;
    }

    if (tool === "spacer") return;

    if (mode === "fade-in" || mode === "fade-out") {
      // Fades work in select (and when clip is selected); ignore other tools.
      if (tool !== "select" && tool !== "ripple") return;
    } else if (tool === "slip") {
      mode = "slip";
    } else if (tool === "ripple" && mode === "move") {
      return;
    } else if (tool !== "select" && tool !== "ripple") {
      return;
    }

    const resolved: DragMode = mode;

    const originX = e.clientX;
    const originStart = clip.start;
    const originIn = clip.in_point;
    const originOut = clip.out_point;
    const originFadeIn = clip.fade_in ?? 0;
    const originFadeOut = clip.fade_out ?? 0;
    const originSpeedRaw = clip.speed ?? 1;
    const originSpeed = Number.isFinite(originSpeedRaw)
      ? Math.min(4, Math.max(0.25, originSpeedRaw))
      : 1;
    const originDur = Math.max(0.05, (originOut - originIn) / originSpeed);
    let latest = {
      start: originStart,
      in_point: originIn,
      out_point: originOut,
      fade_in: originFadeIn,
      fade_out: originFadeOut,
    };
    let slipDelta = 0;

    draggingRef.current = true;
    onDragActive?.(true);
    setDraft(latest);
    if (resolved === "move") onMoveDrag?.("start", originStart);

    const onMoveWin = (ev: PointerEvent) => {
      const dx = ev.clientX - originX;
      const dt = dx / view.pxPerSec;

      if (resolved === "slip") {
        slipDelta = dt * originSpeed;
        latest = {
          start: originStart,
          in_point: Math.max(0, originIn + slipDelta),
          out_point: Math.max(0.05, originOut + slipDelta),
          fade_in: originFadeIn,
          fade_out: originFadeOut,
        };
        setDraft(latest);
        return;
      }

      if (resolved === "fade-in") {
        const maxIn = Math.max(0, originDur - originFadeOut);
        const next = Math.max(0, Math.min(maxIn, originFadeIn + dt));
        latest = {
          start: originStart,
          in_point: originIn,
          out_point: originOut,
          fade_in: next,
          fade_out: originFadeOut,
        };
        setDraft(latest);
        return;
      }

      if (resolved === "fade-out") {
        const maxOut = Math.max(0, originDur - originFadeIn);
        const next = Math.max(0, Math.min(maxOut, originFadeOut - dt));
        latest = {
          start: originStart,
          in_point: originIn,
          out_point: originOut,
          fade_in: originFadeIn,
          fade_out: next,
        };
        setDraft(latest);
        return;
      }

      if (resolved === "move") {
        const next = view.applySnap(Math.max(0, originStart + dt), anchors);
        latest = {
          start: next,
          in_point: originIn,
          out_point: originOut,
          fade_in: originFadeIn,
          fade_out: originFadeOut,
        };
        setDraft(latest);
        onMoveDrag?.("move", next);
        return;
      }

      if (resolved === "trim-left") {
        const maxIn = originOut - 0.05 * originSpeed;
        const newIn = Math.min(maxIn, Math.max(0, originIn + dt * originSpeed));
        const oldMedia = originOut - originIn;
        const newMedia = originOut - newIn;
        latest = {
          start: Math.max(0, originStart + (oldMedia - newMedia) / originSpeed),
          in_point: newIn,
          out_point: originOut,
          fade_in: originFadeIn,
          fade_out: originFadeOut,
        };
        setDraft(latest);
        return;
      }

      const minOut = originIn + 0.05 * originSpeed;
      const newOut = Math.max(minOut, originOut + dt * originSpeed);
      latest = {
        start: originStart,
        in_point: originIn,
        out_point: newOut,
        fade_in: originFadeIn,
        fade_out: originFadeOut,
      };
      setDraft(latest);
    };

    const onUpWin = () => {
      window.removeEventListener("pointermove", onMoveWin);
      window.removeEventListener("pointerup", onUpWin);
      window.removeEventListener("pointercancel", onUpWin);
      view.setSnapGuide(null);
      draggingRef.current = false;
      onDragActive?.(false);

      if (resolved === "slip") {
        if (Math.abs(slipDelta) > 0.001) onSlip(slipDelta);
        setDraft(null);
        return;
      }

      if (resolved === "fade-in" || resolved === "fade-out") {
        const changed =
          Math.abs(latest.fade_in - originFadeIn) > 0.001 ||
          Math.abs(latest.fade_out - originFadeOut) > 0.001;
        if (changed) onSetFades(latest.fade_in, latest.fade_out);
        setDraft(null);
        return;
      }

      const moved =
        Math.abs(latest.start - originStart) > 0.001 ||
        Math.abs(latest.in_point - originIn) > 0.001 ||
        Math.abs(latest.out_point - originOut) > 0.001;

      if (resolved === "move") {
        if (moved) {
          onMove(latest.start);
        } else {
          onMoveDrag?.("end", latest.start);
        }
      } else if (moved) {
        if (tool === "ripple") {
          const edge = resolved === "trim-left" ? "left" : "right";
          const newEdgeTime =
            edge === "left"
              ? latest.start
              : latest.start + clipTimelineDuration({ ...latest, speed: originSpeed });
          onRippleTrim(edge, newEdgeTime);
        } else if (resolved === "trim-left") {
          onTrim(latest.in_point, latest.out_point, true);
        } else {
          onTrim(latest.in_point, latest.out_point, false);
        }
      }
      setDraft(null);
    };

    window.addEventListener("pointermove", onMoveWin);
    window.addEventListener("pointerup", onUpWin);
    window.addEventListener("pointercancel", onUpWin);
  }

  const cursor =
    tool === "slip" ? "ew-resize" : tool === "razor" ? "col-resize" : undefined;

  return (
    <div
      className={`tl-clip role-${clip.role} ${selected ? "selected" : ""} ${clip.linked_clip_id ? "linked" : ""} ${draft || previewing ? "dragging" : ""}`}
      style={{ left, width, cursor }}
      onPointerDown={(e) => beginDrag(e, "move")}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect();
        onContextMenu?.(e);
      }}
      title={`${fileName(clip.media_path)} — drag to move · corners for fade · right-click for tools`}
    >
      {fadeInPx > 1 && (
        <div
          className="tl-fade tl-fade-in"
          style={{ width: fadeInPx }}
          aria-hidden
        />
      )}
      {fadeOutPx > 1 && (
        <div
          className="tl-fade tl-fade-out"
          style={{ width: fadeOutPx }}
          aria-hidden
        />
      )}
      <span
        className="tl-edge left"
        onPointerDown={(e) => beginDrag(e, "trim-left")}
        title={tool === "ripple" ? "Ripple trim in" : "Trim in"}
      />
      <span
        className="tl-fade-handle left"
        onPointerDown={(e) => beginDrag(e, "fade-in")}
        title="Fade in"
        style={{ left: Math.max(8, fadeInPx) }}
      />
      <div className="tl-clip-body">
        <span className="tl-clip-name">{fileName(clip.media_path)}</span>
        <small>{formatTime(dur)}</small>
      </div>
      <span
        className="tl-fade-handle right"
        onPointerDown={(e) => beginDrag(e, "fade-out")}
        title="Fade out"
        style={{ right: Math.max(8, fadeOutPx) }}
      />
      <span
        className="tl-edge right"
        onPointerDown={(e) => beginDrag(e, "trim-right")}
        title={tool === "ripple" ? "Ripple trim out" : "Trim out"}
      />
    </div>
  );
}
