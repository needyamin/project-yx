import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { subscribeBinDrag } from "../bin/binDrag";
import { ClipBlock } from "./ClipBlock";
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
  timelineDuration,
  type Clip,
  type EditMode,
  type LibraryItem,
  type PerformanceTier,
  type Timeline,
  type TimelineTool,
} from "./types";
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
  playhead: number;
  tool: TimelineTool;
  status: string;
  tier: PerformanceTier;
  onTool: (t: TimelineTool) => void;
  onTimeline: (t: Timeline) => void;
  onSelectClip: (id: string | null) => void;
  onSeek: (t: number) => void;
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
  library?: LibraryItem[];
  onAdvancedAudio?: (clipId: string, tab?: "overview" | "waveform" | "effects") => void;
  onAdvancedVideo?: (clipId: string) => void;
};

export function TimelinePanel({
  timeline,
  selectedClipId,
  playhead,
  tool,
  status,
  tier,
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
  onAdvancedAudio,
  onAdvancedVideo,
}: Props) {
  const panelRef = useRef<HTMLElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  const headerDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [binDragOver, setBinDragOver] = useState(false);
  const [rulerHoverTime, setRulerHoverTime] = useState<number | null>(null);
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
  const duration = timelineDuration(timeline, 10);
  const view = useTimelineView(duration);

  const trackClipObstacles = useMemo(() => {
    const map = new Map<string, Array<{ id: string; start: number; duration: number }>>();
    for (const track of timeline.tracks) {
      map.set(
        track.id,
        track.clips.map((c) => ({
          id: c.id,
          start: c.start,
          duration: clipTimelineDuration(c),
        })),
      );
    }
    return map;
  }, [timeline.tracks]);

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
    function onMove(e: MouseEvent) {
      if (!headerDragRef.current) return;
      const delta = e.clientX - headerDragRef.current.startX;
      setHeaderPx(clampHeader(headerDragRef.current.startW + delta));
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
    };
  }, [clampHeader]);

  const selectedClip = useMemo(() => {
    for (const track of timeline.tracks) {
      const clip = track.clips.find((c) => c.id === selectedClipId);
      if (clip) return clip;
    }
    return null;
  }, [timeline, selectedClipId]);

  const anchors = useMemo(() => {
    const pts = [0, playhead];
    for (const track of timeline.tracks) {
      if (track.hidden) continue;
      for (const clip of track.clips) {
        pts.push(clip.start, clip.start + clipTimelineDuration(clip));
      }
    }
    return pts;
  }, [timeline, playhead]);

  const zoneLeft =
    timeline.zone_in != null && timeline.zone_out != null
      ? Math.min(timeline.zone_in, timeline.zone_out)
      : timeline.zone_in;
  const zoneRight =
    timeline.zone_in != null && timeline.zone_out != null
      ? Math.max(timeline.zone_in, timeline.zone_out)
      : timeline.zone_out;

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
    };

    fitIfAllowed();
    const ro = new ResizeObserver(() => fitIfAllowed());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, view.zoomFit, view.hasUserZoomed]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (Math.abs(el.scrollLeft - view.scrollLeft) > 1) {
      el.scrollLeft = view.scrollLeft;
    }
  }, [view.scrollLeft, view.contentWidth]);

  async function run(cmd: string, args: Record<string, unknown>, okMsg?: string) {
    try {
      const next = await invoke<Timeline>(cmd, args);
      onTimeline(next);
      if (okMsg) onStatus(okMsg);
    } catch (e) {
      const msg = String(e);
      if (/no gap/i.test(msg)) onStatus("No gap at that position");
      else onStatus(msg);
    }
  }

  function doZoomFit() {
    const el = scrollerRef.current;
    view.zoomFit(el?.clientWidth ?? 800);
    if (el) el.scrollLeft = 0;
    onStatus(`Fit · ${duration.toFixed(1)}s in view`);
  }

  function openContext(
    e: React.MouseEvent,
    target: ContextMenuState["target"],
  ) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, target });
  }

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

  const activeRulerTicksRef = useRef<RulerTick[]>([]);

  function timeFromClientX(clientX: number): number {
    const scroller = scrollerRef.current;
    if (!scroller) return 0;
    const rect = scroller.getBoundingClientRect();
    const x = clientX - rect.left + scroller.scrollLeft;
    const rawTime = Math.max(0, view.xToTime(x));

    // 1. Magnetic anchor snapping (clip boundaries, markers, zones)
    if (view.snap) {
      const anchorThreshold = Math.max(0.04, 8 / view.pxPerSec);
      let bestAnchor = rawTime;
      let bestAnchorDist = anchorThreshold;
      for (const a of anchors) {
        const d = Math.abs(a - rawTime);
        if (d < bestAnchorDist) {
          bestAnchorDist = d;
          bestAnchor = a;
        }
      }
      if (bestAnchorDist < anchorThreshold) {
        view.setSnapGuide(bestAnchor);
        return Number(bestAnchor.toFixed(4));
      }
    }

    view.setSnapGuide(null);

    // 2. Magnetic ruler division tick snapping
    if (view.snap && activeRulerTicksRef.current.length > 0) {
      const tickThreshold = Math.max(0.02, 6 / view.pxPerSec);
      let bestTick = rawTime;
      let bestTickDist = tickThreshold;
      for (const tick of activeRulerTicksRef.current) {
        const d = Math.abs(tick.t - rawTime);
        if (d < bestTickDist) {
          bestTickDist = d;
          bestTick = tick.t;
        }
      }
      if (bestTickDist < tickThreshold) {
        return Number(bestTick.toFixed(4));
      }
    }

    // 3. Precision interval quantization (exact frame / hundredth / millisecond)
    const FPS = 30;
    const frameDur = 1 / FPS;
    let qStep = frameDur;
    if (view.pxPerSec >= 200) {
      qStep = 0.01; // 10ms / hundredths
    } else if (view.pxPerSec >= 40) {
      qStep = frameDur; // exact 30fps frames
    } else if (view.pxPerSec >= 15) {
      qStep = 0.1; // 100ms
    } else {
      qStep = 0.5; // half second
    }

    const quantized = Math.round(rawTime / qStep) * qStep;
    return Math.max(0, Number(quantized.toFixed(4)));
  }

  const timeFromClientXRef = useRef(timeFromClientX);
  timeFromClientXRef.current = timeFromClientX;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

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
    onRegisterDropResolver((clientX) => Math.max(0, timeFromClientX(clientX)));
    return () => onRegisterDropResolver(null);
    // Re-register when view / anchors change so drop time stays accurate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRegisterDropResolver, view.pxPerSec, view.scrollLeft, anchors]);

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

  function onLanePointer(e: React.MouseEvent<HTMLDivElement>) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (tool === "spacer") return;
    const t = timeFromClientX(e.clientX);
    onSeek(t);
    view.setSnapGuide(null);
  }

  /** Kdenlive-style scrub: press and drag moves the playhead. */
  function beginScrub(e: React.PointerEvent<HTMLDivElement>) {
    if (tool === "spacer") return;
    if ((e.target as HTMLElement).closest(".tl-clip")) return;
    if (e.button !== 0) return;
    e.preventDefault();
    suppressClickRef.current = true;

    const seekAt = (clientX: number) => {
      const t = timeFromClientX(clientX);
      onSeek(t);
    };
    seekAt(e.clientX);

    const onMoveWin = (ev: PointerEvent) => {
      seekAt(ev.clientX);
    };
    const onUpWin = () => {
      window.removeEventListener("pointermove", onMoveWin);
      window.removeEventListener("pointerup", onUpWin);
      window.removeEventListener("pointercancel", onUpWin);
      view.setSnapGuide(null);
    };
    window.addEventListener("pointermove", onMoveWin);
    window.addEventListener("pointerup", onUpWin);
    window.addEventListener("pointercancel", onUpWin);
  }

  function beginSpacerDrag(e: React.PointerEvent<HTMLDivElement>, trackId: string | null) {
    if (tool !== "spacer") return;
    e.preventDefault();
    e.stopPropagation();
    const originX = e.clientX;
    const at = timeFromClientX(e.clientX);
    let latestDelta = 0;
    suppressClickRef.current = true;

    const onMoveWin = (ev: PointerEvent) => {
      latestDelta = (ev.clientX - originX) / view.pxPerSec;
    };

    const onUpWin = () => {
      window.removeEventListener("pointermove", onMoveWin);
      window.removeEventListener("pointerup", onUpWin);
      window.removeEventListener("pointercancel", onUpWin);
      view.setSnapGuide(null);
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

  function trackHeight(track: (typeof timeline.tracks)[0]) {
    if (track.hidden) return 22;
    return track.kind === "video" ? 64 : 48;
  }

  const totalRulerDuration = Math.max(duration + 120, view.xToTime(view.contentWidth) + 60);
  const visibleStart = Math.max(0, view.xToTime(view.scrollLeft) - 5);
  const visibleEnd = view.xToTime(
    view.scrollLeft + (scrollerRef.current?.clientWidth ?? 1920) + 10,
  );
  const rulerTickList = useMemo(() => {
    return rulerTicks(totalRulerDuration, view.pxPerSec, visibleStart, visibleEnd);
  }, [totalRulerDuration, view.pxPerSec, visibleStart, visibleEnd]);
  activeRulerTicksRef.current = rulerTickList;

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
          const partner = findLinkPartner(timeline, selectedClip, playhead);
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
          const clip =
            selectedClip &&
            playhead > selectedClip.start &&
            playhead < selectedClip.start + clipTimelineDuration(selectedClip)
              ? selectedClip
              : timeline.tracks
                  .flatMap((t) => t.clips.map((c) => ({ track: t, clip: c })))
                  .find(({ track, clip: c }) => {
                    if (track.locked) return false;
                    const end = c.start + clipTimelineDuration(c);
                    return playhead > c.start && playhead < end;
                  })?.clip;
          if (!clip) {
            onStatus("Playhead must be inside a clip");
            return;
          }
          void run(
            "split_clip_at",
            { clipId: clip.id, at: playhead, syncLinked: true },
            `Split at ${formatTime(playhead)}`,
          );
        }}
        onRemoveSpaceAllTracks={() => {
          void run(
            "close_gap",
            { at: playhead, trackId: null },
            "Remove Space in All Tracks",
          );
        }}
        onRemoveAllSpacesAfterCursor={() => {
          void run(
            "remove_gaps",
            { from: playhead, trackId: null },
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
      />

      <div
        className="tl-body"
        style={{
          gridTemplateColumns: `${headerPx}px ${HEADER_HANDLE_PX}px minmax(0, 1fr)`,
        }}
      >
        <div className="tl-headers">
          <div className="tl-corner" />
          {timeline.tracks.map((track) => {
            const sameKind = timeline.tracks.filter((t) => t.kind === track.kind).length;
            return (
            <TrackHeader
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
              onContextMenu={(e) => {
                openContext(e, {
                  kind: "track",
                  trackId: track.id,
                  trackKind: track.kind,
                  muted: track.muted,
                  locked: track.locked,
                  hidden: Boolean(track.hidden),
                  canDelete: sameKind > 1 && !track.locked,
                });
              }}
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
          onScroll={(e) => view.setScrollLeft(e.currentTarget.scrollLeft)}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              if (e.deltaY < 0) view.zoomIn();
              else view.zoomOut();
            }
          }}
        >
          <div className="tl-canvas" style={{ width: view.contentWidth }}>
            <div
              className="tl-ruler"
              onClick={onLanePointer}
              onPointerDown={beginScrub}
              onPointerMove={(e) => {
                setRulerHoverTime(timeFromClientX(e.clientX));
              }}
              onPointerLeave={() => {
                setRulerHoverTime(null);
              }}
              onContextMenu={(e) => {
                openContext(e, { kind: "ruler", at: timeFromClientX(e.clientX) });
              }}
            >
              {rulerTickList.map((tick) => (
                <span
                  key={tick.t}
                  className={`tl-tick ${tick.kind}`}
                  style={{ left: view.timeToX(tick.t) }}
                >
                  <i className="tl-tick-mark" aria-hidden />
                  {tick.label ? (
                    <span className="tl-tick-label">{tick.label}</span>
                  ) : null}
                </span>
              ))}
              {rulerHoverTime != null && (
                <div
                  className="tl-ruler-hover"
                  style={{ left: view.timeToX(rulerHoverTime) }}
                >
                  <span className="tl-ruler-hover-badge">
                    {formatTime(rulerHoverTime)}
                  </span>
                </div>
              )}
              {zoneLeft != null && zoneRight != null && zoneRight > zoneLeft && (
                <div
                  className="tl-zone"
                  style={{
                    left: view.timeToX(zoneLeft),
                    width: Math.max(2, view.timeToX(zoneRight - zoneLeft)),
                  }}
                />
              )}
              {(timeline.markers ?? []).map((m) => (
                <div
                  key={m.id}
                  className="tl-marker"
                  style={{ left: view.timeToX(m.time) }}
                  title={m.label || "Marker"}
                />
              ))}
              <div className="tl-playhead" style={{ left: view.timeToX(playhead) }} />
              {view.snapGuide != null && (
                <div className="tl-snap-guide" style={{ left: view.timeToX(view.snapGuide) }} />
              )}
            </div>

            {timeline.tracks.map((track) => {
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
                  onContextMenu={(e) => {
                    if ((e.target as HTMLElement).closest(".tl-clip")) return;
                    openContext(e, {
                      kind: "lane",
                      trackId: track.id,
                      trackKind: track.kind,
                      at: timeFromClientX(e.clientX),
                    });
                  }}
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
                    const trackObs = trackClipObstacles.get(track.id) ?? [];
                    const ownObstacles = trackObs
                      .filter((o) => o.id !== clip.id)
                      .map((o) => ({ start: o.start, duration: o.duration }));
                    let obstacles = ownObstacles;
                    if (clip.linked_clip_id) {
                      for (const [tid, obsList] of trackClipObstacles.entries()) {
                        if (tid !== track.id && obsList.some((o) => o.id === clip.linked_clip_id)) {
                          const partnerObs = obsList
                            .filter((o) => o.id !== clip.linked_clip_id)
                            .map((o) => ({ start: o.start, duration: o.duration }));
                          obstacles = [...ownObstacles, ...partnerObs];
                          break;
                        }
                      }
                    }

                    const libItem = library.find(
                      (m) =>
                        m.path === clip.media_path ||
                        fileName(m.path) === fileName(clip.media_path),
                    );
                    const maxMediaDuration = libItem?.duration ?? Infinity;

                    return (
                      <ClipBlock
                        key={clip.id}
                        clip={clip}
                        selected={selectedClipId === clip.id}
                        tool={tool}
                        view={view}
                        locked={track.locked}
                        obstacles={obstacles}
                        editMode={timeline.edit_mode ?? "normal"}
                        maxMediaDuration={maxMediaDuration}
                        anchors={anchors.filter(
                          (a) =>
                            a !== clip.start &&
                            a !== clip.start + clipTimelineDuration(clip),
                        )}
                        onSelect={() => onSelectClip(clip.id)}
                      onContextMenu={(e) => {
                        const at = timeFromClientX(e.clientX);
                        const end = clip.start + clipTimelineDuration(clip);
                        openContext(e, {
                          kind: "clip",
                          clipId: clip.id,
                          trackId: track.id,
                          linked: Boolean(clip.linked_clip_id),
                          role: clip.role,
                          at: Math.min(Math.max(at, clip.start + 0.05), end - 0.05),
                          clipStart: clip.start,
                          clipEnd: end,
                        });
                      }}
                      previewDraft={
                        dragPreview?.partnerClipId === clip.id
                          ? dragPreview.draft
                          : null
                      }
                      onDragActive={(active) => {
                        if (active) suppressClickRef.current = true;
                      }}
                      onRazor={(at) =>
                        void run(
                          "split_clip_at",
                          { clipId: clip.id, at, syncLinked: true },
                          `Cut at ${formatTime(at)}`,
                        )
                      }
                      onLiveDrag={(phase, draft) => {
                        if (!clip.linked_clip_id) return;
                        if (phase === "end") {
                          return;
                        }
                        setDragPreview({
                          partnerClipId: clip.linked_clip_id,
                          draft,
                        });
                      }}
                      onMove={(newStart) => {
                        // Optimistic immediate update to eliminate snap-back flicker
                        const optimistic: Timeline = {
                          ...timeline,
                          tracks: timeline.tracks.map((t) => {
                            if (
                              !t.clips.some(
                                (c) =>
                                  c.id === clip.id ||
                                  (clip.linked_clip_id && c.id === clip.linked_clip_id),
                              )
                            ) {
                              return t;
                            }
                            const updatedClips = t.clips.map((c) => {
                              if (
                                c.id === clip.id ||
                                (clip.linked_clip_id && c.id === clip.linked_clip_id)
                              ) {
                                return { ...c, start: newStart };
                              }
                              return c;
                            });
                            updatedClips.sort((a, b) => a.start - b.start);
                            return { ...t, clips: updatedClips };
                          }),
                        };
                        onTimeline(optimistic);

                        void (async () => {
                          try {
                            await run(
                              "move_clip",
                              {
                                clipId: clip.id,
                                newStart,
                                syncLinked: true,
                              },
                              `Moved to ${formatTime(newStart)}`,
                            );
                          } finally {
                            setDragPreview(null);
                          }
                        })();
                      }}
                      onTrim={(inPoint, outPoint, keepEnd) => {
                        const newDur = (outPoint - inPoint) / (clip.speed ?? 1);
                        const optimistic: Timeline = {
                          ...timeline,
                          tracks: timeline.tracks.map((t) => {
                            if (
                              !t.clips.some(
                                (c) =>
                                  c.id === clip.id ||
                                  (clip.linked_clip_id && c.id === clip.linked_clip_id),
                              )
                            ) {
                              return t;
                            }
                            const updatedClips = t.clips.map((c) => {
                              if (
                                c.id === clip.id ||
                                (clip.linked_clip_id && c.id === clip.linked_clip_id)
                              ) {
                                const oldDur = clipTimelineDuration(c);
                                const newStart = keepEnd
                                  ? c.start + (oldDur - newDur)
                                  : c.start;
                                return {
                                  ...c,
                                  start: Math.max(0, newStart),
                                  in_point: inPoint,
                                  out_point: outPoint,
                                };
                              }
                              return c;
                            });
                            updatedClips.sort((a, b) => a.start - b.start);
                            return { ...t, clips: updatedClips };
                          }),
                        };
                        onTimeline(optimistic);
                        setDragPreview(null);
                        void run("trim_clip", {
                          clipId: clip.id,
                          inPoint,
                          outPoint,
                          keepEnd,
                          syncLinked: true,
                        });
                      }}
                      onRippleTrim={(edge, newEdgeTime) =>
                        void run(
                          "ripple_trim",
                          {
                            clipId: clip.id,
                            edge,
                            newEdgeTime,
                            syncLinked: true,
                          },
                          `Ripple ${edge}`,
                        )
                      }
                      onSlip={(delta) =>
                        void run(
                          "slip_clip",
                          {
                            clipId: clip.id,
                            delta,
                            syncLinked: true,
                          },
                          `Slip ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}s`,
                        )
                      }
                      onSetFades={(fadeIn, fadeOut) =>
                        void run(
                          "set_clip_fades",
                          {
                            clipId: clip.id,
                            fadeIn,
                            fadeOut,
                          },
                          `Fade ${fadeIn.toFixed(2)}s / ${fadeOut.toFixed(2)}s`,
                        )
                      }
                    />
                  );
                })}
                  <div className="tl-playhead" style={{ left: view.timeToX(playhead) }} />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <TimelineStatusBar
        playhead={playhead}
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
            if (playhead <= clip.start || playhead >= end) {
              onStatus("Playhead must be inside the clip");
              return;
            }
            void run(
              "split_clip_at",
              { clipId, at: playhead, syncLinked: true },
              `Split at ${formatTime(playhead)}`,
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
            const partner = findLinkPartner(timeline, clip, playhead);
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
                : playhead;
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
        />
      )}
    </section>
  );
}

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
  const start = Math.max(0, Math.floor(rangeStart / tickStep) * tickStep);
  const end = Math.min(duration + 1e-4, rangeEnd + 1e-4);

  for (let t = start; t <= end; t += tickStep) {
    const rounded = Number(t.toFixed(4));
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
