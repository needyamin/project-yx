import { memo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Clip, EditMode, IndexedObstacle, Obstacle, TimelineTool } from "./types";
import {
  clipTimelineDuration,
  fileName,
  formatTime,
  nearestInSorted,
  resolveNonOverlappingStart,
} from "./types";
import type { TimelineView } from "./useTimelineView";

export type ClipEditAction =
  | {
    type: "move";
    clipId: string;
    newStart: number;
    /** When set, drop the clip onto this track (cross-track move). */
    targetTrackId?: string | null;
  }
  | { type: "trim"; clipId: string; inPoint: number; outPoint: number; keepEnd: boolean }
  | { type: "razor"; clipId: string; at: number }
  | { type: "rippleTrim"; clipId: string; edge: "left" | "right"; newEdgeTime: number }
  | { type: "slip"; clipId: string; delta: number }
  | { type: "fades"; clipId: string; fadeIn: number; fadeOut: number };

type Props = {
  clip: Clip;
  selected: boolean;
  tool: TimelineTool;
  view: TimelineView;
  locked: boolean;
  /** Shared SORTED snap anchors (all clips/markers/zone). This clip's own
   * edges are excluded once per drag, not per timeline change. */
  anchors: number[];
  /** Shared per-track obstacle lists (ids included) — filtered to remove
   * self/partner once per gesture. Referentially stable per timeline change
   * so memoized clips skip re-render. */
  obstacles?: {
    ownTrack: IndexedObstacle[];
    partner?: IndexedObstacle[] | null;
  } | null;
  editMode?: EditMode;
  maxMediaDuration?: number;
  /** Live draft from parent while a linked partner is being dragged or resized. */
  previewDraft?: {
    start: number;
    in_point: number;
    out_point: number;
  } | null;
  /** Stable edit dispatcher — see ClipEditAction. */
  onEdit: (action: ClipEditAction) => void;
  onSelect: (clipId: string) => void;
  onRazor?: never;
  onMove?: never;
  onTrim?: never;
  onRippleTrim?: never;
  onSlip?: never;
  onSetFades?: never;
  /** Notify parent during move/trim so linked partners can preview lockstep. */
  onLiveDrag?: (
    phase: "start" | "move" | "end",
    clipId: string,
    draft: { start: number; in_point: number; out_point: number },
  ) => void;
  onDragActive?: (active: boolean) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
};

type DragMode = "move" | "trim-left" | "trim-right" | "slip" | "fade-in" | "fade-out";

function ClipBlockImpl({
  clip,
  selected,
  tool,
  view,
  locked,
  anchors,
  obstacles = null,
  editMode = "normal",
  maxMediaDuration = Infinity,
  previewDraft = null,
  onEdit,
  onSelect,
  onLiveDrag,
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
  const [dragMode, setDragMode] = useState<DragMode | null>(null);
  const [trimDelta, setTrimDelta] = useState(0);
  const draggingRef = useRef(false);

  // Local draft wins while this clip is dragged; otherwise linked partner preview.
  const start = draft?.start ?? previewDraft?.start ?? clip.start;
  const inPoint = draft?.in_point ?? previewDraft?.in_point ?? clip.in_point;
  const outPoint = draft?.out_point ?? previewDraft?.out_point ?? clip.out_point;
  const fadeIn = draft?.fade_in ?? clip.fade_in ?? 0;
  const fadeOut = draft?.fade_out ?? clip.fade_out ?? 0;
  const speedRaw = clip.speed ?? 1;
  const speed = Number.isFinite(speedRaw) ? Math.min(4, Math.max(0.25, speedRaw)) : 1;
  const dur = Math.max(0.05, (outPoint - inPoint) / speed);
  const left = view.timeToX(start);
  const width = Math.max(12, view.timeToX(dur));
  const previewing = !draft && previewDraft != null;
  const fadeInPx = Math.min(width, view.timeToX(Math.max(0, fadeIn)));
  const fadeOutPx = Math.min(width, view.timeToX(Math.max(0, fadeOut)));

  function beginDrag(e: ReactPointerEvent, mode: DragMode) {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(clip.id);

    if (tool === "razor") {
      const rect = (e.currentTarget as HTMLElement)
        .closest(".tl-clip")
        ?.getBoundingClientRect();
      const x = rect ? e.clientX - rect.left : e.nativeEvent.offsetX;
      const rawAt = start + x / view.pxPerSec;
      const frameDur = 1 / 30;
      const quantized = Math.round(rawAt / frameDur) * frameDur;
      const at = Number(quantized.toFixed(4));
      onEdit({
        type: "razor",
        clipId: clip.id,
        at: Math.max(start + frameDur, Math.min(start + dur - frameDur, at)),
      });
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
    const originY = e.clientY;
    const originLane = (e.currentTarget as HTMLElement).closest(
      ".tl-lane",
    ) as HTMLElement | null;
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
    // Gesture-scoped drag data, resolved ONCE per drag (never per
    // pointermove): obstacles without self/partner, anchors without this
    // clip's own edges.
    const linkedId = clip.linked_clip_id;
    const dragObstacles: Obstacle[] = [
      ...(obstacles?.ownTrack ?? []),
      ...(obstacles?.partner ?? []),
    ]
      .filter((o) => o.id !== clip.id && (!linkedId || o.id !== linkedId))
      .map((o) => ({ start: o.start, duration: o.duration }));
    const ownEnd = originStart + originDur;
    const dragAnchors = anchors.filter(
      (a) => Math.abs(a - originStart) > 1e-6 && Math.abs(a - ownEnd) > 1e-6,
    );
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
    setDragMode(resolved);
    setTrimDelta(0);
    if (resolved === "move" || resolved === "trim-left" || resolved === "trim-right" || resolved === "slip") {
      onLiveDrag?.("start", clip.id, {
        start: latest.start,
        in_point: latest.in_point,
        out_point: latest.out_point,
      });
    }

    let rafId: number | null = null;
    let pendingEv: PointerEvent | null = null;

    /* Cross-track drag targeting: while the pointer vertically leaves the
     * origin lane (> 14px), resolve the lane under the pointer and float a
     * ghost preview there. All DOM updates are imperative (no re-renders). */
    let ghost: HTMLDivElement | null = null;
    let ghostLaneEl: HTMLElement | null = null;
    let targetTrackId: string | null = null;

    const updateTrackTarget = (ev: PointerEvent, startPx: number) => {
      let lane: HTMLElement | null = null;
      if (Math.abs(ev.clientY - originY) > 14) {
        const hit = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest(".tl-lane") as HTMLElement | null;
        if (
          hit &&
          hit !== originLane &&
          !hit.classList.contains("collapsed") &&
          !hit.classList.contains("locked") &&
          hit.classList.contains(`track-${clip.role}`)
        ) {
          lane = hit;
        }
      }
      const laneTrackId = lane?.dataset.trackId ?? null;
      if (laneTrackId !== targetTrackId) {
        ghostLaneEl?.classList.remove("tl-lane-drop-target");
        ghost?.remove();
        ghost = null;
        ghostLaneEl = null;
        targetTrackId = laneTrackId;
        if (lane && targetTrackId) {
          lane.classList.add("tl-lane-drop-target");
          ghost = document.createElement("div");
          ghost.className = `tl-clip tl-clip-ghost role-${clip.role}`;
          ghost.style.pointerEvents = "none";
          const name = document.createElement("span");
          name.className = "tl-clip-name";
          name.textContent = fileName(clip.media_path);
          ghost.appendChild(name);
          lane.appendChild(ghost);
          ghostLaneEl = lane;
        }
      }
      if (ghost) {
        ghost.style.left = `${startPx}px`;
        ghost.style.width = `${Math.max(12, view.timeToX(originDur))}px`;
      }
    };

    const clearTrackTarget = () => {
      ghostLaneEl?.classList.remove("tl-lane-drop-target");
      ghost?.remove();
      ghost = null;
      ghostLaneEl = null;
      targetTrackId = null;
    };

    const processMove = (ev: PointerEvent) => {
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
        onLiveDrag?.("move", clip.id, {
          start: latest.start,
          in_point: latest.in_point,
          out_point: latest.out_point,
        });
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
        const rawNext = Math.max(0, originStart + dt);
        let snapped = view.applySnap(rawNext, dragAnchors);
        // If left edge did not snap, snap right edge against anchors (flush snapping)
        if (Math.abs(snapped - rawNext) < 0.001 && view.snap) {
          const threshold = Math.max(0.05, 10 / view.pxPerSec);
          const hit = nearestInSorted(dragAnchors, rawNext + originDur, threshold);
          if (hit != null) {
            snapped = Math.max(0, hit - originDur);
            view.showSnapGuide(snapped + originDur);
          }
        }
        const next =
          (editMode ?? "normal") === "normal" && dragObstacles.length > 0
            ? resolveNonOverlappingStart(snapped, originDur, dragObstacles)
            : snapped;
        latest = {
          start: next,
          in_point: originIn,
          out_point: originOut,
          fade_in: originFadeIn,
          fade_out: originFadeOut,
        };
        updateTrackTarget(ev, view.timeToX(next));
        setDraft(latest);
        onLiveDrag?.("move", clip.id, {
          start: latest.start,
          in_point: latest.in_point,
          out_point: latest.out_point,
        });
        return;
      }

      if (resolved === "trim-left") {
        let minStart = 0;
        if (dragObstacles.length > 0) {
          for (const o of dragObstacles) {
            const oEnd = o.start + o.duration;
            if (oEnd <= originStart + 0.001) {
              minStart = Math.max(minStart, oEnd);
            }
          }
        }
        const maxIn = originOut - 0.05 * originSpeed;
        const newIn = Math.min(maxIn, Math.max(0, originIn + dt * originSpeed));
        const oldMedia = originOut - originIn;
        const newMedia = originOut - newIn;
        const proposedStart = originStart + (oldMedia - newMedia) / originSpeed;
        const clampedStart = Math.max(minStart, proposedStart);
        const actualDtMedia = (originStart - clampedStart) * originSpeed;
        const finalIn = Math.min(maxIn, Math.max(0, originIn - actualDtMedia));
        latest = {
          start: clampedStart,
          in_point: finalIn,
          out_point: originOut,
          fade_in: originFadeIn,
          fade_out: originFadeOut,
        };
        setDraft(latest);
        setTrimDelta(clampedStart - originStart);
        onLiveDrag?.("move", clip.id, {
          start: latest.start,
          in_point: latest.in_point,
          out_point: latest.out_point,
        });
        return;
      }

      let maxEnd = Infinity;
      if (dragObstacles.length > 0) {
        for (const o of dragObstacles) {
          if (o.start >= originStart + originDur - 0.001) {
            maxEnd = Math.min(maxEnd, o.start);
          }
        }
      }
      const minOut = originIn + 0.05 * originSpeed;
      const maxOutBound = originIn + (maxEnd - originStart) * originSpeed;
      const allowedMaxOut = Math.min(maxOutBound, maxMediaDuration ?? Infinity);
      const newOut = Math.min(allowedMaxOut, Math.max(minOut, originOut + dt * originSpeed));
      latest = {
        start: originStart,
        in_point: originIn,
        out_point: newOut,
        fade_in: originFadeIn,
        fade_out: originFadeOut,
      };
      setDraft(latest);
      setTrimDelta((newOut - originOut) / originSpeed);
      onLiveDrag?.("move", clip.id, {
        start: latest.start,
        in_point: latest.in_point,
        out_point: latest.out_point,
      });
    };

    const onMoveWin = (ev: PointerEvent) => {
      pendingEv = ev;
      if (rafId == null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (pendingEv && draggingRef.current) {
            processMove(pendingEv);
          }
        });
      }
    };

    const onUpWin = () => {
      window.removeEventListener("pointermove", onMoveWin);
      window.removeEventListener("pointerup", onUpWin);
      window.removeEventListener("pointercancel", onUpWin);
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (pendingEv && draggingRef.current) {
        processMove(pendingEv);
        pendingEv = null;
      }
      const dropTargetTrackId = targetTrackId;
      clearTrackTarget();
      view.showSnapGuide(null);
      draggingRef.current = false;
      onDragActive?.(false);

      if (resolved === "move" || resolved === "trim-left" || resolved === "trim-right" || resolved === "slip") {
        onLiveDrag?.("end", clip.id, {
          start: latest.start,
          in_point: latest.in_point,
          out_point: latest.out_point,
        });
      }

      if (resolved === "slip") {
        if (Math.abs(slipDelta) > 0.001) {
          onEdit({ type: "slip", clipId: clip.id, delta: slipDelta });
        }
        setDraft(null);
        return;
      }

      if (resolved === "fade-in" || resolved === "fade-out") {
        const changed =
          Math.abs(latest.fade_in - originFadeIn) > 0.001 ||
          Math.abs(latest.fade_out - originFadeOut) > 0.001;
        if (changed) {
          onEdit({
            type: "fades",
            clipId: clip.id,
            fadeIn: latest.fade_in,
            fadeOut: latest.fade_out,
          });
        }
        setDraft(null);
        return;
      }

      const moved =
        Math.abs(latest.start - originStart) > 0.001 ||
        Math.abs(latest.in_point - originIn) > 0.001 ||
        Math.abs(latest.out_point - originOut) > 0.001;

      if (resolved === "move") {
        if (moved || dropTargetTrackId) {
          onEdit({
            type: "move",
            clipId: clip.id,
            newStart: latest.start,
            targetTrackId: dropTargetTrackId,
          });
        }
      } else if (moved) {
        if (tool === "ripple") {
          const edge = resolved === "trim-left" ? "left" : "right";
          const newEdgeTime =
            edge === "left"
              ? latest.start
              : latest.start + clipTimelineDuration({ ...latest, speed: originSpeed });
          onEdit({ type: "rippleTrim", clipId: clip.id, edge, newEdgeTime });
        } else if (resolved === "trim-left") {
          onEdit({ type: "trim", clipId: clip.id, inPoint: latest.in_point, outPoint: latest.out_point, keepEnd: true });
        } else {
          onEdit({ type: "trim", clipId: clip.id, inPoint: latest.in_point, outPoint: latest.out_point, keepEnd: false });
        }
      }
      setDraft(null);
      setDragMode(null);
      setTrimDelta(0);
    };

    window.addEventListener("pointermove", onMoveWin);
    window.addEventListener("pointerup", onUpWin);
    window.addEventListener("pointercancel", onUpWin);
  }

  const cursor =
    tool === "slip" ? "ew-resize" : tool === "razor" ? "col-resize" : undefined;

  return (
    <div
      data-clip-id={clip.id}
      className={`tl-clip role-${clip.role} ${selected ? "selected" : ""} ${clip.linked_clip_id ? "linked" : ""} ${draft || previewing ? "dragging" : ""}`}
      style={{ left, width, cursor }}
      onPointerDown={(e) => beginDrag(e, "move")}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect(clip.id);
        onContextMenu?.(e);
      }}
      title={`${fileName(clip.media_path)} — drag to move · corners for fade · right-click for tools`}
    >
      {/*style Fade Ramps with Diagonal Stroke Lines */}
      {fadeInPx > 1 && (
        <div
          className="tl-fade tl-fade-in"
          style={{ width: fadeInPx }}
          aria-hidden
        >
          <svg className="tl-fade-svg" preserveAspectRatio="none" viewBox="0 0 100 100">
            <line x1="0" y1="100" x2="100" y2="0" stroke="rgba(255, 71, 87, 0.9)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      )}
      {fadeOutPx > 1 && (
        <div
          className="tl-fade tl-fade-out"
          style={{ width: fadeOutPx }}
          aria-hidden
        >
          <svg className="tl-fade-svg" preserveAspectRatio="none" viewBox="0 0 100 100">
            <line x1="0" y1="0" x2="100" y2="100" stroke="rgba(255, 71, 87, 0.9)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      )}

      {/* Left Trim Handle (Trim-In style) */}
      <span
        className={`tl-edge left ${dragMode === "trim-left" ? "active" : ""}`}
        onPointerDown={(e) => beginDrag(e, "trim-left")}
        title={tool === "ripple" ? "Ripple trim in / extend" : "Trim in / extend (drag left/right)"}
      >
        <span className="tl-edge-bar" aria-hidden />
      </span>

      {/* Left Fade Handle ( circular grab dot) */}
      <span
        className={`tl-fade-handle left ${fadeIn > 0 ? "has-fade" : ""} ${dragMode === "fade-in" ? "active" : ""}`}
        onPointerDown={(e) => beginDrag(e, "fade-in")}
        title={fadeIn > 0 ? `Fade in: ${fadeIn.toFixed(2)}s (drag to adjust)` : "Drag to fade in"}
        style={{ left: fadeInPx }}
      />

      <div className="tl-clip-body">
        <span className="tl-clip-name">{fileName(clip.media_path)}</span>
        <small>{formatTime(dur)}</small>
      </div>

      {/* Right Fade Handle ( circular grab dot) */}
      <span
        className={`tl-fade-handle right ${fadeOut > 0 ? "has-fade" : ""} ${dragMode === "fade-out" ? "active" : ""}`}
        onPointerDown={(e) => beginDrag(e, "fade-out")}
        title={fadeOut > 0 ? `Fade out: ${fadeOut.toFixed(2)}s (drag to adjust)` : "Drag to fade out"}
        style={{ right: fadeOutPx }}
      />

      {/* Right Trim Handle ( Trim-Out style) */}
      <span
        className={`tl-edge right ${dragMode === "trim-right" ? "active" : ""}`}
        onPointerDown={(e) => beginDrag(e, "trim-right")}
        title={tool === "ripple" ? "Ripple trim out / extend" : "Trim out / extend (drag left/right)"}
      >
        <span className="tl-edge-bar" aria-hidden />
      </span>

      {/* Floating  HUD tooltips during resize or fade */}
      {dragMode === "trim-left" && (
        <div className="tl-hud tl-hud-edge left">
          <span className="tl-hud-title">In: {formatTime(inPoint)}</span>
          <span className="tl-hud-dur">{formatTime(dur)} ({trimDelta >= 0 ? `+${trimDelta.toFixed(2)}s` : `${trimDelta.toFixed(2)}s`})</span>
        </div>
      )}
      {dragMode === "trim-right" && (
        <div className="tl-hud tl-hud-edge right">
          <span className="tl-hud-title">Out: {formatTime(outPoint)}</span>
          <span className="tl-hud-dur">{formatTime(dur)} ({trimDelta >= 0 ? `+${trimDelta.toFixed(2)}s` : `${trimDelta.toFixed(2)}s`})</span>
        </div>
      )}
      {dragMode === "fade-in" && (
        <div className="tl-hud tl-hud-fade" style={{ left: fadeInPx }}>
          <span>Fade In: {fadeIn.toFixed(2)}s</span>
        </div>
      )}
      {dragMode === "fade-out" && (
        <div className="tl-hud tl-hud-fade" style={{ right: fadeOutPx }}>
          <span>Fade Out: {fadeOut.toFixed(2)}s</span>
        </div>
      )}
    </div>
  );
}

/** Memoized: skips re-render unless THIS clip's data/view actually changed. */
export const ClipBlock = memo(ClipBlockImpl);
