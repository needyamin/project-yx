import { memo, useEffect, useRef, useState } from "react";
import { jobs } from "../jobs/jobManager";
import {
  getCachedOverview,
  loadOverviewPeaks,
  overviewFailedFor,
} from "../audio/waveformPeaks";

type Props = {
  /** Asset URL of the media file (convertFileSrc output). */
  src: string;
  /** Clip source window (media-file seconds). */
  inPoint: number;
  outPoint: number;
  /** CSS width in px (canvas is DPR-scaled). */
  width: number;
  height: number;
  /** Priority 2 = visible media; the job manager defers it under scrub. */
  urgent?: boolean;
};

/**
 * Clip waveform, drawn from the per-file peak overview (see waveformPeaks).
 * The overview is decoded once per file in the background; drawing samples
 * it at display resolution, so zooming/trimming never regenerates data and
 * never blocks the UI thread. Blank (no retry storm) when the container
 * can't be decoded as audio.
 */
export const WaveformCanvas = memo(function WaveformCanvas({
  src,
  inPoint,
  outPoint,
  width,
  height,
  urgent = true,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(() => getCachedOverview(src) != null);

  useEffect(() => {
    if (getCachedOverview(src)) {
      setReady(true);
      return;
    }
    if (overviewFailedFor(src)) return;
    const handle = jobs.enqueue(`wave:${src}`, urgent ? 2 : 3, async (signal) => {
      await loadOverviewPeaks(src, { signal });
    });
    // Gate on the data actually being cached, not merely on the job settling:
    // a coalesced request joins another clip's in-flight build, and a
    // cancelled one settles without producing peaks. Flipping `ready` early
    // would run the draw effect once with no overview and then never again
    // (the effect's deps do not change afterwards), leaving the clip blank.
    void handle.promise.then(() => {
      if (getCachedOverview(src)) setReady(true);
    });
    return () => jobs.cancel(`wave:${src}`);
  }, [src, urgent]);

  // Redraw when geometry or data changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const overview = getCachedOverview(src);
    if (!canvas || !overview) return;
    const { peaks, duration: fileDuration } = overview;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const fileDur = Math.max(0.05, fileDuration);
    const span = Math.max(0.05, outPoint - inPoint);
    const mid = h / 2;
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    const stepPx = 2;
    for (let x = 0; x < w; x += stepPx) {
      const t = inPoint + (x / w) * span;
      if (t < 0 || t > fileDur) continue;
      const bin = Math.min(
        peaks.length - 1,
        Math.max(0, Math.floor((t / fileDur) * peaks.length)),
      );
      const peak = peaks[bin];
      if (peak <= 0.001) continue;
      const barH = Math.max(1, peak * (h * 0.9));
      ctx.fillRect(x, mid - barH / 2, stepPx - 0.4, barH);
    }
  }, [ready, src, inPoint, outPoint, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className="tl-waveform"
      style={{ width, height, display: "block", position: "absolute", left: 0, top: 0, pointerEvents: "none" }}
      aria-hidden
    />
  );
});
