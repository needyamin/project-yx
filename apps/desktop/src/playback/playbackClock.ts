import { useSyncExternalStore } from "react";

/**
 * ONE authoritative playback clock.
 *
 * The HTML5 media element inside the Project Monitor is the physical clock;
 * App's rAF loop reads it and publishes the timeline time here. Everything
 * that DISPLAYS time (timeline playhead line, timecodes, scrub sliders,
 * monitor overlay layers) derives its position from this store — no
 * component keeps an independent playhead state.
 *
 * High-frequency separation: publishing during playback notifies React
 * subscribers at most every PLAYHEAD_UI_MS, so only tiny leaf components
 * (timecode, slider, playhead-driven styles) re-render — never the project
 * tree. Paused seeks publish immediately so timecodes are exact.
 */

export const PLAYHEAD_UI_MS = 50;

type Listener = (t: number) => void;

let currentTime = 0;
let notifiedTime = 0;
let notifyTimer = 0;
const listeners = new Set<Listener>();

function flush() {
  notifyTimer = 0;
  if (notifiedTime === currentTime) return;
  notifiedTime = currentTime;
  for (const l of listeners) l(notifiedTime);
}

export const playbackClock = {
  /** Authoritative playhead (seconds). Safe to read every frame. */
  get(): number {
    return currentTime;
  },
  /** Publish a new playhead time. `immediate` bypasses the throttle
   * (paused seeks / scrub release / clip-boundary jumps). */
  publish(t: number, immediate = false) {
    currentTime = t;
    if (immediate) {
      if (notifyTimer) {
        window.clearTimeout(notifyTimer);
        notifyTimer = 0;
      }
      flush();
      return;
    }
    if (!notifyTimer) {
      notifyTimer = window.setTimeout(flush, PLAYHEAD_UI_MS);
    }
  },
  /** Force pending throttled notifications out now (e.g. before a render
   * that must reflect the latest position). */
  flush() {
    if (notifyTimer) {
      window.clearTimeout(notifyTimer);
      flush();
    }
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/**
 * React binding for time-displaying leaves. Re-renders at the clock's
 * throttled notification rate (≈20Hz while playing) — the component using
 * this stays tiny; parents never re-render because of playback.
 */
export function usePlayheadTime(): number {
  return useSyncExternalStore(
    playbackClock.subscribe,
    () => notifiedTime,
    () => 0,
  );
}
