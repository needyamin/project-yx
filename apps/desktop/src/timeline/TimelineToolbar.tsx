import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EditMode, TimelineTool } from "./types";
import {
  IconMore,
  IconRazor,
  IconRedo,
  IconRipple,
  IconSelect,
  IconSlip,
  IconSpacer,
  IconSplit,
  IconUndo,
  IconZoomFit,
  IconZoomIn,
  IconZoomOut,
} from "./icons";

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
  /** Kdenlive: Remove Space in All Tracks (at playhead). */
  onRemoveSpaceAllTracks: () => void;
  /** Kdenlive: Remove All Spaces After Cursor (all tracks from playhead). */
  onRemoveAllSpacesAfterCursor: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
  onAddVideoTrack: () => void;
  onAddAudioTrack: () => void;
  pxPerSec?: number;
  /** Optional slot at the toolbar's right end (e.g. voiceover recorder). */
  voiceover?: ReactNode;
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
  onRemoveSpaceAllTracks,
  onRemoveAllSpacesAfterCursor,
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  onZoomFit,
  onAddVideoTrack,
  onAddAudioTrack,
  pxPerSec,
  voiceover,
}: Props) {
  // Lift / Extract and second-space command remain available from the top
  // menubar and lane context menus — intentionally not repeated here.
  void onLiftZone;
  void onExtractZone;
  void onRemoveAllSpacesAfterCursor;
  void onAddVideoTrack;
  void onAddAudioTrack;
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
          type="button"
          className={`tl-tool-btn ${tool === "select" ? "active" : ""}`}
          title="Selection tool (S)"
          onClick={() => onTool("select")}
        >
          <IconSelect />
          <span>Select</span>
        </button>
        <button
          type="button"
          className="tl-tool-btn"
          title="Split clip at playhead (Ctrl+B)"
          onClick={onSplitAtPlayhead}
        >
          <IconSplit />
          <span>Split</span>
        </button>
        <button
          type="button"
          className={`tl-tool-btn ${tool === "razor" ? "active" : ""}`}
          title="Cut / razor — click a clip to cut (X)"
          onClick={() => onTool("razor")}
        >
          <IconRazor />
          <span>Cut</span>
        </button>
        <button
          type="button"
          className={`tl-tool-btn ${tool === "spacer" ? "active" : ""}`}
          title="Spacer tool — drag to create or remove space (M)"
          onClick={() => onTool("spacer")}
        >
          <IconSpacer />
          <span>Spacer</span>
        </button>
        <button
          type="button"
          className={`tl-tool-btn ${tool === "slip" ? "active" : ""}`}
          title="Slip tool (Y)"
          onClick={() => onTool("slip")}
        >
          <IconSlip />
          <span>Slip</span>
        </button>
        <button
          type="button"
          className={`tl-tool-btn ${tool === "ripple" ? "active" : ""}`}
          title="Ripple tool (R)"
          onClick={() => onTool("ripple")}
        >
          <IconRipple />
          <span>Ripple</span>
        </button>
      </div>

      <div className="tl-tool-group tl-zoom-group">
        <button type="button" className="tl-icon-btn" title="Zoom out" onClick={onZoomOut}>
          <IconZoomOut />
        </button>
        <button
          type="button"
          className="tl-icon-btn"
          title="Fit entire timeline in view"
          onClick={onZoomFit}
        >
          <IconZoomFit />
        </button>
        <button type="button" className="tl-icon-btn" title="Zoom in" onClick={onZoomIn}>
          <IconZoomIn />
        </button>
        {pxPerSec != null && (
          <span className="tl-zoom-label" title="Pixels per second">
            {pxPerSec < 2 ? pxPerSec.toFixed(2) : pxPerSec.toFixed(0)}px/s
          </span>
        )}
      </div>

      {voiceover && <div className="tl-tool-group tl-voiceover-group">{voiceover}</div>}

      <div className="tl-tool-group tl-more-wrap" ref={moreRef}>
        <button
          type="button"
          className={`tl-tool-btn ${moreOpen ? "active" : ""}`}
          title="More tools"
          onClick={() => setMoreOpen((v) => !v)}
        >
          <IconMore />
          <span>More</span>
        </button>
        {moreOpen && (
          <div className="tl-more-menu" role="menu">
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
            <p className="tl-more-label">Markers &amp; zone</p>
            <button type="button" role="menuitem" onClick={() => run(onSetZoneIn)}>
              Set In (I)
            </button>
            <button type="button" role="menuitem" onClick={() => run(onSetZoneOut)}>
              Set Out (O)
            </button>
            <button type="button" role="menuitem" onClick={() => run(onAddMarker)}>
              Add Marker (M)
            </button>

            <div className="tl-more-sep" />
            <p className="tl-more-label">Quick actions</p>
            <button type="button" role="menuitem" onClick={() => run(onRemoveSpaceAllTracks)}>
              Remove Space in All Tracks
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!canLinkToggle}
              onClick={() => run(onToggleLink)}
            >
              {linked ? "Unlink A/V" : "Link A/V"}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!canLinkToggle}
              title={canLinkToggle ? undefined : "Select a clip first"}
              onClick={() => run(onRippleDelete)}
            >
              Ripple delete
            </button>
          </div>
        )}
      </div>

      <div className="tl-tool-group">
        <button type="button" className="tl-icon-btn" title="Undo (Ctrl+Z)" onClick={onUndo}>
          <IconUndo />
        </button>
        <button type="button" className="tl-icon-btn" title="Redo (Ctrl+Y)" onClick={onRedo}>
          <IconRedo />
        </button>
      </div>
    </div>
  );
}
