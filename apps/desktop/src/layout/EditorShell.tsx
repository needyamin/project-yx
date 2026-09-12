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
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const clampTimeline = useCallback((h: number) => {
    const max = Math.round(window.innerHeight * TIMELINE_MAX_VH);
    return Math.max(TIMELINE_MIN, Math.min(max, h));
  }, []);

  useEffect(() => {
    function onResize() {
      setTimelinePx((h) => clampTimeline(h));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampTimeline]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - e.clientY;
      setTimelinePx(clampTimeline(dragRef.current.startH + delta));
    }
    function onUp() {
      dragRef.current = null;
      document.body.classList.remove("resizing-timeline");
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [clampTimeline]);

  return (
    <div
      ref={shellRef}
      className="shell editor-shell"
      style={{
        gridTemplateRows: `36px minmax(0, 1fr) 5px ${timelinePx}px`,
      }}
    >
      {topbar}
      <div className="editor-mid">
        {bin}
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
          dragRef.current = { startY: e.clientY, startH: timelinePx };
          document.body.classList.add("resizing-timeline");
        }}
      />
      <div className="editor-timeline">{timeline}</div>
    </div>
  );
}
