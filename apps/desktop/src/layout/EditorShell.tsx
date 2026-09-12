import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./EditorShell.css";

type Props = {
  topbar: ReactNode;
  bin: ReactNode;
  clipMonitor: ReactNode | null;
  projectMonitor: ReactNode;
  timeline: ReactNode;
};

const TIMELINE_MIN = 240;
const TIMELINE_MAX_VH = 0.62;
const TIMELINE_DEFAULT_VH = 0.44;

const BIN_MIN = 200;
const BIN_DEFAULT = 260;
/** Max width = default + 10% of default. */
const BIN_MAX = Math.round(BIN_DEFAULT * 1.1);
const BIN_HANDLE_PX = 5;

export function EditorShell({
  topbar,
  bin,
  clipMonitor,
  projectMonitor,
  timeline,
}: Props) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [timelinePx, setTimelinePx] = useState(() =>
    Math.round(typeof window !== "undefined" ? window.innerHeight * TIMELINE_DEFAULT_VH : 320),
  );
  const [binPx, setBinPx] = useState(BIN_DEFAULT);
  const timelineDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const binDragRef = useRef<{ startX: number; startW: number } | null>(null);

  const clampTimeline = useCallback((h: number) => {
    const max = Math.round(window.innerHeight * TIMELINE_MAX_VH);
    return Math.max(TIMELINE_MIN, Math.min(max, h));
  }, []);

  const clampBin = useCallback((w: number) => {
    return Math.max(BIN_MIN, Math.min(BIN_MAX, w));
  }, []);

  useEffect(() => {
    function onResize() {
      setTimelinePx((h) => clampTimeline(h));
      setBinPx((w) => clampBin(w));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampTimeline, clampBin]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (timelineDragRef.current) {
        const delta = timelineDragRef.current.startY - e.clientY;
        setTimelinePx(clampTimeline(timelineDragRef.current.startH + delta));
      }
      if (binDragRef.current) {
        const delta = e.clientX - binDragRef.current.startX;
        setBinPx(clampBin(binDragRef.current.startW + delta));
      }
    }
    function onUp() {
      timelineDragRef.current = null;
      binDragRef.current = null;
      document.body.classList.remove("resizing-timeline", "resizing-bin");
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [clampTimeline, clampBin]);

  return (
    <div
      ref={shellRef}
      className="shell editor-shell"
      style={{
        gridTemplateRows: `36px minmax(0, 1fr) 5px ${timelinePx}px`,
      }}
    >
      {topbar}
      <div
        className="editor-mid"
        style={{
          gridTemplateColumns: `${binPx}px ${BIN_HANDLE_PX}px minmax(0, 1fr)`,
        }}
      >
        {bin}
        <div
          className="bin-resize-handle"
          title="Drag to resize panel"
          aria-label="Drag to resize panel"
          onMouseDown={(e) => {
            e.preventDefault();
            binDragRef.current = { startX: e.clientX, startW: binPx };
            document.body.classList.add("resizing-bin");
          }}
        />
        <section className={`monitors-row ${clipMonitor ? "dual" : "solo"}`}>
          {clipMonitor}
          {projectMonitor}
        </section>
      </div>
      <div
        className="timeline-resize-handle"
        title="Drag to resize timeline"
        onMouseDown={(e) => {
          e.preventDefault();
          timelineDragRef.current = { startY: e.clientY, startH: timelinePx };
          document.body.classList.add("resizing-timeline");
        }}
      />
      <div className="editor-timeline">{timeline}</div>
    </div>
  );
}
