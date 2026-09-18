import { invoke } from "@tauri-apps/api/core";
import type { Timeline } from "./types";

/**
 * Cross-component timeline response synchronization.
 *
 * Every Tauri command that returns the full Timeline runs on Tauri's thread
 * pool, so responses can complete out of order. Applying a stale response
 * wholesale regresses the timeline (clips visibly jump back to positions the
 * engine already moved past). Both App-level edits (undo/redo, filters,
 * load/new) and TimelinePanel edits (move/trim/razor) must share ONE
 * sequence counter so a superseded response is dropped regardless of which
 * component issued it.
 *
 * Module-level by design: App.tsx and TimelinePanel.tsx must see the same
 * counter; React context would re-create it, refs would split it.
 */

let seq = 0;
let lastEngineTl: Timeline | null = null;

/** Tag a new edit. Any response tagged before this call is stale. */
export function nextSeq(): number {
  return ++seq;
}

/** True while `tag` is still the newest edit (its response may be applied). */
export function isCurrent(tag: number): boolean {
  return tag === seq;
}

/** Invalidate every pending response — used when the project itself is
 * replaced (load_project / new_project): responses from the previous
 * project must never touch the new state. */
export function invalidatePending(): void {
  ++seq;
}

/** Record a timeline CONFIRMED by the engine (never an optimistic guess).
 * The rollback target when an invoke fails after an optimistic update. */
export function recordEngine(t: Timeline): void {
  lastEngineTl = t;
}

/** Last engine-confirmed timeline, or null before the first response. */
export function lastEngineTimeline(): Timeline | null {
  return lastEngineTl;
}

function isTimelineLike(v: unknown): v is Timeline {
  return (
    !!v &&
    typeof v === "object" &&
    Array.isArray((v as { tracks?: unknown }).tracks)
  );
}

export interface EngineEditOptions {
  /** Called when the invoke itself fails (never for stale responses). */
  onError?: (err: unknown) => void;
}

/**
 * Guarded timeline-mutating invoke for App-level edits.
 *
 * - Tags the request with nextSeq(); if a newer edit superseded this one
 *   while the response was in flight, the response is DROPPED (returns null)
 *   so thread-pool reordering can never regress the timeline.
 * - On success records the engine-confirmed timeline as the rollback target.
 * - On failure logs via console.error (errors must stay visible), calls
 *   onError for status UI, and returns null — callers must treat null as
 *   "state unchanged" and NOT apply any result.
 *
 * Returns null for both stale and failed invokes; the timeline is only ever
 * touched with a non-null, engine-confirmed, current response.
 */
export async function engineEdit<T = Timeline>(
  cmd: string,
  args?: Record<string, unknown>,
  opts?: EngineEditOptions,
): Promise<T | null> {
  const tag = nextSeq();
  let result: T;
  try {
    result = await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`engineEdit ${cmd} failed:`, err);
    opts?.onError?.(err);
    return null;
  }
  if (!isCurrent(tag)) return null;
  if (isTimelineLike(result)) recordEngine(result);
  return result;
}
