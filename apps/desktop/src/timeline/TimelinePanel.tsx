import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { subscribeBinDrag } from "../bin/binDrag";
import { ClipBlock, type ClipEditAction } from "./ClipBlock";
import { VoiceoverButton } from "./VoiceoverButton";
import { ScreenRecorderButton } from "./ScreenRecorderButton";
import {
  TimelineContextMenu,
  type ContextMenuState,
} from "./TimelineContextMenu";
import { TimelineStatusBar } from "./TimelineStatusBar";
import { TimelineToolbar } from "./TimelineToolbar";
import { TrackHeader } from "./TrackHeader";
import {
  formatTime,
  formatRulerTime,
  fileName,
  findLinkPartner,
  clipTimelineDuration,
  isImagePath,
  nearestInSorted,
  timelineDuration,
  type Clip,
  type EditMode,
  type IndexedObstacle,
  type LibraryItem,
  type PerformanceTier,
  type Timeline,
  type TimelineMarker,
  type TimelineTool,
} from "./types";
import { isCurrent, lastEngineTimeline, nextSeq, recordEngine } from "./engineSync";
import { useTimelineView } from "./useTimelineView";
import "./timeline.css";

const HEADER_MIN = 72;
const HEADER_DEFAULT = 88;
/** Max width = default + 10% of default. */
const HEADER_MAX = Math.round(HEADER_DEFAULT * 1.1);
const HEADER_HANDLE_PX = 5;

type Props = {
  timeline: Timeline;
  selectedClipId: string | null;
  tool: TimelineTool;
  status: string;
  tier: PerformanceTier;
  /** Live playhead source of truth — read in callbacks, never re-renders.
   * Time displays subscribe to the playback clock instead of a prop. */
  playheadRef: RefObject<number>;
  onTool: (t: TimelineTool) => void;
  onTimeline: (t: Timeline) => void;
  onSelectClip: (id: string | null) => void;
  onSeek: (t: number, immediate?: boolean) => void;
  onStatus: (s: string) => void;
  onEditMode: (m: EditMode) => void;
  onSetZoneIn: () => void;
  onSetZoneOut: () => void;
  onLiftZone: () => void;
  onExtractZone: () => void;
  onAddMarker: () => void;
  onUndo: () => void;
  onRedo: () => void;
  /** Register clientX → timeline time converter for bin pointer drops. */
  onRegisterDropResolver?: (fn: ((clientX: number) => number) | null) => void;
  /** Register zoom / snap controls for the View menu. */
  onRegisterViewControls?: (
    api: {
      zoomFit: () => void;
      zoomIn: () => void;
      zoomOut: () => void;
      setSnap: (v: boolean) => void;
      snap: boolean;
    } | null,
  ) => void;
  /** Register the imperative playhead mover (called every animation frame). */
  onRegisterPlayhead?: (fn: ((t: number) => void) | null) => void;
  /** Place a file path (e.g. saved voiceover) at a timeline position. */
  onAddMediaPath?: (path: string, start: number, label: string) => void;
  library?: LibraryItem[];
  onAdvancedAudio?: (clipId: string, tab?: "overview" | "waveform" | "effects") => void;
  onAdvancedVideo?: (clipId: string) => void;
  /** Remove every clip from every track (one undo step; stops playback). */
  onClearTimeline?: () => void;
  /** Remove every clip from one track (one undo step; stops playback). */
  onClearTrack?: (trackId: string) => void;
};

export function TimelinePanel({
  timeline,
  selectedClipId,
  tool,
  status,
  tier,
  playheadRef,
  library = [],
  onTool,
  onTimeline,
  onSelectClip,
  onSeek,
  onStatus,
  onEditMode,
  onSetZoneIn,
  onSetZoneOut,
  onLiftZone,
  onExtractZone,
  onAddMarker,
  onUndo,
  onRedo,
  onRegisterDropResolver,
  onRegisterViewControls,
  onRegisterPlayhead,
  onAddMediaPath,
  onAdvancedAudio,
  onAdvancedVideo,
  onClearTimeline,
  onClearTrack,
}: Props) {
  const panelRef = useRef<HTMLElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  const headerDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [binDragOver, setBinDragOver] = useState(false);
  const [binDropPreview, setBinDropPreview] = useState<{
    item: LibraryItem;
    start: number;
    trackId: string;
  } | null>(null);
  const [headerPx, setHeaderPx] = useState(HEADER_DEFAULT);
  /** Live draft shared by linked A/V while one partner is moved or resized. */
  const [dragPreview, setDragPreview] = useState<{
    partnerClipId: string;
    draft: {
      start: number;
      in_point: number;
      out_point: number;
    };
  } | null>(null);
  /** Live voiceover recording: grows a red region at the playhead. */
  const [voiceRec, setVoiceRec] = useState<{ wallStart: number } | null>(null);
  const recWrapRef = useRef<HTMLDivElement | null>(null);
  const recBarRef = useRef<HTMLDivElement | null>(null);
  const recLabelRef = useRef<HTMLSpanElement | null>(null);
  const duration = timelineDuration(timeline, 10);
  const view = useTimelineView(duration);

  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const timelineRef = useRef(timeline);
  // Sync during render, not in an effect: edit handlers read this ref to
  // build optimistic updates, and an effect runs only after paint — a rapid
  // second edit within that window computed its optimistic base from a stale
  // timeline and visually reverted the first edit until the IPC responses
  // caught up.
  timelineRef.current = timeline;
  // Response sequencing + engine-rollback state live in engineSync.ts and
  // are SHARED with App.tsx: undo/redo, filter commits and load/new must
  // participate in the same newest-wins ordering as panel edits.

  /* ------------------------------------------------------------------ */
  /* Memoized per-clip drag data + sorted snap anchors                   */
  /* ------------------------------------------------------------------ */

  const libIndex = useMemo(() => {
    const m = new Map<string, LibraryItem>();
    for (const item of library) {
      m.set(item.path, item);
      m.set(fileName(item.path), item);
    }
    return m;
  }, [library]);

  /** Sorted, de-duplicated snap anchors: clip edges, markers, zone, 0.
   * Shared by every clip — each ClipBlock excludes its own edges once per
   * drag instead of the panel materializing per-clip copies. */
  const snapAnchors = useMemo(() => {
    const pts: number[] = [0];
    for (const track of timeline.tracks) {
      if (track.hidden) continue;
      for (const clip of track.clips) {
        pts.push(clip.start, clip.start + clipTimelineDuration(clip));
      }
    }
    for (const m of timeline.markers ?? []) pts.push(m.time);
    if (timeline.zone_in != null) pts.push(timeline.zone_in);
    if (timeline.zone_out != null) pts.push(timeline.zone_out);
    pts.sort((a, b) => a - b);
    return pts.filter((v, i) => i === 0 || v !== pts[i - 1]);
  }, [timeline]);

  const snapAnchorsRef = useRef<number[]>(snapAnchors);
  useEffect(() => {
    snapAnchorsRef.current = snapAnchors;
  }, [snapAnchors]);

  /** Per-clip drag data referencing SHARED per-track obstacle lists —
   * O(tracks + clips) to build. ClipBlock filters self/partner once per
   * drag; the old per-clip materialization was O(clips²) per edit. */
  type ClipInfo = {
    obstacles: {
      ownTrack: IndexedObstacle[];
      partner: IndexedObstacle[] | null;
    };
    maxMediaDuration: number;
  };
  const clipInfo = useMemo(() => {
    const map = new Map<string, ClipInfo>();
    const trackObs = new Map<string, IndexedObstacle[]>();
    const trackByClip = new Map<string, string>();
    for (const track of timeline.tracks) {
      trackObs.set(
        track.id,
        track.clips.map((c) => ({
          id: c.id,
          start: c.start,
          duration: clipTimelineDuration(c),
        })),
      );
      for (const c of track.clips) trackByClip.set(c.id, track.id);
    }
    for (const track of timeline.tracks) {
      const own = trackObs.get(track.id) ?? [];
      for (const clip of track.clips) {
        let partnerObstacles: IndexedObstacle[] | null = null;
        if (clip.linked_clip_id) {
          const pTrackId = trackByClip.get(clip.linked_clip_id);
          if (pTrackId && pTrackId !== track.id) {
            partnerObstacles = trackObs.get(pTrackId) ?? null;
          }
        }
        const libItem =
          libIndex.get(clip.media_path) ?? libIndex.get(fileName(clip.media_path));
        // Stills and GIFs loop at export, so their timeline length is not
        // capped by the probed (near-zero) image duration.
        const stillVisual = isImagePath(clip.media_path);
        map.set(clip.id, {
          obstacles: { ownTrack: own, partner: partnerObstacles },
          maxMediaDuration: stillVisual
            ? Infinity
            : (libItem?.duration ?? Infinity),
        });
      }
    }
    return map;
  }, [timeline, libIndex]);

  const selectedClip = useMemo(() => {
    for (const track of timeline.tracks) {
      const clip = track.clips.find((c) => c.id === selectedClipId);
      if (clip) return clip;
    }
    return null;
  }, [timeline, selectedClipId]);

  /* ------------------------------------------------------------------ */
  /* Imperative playhead — never re-renders while playing/scrubbing      */
  /* ------------------------------------------------------------------ */

  const playheadElsRef = useRef<Set<HTMLDivElement>>(new Set());
  const registerPlayheadEl = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    playheadElsRef.current.add(el);
    return () => {
      playheadElsRef.current.delete(el);
    };
  }, []);
  const movePlayhead = useCallback((t: number) => {
    const x = Math.max(0, t) * viewRef.current.pxPerSec;
    playheadElsRef.current.forEach((el) => {
      el.style.left = `${x}px`;
    });
  }, []);

  useEffect(() => {
    onRegisterPlayhead?.(movePlayhead);
    return () => onRegisterPlayhead?.(null);
  }, [onRegisterPlayhead, movePlayhead]);

  // Initial position + reposition after zoom (committed playhead; during
  // playback the clock loop corrects on the next frame anyway).
  useEffect(() => {
    movePlayhead(playheadRef.current);
    // Deliberately not keyed on the live playhead — the mover owns updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movePlayhead, view.pxPerSec]);

  /* ------------------------------------------------------------------ */
  /* Viewport culling                                                    */
  /* ------------------------------------------------------------------ */

  /** Scroller viewport in canvas px — clips fully outside it are not
   * rendered, keeping DOM size and reconciliation cost independent of
   * project length. rAF-coalesced; scroll stays native. */
  const [viewport, setViewport] = useState({ left: 0, width: 1600 });
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      setViewport((prev) =>
        prev.left === el.scrollLeft && prev.width === el.clientWidth
          ? prev
          : { left: el.scrollLeft, width: el.clientWidth },
      );
    };
    const requestUpdate = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    el.addEventListener("scroll", requestUpdate, { passive: true });
    const ro = new ResizeObserver(requestUpdate);
    ro.observe(el);
    update();
    return () => {
      el.removeEventListener("scroll", requestUpdate);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  /* ------------------------------------------------------------------ */
  /* Header resize                                                       */
  /* ------------------------------------------------------------------ */

  const clampHeader = useCallback((w: number) => {
    return Math.max(HEADER_MIN, Math.min(HEADER_MAX, w));
  }, []);

  useEffect(() => {
    function onResize() {
      setHeaderPx((w) => clampHeader(w));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampHeader]);

  useEffect(() => {
    let raf = 0;
    let latest = 0;
    function onMove(e: MouseEvent) {
      if (!headerDragRef.current) return;
      latest = e.clientX - headerDragRef.current.startX;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (headerDragRef.current) {
            setHeaderPx(clampHeader(headerDragRef.current.startW + latest));
          }
        });
      }
    }
    function onUp() {
      headerDragRef.current = null;
      document.body.classList.remove("resizing-tl-headers");
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [clampHeader]);

  /* ------------------------------------------------------------------ */
  /* Backend runs + optimistic edit dispatcher                           */
  /* ------------------------------------------------------------------ */

  const run = useCallback(
    async (cmd: string, args: Record<string, unknown>, okMsg?: string) => {
      const seq = nextSeq();
      try {
        const next = await invoke<Timeline>(cmd, args);
        if (!isCurrent(seq)) return next; // superseded by a newer edit
        recordEngine(next);
        onTimeline(next);
        if (okMsg) onStatus(okMsg);
        return next;
      } catch (e) {
        const msg = String(e);
        if (/no gap/i.test(msg)) onStatus("No gap at that position");
        else onStatus(msg);
        // The engine rejected the command — roll back any optimistic update
        // so the GUI never keeps showing a position the engine refused.
        const engineTl = lastEngineTimeline(); if (engineTl) onTimeline(engineTl);
        return null;
      }
    },
    [onTimeline, onStatus],
  );

  /** Optimistic timeline clone with the target clip(s) updated. */
  function optimisticUpdate(
    tl: Timeline,
    clipIds: string[],
    update: (c: Clip) => Clip,
  ): Timeline {
    const ids = new Set(clipIds);
    return {
      ...tl,
      tracks: tl.tracks.map((t) => {
        if (!t.clips.some((c) => ids.has(c.id))) return t;
        const updated = t.clips.map((c) => (ids.has(c.id) ? update(c) : c));
        updated.sort((a, b) => a.start - b.start);
        return { ...t, clips: updated };
      }),
    };
  }

  const editClip = useCallback(
    async (action: ClipEditAction) => {
      const tl = timelineRef.current;
      if (!tl) return;
      let clip: Clip | null = null;
      let srcTrackId: string | null = null;
      for (const t of tl.tracks) {
        const hit = t.clips.find((c) => c.id === action.clipId);
        if (hit) {
          clip = hit;
          srcTrackId = t.id;
          break;
        }
      }
      if (!clip) return;
      const linkedId = clip.linked_clip_id;
      const targetIds = linkedId ? [clip.id, linkedId] : [clip.id];

      switch (action.type) {
        case "move": {
          const seq = nextSeq();
          const targetTrackId = action.targetTrackId ?? null;
          const crossTrack = Boolean(targetTrackId && srcTrackId && targetTrackId !== srcTrackId);
          if (crossTrack) {
            // Optimistic: relocate the dragged clip; the backend response
            // (with linked-pair track mapping) replaces the state right after.
            onTimeline({
              ...tl,
              tracks: tl.tracks.map((t) => {
                if (t.id !== srcTrackId && t.id !== targetTrackId) return t;
                let clips = t.clips;
                if (t.id === srcTrackId) clips = clips.filter((c) => c.id !== clip.id);
                if (t.id === targetTrackId) clips = [...clips, { ...clip, start: action.newStart }];
                return { ...t, clips: [...clips].sort((a, b) => a.start - b.start) };
              }),
            });
          } else {
            // Same-track: optimistic update removes drop snap-back.
            onTimeline(
              optimisticUpdate(tl, targetIds, (c) => ({ ...c, start: action.newStart })),
            );
          }
          try {
            const next = await invoke<Timeline>("move_clip", {
              clipId: action.clipId,
              newStart: action.newStart,
              syncLinked: true,
              targetTrackId,
            });
            if (!isCurrent(seq)) return; // superseded by a newer edit
            recordEngine(next);
            onTimeline(next);
            onStatus(
              crossTrack
                ? `Moved to ${formatTime(action.newStart)} on new track`
                : `Moved to ${formatTime(action.newStart)}`,
            );
          } catch (e) {
            onStatus(String(e));
            // Roll back the optimistic update — the engine refused the move,
            // so the clip must not keep sitting at the dropped position.
            const engineTl = lastEngineTimeline(); if (engineTl) onTimeline(engineTl);
          } finally {
            setDragPreview(null);
          }
          return;
        }
        case "trim": {
          const { inPoint, outPoint, keepEnd } = action;
          const speed = clip.speed ?? 1;
          const newDur = (outPoint - inPoint) / speed;
          const applyOne = (c: Clip): Clip => {
            const oldDur = clipTimelineDuration(c);
            const newStart = keepEnd ? c.start + (oldDur - newDur) : c.start;
            return {
              ...c,
              start: Math.max(0, newStart),
              in_point: inPoint,
              out_point: outPoint,
            };
          };
          onTimeline(optimisticUpdate(tl, targetIds, applyOne));
          setDragPreview(null);
          void run("trim_clip", {
            clipId: action.clipId,
            inPoint,
            outPoint,
            keepEnd,
            syncLinked: true,
          });
          return;
        }
        case "razor":
          void run(
            "split_clip_at",
            { clipId: action.clipId, at: action.at, syncLinked: true },
            `Cut at ${formatTime(action.at)}`,
          );
          return;
        case "rippleTrim":
          void run(
            "ripple_trim",
            {
              clipId: action.clipId,
              edge: action.edge,
              newEdgeTime: action.newEdgeTime,
              syncLinked: true,
            },
            `Ripple ${action.edge}`,
          );
          return;
        case "slip":
          void run(
            "slip_clip",
            {
              clipId: action.clipId,
              delta: action.delta,
              syncLinked: true,
            },
            `Slip ${action.delta >= 0 ? "+" : ""}${action.delta.toFixed(2)}s`,
          );
          return;
        case "fades":
          void run(
            "set_clip_fades",
            {
              clipId: action.clipId,
              fadeIn: action.fadeIn,
              fadeOut: action.fadeOut,
            },
            `Fade ${action.fadeIn.toFixed(2)}s / ${action.fadeOut.toFixed(2)}s`,
          );
          return;
      }
    },
    [onTimeline, onStatus, run],
  );

  /* ------------------------------------------------------------------ */
  /* Fit / zoom                                                          */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    view.maybeAutoFit(el.clientWidth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration]);

  // Fit full timeline into view on open / panel resize (until user zooms).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let lastW = 0;

    const fitIfAllowed = () => {
      if (view.hasUserZoomed()) return;
      const w = el.clientWidth;
      if (w < 40) return;
      if (lastW > 0 && Math.abs(w - lastW) < 12) return;
      lastW = w;
      view.zoomFit(w);
      el.scrollLeft = 0;
    };

    fitIfAllowed();
    const ro = new ResizeObserver(() => fitIfAllowed());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, view.zoomFit, view.hasUserZoomed]);

  function doZoomFit() {
    const el = scrollerRef.current;
    view.zoomFit(el?.clientWidth ?? 800);
    if (el) el.scrollLeft = 0;
    onStatus(`Fit · ${duration.toFixed(1)}s in view`);
  }

  useEffect(() => {
    if (!onRegisterViewControls) return;
    onRegisterViewControls({
      zoomFit: doZoomFit,
      zoomIn: view.zoomIn,
      zoomOut: view.zoomOut,
      setSnap: view.setSnap,
      snap: view.snap,
    });
    return () => onRegisterViewControls(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRegisterViewControls, view.snap, view.pxPerSec, duration]);

  /* ------------------------------------------------------------------ */
  /* Time from pointer + scrubbing (rAF batched)                         */
  /* ------------------------------------------------------------------ */

  const activeRulerTicksRef: MutableRefObject<RulerTick[]> = useRef([]);

  const timeFromClientX = useCallback(
    (clientX: number): number => {
      const scroller = scrollerRef.current;
      if (!scroller) return 0;
      const rect = scroller.getBoundingClientRect();
      const x = clientX - rect.left + scroller.scrollLeft;
      const v = viewRef.current;
      const rawTime = Math.max(0, v.xToTime(x));

      // 1. Magnetic anchor snapping (clip boundaries, markers, zones) —
      // binary search over the sorted anchor index.
      if (v.snap) {
        const anchorThreshold = Math.max(0.04, 8 / v.pxPerSec);
        const hit = nearestInSorted(
          snapAnchorsRef.current,
          rawTime,
          anchorThreshold,
        );
        if (hit != null) {
          v.showSnapGuide(hit);
          return Number(hit.toFixed(4));
        }
      }

      v.showSnapGuide(null);

      // 2. Magnetic ruler division tick snapping (ticks are ascending).
      if (v.snap && activeRulerTicksRef.current.length > 0) {
        const tickThreshold = Math.max(0.02, 6 / v.pxPerSec);
        const ticks = activeRulerTicksRef.current;
        let lo = 0;
        let hi = ticks.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (ticks[mid].t < rawTime) lo = mid + 1;
          else hi = mid;
        }
        let bestTick = rawTime;
        let bestTickDist = tickThreshold;
        for (let idx = lo - 1; idx <= lo; idx++) {
          if (idx < 0 || idx >= ticks.length) continue;
          const d = Math.abs(ticks[idx].t - rawTime);
          if (d < bestTickDist) {
            bestTickDist = d;
            bestTick = ticks[idx].t;
          }
        }
        if (bestTickDist < tickThreshold) {
          return Number(bestTick.toFixed(4));
        }
      }

      // 3. Precision interval quantization (exact frame / hundredth / ms)
      const FPS = 30;
      const frameDur = 1 / FPS;
      let qStep = frameDur;
      if (v.pxPerSec >= 200) {
        qStep = 0.01; // 10ms / hundredths
      } else if (v.pxPerSec >= 40) {
        qStep = frameDur; // exact 30fps frames
      } else if (v.pxPerSec >= 15) {
        qStep = 0.1; // 100ms
      } else {
        qStep = 0.5; // half second
      }

      const quantized = Math.round(rawTime / qStep) * qStep;
      return Math.max(0, Number(quantized.toFixed(4)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const timeFromClientXRef = useRef(timeFromClientX);
  useEffect(() => {
    timeFromClientXRef.current = timeFromClientX;
  }, [timeFromClientX]);

  useEffect(() => {
    return subscribeBinDrag((session) => {
      if (!session?.active) {
        setBinDragOver(false);
        setBinDropPreview(null);
        return;
      }
      const el = document.elementFromPoint(session.clientX, session.clientY);
      const over =
        Boolean(el?.closest(".timeline-panel")) ||
        Boolean(el?.closest(".tl-scroller"));
      setBinDragOver(over);
      if (!over) {
        setBinDropPreview(null);
        return;
      }

      const item = session.item;
      const preferKind: "video" | "audio" = item.has_video ? "video" : "audio";
      const tl = timelineRef.current;
      const lane = el?.closest(".tl-lane") as HTMLElement | null;
      const hoverId = lane?.dataset.trackId ?? null;
      const hoverTrack = hoverId ? tl.tracks.find((t) => t.id === hoverId) : null;
      const track =
        hoverTrack && !hoverTrack.hidden
          ? hoverTrack
          : tl.tracks.find((t) => t.kind === preferKind && !t.hidden) ??
          tl.tracks.find((t) => !t.hidden) ??
          tl.tracks[0];
      if (!track) {
        setBinDropPreview(null);
        return;
      }
      const start = Math.max(0, timeFromClientXRef.current(session.clientX));
      setBinDropPreview({ item, start, trackId: track.id });
    });
  }, []);

  useEffect(() => {
    if (!onRegisterDropResolver) return;
    onRegisterDropResolver((clientX) =>
      Math.max(0, timeFromClientXRef.current(clientX)),
    );
    return () => onRegisterDropResolver(null);
  }, [onRegisterDropResolver]);

  const onLanePointer = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      if (tool === "spacer") return;
      const t = timeFromClientXRef.current(e.clientX);
      onSeek(t);
      viewRef.current.showSnapGuide(null);
    },
    [tool, onSeek],
  );

  /**style scrub: press and drag moves the playhead (rAF batched). */
  const beginScrub = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (tool === "spacer") return;
      if ((e.target as HTMLElement).closest(".tl-clip")) return;
      if (e.button !== 0) return;
      e.preventDefault();
      suppressClickRef.current = true;

      let raf = 0;
      let pendingX: number | null = null;
      let lastX = e.clientX;
      const seekAt = (clientX: number, immediate: boolean) => {
        lastX = clientX;
        onSeek(timeFromClientXRef.current(clientX), immediate);
      };
      seekAt(e.clientX, true);

      const onMoveWin = (ev: PointerEvent) => {
        pendingX = ev.clientX;
        if (!raf) {
          raf = requestAnimationFrame(() => {
            raf = 0;
            if (pendingX != null) {
              seekAt(pendingX, false);
              pendingX = null;
            }
          });
        }
      };
      const onUpWin = () => {
        window.removeEventListener("pointermove", onMoveWin);
        window.removeEventListener("pointerup", onUpWin);
        window.removeEventListener("pointercancel", onUpWin);
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        pendingX = null;
        seekAt(lastX, true);
        viewRef.current.showSnapGuide(null);
      };
      window.addEventListener("pointermove", onMoveWin);
      window.addEventListener("pointerup", onUpWin);
      window.addEventListener("pointercancel", onUpWin);
    },
    [tool, onSeek],
  );

  function beginSpacerDrag(e: React.PointerEvent<HTMLDivElement>, trackId: string | null) {
    if (tool !== "spacer") return;
    e.preventDefault();
    e.stopPropagation();
    const originX = e.clientX;
    const at = timeFromClientXRef.current(e.clientX);
    let latestDelta = 0;
    suppressClickRef.current = true;

    const onMoveWin = (ev: PointerEvent) => {
      latestDelta = (ev.clientX - originX) / viewRef.current.pxPerSec;
    };

    const onUpWin = () => {
      window.removeEventListener("pointermove", onMoveWin);
      window.removeEventListener("pointerup", onUpWin);
      window.removeEventListener("pointercancel", onUpWin);
      viewRef.current.showSnapGuide(null);
      if (Math.abs(latestDelta) > 0.001) {
        void run(
          "spacer_shift",
          {
            at,
            delta: latestDelta,
            trackId,
          },
          `Spacer ${latestDelta >= 0 ? "+" : ""}${latestDelta.toFixed(2)}s`,
        );
      }
    };

    window.addEventListener("pointermove", onMoveWin);
    window.addEventListener("pointerup", onUpWin);
    window.addEventListener("pointercancel", onUpWin);
  }

  /* ------------------------------------------------------------------ */
  /* Context menus (stable handlers; clip resolved via data attribute)   */
  /* ------------------------------------------------------------------ */

  const openContext = useCallback(
    (e: React.MouseEvent, target: ContextMenuState["target"]) => {
      e.preventDefault();
      e.stopPropagation();
      setCtxMenu({ x: e.clientX, y: e.clientY, target });
    },
    [],
  );

  const handleClipContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const clipId = (e.target as HTMLElement)
        .closest(".tl-clip")
        ?.getAttribute("data-clip-id");
      const tl = timelineRef.current;
      if (!clipId || !tl) return;
      let clip: Clip | null = null;
      let trackId = "";
      for (const t of tl.tracks) {
        const hit = t.clips.find((c) => c.id === clipId);
        if (hit) {
          clip = hit;
          trackId = t.id;
          break;
        }
      }
      if (!clip) return;
      const at = timeFromClientXRef.current(e.clientX);
      const end = clip.start + clipTimelineDuration(clip);
      openContext(e, {
        kind: "clip",
        clipId: clip.id,
        trackId,
        linked: Boolean(clip.linked_clip_id),
        role: clip.role,
        at: Math.min(Math.max(at, clip.start + 0.05), end - 0.05),
        clipStart: clip.start,
        clipEnd: end,
      });
    },
    [openContext],
  );

  const handleRulerContext = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      openContext(e, { kind: "ruler", at: timeFromClientXRef.current(e.clientX) });
    },
    [openContext],
  );

  const handleLaneContext = useCallback(
    (trackId: string, trackKind: "video" | "audio") =>
      (e: React.MouseEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest(".tl-clip")) return;
        openContext(e, {
          kind: "lane",
          trackId,
          trackKind,
          at: timeFromClientXRef.current(e.clientX),
        });
      },
    [openContext],
  );

  const handleTrackContext = useCallback(
    (
      track: { id: string; kind: "video" | "audio"; muted: boolean; locked: boolean; hidden?: boolean },
      canDelete: boolean,
    ) =>
      (e: React.MouseEvent) => {
        openContext(e, {
          kind: "track",
          trackId: track.id,
          trackKind: track.kind,
          muted: track.muted,
          locked: track.locked,
          hidden: Boolean(track.hidden),
          canDelete,
        });
      },
    [openContext],
  );

  async function setZoneAt(which: "in" | "out", time: number) {
    onSeek(time);
    if (which === "in") {
      await run(
        "set_zone",
        { zoneIn: time, zoneOut: timeline.zone_out },
        `Zone in ${formatTime(time)}`,
      );
    } else {
      await run(
        "set_zone",
        { zoneIn: timeline.zone_in, zoneOut: time },
        `Zone out ${formatTime(time)}`,
      );
    }
  }

  function trackHeight(track: (typeof timeline.tracks)[0]) {
    if (track.hidden) return 22;
    return track.kind === "video" ? 64 : 48;
  }

  /** Rows render top→bottom as FRONT→BACK (NLE convention): the highest
   * video track is the topmost row and composites in front; audio tracks sit
   * below. The engine stacks array order bottom→top, so this keeps "visually
   * higher = renders in front" true everywhere. */
  const displayTracks = useMemo(() => {
    const video = timeline.tracks.filter((t) => t.kind === "video").reverse();
    const audio = timeline.tracks.filter((t) => t.kind === "audio");
    return [...video, ...audio];
  }, [timeline.tracks]);

  const zoneLeft =
    timeline.zone_in != null && timeline.zone_out != null
      ? Math.min(timeline.zone_in, timeline.zone_out)
      : timeline.zone_in;
  const zoneRight =
    timeline.zone_in != null && timeline.zone_out != null
      ? Math.max(timeline.zone_in, timeline.zone_out)
      : timeline.zone_out;

  const totalRulerDuration = duration + 120;

  /** Clips intersecting [visibleFromT, visibleToT] render; others are culled.
   * The selected clip is always rendered (it may be mid-drag near an edge). */
  const CULL_MARGIN_PX = 480;
  const visibleFromT = (viewport.left - CULL_MARGIN_PX) / view.pxPerSec;
  const visibleToT = (viewport.left + viewport.width + CULL_MARGIN_PX) / view.pxPerSec;

  /* Live voiceover recording region on the first audio lane. */
  useEffect(() => {
    if (!voiceRec) return;
    const canvas = scrollerRef.current?.querySelector(".tl-canvas") ?? null;
    const lane = scrollerRef.current?.querySelector(
      ".tl-lane.track-audio:not(.collapsed)",
    ) as HTMLElement | null;
    const wrap = recWrapRef.current;
    if (wrap) {
      if (canvas) {
        canvas.classList.add("recording-active");
      }
      wrap.style.top = `${lane?.offsetTop ?? 0}px`;
      wrap.style.height = `${lane?.offsetHeight ?? 48}px`;
    }
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const pps = viewRef.current.pxPerSec;
      const elapsed = (performance.now() - voiceRec.wallStart) / 1000;
      const x = playheadRef.current * pps;
      const bar = recBarRef.current;
      if (bar) {
        bar.style.left = `${x}px`;
        bar.style.width = `${Math.max(2, elapsed * pps)}px`;
      }
      const label = recLabelRef.current;
      if (label) {
        label.style.left = `${x + 4}px`;
        label.textContent = `REC ${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`;
      }
      const sc = scrollerRef.current;
      if (sc && x > sc.scrollLeft + sc.clientWidth - 80) {
        sc.scrollLeft = x - sc.clientWidth + 160;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      canvas?.classList.remove("recording-active");
    };
  }, [voiceRec]);

  /* Linked-partner live preview: only the partner clip re-renders. */
  const handleLiveDrag = useCallback(
    (phase: "start" | "move" | "end", clipId: string, draft: {
      start: number;
      in_point: number;
      out_point: number;
    }) => {
      if (phase === "end") {
        // ALWAYS clear the preview on gesture end — including no-op drags
        // and simple clicks (pointerdown already set an "origin" preview).
        // A leftover previewDraft pins the partner to its OLD position, so
        // engine-driven moves (ripple, close gap, undo) never showed up on
        // the partner until the next pointer interaction.
        setDragPreview(null);
        return;
      }
      const tl = timelineRef.current;
      if (!tl) return;
      let linkedId: string | null = null;
      for (const t of tl.tracks) {
        const hit = t.clips.find((c) => c.id === clipId);
        if (hit) {
          linkedId = hit.linked_clip_id;
          break;
        }
      }
      if (!linkedId) return;
      setDragPreview({ partnerClipId: linkedId, draft });
    },
    [],
  );

  const handleDragActive = useCallback((active: boolean) => {
    if (active) suppressClickRef.current = true;
  }, []);

  const markers = useMemo(() => timeline.markers ?? [], [timeline.markers]);

  return (
    <section
      ref={panelRef}
      className={`timeline-panel ${binDragOver ? "bin-drag-over" : ""}`}
    >
      <TimelineToolbar
        tool={tool}
        onTool={onTool}
        editMode={timeline.edit_mode ?? "normal"}
        onEditMode={onEditMode}
        onSetZoneIn={onSetZoneIn}
        onSetZoneOut={onSetZoneOut}
        onLiftZone={onLiftZone}
        onExtractZone={onExtractZone}
        onAddMarker={onAddMarker}
        canLinkToggle={Boolean(selectedClip)}
        linked={Boolean(selectedClip?.linked_clip_id)}
        onToggleLink={() => {
          if (!selectedClip) return;
          if (selectedClip.linked_clip_id) {
            void run("unlink_clip", { clipId: selectedClip.id }, "Unlinked");
            return;
          }
          const partner = findLinkPartner(timeline, selectedClip, playheadRef.current);
          if (!partner) {
            onStatus("No audio/video partner found to link");
            return;
          }
          void run(
            "link_clips",
            { clipA: selectedClip.id, clipB: partner.id },
            "Linked A/V",
          );
        }}
        onRippleDelete={() => {
          if (!selectedClipId) return;
          void run(
            "ripple_delete",
            { clipId: selectedClipId, removeLinked: true },
            "Ripple delete",
          );
          onSelectClip(null);
        }}
        onSplitAtPlayhead={() => {
          const ph = playheadRef.current;
          const clip =
            selectedClip &&
              ph > selectedClip.start &&
              ph < selectedClip.start + clipTimelineDuration(selectedClip)
              ? selectedClip
              : timeline.tracks
                .flatMap((t) => t.clips.map((c) => ({ track: t, clip: c })))
                .find(({ track, clip: c }) => {
                  if (track.locked) return false;
                  const end = c.start + clipTimelineDuration(c);
                  return ph > c.start && ph < end;
                })?.clip;
          if (!clip) {
            onStatus("Playhead must be inside a clip");
            return;
          }
          void run(
            "split_clip_at",
            { clipId: clip.id, at: ph, syncLinked: true },
            `Split at ${formatTime(ph)}`,
          );
        }}
        onRemoveSpaceAllTracks={() => {
          void run(
            "close_gap",
            { at: playheadRef.current, trackId: null },
            "Remove Space in All Tracks",
          );
        }}
        onRemoveAllSpacesAfterCursor={() => {
          void run(
            "remove_gaps",
            { from: playheadRef.current, trackId: null },
            "Remove All Spaces After Cursor",
          );
        }}
        onUndo={onUndo}
        onRedo={onRedo}
        onZoomIn={() => {
          view.zoomIn();
          onStatus(`Zoom ${view.pxPerSec.toFixed(1)} px/s`);
        }}
        onZoomOut={() => {
          view.zoomOut();
          onStatus(`Zoom ${Math.max(view.minPxPerSec, view.pxPerSec / 1.25).toFixed(1)} px/s`);
        }}
        onZoomFit={doZoomFit}
        onAddVideoTrack={() => void run("add_track", { kind: "video" }, "Video track added")}
        onAddAudioTrack={() => void run("add_track", { kind: "audio" }, "Audio track added")}
        pxPerSec={view.pxPerSec}
        voiceover={
          <>
            <VoiceoverButton
              onStatus={onStatus}
              onRecordingChange={(rec) =>
                setVoiceRec(rec ? { wallStart: performance.now() } : null)
              }
              onSaved={(path) => {
                onAddMediaPath?.(
                  path,
                  playheadRef.current,
                  `Voiceover added at ${formatTime(playheadRef.current)}`,
                );
                // Bring the fresh clip into view.
                const sc = scrollerRef.current;
                if (sc) {
                  const x = playheadRef.current * viewRef.current.pxPerSec;
                  if (x < sc.scrollLeft + 80 || x > sc.scrollLeft + sc.clientWidth - 160) {
                    sc.scrollTo({ left: Math.max(0, x - sc.clientWidth * 0.4), behavior: "smooth" });
                  }
                }
              }}
            />
            <ScreenRecorderButton
              onStatus={onStatus}
              onSaved={(path) => {
                onAddMediaPath?.(
                  path,
                  playheadRef.current,
                  `Screen recording added at ${formatTime(playheadRef.current)}`,
                );
                const sc = scrollerRef.current;
                if (sc) {
                  const x = playheadRef.current * viewRef.current.pxPerSec;
                  if (x < sc.scrollLeft + 80 || x > sc.scrollLeft + sc.clientWidth - 160) {
                    sc.scrollTo({ left: Math.max(0, x - sc.clientWidth * 0.4), behavior: "smooth" });
                  }
                }
              }}
            />
          </>
        }
      />

      <div
        className="tl-body"
        style={{
          gridTemplateColumns: `${headerPx}px ${HEADER_HANDLE_PX}px minmax(0, 1fr)`,
        }}
      >
        <div className="tl-headers">
          <div className="tl-corner" />
          {displayTracks.map((track) => {
            const sameKind = timeline.tracks.filter((t) => t.kind === track.kind).length;
            return (
              <TrackHeaderMemo
                key={track.id}
                track={track}
                height={trackHeight(track)}
                canDelete={sameKind > 1}
                onMute={() =>
                  void run("set_track_mute", {
                    trackId: track.id,
                    muted: !track.muted,
                  })
                }
                onLock={() =>
                  void run("set_track_lock", {
                    trackId: track.id,
                    locked: !track.locked,
                  })
                }
                onHide={() =>
                  void run(
                    "set_track_hidden",
                    {
                      trackId: track.id,
                      hidden: !track.hidden,
                    },
                    track.hidden ? `Show ${track.name}` : `Hide ${track.name}`,
                  )
                }
                onDelete={() => {
                  if (
                    !window.confirm(
                      `Delete track ${track.name}? Clips on this track will be removed.`,
                    )
                  ) {
                    return;
                  }
                  void run("remove_track", { trackId: track.id }, `Deleted ${track.name}`);
                }}
                onContextMenu={handleTrackContext(track, sameKind > 1 && !track.locked)}
              />
            );
          })}
        </div>

        <div
          className="tl-header-resize-handle"
          title="Drag to resize track headers"
          aria-label="Drag to resize track headers"
          onMouseDown={(e) => {
            e.preventDefault();
            headerDragRef.current = { startX: e.clientX, startW: headerPx };
            document.body.classList.add("resizing-tl-headers");
          }}
        />

        <div
          className={`tl-scroller ${binDragOver ? "bin-drag-over" : ""}`}
          ref={scrollerRef}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              if (e.deltaY < 0) view.zoomIn();
              else view.zoomOut();
            }
          }}
        >
          <div className="tl-canvas" style={{ width: view.contentWidth }}>
            <Ruler
              pxPerSec={view.pxPerSec}
              totalDuration={totalRulerDuration}
              zoneLeft={zoneLeft}
              zoneRight={zoneRight}
              markers={markers}
              scrollerRef={scrollerRef}
              ticksOutRef={activeRulerTicksRef}
              timeFromClientXRef={timeFromClientXRef}
              onScrubStart={beginScrub}
              onSeekClick={onLanePointer}
              onContextMenu={handleRulerContext}
              registerPlayheadEl={registerPlayheadEl}
              registerSnapGuideEl={view.registerSnapGuideEl}
            />

            {voiceRec && (
              <div ref={recWrapRef} className="tl-rec-overlay" aria-hidden>
                <div ref={recBarRef} className="tl-rec-bar" />
                <span ref={recLabelRef} className="tl-rec-label">
                  REC 0:00
                </span>
              </div>
            )}

            {displayTracks.map((track) => {
              const h = trackHeight(track);
              if (track.hidden) {
                return (
                  <div
                    key={track.id}
                    className={`tl-lane track-${track.kind} collapsed`}
                    data-track-id={track.id}
                    style={{ height: h }}
                    onClick={onLanePointer}
                    onPointerDown={beginScrub}
                  />
                );
              }
              return (
                <div
                  key={track.id}
                  className={`tl-lane track-${track.kind} ${track.muted ? "muted" : ""} ${track.locked ? "locked" : ""} ${tool === "spacer" ? "spacer-tool" : ""}`}
                  data-track-id={track.id}
                  style={{ height: h }}
                  onClick={onLanePointer}
                  onPointerDown={(e) => {
                    if (tool === "spacer" && !(e.target as HTMLElement).closest(".tl-clip")) {
                      beginSpacerDrag(e, track.id);
                      return;
                    }
                    beginScrub(e);
                  }}
                  onContextMenu={handleLaneContext(track.id, track.kind)}
                >
                  {binDropPreview?.trackId === track.id && (
                    <div
                      className={`tl-bin-drop-preview role-${binDropPreview.item.has_video ? "video" : "audio"}`}
                      style={{
                        left: view.timeToX(binDropPreview.start),
                        width: Math.max(
                          12,
                          view.timeToX(Math.max(0.05, binDropPreview.item.duration)),
                        ),
                      }}
                      aria-hidden
                    >
                      <div className="tl-clip-body">
                        <span className="tl-clip-name">{binDropPreview.item.name}</span>
                        <small>{formatTime(binDropPreview.item.duration)}</small>
                      </div>
                    </div>
                  )}
                  {track.clips.map((clip: Clip) => {
                    const info = clipInfo.get(clip.id);
                    const cEnd = clip.start + clipTimelineDuration(clip);
                    if (
                      selectedClipId !== clip.id &&
                      (cEnd < visibleFromT || clip.start > visibleToT)
                    ) {
                      return null;
                    }
                    return (
                      <ClipBlock
                        key={clip.id}
                        clip={clip}
                        selected={selectedClipId === clip.id}
                        tool={tool}
                        view={view}
                        locked={track.locked}
                        obstacles={info?.obstacles}
                        anchors={snapAnchors}
                        editMode={timeline.edit_mode ?? "normal"}
                        maxMediaDuration={info?.maxMediaDuration ?? Infinity}
                        onSelect={onSelectClip}
                        onEdit={editClip}
                        onContextMenu={handleClipContextMenu}
                        previewDraft={
                          dragPreview?.partnerClipId === clip.id
                            ? dragPreview.draft
                            : null
                        }
                        onDragActive={handleDragActive}
                        onLiveDrag={handleLiveDrag}
                      />
                    );
                  })}
                  <div className="tl-playhead" ref={registerPlayheadEl} />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <TimelineStatusBarMemo
        editMode={timeline.edit_mode ?? "normal"}
        tier={tier}
        snap={view.snap}
        onSnap={view.setSnap}
        status={status}
      />

      {ctxMenu && (
        <TimelineContextMenu
          menu={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onSplitAt={(clipId, at) => {
            onSelectClip(clipId);
            void run(
              "split_clip_at",
              { clipId, at, syncLinked: true },
              `Cut at ${formatTime(at)}`,
            );
          }}
          onSplitPlayhead={() => {
            if (!selectedClipId && ctxMenu.target.kind === "clip") {
              onSelectClip(ctxMenu.target.clipId);
            }
            const clipId =
              ctxMenu.target.kind === "clip" ? ctxMenu.target.clipId : selectedClipId;
            if (!clipId) return;
            const clip =
              ctxMenu.target.kind === "clip"
                ? timeline.tracks
                  .flatMap((tr) => tr.clips)
                  .find((c) => c.id === clipId)
                : selectedClip;
            if (!clip) return;
            const end = clip.start + clipTimelineDuration(clip);
            if (playheadRef.current <= clip.start || playheadRef.current >= end) {
              onStatus("Playhead must be inside the clip");
              return;
            }
            void run(
              "split_clip_at",
              { clipId, at: playheadRef.current, syncLinked: true },
              `Split at ${formatTime(playheadRef.current)}`,
            );
          }}
          onDelete={(clipId) => {
            onSelectClip(clipId);
            void run(
              "remove_clip",
              { clipId, removeLinked: true },
              "Clip deleted",
            );
            onSelectClip(null);
          }}
          onRippleDelete={(clipId) => {
            void run(
              "ripple_delete",
              { clipId, removeLinked: true },
              "Ripple delete",
            );
            onSelectClip(null);
          }}
          onToggleLink={(clipId) => {
            onSelectClip(clipId);
            const clip = timeline.tracks
              .flatMap((tr) => tr.clips)
              .find((c) => c.id === clipId);
            if (!clip) return;
            if (clip.linked_clip_id) {
              void run("unlink_clip", { clipId }, "Unlinked");
              return;
            }
            const partner = findLinkPartner(timeline, clip, playheadRef.current);
            if (!partner) {
              onStatus("No audio/video partner found to link");
              return;
            }
            void run(
              "link_clips",
              { clipA: clip.id, clipB: partner.id },
              "Linked A/V",
            );
          }}
          onCloseGapAt={(at, trackId) => {
            void run(
              "close_gap",
              { at, trackId },
              trackId ? "Remove Space" : "Remove Space in All Tracks",
            );
          }}
          onFillGapsFrom={(from, trackId) => {
            void run(
              "remove_gaps",
              { from, trackId },
              "Remove All Spaces After Cursor",
            );
          }}
          onInsertSpaceAt={(at, trackId) => {
            void run(
              "spacer_shift",
              { at, delta: 1, trackId },
              "Insert Space (+1.0s)",
            );
          }}
          onSeek={onSeek}
          onSetZoneIn={() => {
            if (ctxMenu.target.kind === "ruler") void setZoneAt("in", ctxMenu.target.at);
          }}
          onSetZoneOut={() => {
            if (ctxMenu.target.kind === "ruler") void setZoneAt("out", ctxMenu.target.at);
          }}
          onAddMarker={() => {
            const at =
              ctxMenu.target.kind === "ruler" || ctxMenu.target.kind === "lane"
                ? ctxMenu.target.at
                : playheadRef.current;
            onSeek(at);
            void run(
              "add_marker",
              {
                time: at,
                label: `M${(timeline.markers?.length ?? 0) + 1}`,
              },
              `Marker @ ${formatTime(at)}`,
            );
          }}
          onAddVideoTrack={() => void run("add_track", { kind: "video" }, "Video track added")}
          onAddAudioTrack={() => void run("add_track", { kind: "audio" }, "Audio track added")}
          onRemoveTrack={(trackId) => {
            const track = timeline.tracks.find((tr) => tr.id === trackId);
            if (!track) return;
            const sameKind = timeline.tracks.filter((tr) => tr.kind === track.kind).length;
            if (sameKind <= 1) {
              onStatus(`Keep at least one ${track.kind} track`);
              return;
            }
            if (track.locked) {
              onStatus("Unlock the track before deleting");
              return;
            }
            if (
              !window.confirm(
                `Delete track ${track.name}? Clips on this track will be removed.`,
              )
            ) {
              return;
            }
            void run("remove_track", { trackId }, `Deleted ${track.name}`);
          }}
          onMuteTrack={(trackId, muted) => {
            void run("set_track_mute", { trackId, muted });
          }}
          onLockTrack={(trackId, locked) => {
            void run("set_track_lock", { trackId, locked });
          }}
          onHideTrack={(trackId, hidden) => {
            void run(
              "set_track_hidden",
              { trackId, hidden },
              hidden ? "Track hidden" : "Track shown",
            );
          }}
          onAdvancedAudio={onAdvancedAudio}
          onAdvancedVideo={onAdvancedVideo}
          onClearTimeline={onClearTimeline}
          onClearTrack={onClearTrack}
        />
      )}
    </section>
  );
}

/** Memoized header: skip re-render unless the track data itself changed. */
const TrackHeaderMemo = memo(
  TrackHeader,
  (a, b) => a.track === b.track && a.height === b.height && a.canDelete === b.canDelete,
);

const TimelineStatusBarMemo = memo(TimelineStatusBar);type RulerProps = {
  pxPerSec: number;
  totalDuration: number;
  zoneLeft: number | null;
  zoneRight: number | null;
  markers: TimelineMarker[];
  scrollerRef: RefObject<HTMLDivElement | null>;
  ticksOutRef: MutableRefObject<RulerTick[]>;
  timeFromClientXRef: MutableRefObject<(clientX: number) => number>;
  onScrubStart: (e: React.PointerEvent<HTMLDivElement>) => void;
  onSeekClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
  registerPlayheadEl: (el: HTMLDivElement | null) => void;
  registerSnapGuideEl: (el: HTMLElement | null) => void;
};

/**
 * Isolated ruler: owns hover + scroll-derived tick state so scrolling /
 * hovering / playing never re-renders tracks or clips. The playhead line and
 * snap guide are positioned imperatively by the parent.
 */
const Ruler = memo(function Ruler({
  pxPerSec,
  totalDuration,
  zoneLeft,
  zoneRight,
  markers,
  scrollerRef,
  ticksOutRef,
  timeFromClientXRef,
  onScrubStart,
  onSeekClick,
  onContextMenu,
  registerPlayheadEl,
  registerSnapGuideEl,
}: RulerProps) {
  const [scroll, setScroll] = useState({ left: 0, width: 1920 });
  const [hoverT, setHoverT] = useState<number | null>(null);
  /** Hover position coalesced to one update per frame — high-rate mice must
   * not re-render the ruler for every pointermove. */
  const hoverRafRef = useRef(0);
  const hoverPendingRef = useRef<number | null>(null);
  const onRulerPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      hoverPendingRef.current = timeFromClientXRef.current(e.clientX);
      if (!hoverRafRef.current) {
        hoverRafRef.current = requestAnimationFrame(() => {
          hoverRafRef.current = 0;
          const t = hoverPendingRef.current;
          hoverPendingRef.current = null;
          if (t == null) return;
          setHoverT((prev) => (prev === t ? prev : t));
        });
      }
    },
    [timeFromClientXRef],
  );
  useEffect(() => {
    return () => {
      if (hoverRafRef.current) cancelAnimationFrame(hoverRafRef.current);
    };
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      setScroll((prev) =>
        prev.left === el.scrollLeft && prev.width === el.clientWidth
          ? prev
          : { left: el.scrollLeft, width: el.clientWidth },
      );
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    update();
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollerRef]);

  const visibleStart = Math.max(0, scroll.left / pxPerSec - 5);
  const visibleEnd = (scroll.left + scroll.width + 10) / pxPerSec;
  const ticks = useMemo(
    () => rulerTicks(totalDuration, pxPerSec, visibleStart, visibleEnd),
    [totalDuration, pxPerSec, visibleStart, visibleEnd],
  );

  useEffect(() => {
    ticksOutRef.current = ticks;
  }, [ticksOutRef, ticks]);

  return (
    <div
      className="tl-ruler"
      onClick={onSeekClick}
      onPointerDown={onScrubStart}
      onPointerMove={onRulerPointerMove}
      onPointerLeave={() => setHoverT(null)}
      onContextMenu={onContextMenu}
    >
      {ticks.map((tick) => (
        <span
          key={tick.t}
          className={`tl-tick ${tick.kind}`}
          style={{ left: tick.t * pxPerSec }}
        >
          <i className="tl-tick-mark" aria-hidden />
          {tick.label ? (
            <span className="tl-tick-label">{tick.label}</span>
          ) : null}
        </span>
      ))}
      {hoverT != null && (
        <div className="tl-ruler-hover" style={{ left: hoverT * pxPerSec }}>
          <span className="tl-ruler-hover-badge">{formatTime(hoverT)}</span>
        </div>
      )}
      {zoneLeft != null && zoneRight != null && zoneRight > zoneLeft && (
        <div
          className="tl-zone"
          style={{
            left: zoneLeft * pxPerSec,
            width: Math.max(2, (zoneRight - zoneLeft) * pxPerSec),
          }}
        />
      )}
      {markers.map((m) => (
        <div
          key={m.id}
          className="tl-marker"
          style={{ left: m.time * pxPerSec }}
          title={m.label || "Marker"}
        />
      ))}
      <div className="tl-playhead" ref={registerPlayheadEl} />
      <div
        className="tl-snap-guide"
        ref={registerSnapGuideEl}
        style={{ display: "none" }}
      />
    </div>
  );
});

export type RulerTickKind = "major" | "medium" | "minor" | "micro";

export type RulerTick = {
  t: number;
  kind: RulerTickKind;
  label: string | null;
};

/** Detailed ruler ticks: major time labels, halfway medium ticks, minor divisions, and micro frame/ms ticks. */
function rulerTicks(
  duration: number,
  pxPerSec: number,
  rangeStart = 0,
  rangeEnd = duration,
): RulerTick[] {
  const targetPx = 100;
  const rawStep = targetPx / Math.max(0.01, pxPerSec);
  const nice = [
    0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
  ];
  let step = nice[nice.length - 1];
  for (const n of nice) {
    if (n >= rawStep) {
      step = n;
      break;
    }
  }

  // Determine minor subdivision count
  let minorDivisions = 5;
  if (step === 1 || step === 2 || step === 10 || step === 60) {
    minorDivisions = 10;
  } else if (step === 0.5 || step === 0.2 || step === 0.1 || step === 15 || step === 30) {
    minorDivisions = 5;
  } else {
    minorDivisions = 4;
  }
  const minorStep = step / minorDivisions;

  // Determine if micro ticks fit (at least 4px between micro ticks)
  let microDivisions = 1;
  const minTickPx = 4;
  if (minorStep * pxPerSec >= 24) {
    if (minorStep * pxPerSec >= 40) {
      microDivisions = 5;
    } else {
      microDivisions = 2;
    }
  }
  const tickStep = minorStep / microDivisions;

  if (tickStep * pxPerSec < minTickPx) {
    return [];
  }

  const isMajor = (t: number) => {
    const q = t / step;
    return Math.abs(q - Math.round(q)) < 1e-4;
  };

  const isMedium = (t: number) => {
    const halfStep = step / 2;
    const q = t / halfStep;
    return Math.abs(q - Math.round(q)) < 1e-4;
  };

  const isMinor = (t: number) => {
    const q = t / minorStep;
    return Math.abs(q - Math.round(q)) < 1e-4;
  };

  const ticks: RulerTick[] = [];
  const seen = new Set<number>();
  const start = Math.max(0, Math.floor(rangeStart / tickStep) * tickStep);
  const end = Math.min(duration + 1e-4, rangeEnd + 1e-4);

  for (let t = start; t <= end; t += tickStep) {
    const rounded = Number(t.toFixed(4));
    if (seen.has(rounded)) continue; // guard duplicate keys at micro zooms
    seen.add(rounded);
    const major = isMajor(rounded);
    const medium = !major && isMedium(rounded);
    const minor = !major && !medium && isMinor(rounded);
    const kind: RulerTickKind = major ? "major" : medium ? "medium" : minor ? "minor" : "micro";
    ticks.push({
      t: rounded,
      kind,
      label: major ? formatRulerTime(rounded, step) : null,
    });
  }
  return ticks;
}
