import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Clip, TimelineTool } from "./types";
import { fileName, formatTime } from "./types";
import type { TimelineView } from "./useTimelineView";

type Props = {
  clip: Clip;
  selected: boolean;
  tool: TimelineTool;
  view: TimelineView;
  locked: boolean;
  anchors: number[];
  onSelect: () => void;
  onRazor: (at: number) => void;
  onMove: (newStart: number) => void;
  onTrim: (inPoint: number, outPoint: number, keepEnd: boolean) => void;
  onRippleTrim: (edge: "left" | "right", newEdgeTime: number) => void;
  onSlip: (delta: number) => void;
  onDragActive?: (active: boolean) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
};

type DragMode = "move" | "trim-left" | "trim-right" | "slip";

export function ClipBlock({
  clip,
  selected,
  tool,
  view,
  locked,
  anchors,
  onSelect,
  onRazor,
  onMove,
  onTrim,
  onRippleTrim,
  onSlip,
  onDragActive,
  onContextMenu,
}: Props) {
  const [draft, setDraft] = useState<{
    start: number;
    in_point: number;
    out_point: number;
  } | null>(null);
  const draggingRef = useRef(false);

  const start = draft?.start ?? clip.start;
  const inPoint = draft?.in_point ?? clip.in_point;
  const outPoint = draft?.out_point ?? clip.out_point;
  const dur = Math.max(0.05, outPoint - inPoint);
  const left = view.timeToX(start);
  const width = Math.max(12, view.timeToX(dur));

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

    if (tool === "slip") {
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
    let latest = {
      start: originStart,
      in_point: originIn,
      out_point: originOut,
    };
    let slipDelta = 0;

    draggingRef.current = true;
    onDragActive?.(true);
    setDraft(latest);

    const onMoveWin = (ev: PointerEvent) => {
      const dx = ev.clientX - originX;
      const dt = dx / view.pxPerSec;

      if (resolved === "slip") {
        slipDelta = dt;
        // Visual: shift source window while keeping timeline span fixed
        latest = {
          start: originStart,
          in_point: Math.max(0, originIn + dt),
          out_point: Math.max(0.05, originOut + dt),
        };
        setDraft(latest);
        return;
      }

      if (resolved === "move") {
        const next = view.applySnap(Math.max(0, originStart + dt), anchors);
        latest = { start: next, in_point: originIn, out_point: originOut };
        setDraft(latest);
        return;
      }

      if (resolved === "trim-left") {
        const maxIn = originOut - 0.05;
        const newIn = Math.min(maxIn, Math.max(0, originIn + dt));
        const oldDur = originOut - originIn;
        const newDur = originOut - newIn;
        latest = {
          start: Math.max(0, originStart + (oldDur - newDur)),
          in_point: newIn,
          out_point: originOut,
        };
        setDraft(latest);
        return;
      }

      const minOut = originIn + 0.05;
      const newOut = Math.max(minOut, originOut + dt);
      latest = {
        start: originStart,
        in_point: originIn,
        out_point: newOut,
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

      const moved =
        Math.abs(latest.start - originStart) > 0.001 ||
        Math.abs(latest.in_point - originIn) > 0.001 ||
        Math.abs(latest.out_point - originOut) > 0.001;

      if (moved) {
        if (resolved === "move") {
          onMove(latest.start);
        } else if (tool === "ripple") {
          const edge = resolved === "trim-left" ? "left" : "right";
          const newEdgeTime =
            edge === "left"
              ? latest.start
              : latest.start + (latest.out_point - latest.in_point);
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
      className={`tl-clip role-${clip.role} ${selected ? "selected" : ""} ${clip.linked_clip_id ? "linked" : ""} ${draft ? "dragging" : ""}`}
      style={{ left, width, cursor }}
      onPointerDown={(e) => beginDrag(e, "move")}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect();
        onContextMenu?.(e);
      }}
      title={`${fileName(clip.media_path)} — drag to move · right-click for tools`}
    >
      <span
        className="tl-edge left"
        onPointerDown={(e) => beginDrag(e, "trim-left")}
        title={tool === "ripple" ? "Ripple trim in" : "Trim in"}
      />
      <div className="tl-clip-body">
        <span className="tl-clip-name">{fileName(clip.media_path)}</span>
        <small>{formatTime(dur)}</small>
      </div>
      <span
        className="tl-edge right"
        onPointerDown={(e) => beginDrag(e, "trim-right")}
        title={tool === "ripple" ? "Ripple trim out" : "Trim out"}
      />
    </div>
  );
}
