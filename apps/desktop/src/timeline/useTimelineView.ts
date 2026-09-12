import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MIN_PPS = 0.35;
const MAX_PPS = 480;
const DEFAULT_PPS = 64;

export function useTimelineView(durationSec: number) {
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PPS);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [snap, setSnap] = useState(true);
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  const userZoomedRef = useRef(false);
  const lastFitDuration = useRef(0);

  const contentWidth = useMemo(
    () => Math.max(640, durationSec * pxPerSec + 160),
    [durationSec, pxPerSec],
  );

  const hasUserZoomed = useCallback(() => userZoomedRef.current, []);

  const zoomIn = useCallback(() => {
    userZoomedRef.current = true;
    setPxPerSec((v) => Math.min(MAX_PPS, v * 1.25));
  }, []);

  const zoomOut = useCallback(() => {
    userZoomedRef.current = true;
    setPxPerSec((v) => Math.max(MIN_PPS, v / 1.25));
  }, []);

  const zoomFit = useCallback(
    (viewportWidth: number) => {
      // Match contentWidth padding (+160) so the full duration fits in view.
      const usable = Math.max(240, viewportWidth - 160);
      const safeDur = Math.max(1, durationSec);
      const next = usable / safeDur;
      setPxPerSec(Math.min(MAX_PPS, Math.max(MIN_PPS, next)));
      setScrollLeft(0);
      lastFitDuration.current = durationSec;
      userZoomedRef.current = false;
    },
    [durationSec],
  );

  /** Auto-fit when timeline becomes much longer (e.g. first long clip). */
  const maybeAutoFit = useCallback(
    (viewportWidth: number) => {
      if (userZoomedRef.current) return;
      if (durationSec <= 0) return;
      const grew =
        lastFitDuration.current === 0 ||
        durationSec > lastFitDuration.current * 1.15 ||
        durationSec * pxPerSec > viewportWidth * 1.05;
      if (grew) {
        zoomFit(viewportWidth);
      }
    },
    [durationSec, pxPerSec, zoomFit],
  );

  const timeToX = useCallback((t: number) => t * pxPerSec, [pxPerSec]);

  const xToTime = useCallback((x: number) => Math.max(0, x / pxPerSec), [pxPerSec]);

  const applySnap = useCallback(
    (t: number, anchors: number[]) => {
      if (!snap) {
        setSnapGuide(null);
        return t;
      }
      const threshold = Math.max(0.05, 10 / pxPerSec);
      let best = t;
      let bestDist = threshold;
      for (const a of anchors) {
        const d = Math.abs(a - t);
        if (d < bestDist) {
          bestDist = d;
          best = a;
        }
      }
      setSnapGuide(bestDist < threshold ? best : null);
      return best;
    },
    [snap, pxPerSec],
  );

  useEffect(() => {
    // Keep scrollLeft applied when fit resets it.
  }, [scrollLeft]);

  return {
    pxPerSec,
    setPxPerSec,
    scrollLeft,
    setScrollLeft,
    snap,
    setSnap,
    snapGuide,
    setSnapGuide,
    contentWidth,
    zoomIn,
    zoomOut,
    zoomFit,
    maybeAutoFit,
    hasUserZoomed,
    timeToX,
    xToTime,
    applySnap,
    minPxPerSec: MIN_PPS,
    maxPxPerSec: MAX_PPS,
  };
}

export type TimelineView = ReturnType<typeof useTimelineView>;
