import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nearestInSorted } from "./types";

const MIN_PPS = 0.35;
const MAX_PPS = 480;
const DEFAULT_PPS = 64;

/**
 * Timeline view model (zoom + snap).
 *
 * Perf contract:
 * - The returned object is referentially stable across renders unless zoom or
 *   snap actually changes, so memoized clips only re-render on real zooms.
 * - Scroll is NOT mirrored into React state — the scroller scrolls natively.
 * - The snap guide line is moved imperatively (no re-render while dragging).
 */
export function useTimelineView(durationSec: number) {
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PPS);
  const [snap, setSnap] = useState(true);
  const userZoomedRef = useRef(false);
  const lastFitDuration = useRef(0);
  const snapGuideElRef = useRef<HTMLElement | null>(null);

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
      lastFitDuration.current = durationSec;
      userZoomedRef.current = false;
    },
    [durationSec],
  );

  /**
   * Auto-fit when the timeline GROWS (new recording/import added): the whole
   * sequence comes into view automatically. This ignores manual zoom on
   * purpose — new material must always be visible; manual zoom still applies
   * for resize events (see the panel's resize fit).
   */
  const maybeAutoFit = useCallback(
    (viewportWidth: number) => {
      if (durationSec <= 0) return;
      const firstFit = lastFitDuration.current === 0;
      const grew = lastFitDuration.current > 0 && durationSec >= lastFitDuration.current + 1.0;
      if (firstFit || grew) {
        zoomFit(viewportWidth);
        return;
      }
      if (!userZoomedRef.current && durationSec * pxPerSec > viewportWidth * 1.05) {
        zoomFit(viewportWidth);
      }
    },
    [durationSec, pxPerSec, zoomFit],
  );

  const timeToX = useCallback((t: number) => t * pxPerSec, [pxPerSec]);

  const xToTime = useCallback((x: number) => Math.max(0, x / pxPerSec), [pxPerSec]);

  /** Imperative snap-guide line update — no React state, no re-render. */
  const showSnapGuide = useCallback((t: number | null) => {
    const el = snapGuideElRef.current;
    if (!el) return;
    if (t == null) {
      el.style.display = "none";
    } else {
      el.style.display = "block";
      el.style.left = `${t * pxPerSec}px`;
    }
  }, [pxPerSec]);

  const registerSnapGuideEl = useCallback((el: HTMLElement | null) => {
    snapGuideElRef.current = el;
  }, []);

  const applySnap = useCallback(
    (t: number, anchors: number[]) => {
      if (!snap || anchors.length === 0) {
        showSnapGuide(null);
        return t;
      }
      const threshold = Math.max(0.05, 10 / pxPerSec);
      // Binary search over the sorted anchor index — O(log n) per frame
      // instead of scanning every clip edge on every pointermove.
      const hit = nearestInSorted(anchors, t, threshold);
      showSnapGuide(hit);
      return hit ?? t;
    },
    [snap, pxPerSec, showSnapGuide],
  );

  // Snap guide element is re-created by React on remount; reset its visibility.
  useEffect(() => {
    showSnapGuide(null);
  }, [showSnapGuide]);

  const view = useMemo(
    () => ({
      pxPerSec,
      setPxPerSec,
      snap,
      setSnap,
      contentWidth,
      zoomIn,
      zoomOut,
      zoomFit,
      maybeAutoFit,
      hasUserZoomed,
      timeToX,
      xToTime,
      applySnap,
      showSnapGuide,
      registerSnapGuideEl,
      minPxPerSec: MIN_PPS,
      maxPxPerSec: MAX_PPS,
    }),
    [
      pxPerSec,
      snap,
      contentWidth,
      zoomIn,
      zoomOut,
      zoomFit,
      maybeAutoFit,
      hasUserZoomed,
      timeToX,
      xToTime,
      applySnap,
      showSnapGuide,
      registerSnapGuideEl,
    ],
  );

  return view;
}

export type TimelineView = ReturnType<typeof useTimelineView>;
