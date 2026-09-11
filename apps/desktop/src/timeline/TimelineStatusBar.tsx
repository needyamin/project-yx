import type { EditMode, PerformanceTier } from "./types";
import { formatTime } from "./types";

type Props = {
  playhead: number;
  editMode: EditMode;
  tier: PerformanceTier;
  snap: boolean;
  onSnap: (v: boolean) => void;
  status?: string;
};

export function TimelineStatusBar({
  playhead,
  editMode,
  tier,
  snap,
  onSnap,
  status,
}: Props) {
  return (
    <div className="tl-statusbar">
      <div className="tl-status-toggles">
        <button
          type="button"
          className={snap ? "active" : ""}
          title="Snap"
          onClick={() => onSnap(!snap)}
        >
          Snap
        </button>
      </div>
      <span className="tl-status-tc">{formatTime(playhead)}</span>
      <span className="tl-status-mode">{editMode}</span>
      <span className={`tl-status-tier tier-${tier}`}>{tier}</span>
      {status && <span className="tl-status-msg">{status}</span>}
    </div>
  );
}
