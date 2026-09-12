import { useEffect, useMemo, useRef, useState } from "react";
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
  findLinkPartner,
  timelineDuration,
  type Clip,
  type EditMode,
  type PerformanceTier,
  type Timeline,
  type TimelineTool,
} from "./types";
import { useTimelineView } from "./useTimelineView";
import "./timeline.css";

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
};

export function TimelinePanel({
  timeline,
  selectedClipId,
  playhead,
  tool,
  status,
  tier,
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
}: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [binDragOver, setBinDragOver] = useState(false);
  /** Live start shared by linked A/V while one partner is moved. */
  const [dragPreview, setDragPreview] = useState<{
    clipIds: string[];
    start: number;
  } | null>(null);
  const duration = timelineDuration(timeline, 10);
  const view = useTimelineView(duration);

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
        pts.push(clip.start, clip.start + (clip.out_point - clip.in_point));
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

  function timeFromClientX(clientX: number): number {
    const scroller = scrollerRef.current;
    if (!scroller) return 0;
    const rect = scroller.getBoundingClientRect();
    const x = clientX - rect.left + scroller.scrollLeft;
    return view.applySnap(view.xToTime(x), anchors);
  }

  useEffect(() => {
    return subscribeBinDrag((session) => {
      if (!session?.active) {
        setBinDragOver(false);
        return;
      }
      const el = document.elementFromPoint(session.clientX, session.clientY);
      const over =
        Boolean(el?.closest(".timeline-panel")) ||
        Boolean(el?.closest(".tl-scroller"));
      setBinDragOver(over);
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

  return (
    <section className={`timeline-panel ${binDragOver ? "bin-drag-over" : ""}`}>
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
            playhead < selectedClip.start + (selectedClip.out_point - selectedClip.in_point)
              ? selectedClip
              : timeline.tracks
                  .flatMap((t) => t.clips.map((c) => ({ track: t, clip: c })))
                  .find(({ track, clip: c }) => {
                    if (track.locked) return false;
                    const end = c.start + (c.out_point - c.in_point);
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

      <div className="tl-body">
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
                  kind: "lane",
                  trackId: track.id,
                  trackKind: track.kind,
                  at: playhead,
                  canDelete: sameKind > 1 && !track.locked,
                });
              }}
            />
            );
          })}
        </div>

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
              onContextMenu={(e) => {
                openContext(e, { kind: "ruler", at: timeFromClientX(e.clientX) });
              }}
            >
              {rulerTicks(duration, view.pxPerSec).map((tick) => (
                <span
                  key={tick.t}
                  className={`tl-tick ${tick.major ? "major" : "minor"}`}
                  style={{ left: view.timeToX(tick.t) }}
                >
                  <i className="tl-tick-mark" aria-hidden />
                  {tick.label ? (
                    <span className="tl-tick-label">{tick.label}</span>
                  ) : null}
                </span>
              ))}
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
                    const sameKind = timeline.tracks.filter((t) => t.kind === track.kind).length;
                    openContext(e, {
                      kind: "lane",
                      trackId: track.id,
                      trackKind: track.kind,
                      at: timeFromClientX(e.clientX),
                      canDelete: sameKind > 1 && !track.locked,
                    });
                  }}
                >
                  {track.clips.map((clip: Clip) => (
                    <ClipBlock
                      key={clip.id}
                      clip={clip}
                      selected={selectedClipId === clip.id}
                      tool={tool}
                      view={view}
                      locked={track.locked}
                      anchors={anchors.filter(
                        (a) =>
                          a !== clip.start &&
                          a !== clip.start + (clip.out_point - clip.in_point),
                      )}
                      onSelect={() => onSelectClip(clip.id)}
                      onContextMenu={(e) => {
                        const at = timeFromClientX(e.clientX);
                        const end = clip.start + (clip.out_point - clip.in_point);
                        openContext(e, {
                          kind: "clip",
                          clipId: clip.id,
                          trackId: track.id,
                          linked: Boolean(clip.linked_clip_id),
                          at: Math.min(Math.max(at, clip.start + 0.05), end - 0.05),
                          clipStart: clip.start,
                          clipEnd: end,
                        });
                      }}
                      previewStart={
                        dragPreview?.clipIds.includes(clip.id)
                          ? dragPreview.start
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
                      onMoveDrag={(phase, start) => {
                        if (!clip.linked_clip_id) return;
                        if (phase === "end") {
                          setDragPreview(null);
                          return;
                        }
                        setDragPreview({
                          clipIds: [clip.id, clip.linked_clip_id],
                          start,
                        });
                      }}
                      onMove={(newStart) => {
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
                      onTrim={(inPoint, outPoint, keepEnd) =>
                        void run("trim_clip", {
                          clipId: clip.id,
                          inPoint,
                          outPoint,
                          keepEnd,
                          syncLinked: true,
                        })
                      }
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
                  ))}
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
          tool={tool}
          editMode={timeline.edit_mode ?? "normal"}
          onClose={() => setCtxMenu(null)}
          onTool={onTool}
          onEditMode={onEditMode}
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
                    .flatMap((t) => t.clips)
                    .find((c) => c.id === clipId)
                : selectedClip;
            if (!clip) return;
            const end = clip.start + (clip.out_point - clip.in_point);
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
              .flatMap((t) => t.clips)
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
          onSetZoneIn={() => void setZoneAt("in", ctxMenu.target.at)}
          onSetZoneOut={() => void setZoneAt("out", ctxMenu.target.at)}
          onLiftZone={onLiftZone}
          onExtractZone={onExtractZone}
          onAddMarker={() => {
            onSeek(ctxMenu.target.at);
            void run(
              "add_marker",
              {
                time: ctxMenu.target.at,
                label: `M${(timeline.markers?.length ?? 0) + 1}`,
              },
              `Marker @ ${formatTime(ctxMenu.target.at)}`,
            );
          }}
          onAddVideoTrack={() => void run("add_track", { kind: "video" }, "Video track added")}
          onAddAudioTrack={() => void run("add_track", { kind: "audio" }, "Audio track added")}
          onRemoveTrack={(trackId) => {
            const track = timeline.tracks.find((t) => t.id === trackId);
            if (!track) return;
            const sameKind = timeline.tracks.filter((t) => t.kind === track.kind).length;
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
          canDeleteTrack={(trackId) => {
            const track = timeline.tracks.find((t) => t.id === trackId);
            if (!track || track.locked) return false;
            return timeline.tracks.filter((t) => t.kind === track.kind).length > 1;
          }}
          onZoomFit={doZoomFit}
          onZoomIn={view.zoomIn}
          onZoomOut={view.zoomOut}
          onUndo={onUndo}
          onRedo={onRedo}
        />
      )}
    </section>
  );
}

/** Major/minor ticks; labels emphasize minutes when zoomed out. */
function rulerTicks(
  duration: number,
  pxPerSec: number,
): { t: number; major: boolean; label: string | null }[] {
  const targetPx = 72;
  const rawStep = targetPx / Math.max(0.01, pxPerSec);
  const nice = [
    0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
  ];
  let step = nice[nice.length - 1];
  for (const n of nice) {
    if (n >= rawStep) {
      step = n;
      break;
    }
  }

  let minorStep = step;
  if (step >= 60) minorStep = step / 5;
  else if (step >= 10) minorStep = step / 5;
  else if (step >= 1) minorStep = step / 2;

  const isMajor = (t: number) => {
    const q = t / step;
    return Math.abs(q - Math.round(q)) < 1e-6;
  };

  const ticks: { t: number; major: boolean; label: string | null }[] = [];
  const end = duration + 1e-6;
  for (let t = 0; t <= end; t += minorStep) {
    const rounded = Number(t.toFixed(3));
    const major = isMajor(rounded);
    ticks.push({
      t: rounded,
      major,
      label: major ? formatRulerTime(rounded, step) : null,
    });
  }
  const last = ticks[ticks.length - 1];
  if (!last || last.t < duration - 1e-6) {
    const t = Number(duration.toFixed(3));
    ticks.push({
      t,
      major: true,
      label: formatRulerTime(t, step),
    });
  }
  return ticks;
}
