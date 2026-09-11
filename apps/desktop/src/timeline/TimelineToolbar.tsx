import { useEffect, useRef, useState } from "react";
import type { EditMode, TimelineTool } from "./types";

type Props = {
  tool: TimelineTool;
  onTool: (t: TimelineTool) => void;
  editMode: EditMode;
  onEditMode: (m: EditMode) => void;
  onSetZoneIn: () => void;
  onSetZoneOut: () => void;
  onLiftZone: () => void;
  onExtractZone: () => void;
  onAddMarker: () => void;
  canLinkToggle: boolean;
  linked: boolean;
  onToggleLink: () => void;
  onRippleDelete: () => void;
  onSplitAtPlayhead: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
  onAddVideoTrack: () => void;
  onAddAudioTrack: () => void;
  pxPerSec?: number;
};

export function TimelineToolbar({
  tool,
  onTool,
  editMode,
  onEditMode,
  onSetZoneIn,
  onSetZoneOut,
  onLiftZone,
  onExtractZone,
  onAddMarker,
  canLinkToggle,
  linked,
  onToggleLink,
  onRippleDelete,
  onSplitAtPlayhead,
  onZoomIn,
  onZoomOut,
  onZoomFit,
  onAddVideoTrack,
  onAddAudioTrack,
  pxPerSec,
}: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!moreOpen) return;
    function onDoc(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  function run(action: () => void) {
    action();
    setMoreOpen(false);
  }

  return (
    <div className="tl-toolbar">
      <div className="tl-tool-group">
        <button
          className={tool === "select" ? "active" : ""}
          title="Select / drag move (S)"
          onClick={() => onTool("select")}
        >
          Select
        </button>
        <button
          className={tool === "razor" ? "active" : ""}
          title="Razor cut (X)"
          onClick={() => onTool("razor")}
        >
          Razor
        </button>
        <button title="Split at playhead (Ctrl+B)" onClick={onSplitAtPlayhead}>
          Split
        </button>
      </div>

      <div className="tl-tool-group tl-zoom-group">
        <button title="Zoom out" onClick={onZoomOut}>
          −
        </button>
        <button className="fit-btn active" title="Fit entire timeline in view" onClick={onZoomFit}>
          Fit
        </button>
        <button title="Zoom in" onClick={onZoomIn}>
          +
        </button>
        {pxPerSec != null && (
          <span className="tl-zoom-label" title="Pixels per second">
            {pxPerSec < 2 ? pxPerSec.toFixed(2) : pxPerSec.toFixed(0)}px/s
          </span>
        )}
      </div>

      <div className="tl-tool-group tl-more-wrap" ref={moreRef}>
        <button
          className={moreOpen ? "active" : ""}
          title="More tools"
          onClick={() => setMoreOpen((v) => !v)}
        >
          More…
        </button>
        {moreOpen && (
          <div className="tl-more-menu" role="menu">
            <p className="tl-more-label">Tools</p>
            {(
              [
                ["spacer", "Spacer (M)"],
                ["slip", "Slip (Y)"],
                ["ripple", "Ripple (R)"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                className={tool === id ? "active" : ""}
                onClick={() => run(() => onTool(id))}
              >
                {label}
              </button>
            ))}

            <div className="tl-more-sep" />
            <p className="tl-more-label">Edit mode</p>
            {(
              [
                ["normal", "Normal"],
                ["insert", "Insert"],
                ["overwrite", "Overwrite"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                className={editMode === id ? "active" : ""}
                onClick={() => run(() => onEditMode(id))}
              >
                {label}
              </button>
            ))}

            <div className="tl-more-sep" />
            <p className="tl-more-label">Zone</p>
            <button type="button" role="menuitem" onClick={() => run(onSetZoneIn)}>
              Set In (I)
            </button>
            <button type="button" role="menuitem" onClick={() => run(onSetZoneOut)}>
              Set Out (O)
            </button>
            <button type="button" role="menuitem" onClick={() => run(onLiftZone)}>
              Lift
            </button>
            <button type="button" role="menuitem" onClick={() => run(onExtractZone)}>
              Extract
            </button>
            <button type="button" role="menuitem" onClick={() => run(onAddMarker)}>
              Marker
            </button>

            <div className="tl-more-sep" />
            <p className="tl-more-label">Edit</p>
            <button
              type="button"
              role="menuitem"
              disabled={!canLinkToggle}
              onClick={() => run(onToggleLink)}
            >
              {linked ? "Unlink A/V" : "Link A/V"}
            </button>
            <button type="button" role="menuitem" onClick={() => run(onRippleDelete)}>
              Ripple delete
            </button>
            <button type="button" role="menuitem" onClick={() => run(onAddVideoTrack)}>
              Add video track
            </button>
            <button type="button" role="menuitem" onClick={() => run(onAddAudioTrack)}>
              Add audio track
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
