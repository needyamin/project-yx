import type { Track } from "./types";
import { IconDelete, IconHide, IconLock, IconMute } from "./icons";

type Props = {
  track: Track;
  height: number;
  canDelete: boolean;
  onMute: () => void;
  onLock: () => void;
  onHide: () => void;
  onDelete: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
};

export function TrackHeader({
  track,
  height,
  canDelete,
  onMute,
  onLock,
  onHide,
  onDelete,
  onContextMenu,
}: Props) {
  return (
    <div
      className={`tl-header track-${track.kind} ${track.hidden ? "hidden-track" : ""}`}
      style={{ height }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(e);
      }}
    >
      <strong>{track.name}</strong>
      <div className="tl-header-actions">
        <button
          type="button"
          className={`tl-icon-btn xs ${track.muted ? "active danger" : ""}`}
          title={track.muted ? "Unmute" : "Mute"}
          onClick={onMute}
        >
          <IconMute size={12} />
        </button>
        <button
          type="button"
          className={`tl-icon-btn xs ${track.locked ? "active" : ""}`}
          title={track.locked ? "Unlock" : "Lock"}
          onClick={onLock}
        >
          <IconLock size={12} />
        </button>
        <button
          type="button"
          className={`tl-icon-btn xs ${track.hidden ? "active" : ""}`}
          title={track.hidden ? "Show track" : "Hide track"}
          onClick={onHide}
        >
          <IconHide size={12} />
        </button>
        <button
          type="button"
          className="tl-icon-btn xs danger"
          title={
            canDelete
              ? `Delete ${track.kind} track`
              : `Keep at least one ${track.kind} track`
          }
          disabled={!canDelete || track.locked}
          onClick={onDelete}
        >
          <IconDelete size={12} />
        </button>
      </div>
    </div>
  );
}
