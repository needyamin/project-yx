/** Cached waveform peak extraction — decodes each media file ONCE. */

export type PeakData = {
  peaks: Float32Array;
  peakAbs: number;
  /** Clip-window PCM for Web Audio preview playback. */
  buffer: AudioBuffer | null;
};

/** Full-file decode cache: trimming a clip must NOT re-download/re-decode. */
const decodedCache = new Map<string, AudioBuffer>();
/** Per-window peak cache (peaks are cheap to recompute from a decoded buffer). */
const cache = new Map<string, PeakData>();

const BINS = 256;
const MAX_SAMPLES = 2_500_000;
const BINS_PER_CHUNK = 32;

/* ------------------------------------------------------------------ */
/* Multi-resolution per-file overview (timeline waveforms)             */
/* ------------------------------------------------------------------ */

/** Bins across the whole file. 4096 bins ≈ 14 bins/second for an hour of
 * media — drawing at any zoom samples this array, so zooming NEVER
 * regenerates peak data; only the decode (once per file) is expensive. */
export const OVERVIEW_BINS = 4096;
const OVERVIEW_CHUNK = 256;
export type PeakOverview = { peaks: Float32Array; duration: number };
const overviewCache = new Map<string, PeakOverview>();
const overviewFailed = new Set<string>();
/** in-flight overview builders, so concurrent clips share one build. */
const overviewPending = new Map<string, Promise<PeakOverview | null>>();

export function getCachedOverview(src: string): PeakOverview | null {
  return overviewCache.get(src) ?? null;
}

export function overviewFailedFor(src: string): boolean {
  return overviewFailed.has(src);
}

/**
 * Fallback deadline for `yieldToUi`. rAF is the right primitive (it keeps the
 * build frame-aligned and never competes with paint), but Chromium STARVES
 * `requestAnimationFrame` while the window is occluded or minimized — the same
 * starvation `dev/qa.ts` shims around. A build parked on a starved rAF never
 * settles, and because the job manager holds a concurrency slot until a job
 * settles, that would starve every other background job for as long as the
 * window stayed hidden. In the normal case rAF fires in ~16 ms and this
 * deadline never wins, so chunk pacing is unchanged.
 */
const YIELD_FALLBACK_MS = 250;

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let timer = 0;
    let frame = 0;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) window.clearTimeout(timer);
      if (frame) window.cancelAnimationFrame(frame);
      resolve();
    };
    timer = window.setTimeout(finish, YIELD_FALLBACK_MS);
    frame = requestAnimationFrame(finish);
  });
}

/**
 * Build (or join) the per-file peak overview. Decodes the file once
 * (shared with the Advanced Audio preview path), computes peaks in rAF
 * chunks so the UI never blocks, and caches the result for every clip.
 * `signal` aborts cooperatively (job manager).
 */
export function loadOverviewPeaks(
  src: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PeakOverview | null> {
  const cached = overviewCache.get(src);
  if (cached) return Promise.resolve(cached);
  const pending = overviewPending.get(src);
  if (pending) return pending;

  const build = async (): Promise<PeakOverview | null> => {
    try {
      let decoded = decodedCache.get(src);
      if (!decoded) {
        const res = await fetch(src, { signal: opts.signal });
        if (opts.signal?.aborted) return null;
        const buf = await res.arrayBuffer();
        if (opts.signal?.aborted) return null;
        await yieldToUi();
        const ctx = audioContext();
        decoded = await ctx.decodeAudioData(buf);
        if (opts.signal?.aborted) return null;
        decodedCache.set(src, decoded);
        // Keep the decode cache bounded (decoded PCM is large).
        if (decodedCache.size > 24) {
          const oldest = decodedCache.keys().next().value;
          if (oldest !== undefined && oldest !== src) {
            decodedCache.delete(oldest);
          }
        }
      }
      const ch = decoded.getChannelData(0);
      const bins = new Float32Array(OVERVIEW_BINS);
      const perBin = Math.max(1, Math.floor(ch.length / OVERVIEW_BINS));
      let maxAbs = 1e-6;
      for (let binStart = 0; binStart < OVERVIEW_BINS; binStart += OVERVIEW_CHUNK) {
        if (opts.signal?.aborted) return null;
        const binEnd = Math.min(OVERVIEW_BINS, binStart + OVERVIEW_CHUNK);
        for (let b = binStart; b < binEnd; b++) {
          let peak = 0;
          const start = b * perBin;
          const end = Math.min(ch.length, start + perBin);
          // Overview stride: sample at most ~16k points per bin.
          const stride = Math.max(1, Math.floor(perBin / 16000));
          for (let j = start; j < end; j += stride) {
            const v = Math.abs(ch[j]);
            if (v > peak) peak = v;
          }
          bins[b] = peak;
          if (peak > maxAbs) maxAbs = peak;
        }
        await yieldToUi();
      }
      // Normalize so quiet files still render visibly.
      if (maxAbs > 0 && maxAbs < 1) {
        const gain = Math.min(4, 0.92 / maxAbs);
        for (let b = 0; b < OVERVIEW_BINS; b++) {
          bins[b] = Math.min(1, bins[b] * gain);
        }
      }
      overviewCache.set(src, { peaks: bins, duration: decoded.duration });
      return { peaks: bins, duration: decoded.duration };
    } catch {
      // Unsupported container/codec for Web Audio — leave waveform blank
      // rather than retrying forever.
      overviewFailed.add(src);
      return null;
    } finally {
      overviewPending.delete(src);
    }
  };
  const p = build();
  overviewPending.set(src, p);
  return p;
}

let sharedCtx: AudioContext | null = null;
function audioContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new AudioContext();
  }
  return sharedCtx;
}


function cacheKey(mediaPath: string, inPoint: number, outPoint: number): string {
  return `${mediaPath}|${inPoint.toFixed(3)}|${outPoint.toFixed(3)}`;
}

function sliceClipBuffer(
  decoded: AudioBuffer,
  inPoint: number,
  outPoint: number,
): AudioBuffer {
  const sr = decoded.sampleRate;
  const start = Math.max(0, Math.min(decoded.length - 1, Math.floor(inPoint * sr)));
  const end = Math.max(
    start + 1,
    Math.min(decoded.length, Math.ceil(Math.min(outPoint, decoded.duration) * sr)),
  );
  const len = end - start;
  const sliced = new AudioBuffer({
    length: len,
    numberOfChannels: decoded.numberOfChannels,
    sampleRate: sr,
  });
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const src = decoded.getChannelData(c).subarray(start, end);
    sliced.copyToChannel(new Float32Array(src), c);
  }
  return sliced;
}

export function getCachedPeaks(
  mediaPath: string,
  inPoint = 0,
  outPoint = Number.POSITIVE_INFINITY,
): PeakData | null {
  return cache.get(cacheKey(mediaPath, inPoint, outPoint)) ?? null;
}

/**
 * Fetch + decode audio once per file, then extract peaks in rAF chunks for
 * [inPoint, outPoint]. Also caches a sliced AudioBuffer for preview playback.
 */
export async function loadWaveformPeaks(
  src: string,
  mediaPath: string,
  opts: {
    inPoint?: number;
    outPoint?: number;
    signal?: AbortSignal;
    onProgress?: (partial: PeakData, done: boolean) => void;
  } = {},
): Promise<PeakData | null> {
  const inPoint = Math.max(0, opts.inPoint ?? 0);
  const outPoint = Math.max(inPoint + 0.05, opts.outPoint ?? Number.POSITIVE_INFINITY);
  const key = cacheKey(mediaPath, inPoint, outPoint);

  const cached = cache.get(key);
  if (cached?.buffer) {
    opts.onProgress?.(cached, true);
    return cached;
  }

  const { signal } = opts;
  if (signal?.aborted) return null;

  // Decode once per media file (survives trim changes / reopens).
  let decoded = decodedCache.get(src);
  if (!decoded) {
    const res = await fetch(src, { signal });
    if (signal?.aborted) return null;
    const buf = await res.arrayBuffer();
    if (signal?.aborted) return null;

    await yieldToUi();
    if (signal?.aborted) return null;

    const ctx = audioContext();
    decoded = await ctx.decodeAudioData(buf);
    if (signal?.aborted) return null;
    decodedCache.set(src, decoded);
    // Keep the cache bounded (decoded PCM is large).
    if (decodedCache.size > 24) {
      const oldest = decodedCache.keys().next().value;
      if (oldest !== undefined) {
        decodedCache.delete(oldest);
        for (const k of [...cache.keys()]) {
          if (k.startsWith(oldest.split("|")[0] + "|")) cache.delete(k);
        }
      }
    }
  }

  const clipBuffer = sliceClipBuffer(decoded, inPoint, outPoint);
  const ch = clipBuffer.getChannelData(0);
  const stride = ch.length > MAX_SAMPLES ? Math.ceil(ch.length / MAX_SAMPLES) : 1;
  const effectiveLen = Math.floor(ch.length / stride);
  const block = Math.max(1, Math.floor(effectiveLen / BINS));
  const out = new Float32Array(BINS);
  let maxAbs = 1e-6;

  for (let binStart = 0; binStart < BINS; binStart += BINS_PER_CHUNK) {
    if (signal?.aborted) return null;
    const binEnd = Math.min(BINS, binStart + BINS_PER_CHUNK);
    for (let i = binStart; i < binEnd; i++) {
      let peak = 0;
      const start = i * block * stride;
      const end = Math.min(ch.length, (i + 1) * block * stride);
      for (let j = start; j < end; j += stride) {
        const v = Math.abs(ch[j]);
        if (v > peak) peak = v;
      }
      out[i] = peak;
      if (peak > maxAbs) maxAbs = peak;
    }
    opts.onProgress?.(
      { peaks: out.slice(0, binEnd), peakAbs: maxAbs, buffer: null },
      false,
    );
    await yieldToUi();
  }

  const result: PeakData = { peaks: out, peakAbs: maxAbs, buffer: clipBuffer };
  cache.set(key, result);
  opts.onProgress?.(result, true);
  return result;
}
