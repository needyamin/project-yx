/**
 * Magic Remove — global progress window.
 *
 * A small always-visible card (bottom-center of the app, above the timeline)
 * shown whenever a Magic Remove job runs, whether or not the tool panel is
 * open. Shows phase, animated progress bar, live percent, elapsed time and
 * a Cancel button — the user always sees that work is happening.
 *
 * Also renders failures (error mode) so nothing can ever fail silently.
 */
import { useEffect, useState } from "react";
import "./MagicProgressDialog.css";

type Props = {
  phase: string;
  percent: number;
  /** Job start epoch ms — drives the ticking elapsed timer. */
  startedAt: number;
  /** When set, the window shows the failure instead of progress. */
  error?: string | null;
  onCancel: () => void;
};

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `0:${String(s % 60).padStart(2, "0")}`;
}

export function MagicProgressDialog({ phase, percent, startedAt, error, onCancel }: Props) {
  const [now, setNow] = useState(Date.now());

  // Tick every second so the elapsed timer always shows life, even before
  // the first backend progress event arrives.
  useEffect(() => {
    if (error) return; // static error card — no ticking
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [error]);

  if (error) {
    return (
      <div className="magic-progress-window error" role="alert">
        <div className="mpw-icon error" aria-hidden>
          <span>⚠</span>
        </div>
        <div className="mpw-body">
          <div className="mpw-title">Magic Remove</div>
          <div className="mpw-error-text">{error}</div>
        </div>
        <button type="button" className="mpw-cancel" onClick={onCancel}>
          OK
        </button>
      </div>
    );
  }

  const tracking = phase === "tracking";
  const pct = Math.max(0, Math.min(1, percent));
  return (
    <div className="magic-progress-window" role="status" aria-live="polite">
      <div className="mpw-icon" aria-hidden>
        <span className="mpw-spin">✨</span>
      </div>
      <div className="mpw-body">
        <div className="mpw-title">
          {tracking ? "Magic Remove — tracking the mask" : "Magic Remove — rebuilding background"}
        </div>
        <div className="mpw-track">
          <div className="mpw-fill" style={{ width: `${Math.round(pct * 100)}%` }} />
        </div>
        <div className="mpw-meta">
          <span>
            {tracking
              ? "Following the selected area across frames…"
              : "Processing every frame of the clip…"}
          </span>
          <span className="mpw-nums">
            {Math.round(pct * 100)}% · {fmtElapsed(now - startedAt)}
          </span>
        </div>
      </div>
      <button type="button" className="mpw-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
