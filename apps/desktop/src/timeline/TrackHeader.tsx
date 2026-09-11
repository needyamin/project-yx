import type { Track } from "./types";

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
          className={track.muted ? "active danger" : ""}
          title={track.muted ? "Unmute" : "Mute"}
          onClick={onMute}
        >
          M
        </button>
        <button
          className={`tl-header-extra ${track.locked ? "active" : ""}`}
          title={track.locked ? "Unlock" : "Lock"}
          onClick={onLock}
        >
          L
        </button>
        <button
          className={`tl-header-extra ${track.hidden ? "active" : ""}`}
          title={track.hidden ? "Show track" : "Hide track"}
          onClick={onHide}
        >
          H
        </button>
        <button
          className="danger tl-header-extra"
          title={
            canDelete
              ? `Delete ${track.kind} track`
              : `Keep at least one ${track.kind} track`
          }
          disabled={!canDelete || track.locked}
          onClick={onDelete}
        >
          ×
        </button>
      </div>
    </div>
  );
}
