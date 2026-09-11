import type { ReactNode } from "react";
import "./EditorShell.css";

type Props = {
  topbar: ReactNode;
  bin: ReactNode;
  clipMonitor: ReactNode | null;
  projectMonitor: ReactNode;
  effects: ReactNode;
  timeline: ReactNode;
};

export function EditorShell({
  topbar,
  bin,
  clipMonitor,
  projectMonitor,
  effects,
  timeline,
}: Props) {
  return (
    <div className="shell editor-shell">
      {topbar}
      <div className="editor-mid">
        {bin}
        <section className={`monitors-row ${clipMonitor ? "dual" : "single"}`}>
          {clipMonitor}
          {projectMonitor}
        </section>
        {effects}
      </div>
      <div className="editor-timeline">{timeline}</div>
    </div>
  );
}
