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

/**
 * Upper bound on memoized entries. Keys are per (file, 0.25 s bucket), so one
 * hour of media produces ~14 400 of them — unbounded, the two collections grew
 * for the whole session and never shrank (steady memory growth on long
 * projects). Eviction is safe in both directions: the Rust side keeps the JPEG
 * in its own on-disk cache, so a dropped URL re-resolves to a cheap disk hit
 * rather than a re-encode, and a dropped failure mark merely allows a retry
 * later instead of permanently blacklisting the file.
 */
const MAX_ENTRIES = 4000;

function rememberUrl(key: string, value: string) {
  cache.set(key, value);
  if (cache.size > MAX_ENTRIES) {
    // Map preserves insertion order — the first key is the oldest.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function rememberFailure(key: string) {
  failed.add(key);
  if (failed.size > MAX_ENTRIES) {
    const oldest = failed.values().next().value;
    if (oldest !== undefined) failed.delete(oldest);
  }
}

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
      rememberUrl(key, src);
      onReady(src);
    } catch (e) {
      // Missing/corrupt media: stop retry storms, leave the clip clean.
      rememberFailure(key);
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
  rememberFailure(cacheKey(mediaPath, time));
}
