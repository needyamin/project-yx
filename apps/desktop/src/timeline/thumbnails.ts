import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { jobs } from "../jobs/jobManager";

/**
 * Timeline thumbnail pipeline.
 *
 * Rust generates (and disk-caches) one small JPEG per (file, 0.25s time
 * bucket); this module memoizes the asset URLs, collapses concurrent
 * requests for the same frame, and routes fetches through the job manager
 * so visible clips win over background work and obsolete jobs cancel.
 */

const cache = new Map<string, string>();
const failed = new Set<string>();

const bucket = (time: number) => Math.max(0, Math.round(time * 4) / 4);

export function cacheKey(mediaPath: string, time: number): string {
  return `${mediaPath}|${bucket(time)}`;
}

export function getCachedThumbnail(mediaPath: string, time: number): string | null {
  return cache.get(cacheKey(mediaPath, time)) ?? null;
}

export function thumbnailFailed(mediaPath: string, time: number): boolean {
  return failed.has(cacheKey(mediaPath, time));
}

/**
 * Request a thumbnail; `onReady` fires synchronously from cache when
 * possible, otherwise once the backend has generated it. Returns a cancel
 * handle (safe to call multiple times).
 */
export function requestThumbnail(
  mediaPath: string,
  time: number,
  onReady: (src: string) => void,
): () => void {
  const key = cacheKey(mediaPath, time);
  const hit = cache.get(key);
  if (hit) {
    onReady(hit);
    return () => undefined;
  }
  if (failed.has(key)) return () => undefined;
  const handle = jobs.enqueue(`thumb:${key}`, 2, async (signal) => {
    // Bail out before invoking if we were cancelled while queued.
    if (signal.aborted) return;
    try {
      const path = await invoke<string>("get_media_thumbnail", {
        source: mediaPath,
        time: bucket(time),
      });
      if (signal.aborted) return;
      let src: string;
      try {
        src = convertFileSrc(path);
      } catch {
        return;
      }
      cache.set(key, src);
      onReady(src);
    } catch (e) {
      // Missing/corrupt media: stop retry storms, leave the clip clean.
      failed.add(key);
      throw e;
    }
  });
  void handle.promise.catch(() => undefined);
  let cancelled = false;
  return () => {
    if (cancelled) return;
    cancelled = true;
    jobs.cancel(`thumb:${key}`);
  };
}

export function markThumbnailFailed(mediaPath: string, time: number) {
  failed.add(cacheKey(mediaPath, time));
}
