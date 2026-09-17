import type { Clip, Timeline } from "./types";

/**
 * Identity-preserving timeline updates.
 *
 * Rust is the source of truth: every edit command returns the WHOLE timeline
 * over IPC. Deserialization produces all-new objects, so without reconcile a
 * single-clip edit would change the identity of every clip in the project and
 * re-render every memoized ClipBlock — the main "more clips = more lag"
 * amplifier. reconcileTimeline walks the fresh payload and reuses the
 * previous object reference for every track / clip / filter whose content is
 * unchanged, so React memoization only re-renders what actually changed.
 *
 * normalizeTimeline is folded into the same pass: defaults are filled on the
 * NEW objects only; reused objects were already normalized by an earlier
 * pass. Cost is O(total clips) with small constants per edit.
 */

function normParams(p: unknown): Record<string, unknown> {
  return (p ?? {}) as Record<string, unknown>;
}

function paramsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const av = a ?? {};
  const bv = b ?? {};
  if (typeof av !== "object" || typeof bv !== "object") return av === bv;
  // Filter params are small JSON blobs; stringify is fast at edit frequency
  // and only runs when references differ (fresh IPC payloads always differ).
  return JSON.stringify(av) === JSON.stringify(bv);
}

function filtersEqual(
  a: Clip["filters"] | undefined,
  b: Clip["filters"] | undefined,
): boolean {
  const fa = a ?? [];
  const fb = b ?? [];
  if (fa.length !== fb.length) return false;
  for (let i = 0; i < fa.length; i++) {
    const x = fa[i];
    const y = fb[i];
    if (
      x.id !== y.id ||
      x.kind !== y.kind ||
      !!x.enabled !== !!y.enabled ||
      !paramsEqual(x.params, y.params)
    ) {
      return false;
    }
  }
  return true;
}

function clipEqual(a: Clip, b: Clip): boolean {
  return (
    a.id === b.id &&
    a.media_path === b.media_path &&
    (a.source_path ?? null) === (b.source_path ?? null) &&
    a.start === b.start &&
    a.in_point === b.in_point &&
    a.out_point === b.out_point &&
    a.role === b.role &&
    (a.linked_clip_id ?? null) === (b.linked_clip_id ?? null) &&
    (a.fade_in ?? 0) === (b.fade_in ?? 0) &&
    (a.fade_out ?? 0) === (b.fade_out ?? 0) &&
    !!a.reverse === !!b.reverse &&
    (a.speed ?? 1) === (b.speed ?? 1) &&
    filtersEqual(a.filters, b.filters)
  );
}

function normalizeClip(c: Clip): Clip {
  return {
    ...c,
    fade_in: c.fade_in ?? 0,
    fade_out: c.fade_out ?? 0,
    filters: (c.filters ?? []).map((f) => ({
      ...f,
      params: normParams(f.params),
    })),
  };
}

function normalizeTrack(tr: Timeline["tracks"][0]): Timeline["tracks"][0] {
  return {
    ...tr,
    hidden: tr.hidden ?? false,
    clips: tr.clips.map(normalizeClip),
  };
}

/** Fill defaults for payloads from older builds (top-level fields only). */
export function normalizeTimeline(t: Timeline): Timeline {
  return {
    ...t,
    edit_mode: t.edit_mode ?? "normal",
    markers: t.markers ?? [],
    zone_in: t.zone_in ?? null,
    zone_out: t.zone_out ?? null,
    tracks: t.tracks.map(normalizeTrack),
  };
}

function reconcileClip(prevClips: Map<string, Clip>, next: Clip): Clip {
  const prev = prevClips.get(next.id);
  const norm = normalizeClip(next);
  if (prev && clipEqual(prev, norm)) return prev;
  return norm;
}

/**
 * Merge a fresh backend timeline into the previous one, preserving object
 * identities for unchanged tracks / clips / filters. The returned object is
 * always a new top-level reference (safe for React state), but unchanged
 * subtrees keep their previous references.
 */
export function reconcileTimeline(prev: Timeline | null, next: Timeline): Timeline {
  const merged: Timeline = {
    ...next,
    edit_mode: next.edit_mode ?? "normal",
    markers: next.markers ?? [],
    zone_in: next.zone_in ?? null,
    zone_out: next.zone_out ?? null,
  };
  if (!prev) return normalizeTimeline(merged);
  const prevTracks = new Map(prev.tracks.map((t) => [t.id, t]));
  const tracks = merged.tracks.map((t) => {
    const prevT = prevTracks.get(t.id);
    if (!prevT) {
      return normalizeTrack(t);
    }
    const prevClipMap = new Map(prevT.clips.map((c) => [c.id, c]));
    const clips = t.clips.map((c) => reconcileClip(prevClipMap, c));
    if (
      (t.hidden ?? false) === prevT.hidden &&
      clips.length === prevT.clips.length &&
      clips.every((c, i) => c === prevT.clips[i])
    ) {
      return prevT;
    }
    return { ...t, hidden: t.hidden ?? false, clips };
  });
  // Only rebuild tracks array if something actually changed.
  if (
    tracks.length === prev.tracks.length &&
    tracks.every((t, i) => t === prev.tracks[i]) &&
    merged.edit_mode === prev.edit_mode &&
    merged.zone_in === prev.zone_in &&
    merged.zone_out === prev.zone_out &&
    markersEqual(merged.markers, prev.markers) &&
    merged.frame_rate === prev.frame_rate &&
    merged.width === prev.width &&
    merged.height === prev.height
  ) {
    // Content-identical payload (e.g. a redundant refresh): still return a
    // fresh top-level object so callers can setState unconditionally, but
    // with every subtree shared.
    return { ...merged, tracks: prev.tracks, markers: prev.markers };
  }
  return { ...merged, tracks };
}

function markersEqual(
  a: Timeline["markers"],
  b: Timeline["markers"],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].time !== b[i].time || a[i].label !== b[i].label) {
      return false;
    }
  }
  return true;
}
