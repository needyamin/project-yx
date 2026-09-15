import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ExportDialog, type ExportSettings } from "./export/ExportDialog";
import { ProjectBin, type BinFilter } from "./bin/ProjectBin";
import { EditorShell } from "./layout/EditorShell";
import { TopMenubar } from "./layout/TopMenubar";
import { checkForAppUpdate } from "./update/checkUpdate";
import { UpdateDialog } from "./update/UpdateDialog";
import { ClipMonitor } from "./monitors/ClipMonitor";
import { ProjectMonitor, type PreviewAspect, type PreviewMode } from "./monitors/ProjectMonitor";
import { EffectInspector } from "./effects/EffectInspector";
import {
  EFFECT_CATALOG,
  defaultParams,
  effectLabel,
  previewPitchRate,
  previewVideoStyle,
  previewVolumeGain,
  type FilterInstance,
} from "./effects/effects";
import {
  AdvancedAudioDialog,
  type AdvancedAudioTarget,
} from "./audio/AdvancedAudioDialog";
import {
  AdvancedVideoDialog,
  type AdvancedVideoTarget,
} from "./video/AdvancedVideoDialog";
import "./monitors/ProjectMonitor.css";
import { TimelinePanel } from "./timeline/TimelinePanel";
import {
  clipAtPlayhead,
  clipFadeGain,
  clipTimelineDuration,
  fileName,
  findLinkPartner,
  formatTime,
  nextClipAfter,
  timelineDuration,
  type BootInfo,
  type EditMode,
  type LibraryItem,
  type MediaInfo,
  type Timeline,
  type TimelineTool,
} from "./timeline/types";
import "./App.css";

function clipSpeed(clip: { speed?: number }): number {
  const raw = clip.speed ?? 1;
  return Number.isFinite(raw) ? Math.min(4, Math.max(0.25, raw)) : 1;
}

const MEDIA_EXTENSIONS = [
  "mp4",
  "mov",
  "mkv",
  "webm",
  "avi",
  "m4v",
  "mp3",
  "wav",
  "aac",
  "m4a",
  "flac",
  "ogg",
] as const;

const UPSERT_FILTER_KINDS = new Set(["denoise", "pitch", "volume"]);

/** React-state playhead refresh while playing (the live playhead is moved
 * imperatively every frame; this only feeds timecode/sliders). */
const PLAYHEAD_UI_MS = 250;

type UnderPlayhead = NonNullable<ReturnType<typeof clipAtPlayhead>>;

const FILTERS = EFFECT_CATALOG.map((e) => ({
  id: e.id,
  label: e.label,
  heavy: e.heavy,
  roles: e.roles,
}));

function isMediaPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (MEDIA_EXTENSIONS as readonly string[]).includes(ext);
}

/** Media-file time for timeline position t within a clip (handles speed + reverse). */
function mediaTimeForClip(
  clip: { start: number; in_point: number; out_point: number; reverse?: boolean; speed?: number },
  t: number,
): number {
  const speed = clipSpeed(clip);
  const local = t - clip.start;
  const media = clip.reverse
    ? clip.out_point - local * speed
    : clip.in_point + local * speed;
  return Math.max(clip.in_point, Math.min(media, clip.out_point - 0.01));
}

/** Reuse prior {track,clip} when still the same clip object (avoids effect thrash). */
function stableUnderPlayhead(
  timeline: Timeline | null,
  playhead: number,
  kind: "video" | "audio",
  cache: { current: UnderPlayhead | null },
): UnderPlayhead | null {
  if (!timeline) {
    cache.current = null;
    return null;
  }
  const hit = clipAtPlayhead(timeline, playhead, kind);
  if (!hit) {
    cache.current = null;
    return null;
  }
  const prev = cache.current;
  if (prev && prev.clip.id === hit.clip.id && prev.clip === hit.clip) {
    return prev;
  }
  cache.current = hit;
  return hit;
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const shadowVideoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const resumePlayRef = useRef(false);
  const transitioningRef = useRef(false);
  const playheadRef = useRef(0);
  const playingRef = useRef(false);
  const reverseRafRef = useRef(0);
  const gapRafRef = useRef(0);
  const playheadUiTimer = useRef(0);
  const movePlayheadRef = useRef<((t: number) => void) | null>(null);
  const previewModeRef = useRef<PreviewMode>("empty");
  const videoUnderCache = useRef<UnderPlayhead | null>(null);
  const audioUnderCache = useRef<UnderPlayhead | null>(null);
  const videoUnderRef = useRef<UnderPlayhead | null>(null);
  const audioUnderRef = useRef<UnderPlayhead | null>(null);
  const monitorVolumeRef = useRef(1);
  const monitorMutedRef = useRef(false);
  const lastVideoStyle = useRef({
    filter: "",
    transform: "",
    opacity: "",
    clipPath: "",
  });
  const lastAudioVolume = useRef(-1);
  const timelineDropRef = useRef<((clientX: number) => number) | null>(null);
  const viewControlsRef = useRef<{
    zoomFit: () => void;
    zoomIn: () => void;
    zoomOut: () => void;
    setSnap: (v: boolean) => void;
    snap: boolean;
  } | null>(null);
  const [boot, setBoot] = useState<BootInfo | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const timelineRef = useRef<Timeline | null>(null);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [binFilter, setBinFilter] = useState<BinFilter>("media");
  const [focusFilterId, setFocusFilterId] = useState<string | null>(null);
  const [tool, setTool] = useState<TimelineTool>("select");
  const [status, setStatus] = useState("Booting…");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  /** Bumped whenever the monitor's active video element changes (buffer swap). */
  const [videoEpoch, setVideoEpoch] = useState(0);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewAspect, setPreviewAspect] = useState<PreviewAspect>("landscape");
  const [exportOpen, setExportOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [cropTool, setCropTool] = useState(false);
  const [snapOn, setSnapOn] = useState(true);
  const [monitorVolume, setMonitorVolume] = useState(1);
  const [monitorMuted, setMonitorMuted] = useState(false);
  const [clipMonitorOpen, setClipMonitorOpen] = useState(true);
  const [advancedAudio, setAdvancedAudio] = useState<AdvancedAudioTarget | null>(null);
  const [advancedVideo, setAdvancedVideo] = useState<AdvancedVideoTarget | null>(null);

  // Refs used inside event handlers / animation loops are synced in effects,
  // never during render (safe under concurrent rendering).
  useEffect(() => {
    timelineRef.current = timeline;
  }, [timeline]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    monitorVolumeRef.current = monitorVolume;
    monitorMutedRef.current = monitorMuted;
  }, [monitorVolume, monitorMuted]);

  const refreshBoot = useCallback(async () => {
    const info = await invoke<BootInfo>("get_boot_info");
    setBoot(info);
    setTimeline(normalizeTimeline(info.timeline));
    setStatus(`Ready · ${info.policy.tier} tier · ${info.policy.proxy.height}p proxy`);
  }, []);

  useEffect(() => {
    refreshBoot().catch((e) => setStatus(String(e)));
  }, [refreshBoot]);

  // Background proxy finished → hot-swap timeline clips onto the proxy so
  // playback gets smoother without any user action.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ sourcePath: string; proxyPath: string }>("proxy-ready", (event) => {
      const { sourcePath, proxyPath } = event.payload;
      void invoke<Timeline>("swap_timeline_media", { sourcePath, proxyPath })
        .then((next) => {
          setTimeline(normalizeTimeline(next));
          setStatus("Proxy ready — preview now plays the proxy file");
        })
        .catch(() => undefined);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Silent update check after launch.
  useEffect(() => {
    if (!boot) return;
    const t = window.setTimeout(() => {
      void checkForAppUpdate({
        interactive: false,
        onStatus: (s) => {
          if (s.kind === "available") setStatus(s.message);
          else if (s.kind === "none") {
            /* keep ready status */
          } else if (s.kind === "error") {
            /* quiet on launch */
          }
        },
      });
    }, 2500);
    return () => window.clearTimeout(t);
  }, [boot]);

  // Tray: Check for Updates…
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen("tray-check-updates", () => {
      setUpdateOpen(true);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const selectedMedia = useMemo(
    () => library.find((m) => m.id === selectedMediaId) ?? null,
    [library, selectedMediaId],
  );

  const selectedClip = useMemo(() => {
    if (!timeline || !selectedClipId) return null;
    for (const track of timeline.tracks) {
      const clip = track.clips.find((c) => c.id === selectedClipId);
      if (clip) return { track, clip };
    }
    return null;
  }, [timeline, selectedClipId]);

  const videoUnderPlayhead = useMemo(
    () => stableUnderPlayhead(timeline, playhead, "video", videoUnderCache),
    [timeline, playhead],
  );

  const audioUnderPlayhead = useMemo(
    () => stableUnderPlayhead(timeline, playhead, "audio", audioUnderCache),
    [timeline, playhead],
  );

  useEffect(() => {
    videoUnderRef.current = videoUnderPlayhead;
    audioUnderRef.current = audioUnderPlayhead;
    previewModeRef.current = videoUnderPlayhead
      ? "video"
      : audioUnderPlayhead
        ? "audio"
        : "empty";
  }, [videoUnderPlayhead, audioUnderPlayhead]);

  const previewMode: PreviewMode = videoUnderPlayhead
    ? "video"
    : audioUnderPlayhead
      ? "audio"
      : "empty";

  const previewPath = useMemo(() => {
    if (previewMode === "video") return videoUnderPlayhead?.clip.media_path ?? null;
    if (previewMode === "audio") return audioUnderPlayhead?.clip.media_path ?? null;
    return null;
  }, [previewMode, videoUnderPlayhead, audioUnderPlayhead]);

  /** Timeline A-track path for Project Monitor (video is muted; this drives sound). */
  const timelineAudioPath = useMemo(() => {
    if (!audioUnderPlayhead) return null;
    return audioUnderPlayhead.clip.media_path;
  }, [audioUnderPlayhead]);

  const previewSrc = useMemo(() => {
    if (!previewPath) return null;
    try {
      return convertFileSrc(previewPath);
    } catch {
      return null;
    }
  }, [previewPath]);

  const timelineAudioSrc = useMemo(() => {
    if (!timelineAudioPath) return null;
    try {
      return convertFileSrc(timelineAudioPath);
    } catch {
      return null;
    }
  }, [timelineAudioPath]);

  const projectDuration = useMemo(
    () => (timeline ? timelineDuration(timeline, 10) : 10),
    [timeline],
  );

  const hasTimelineClips = useMemo(
    () => !!timeline?.tracks.some((t) => t.clips.length > 0),
    [timeline],
  );

  useEffect(() => {
    if (previewPath && !previewSrc) {
      setPreviewError("Could not convert media path for preview.");
    } else {
      setPreviewError(null);
    }
  }, [previewPath, previewSrc]);

  /**
   * Load media into the project monitor.
   *
   * Video sources load into the hidden buffer element and are revealed only
   * after `loadedmetadata`, then the front/back roles swap — cuts between
   * different files no longer tear down the playing decoder.
   */
  useEffect(() => {
    const audio = audioRef.current;
    const front = videoRef.current;
    const back = shadowVideoRef.current;
    const shouldResume = resumePlayRef.current;
    resumePlayRef.current = false;

    if (previewMode === "empty") {
      if (front && !front.paused) front.pause();
      if (back && !back.paused) back.pause();
      if (audio && !audio.paused) audio.pause();
      return;
    }
    if (previewMode === "audio") {
      if (front && !front.paused) front.pause();
      if (back && !back.paused) back.pause();
    }

    const wantAudioSrc = timelineAudioSrc ?? (previewMode === "audio" ? previewSrc : null);
    const needVideoLoad =
      previewMode === "video" &&
      !!previewSrc &&
      front?.getAttribute("src") !== previewSrc &&
      back?.getAttribute("src") !== previewSrc;
    const needAudioLoad = Boolean(
      wantAudioSrc && audio && audio.getAttribute("src") !== wantAudioSrc,
    );

    const syncAudioLocal = () => {
      const audioHit = audioUnderRef.current;
      if (!audio || !audioHit || !wantAudioSrc) return;
      const t = playheadRef.current;
      audio.currentTime = Math.max(
        audioHit.clip.in_point,
        Math.min(audioHit.clip.in_point + (t - audioHit.clip.start), audioHit.clip.out_point - 0.01),
      );
    };

    if (!needVideoLoad && !needAudioLoad) {
      // Sources already loaded — seek only when out of sync (no reload).
      if (previewMode === "video" && front) {
        const hit = videoUnderRef.current;
        if (hit) {
          const want = mediaTimeForClip(hit.clip, playheadRef.current);
          if (Math.abs(front.currentTime - want) > 0.15) {
            front.currentTime = want;
          }
        }
        if (shouldResume && front.paused) {
          void front
            .play()
            .then(() => setPlaying(true))
            .catch(() => setPlaying(false));
          if (timelineAudioSrc && audio && audio.paused) {
            void audio.play().catch(() => undefined);
          }
        }
      }
      return;
    }

    if (!shouldResume && !playingRef.current) {
      setPlaying(false);
    }

    if (needVideoLoad && previewMode === "video" && previewSrc && front && back) {
      if (needAudioLoad && audio && wantAudioSrc) {
        audio.src = wantAudioSrc;
        audio.load();
      }
      // Buffer the new source in the hidden element.
      back.src = previewSrc;
      back.muted = true;
      back.load();
      const onMeta = () => {
        const hit = videoUnderRef.current;
        if (hit) {
          back.currentTime = mediaTimeForClip(hit.clip, playheadRef.current);
        }
        syncAudioLocal();
        // Carry over effect CSS, then swap front/back roles.
        back.style.filter = front.style.filter;
        back.style.transform = front.style.transform;
        back.style.opacity = front.style.opacity;
        back.style.clipPath = front.style.clipPath;
        back.classList.remove("is-back");
        back.classList.add("is-front");
        front.classList.remove("is-front");
        front.classList.add("is-back");
        // Reassign roles BEFORE pausing the old element so its pause event is
        // recognized as stale (isActiveElement guard) at any load speed.
        videoRef.current = back;
        shadowVideoRef.current = front;
        if (!front.paused) front.pause();
        setVideoEpoch((e) => e + 1);
        if (shouldResume || playingRef.current) {
          void back
            .play()
            .then(() => setPlaying(true))
            .catch(() => setPlaying(false));
          if (wantAudioSrc && audio) {
            void audio.play().catch(() => undefined);
          }
        }
      };
      back.addEventListener("loadedmetadata", onMeta, { once: true });
      return () => back.removeEventListener("loadedmetadata", onMeta);
    }

    if (previewMode === "audio" && needAudioLoad && audio && wantAudioSrc) {
      audio.src = wantAudioSrc;
      audio.load();
      const onMeta = () => {
        syncAudioLocal();
        if (shouldResume || playingRef.current) {
          void audio
            .play()
            .then(() => setPlaying(true))
            .catch(() => setPlaying(false));
        }
      };
      audio.addEventListener("loadedmetadata", onMeta, { once: true });
      return () => audio.removeEventListener("loadedmetadata", onMeta);
    }
  }, [previewSrc, timelineAudioSrc, previewMode]);

  const commitPlayhead = useCallback((t: number, immediate = false) => {
    const next = Math.max(0, t);
    playheadRef.current = next;
    // Live playhead moves with zero React involvement.
    movePlayheadRef.current?.(next);
    if (immediate || !playingRef.current) {
      window.clearTimeout(playheadUiTimer.current);
      playheadUiTimer.current = 0;
      setPlayhead(next);
      return;
    }
    if (playheadUiTimer.current) return;
    playheadUiTimer.current = window.setTimeout(() => {
      playheadUiTimer.current = 0;
      setPlayhead(playheadRef.current);
    }, PLAYHEAD_UI_MS);
  }, []);

  useEffect(() => {
    return () => window.clearTimeout(playheadUiTimer.current);
  }, []);

  /** Master playback clock: one rAF loop reads the media element per frame. */
  useEffect(() => {
    if (!playing || previewMode === "empty") return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!playingRef.current) return;
      const mode = previewModeRef.current;
      const active = mode === "video" ? videoRef.current : audioRef.current;
      if (!active) return;
      // Paused media means either reverse playback (own stepper drives the
      // playhead) or a pending buffered swap — the media clock is stale, so
      // skip instead of corrupting the playhead with a frozen currentTime.
      if (active.paused) return;
      const hit = mode === "video" ? videoUnderRef.current : audioUnderRef.current;
      if (!hit) return;

      const speed = clipSpeed(hit.clip);
      const reversed = mode === "video" && !!hit.clip.reverse;
      const localMedia = reversed
        ? hit.clip.out_point - active.currentTime
        : active.currentTime - hit.clip.in_point;
      const timelineTime = hit.clip.start + localMedia / speed;
      commitPlayhead(Math.max(hit.clip.start, timelineTime), false);

      // Keep A-track audio locked to the video clock.
      const audio = audioRef.current;
      const audioHit = audioUnderRef.current;
      if (mode === "video" && audio && audioHit && !audio.paused) {
        const pitchRate = previewPitchRate(
          (audioHit.clip.filters ?? []) as FilterInstance[],
        );
        if (Math.abs(pitchRate - 1) < 0.02) {
          const want = audioHit.clip.in_point + (timelineTime - audioHit.clip.start);
          if (Math.abs(audio.currentTime - want) > 0.12) {
            audio.currentTime = Math.max(
              audioHit.clip.in_point,
              Math.min(want, audioHit.clip.out_point - 0.01),
            );
          }
        }
      }

      // Cut / gap / end-of-clip handling.
      const clipEnd = hit.clip.start + clipTimelineDuration(hit.clip);
      if (
        timelineTime >= clipEnd - 0.02 ||
        active.currentTime >= hit.clip.out_point - 0.02
      ) {
        const tl = timelineRef.current;
        const next = tl
          ? nextClipAfter(tl, clipEnd, mode === "video" ? "video" : "audio")
          : null;
        if (next && next.clip.id !== hit.clip.id) {
          const isSameMedia = next.clip.media_path === hit.clip.media_path;
          const isContiguousTimeline = next.clip.start <= clipEnd + 0.04;
          const isContinuousMedia =
            Math.abs(hit.clip.out_point - next.clip.in_point) < 0.05;

          if (isSameMedia && isContiguousTimeline && isContinuousMedia) {
            // Seamless continuous playback across split point.
            commitPlayhead(next.clip.start, false);
            return;
          } else if (isSameMedia && isContiguousTimeline) {
            // Same media, in_point jumped: seek within the loaded file.
            active.currentTime = next.clip.in_point;
            commitPlayhead(next.clip.start, false);
            return;
          } else if (isContiguousTimeline) {
            // Cut to different media — buffered swap (no decoder teardown stall).
            resumePlayRef.current = playingRef.current;
            transitioningRef.current = true;
            active.pause();
            audioRef.current?.pause();
            commitPlayhead(next.clip.start, true);
            window.setTimeout(() => {
              transitioningRef.current = false;
            }, 50);
            return;
          }
        }

        // Gap between clips or end of timeline.
        const wasPlaying = playingRef.current;
        transitioningRef.current = true;
        active.pause();
        audioRef.current?.pause();
        window.setTimeout(() => {
          transitioningRef.current = false;
        }, 50);

        commitPlayhead(clipEnd, true);

        const dur = tl ? timelineDuration(tl, 10) : 10;
        if (wasPlaying && clipEnd < dur - 0.05) {
          playingRef.current = true;
          setPlaying(true);
        } else if (wasPlaying) {
          playingRef.current = false;
          setPlaying(false);
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, previewMode, commitPlayhead]);

  // Media element state listeners (play/pause/error). Re-attached when the
  // active video element changes (buffer swap) via videoEpoch.
  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    const active = previewMode === "video" ? video : previewMode === "audio" ? audio : null;
    if (!active) return;

    const isActiveElement = (ev: Event) =>
      ev.target ===
      (previewModeRef.current === "video" ? videoRef.current : audioRef.current);

    const onPlay = (ev: Event) => {
      if (!isActiveElement(ev)) return;
      setPlaying(true);
      if (previewMode === "video" && audio && timelineAudioSrc && audio.paused) {
        void audio.play().catch(() => undefined);
      }
    };
    const onPause = (ev: Event) => {
      // Ignore pause events from the retired buffer element during a swap.
      if (!isActiveElement(ev)) return;
      if (transitioningRef.current) return;
      cancelAnimationFrame(reverseRafRef.current);
      reverseRafRef.current = 0;
      cancelAnimationFrame(gapRafRef.current);
      gapRafRef.current = 0;
      playingRef.current = false;
      setPlaying(false);
      audio?.pause();
      commitPlayhead(playheadRef.current, true);
    };
    const onErr = (ev: Event) => {
      if (!isActiveElement(ev)) return;
      setPreviewError("Could not load preview.");
    };

    active.addEventListener("play", onPlay);
    active.addEventListener("pause", onPause);
    active.addEventListener("error", onErr);
    return () => {
      active.removeEventListener("play", onPlay);
      active.removeEventListener("pause", onPause);
      active.removeEventListener("error", onErr);
    };
  }, [previewMode, timelineAudioSrc, commitPlayhead, videoEpoch]);

  // Gap playback ticker: drives playhead across gaps at 1x (blank frame).
  useEffect(() => {
    if (!playing || previewMode === "video") {
      if (gapRafRef.current) {
        cancelAnimationFrame(gapRafRef.current);
        gapRafRef.current = 0;
      }
      return;
    }

    let lastWall = performance.now();

    const tick = (now: number) => {
      if (!playingRef.current) return;
      const dt = Math.min(0.1, (now - lastWall) / 1000);
      lastWall = now;

      const currentPh = playheadRef.current;
      const nextPh = currentPh + dt;

      const tl = timelineRef.current;
      const dur = tl ? timelineDuration(tl, 10) : 10;
      if (nextPh >= dur) {
        commitPlayhead(dur, true);
        playingRef.current = false;
        setPlaying(false);
        const audio = audioRef.current;
        if (audio && !audio.paused) audio.pause();
        return;
      }

      const vClip = tl ? clipAtPlayhead(tl, nextPh, "video") : null;
      if (vClip) {
        // Reached the next video clip!
        resumePlayRef.current = true;
        commitPlayhead(nextPh, true);
        return;
      }

      // Still in a gap: advance playhead (imperative + throttled state).
      commitPlayhead(nextPh, false);

      const aClip = tl ? clipAtPlayhead(tl, nextPh, "audio") : null;
      const audio = audioRef.current;
      if (audio && aClip) {
        if (audio.paused) void audio.play().catch(() => undefined);
      } else if (audio && !audio.paused && !aClip) {
        audio.pause();
      }

      gapRafRef.current = requestAnimationFrame(tick);
    };

    gapRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (gapRafRef.current) {
        cancelAnimationFrame(gapRafRef.current);
        gapRafRef.current = 0;
      }
    };
  }, [playing, previewMode, commitPlayhead]);

  async function importPaths(paths: string[]) {
    const mediaPaths = paths.filter(isMediaPath);
    if (mediaPaths.length === 0) {
      setStatus("No supported media files");
      return;
    }
    try {
      setBusy(true);
      const imported: LibraryItem[] = [];
      for (const path of mediaPaths) {
        setStatus(`Importing ${fileName(path)}…`);
        const info = await invoke<MediaInfo>("import_media", { path });
        imported.push({
          ...info,
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: fileName(path),
        });
      }
      setLibrary((prev) => [...imported, ...prev]);
      const last = imported[0];
      if (last) {
        setSelectedMediaId(last.id);
        setBinFilter(last.has_video ? "media" : "audio");
      }
      setStatus(
        imported.length === 1
          ? `Imported ${imported[0].name}`
          : `Imported ${imported.length} files`,
      );
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "Media",
            extensions: [...MEDIA_EXTENSIONS],
          },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await importPaths(paths);
    } catch (e) {
      setStatus(String(e));
    }
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const { type } = event.payload;
        if (type === "enter" || type === "over") {
          setDragOver(true);
        } else if (type === "leave") {
          setDragOver(false);
        } else if (type === "drop") {
          setDragOver(false);
          void importPaths(event.payload.paths);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => setStatus(String(e)));

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addMediaToTimeline(media: LibraryItem, start = 0) {
    try {
      setBusy(true);
      const next = await invoke<Timeline>("add_media_to_timeline", {
        mediaPath: media.path,
        start,
      });
      setTimeline(normalizeTimeline(next));
      const first = next.tracks.flatMap((t) => t.clips).sort((a, b) => b.start - a.start)[0];
      if (first) setSelectedClipId(first.id);
      const kind =
        media.has_video && media.has_audio
          ? "linked V+A"
          : media.has_video
            ? "video"
            : "audio";
      setStatus(`Added ${media.name} as ${kind} at ${formatTime(start)}`);
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onUndo() {
    try {
      setTimeline(normalizeTimeline(await invoke<Timeline>("undo")));
      setStatus("Undo");
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function onRedo() {
    try {
      setTimeline(normalizeTimeline(await invoke<Timeline>("redo")));
      setStatus("Redo");
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function onRemove() {
    if (!selectedClipId) return;
    try {
      setTimeline(
        normalizeTimeline(
          await invoke<Timeline>("remove_clip", {
            clipId: selectedClipId,
            removeLinked: true,
          }),
        ),
      );
      setSelectedClipId(null);
      setStatus("Clip deleted");
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function onRippleDelete() {
    if (!selectedClipId) return;
    try {
      setTimeline(
        normalizeTimeline(
          await invoke<Timeline>("ripple_delete", {
            clipId: selectedClipId,
            removeLinked: true,
          }),
        ),
      );
      setSelectedClipId(null);
      setStatus("Ripple delete");
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function onToggleLink() {
    if (!selectedClipId || !selectedClip || !timeline) return;
    try {
      if (selectedClip.clip.linked_clip_id) {
        setTimeline(
          normalizeTimeline(await invoke<Timeline>("unlink_clip", { clipId: selectedClipId })),
        );
        setStatus("Unlinked");
        return;
      }
      const partner = findLinkPartner(timeline, selectedClip.clip, playheadRef.current);
      if (!partner) {
        setStatus("No audio/video partner found to link");
        return;
      }
      setTimeline(
        normalizeTimeline(
          await invoke<Timeline>("link_clips", {
            clipA: selectedClip.clip.id,
            clipB: partner.id,
          }),
        ),
      );
      setStatus("Linked A/V");
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function onFilter(kind: string) {
    if (!selectedClipId || !selectedClip) {
      setStatus("Select a timeline clip first");
      return;
    }
    const roles = EFFECT_CATALOG.find((e) => e.id === kind)?.roles;
    if (roles && !roles.includes(selectedClip.clip.role)) {
      setStatus(`${kind} is for ${roles.join("/")} clips`);
      return;
    }
    if (kind === "pitch") {
      setStatus("Add Change voice, then set semitones under Applied (or use Advanced Audio)");
    }
    await upsertClipFilter(selectedClipId, kind, undefined);
  }

  async function upsertClipFilter(
    clipId: string,
    kind: string,
    params?: Record<string, unknown>,
  ): Promise<string | null> {
    const hit = findClipById(clipId);
    if (!hit) {
      return null;
    }
    try {
      if (kind === "volume") {
        const gain =
          typeof params?.gain === "number" ? (params.gain as number) : 1;
        let vol = hit.clip.filters?.find((f) => f.kind === "volume");
        let next: Timeline;
        if (!vol) {
          next = normalizeTimeline(
            await invoke<Timeline>("add_filter", {
              clipId,
              kind: "volume",
              params: { gain },
            }),
          );
          vol = next.tracks
            .flatMap((t) => t.clips)
            .find((c) => c.id === clipId)
            ?.filters?.find((f) => f.kind === "volume");
        } else {
          next = normalizeTimeline(
            await invoke<Timeline>("update_filter", {
              clipId,
              filterId: vol.id,
              params: { gain },
            }),
          );
        }
        setTimeline(next);
        setSelectedClipId(clipId);
        setFocusFilterId(vol?.id ?? null);
        setBinFilter("applied");
        setStatus("Volume on clip — adjust under Applied");
        return vol?.id ?? null;
      }

      if (UPSERT_FILTER_KINDS.has(kind)) {
        const existing = hit.clip.filters?.find((f) => f.kind === kind);
        if (existing) {
          const nextParams = {
            ...((existing.params ?? {}) as Record<string, unknown>),
            ...(params ?? {}),
          };
          const next = normalizeTimeline(
            await invoke<Timeline>("update_filter", {
              clipId,
              filterId: existing.id,
              params: nextParams,
            }),
          );
          setTimeline(next);
          setSelectedClipId(clipId);
          setFocusFilterId(existing.id);
          setBinFilter("applied");
          const label = effectLabel(kind);
          setStatus(
            kind === "denoise"
              ? "Noise remove on clip — see Applied (heard on export)"
              : `${label} updated — adjust under Applied (heard on export)`,
          );
          return existing.id;
        }
      }

      const next = normalizeTimeline(
        await invoke<Timeline>("add_filter", {
          clipId,
          kind,
          params: { ...defaultParams(kind), ...(params ?? {}) },
        }),
      );
      setTimeline(next);
      const clip = next.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
      const added = [...(clip?.filters ?? [])].reverse().find((f) => f.kind === kind);
      setSelectedClipId(clipId);
      setFocusFilterId(added?.id ?? null);
      setBinFilter("applied");
      const label = effectLabel(kind);
      setStatus(
        kind === "denoise"
          ? "Noise remove on clip — see Applied (heard on export)"
          : `${label} on clip — adjust under Applied (heard on export)`,
      );
      return added?.id ?? null;
    } catch (e) {
      setStatus(String(e));
      return null;
    }
  }

  async function updateFilterParams(filterId: string, params: Record<string, unknown>) {
    if (!selectedClipId) return;
    try {
      setTimeline(
        normalizeTimeline(
          await invoke<Timeline>("update_filter", {
            clipId: selectedClipId,
            filterId,
            params,
          }),
        ),
      );
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function toggleFilter(filterId: string, enabled: boolean) {
    if (!selectedClipId) return;
    try {
      setTimeline(
        normalizeTimeline(
          await invoke<Timeline>("set_filter_enabled", {
            clipId: selectedClipId,
            filterId,
            enabled,
          }),
        ),
      );
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function removeFilter(filterId: string) {
    if (!selectedClipId) return;
    try {
      setTimeline(
        normalizeTimeline(
          await invoke<Timeline>("remove_filter", {
            clipId: selectedClipId,
            filterId,
          }),
        ),
      );
      setStatus("Effect removed");
    } catch (e) {
      setStatus(String(e));
    }
  }

  function findClipById(clipId: string) {
    if (!timeline) return null;
    for (const track of timeline.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return { track, clip };
    }
    return null;
  }

  function openAdvancedAudioForClip(
    clipId: string,
    tab: "overview" | "waveform" | "effects" = "overview",
  ) {
    let hit = findClipById(clipId);
    let resolvedFromVideo = false;
    // Video A/V pairs: edit the linked audio clip, never the video track.
    if (hit && hit.clip.role === "video" && timeline) {
      const partner = findLinkPartner(timeline, hit.clip, playheadRef.current);
      if (partner && partner.role === "audio") {
        hit = findClipById(partner.id);
        resolvedFromVideo = true;
      } else {
        setStatus("No linked audio clip — select the A-track audio clip");
        return;
      }
    }
    if (!hit || hit.clip.role !== "audio") {
      setStatus("Select an audio clip");
      return;
    }
    const audioClipId = hit.clip.id;
    const vol = hit.clip.filters?.find((f) => f.kind === "volume" && f.enabled);
    const gain =
      typeof vol?.params?.gain === "number" ? (vol.params.gain as number) : 1;
    const pitch = hit.clip.filters?.find((f) => f.kind === "pitch");
    const initialSemitones =
      typeof pitch?.params?.semitones === "number" ? (pitch.params.semitones as number) : 0;
    const initialVoicePreset =
      typeof pitch?.params?.preset === "string" &&
      ["male", "female", "child", "custom"].includes(pitch.params.preset as string)
        ? (pitch.params.preset as "male" | "female" | "child" | "custom")
        : undefined;
    setSelectedClipId(audioClipId);
    const appliedKinds = [
      ...new Set((hit.clip.filters ?? []).map((f) => f.kind).filter(Boolean)),
    ];
    setAdvancedAudio({
      mediaPath: hit.clip.media_path,
      name: fileName(hit.clip.media_path),
      duration: Math.max(0.05, hit.clip.out_point - hit.clip.in_point),
      inPoint: hit.clip.in_point,
      outPoint: hit.clip.out_point,
      clipId: audioClipId,
      fadeIn: hit.clip.fade_in ?? 0,
      fadeOut: hit.clip.fade_out ?? 0,
      volumeGain: gain,
      sourceMode: false,
      appliedKinds,
      initialSemitones,
      initialVoicePreset,
      initialTab: tab,
    });
    if (resolvedFromVideo) {
      setStatus("Advanced Audio edits the linked audio clip (not video)");
    }
  }

  function openAdvancedAudioForBin(
    item: LibraryItem,
    tab: "overview" | "waveform" | "effects" = "overview",
  ) {
    const onTimeline = timeline?.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.role === "audio" && c.media_path === item.path);
    if (onTimeline) {
      openAdvancedAudioForClip(onTimeline.id, tab);
      return;
    }
    setAdvancedAudio({
      mediaPath: item.path,
      name: item.name,
      duration: Math.max(0.05, item.duration),
      inPoint: 0,
      outPoint: Math.max(0.05, item.duration),
      clipId: null,
      fadeIn: 0,
      fadeOut: 0,
      volumeGain: 1,
      sourceMode: true,
      appliedKinds: [],
      initialTab: tab,
    });
  }

  async function removeEffectByKind(clipId: string, kind: string) {
    const hit = findClipById(clipId);
    if (!hit) return;
    const filters = (hit.clip.filters ?? []).filter((f) => f.kind === kind);
    if (filters.length === 0) return;
    try {
      let next: Timeline | null = null;
      for (const f of filters) {
        next = normalizeTimeline(
          await invoke<Timeline>("remove_filter", {
            clipId,
            filterId: f.id,
          }),
        );
      }
      if (next) setTimeline(next);
      setStatus(`${effectLabel(kind)} removed`);
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function ensureVolumeGain(clipId: string, gain: number) {
    const hit = findClipById(clipId);
    if (!hit) return;
    try {
      let filters = hit.clip.filters ?? [];
      let vol = filters.find((f) => f.kind === "volume");
      if (!vol) {
        const next = normalizeTimeline(
          await invoke<Timeline>("add_filter", { clipId, kind: "volume" }),
        );
        setTimeline(next);
        const again = next.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
        vol = again?.filters?.find((f) => f.kind === "volume");
      }
      if (!vol) return;
      setTimeline(
        normalizeTimeline(
          await invoke<Timeline>("update_filter", {
            clipId,
            filterId: vol.id,
            params: { gain },
          }),
        ),
      );
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function setAudioFades(clipId: string, fadeIn: number, fadeOut: number) {
    try {
      setTimeline(
        normalizeTimeline(
          await invoke<Timeline>("set_clip_fades", {
            clipId,
            fadeIn,
            fadeOut,
          }),
        ),
      );
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function setClipReverse(clipId: string, reverse: boolean) {
    try {
      setTimeline(
        normalizeTimeline(
          await invoke<Timeline>("set_clip_reverse", {
            clipId,
            reverse,
          }),
        ),
      );
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function setClipSpeed(clipId: string, speed: number) {
    try {
      setTimeline(
        normalizeTimeline(
          await invoke<Timeline>("set_clip_speed", {
            clipId,
            speed,
          }),
        ),
      );
    } catch (e) {
      setStatus(String(e));
    }
  }

  function openAdvancedVideoForClip(clipId: string) {
    const hit = findClipById(clipId);
    if (!hit || hit.clip.role !== "video") {
      setStatus("Select a video clip");
      return;
    }
    setSelectedClipId(clipId);
    const appliedKinds = [
      ...new Set((hit.clip.filters ?? []).map((f) => f.kind).filter(Boolean)),
    ];
    setAdvancedVideo({
      mediaPath: hit.clip.media_path,
      name: fileName(hit.clip.media_path),
      duration: Math.max(0.05, hit.clip.out_point - hit.clip.in_point),
      inPoint: hit.clip.in_point,
      outPoint: hit.clip.out_point,
      clipId,
      fadeIn: hit.clip.fade_in ?? 0,
      fadeOut: hit.clip.fade_out ?? 0,
      reverse: !!hit.clip.reverse,
      speed: clipSpeed(hit.clip),
      sourceMode: false,
      appliedKinds,
      filters: (hit.clip.filters ?? []) as FilterInstance[],
    });
  }

  // Keep Advanced Video chips / reverse / speed in sync with timeline writes.
  useEffect(() => {
    if (!advancedVideo?.clipId || !timeline) return;
    let found: (typeof timeline.tracks)[0]["clips"][0] | null = null;
    for (const track of timeline.tracks) {
      const c = track.clips.find((x) => x.id === advancedVideo.clipId);
      if (c) {
        found = c;
        break;
      }
    }
    if (!found || found.role !== "video") return;
    const appliedKinds = [
      ...new Set((found.filters ?? []).map((f) => f.kind).filter(Boolean)),
    ];
    setAdvancedVideo((prev) => {
      if (!prev || prev.clipId !== found!.id) return prev;
      return {
        ...prev,
        fadeIn: found!.fade_in ?? 0,
        fadeOut: found!.fade_out ?? 0,
        reverse: !!found!.reverse,
        speed: clipSpeed(found!),
        appliedKinds,
        filters: (found!.filters ?? []) as FilterInstance[],
        inPoint: found!.in_point,
        outPoint: found!.out_point,
        duration: Math.max(0.05, found!.out_point - found!.in_point),
      };
    });
  }, [timeline, advancedVideo?.clipId]);

  async function cutAudioSelection(clipId: string, selStart: number, selEnd: number) {
    const hit = findClipById(clipId);
    if (!hit) return;
    const clip = hit.clip;
    const syncLinked = Boolean(clip.linked_clip_id);
    const absA = clip.start + Math.max(0, selStart);
    const absB = clip.start + Math.min(clip.out_point - clip.in_point, selEnd);
    if (absB - absA < 0.05) {
      setStatus("Selection too small");
      return;
    }
    try {
      // Split at end, then at start, then remove middle piece.
      let tl = normalizeTimeline(
        await invoke<Timeline>("split_clip_at", {
          clipId,
          at: absB,
          syncLinked,
        }),
      );
      setTimeline(tl);
      tl = normalizeTimeline(
        await invoke<Timeline>("split_clip_at", {
          clipId,
          at: absA,
          syncLinked,
        }),
      );
      setTimeline(tl);
      const mid = tl.tracks
        .flatMap((t) => t.clips)
        .find(
          (c) =>
            c.media_path === clip.media_path &&
            Math.abs(c.start - absA) < 0.04 &&
            Math.abs(c.start + (c.out_point - c.in_point) - absB) < 0.08,
        );
      if (mid) {
        tl = normalizeTimeline(
          await invoke<Timeline>("ripple_delete", {
            clipId: mid.id,
            removeLinked: syncLinked,
          }),
        );
        setTimeline(tl);
        setSelectedClipId(null);
        setAdvancedAudio(null);
        setStatus("Selection cut");
      } else {
        setStatus("Cut splits done — select middle clip to delete if needed");
      }
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function applyAudioEffectToClip(
    clipId: string,
    kind: string,
    params?: Record<string, unknown>,
  ) {
    await upsertClipFilter(clipId, kind, params);
  }

  async function commitCrop(crop: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }) {
    let targetClipId = selectedClipId;
    let targetClip = selectedClip;
    if (!targetClipId && videoUnderPlayhead) {
      targetClipId = videoUnderPlayhead.clip.id;
      targetClip = videoUnderPlayhead;
      setSelectedClipId(targetClipId);
    }
    if (!targetClipId || !targetClip) {
      setStatus("Select a clip to crop");
      return;
    }
    try {
      let filters = targetClip.clip.filters ?? [];
      let cropFilter = filters.find((f) => f.kind === "crop");
      if (!cropFilter) {
        const next = normalizeTimeline(
          await invoke<Timeline>("add_filter", { clipId: targetClipId, kind: "crop" }),
        );
        setTimeline(next);
        const clip = next.tracks.flatMap((t) => t.clips).find((c) => c.id === targetClipId);
        cropFilter = clip?.filters.find((f) => f.kind === "crop");
        filters = clip?.filters ?? [];
      }
      if (!cropFilter) return;
      const updated = normalizeTimeline(
        await invoke<Timeline>("update_filter", {
          clipId: targetClipId,
          filterId: cropFilter.id,
          params: crop,
        }),
      );
      setTimeline(updated);
      setStatus("Crop updated");
    } catch (e) {
      setStatus(String(e));
    }
  }

  const exportSource = useMemo(() => {
    return (
      selectedMedia?.path ??
      selectedClip?.clip.media_path ??
      videoUnderPlayhead?.clip.media_path ??
      audioUnderPlayhead?.clip.media_path ??
      null
    );
  }, [
    selectedMedia,
    selectedClip,
    videoUnderPlayhead,
    audioUnderPlayhead,
  ]);

  const canExport = hasTimelineClips || !!exportSource;

  function openExportDialog() {
    if (!canExport) {
      setStatus("Add media to the timeline (or select a file) to export");
      return;
    }
    setExportOpen(true);
  }

  async function runExport(settings: ExportSettings) {
    if (!canExport) {
      setStatus("Add media to the timeline (or select a file) to export");
      return;
    }
    try {
      const label =
        settings.height > settings.width
          ? `${settings.height}p-vertical`
          : `${settings.height}p`;
      const outputPath = await save({
        filters: [{ name: "MP4", extensions: ["mp4"] }],
        defaultPath: `yx-export-${settings.preset}-${label}.mp4`,
      });
      if (!outputPath) return;

      setBusy(true);
      setExportProgress(0);
      setStatus(`Exporting ${settings.width}×${settings.height}…`);

      const unlisten = await listen<{ percent: number; phase: string }>(
        "export-progress",
        (event) => {
          setExportProgress(event.payload.percent);
          if (event.payload.phase === "encoding") {
            setStatus(
              `Exporting ${settings.width}×${settings.height} · ${Math.round(event.payload.percent * 100)}%`,
            );
          }
        },
      );

      try {
        const sourceItem =
          library.find((m) => m.path === exportSource) ??
          (selectedMedia?.path === exportSource ? selectedMedia : null);
        await invoke("export_media", {
          inputPath: hasTimelineClips ? null : exportSource,
          outputPath,
          width: settings.width,
          height: settings.height,
          fps: settings.fps,
          codec: settings.codec,
          x264Preset: settings.x264Preset,
          crf: settings.qualityMode === "crf" ? settings.crf : null,
          videoBitrate:
            settings.qualityMode === "bitrate" ? settings.videoBitrate : null,
          audioBitrate: settings.audioBitrate,
          fit: settings.fit,
          encoder: settings.encoder,
          matchSource: settings.matchSource,
          duration: hasTimelineClips
            ? projectDuration
            : (sourceItem?.duration ?? null),
        });
        setExportProgress(1);
        setExportOpen(false);
        setStatus(
          hasTimelineClips
            ? `Exported timeline · ${settings.width}×${settings.height}`
            : `Exported ${settings.width}×${settings.height}`,
        );
      } finally {
        unlisten();
      }
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
      setExportProgress(0);
    }
  }

  async function setEditMode(mode: EditMode) {
    try {
      setTimeline(normalizeTimeline(await invoke<Timeline>("set_edit_mode", { mode })));
      setStatus(`Edit mode: ${mode}`);
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function addMarkerAtPlayhead() {
    try {
      setTimeline(
        normalizeTimeline(
          await invoke<Timeline>("add_marker", {
            time: playheadRef.current,
            label: `M${(timeline?.markers?.length ?? 0) + 1}`,
          }),
        ),
      );
      setStatus("Marker added");
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function setZoneIn() {
    try {
      setTimeline(
        normalizeTimeline(
          await invoke<Timeline>("set_zone", {
            zoneIn: playheadRef.current,
            zoneOut: timeline?.zone_out ?? null,
          }),
        ),
      );
      setStatus(`Zone in ${playheadRef.current.toFixed(2)}s`);
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function setZoneOut() {
    try {
      setTimeline(
        normalizeTimeline(
          await invoke<Timeline>("set_zone", {
            zoneIn: timeline?.zone_in ?? null,
            zoneOut: playheadRef.current,
          }),
        ),
      );
      setStatus(`Zone out ${playheadRef.current.toFixed(2)}s`);
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function liftZone() {
    try {
      setTimeline(normalizeTimeline(await invoke<Timeline>("lift_zone")));
      setStatus("Lift zone");
    } catch (e) {
      const msg = String(e);
      setStatus(/no zone/i.test(msg) ? "No zone set" : msg);
    }
  }

  async function extractZone() {
    try {
      setTimeline(normalizeTimeline(await invoke<Timeline>("extract_zone")));
      setStatus("Extract zone");
    } catch (e) {
      const msg = String(e);
      setStatus(/no zone/i.test(msg) ? "No zone set" : msg);
    }
  }

  async function splitAtPlayhead() {
    const ph = playheadRef.current;
    const tl = timelineRef.current;
    if (!tl) return;
    const under =
      clipAtPlayhead(tl, ph, "video") ??
      clipAtPlayhead(tl, ph, "audio");
    const sel = selectedClip;
    const selectedUnder =
      sel &&
      ph > sel.clip.start &&
      ph < sel.clip.start + clipTimelineDuration(sel.clip)
        ? sel.clip
        : null;
    const clip = selectedUnder ?? under?.clip;
    if (!clip) {
      setStatus("Playhead must be inside a clip");
      return;
    }
    try {
      setTimeline(
        normalizeTimeline(
          await invoke<Timeline>("split_clip_at", {
            clipId: clip.id,
            at: ph,
            syncLinked: true,
          }),
        ),
      );
      setStatus(`Split at ${ph.toFixed(2)}s`);
    } catch (e) {
      setStatus(String(e));
    }
  }

  const applyPreviewFades = useCallback(
    (
      t: number,
      videoClip: {
        start: number;
        in_point: number;
        out_point: number;
        fade_in?: number;
        fade_out?: number;
        filters?: FilterInstance[];
      } | null,
      audioClip: {
        start: number;
        in_point: number;
        out_point: number;
        fade_in?: number;
        fade_out?: number;
        filters?: FilterInstance[];
      } | null,
    ) => {
      const video = videoRef.current;
      const audio = audioRef.current;
      if (video) {
        const fade = videoClip ? clipFadeGain(videoClip, t) : 1;
        const style = previewVideoStyle(
          (videoClip?.filters ?? []) as FilterInstance[],
          fade,
        );
        const opacity = String(style.opacity);
        const clipPath = style.clipPath ?? "";
        const prev = lastVideoStyle.current;
        if (prev.filter !== style.filter) {
          video.style.filter = style.filter;
          prev.filter = style.filter;
        }
        if (prev.transform !== style.transform) {
          video.style.transform = style.transform;
          prev.transform = style.transform;
        }
        if (prev.opacity !== opacity) {
          video.style.opacity = opacity;
          prev.opacity = opacity;
        }
        if (prev.clipPath !== clipPath) {
          video.style.clipPath = clipPath;
          prev.clipPath = clipPath;
        }
      }
      if (audio) {
        const fade = audioClip ? clipFadeGain(audioClip, t) : 1;
        const vol = monitorMutedRef.current
          ? 0
          : Math.min(
              1,
              previewVolumeGain((audioClip?.filters ?? []) as FilterInstance[], fade) *
                monitorVolumeRef.current,
            );
        if (Math.abs(lastAudioVolume.current - vol) > 0.001) {
          audio.volume = vol;
          lastAudioVolume.current = vol;
        }
      }
    },
    [],
  );

  function togglePlay() {
    const video = videoRef.current;
    const audio = audioRef.current;

    const stopPlayback = () => {
      cancelAnimationFrame(reverseRafRef.current);
      reverseRafRef.current = 0;
      cancelAnimationFrame(gapRafRef.current);
      gapRafRef.current = 0;
      playingRef.current = false;
      setPlaying(false);
      video?.pause();
      audio?.pause();
    };

    // Gate on playingRef — reverse keeps video.paused true, so !paused is unreliable.
    if (playingRef.current) {
      stopPlayback();
      return;
    }

    const tl = timelineRef.current;
    const dur = tl ? timelineDuration(tl, 10) : 10;
    if (playheadRef.current >= dur - 0.05) {
      commitPlayhead(0, true);
    }

    const curTime = playheadRef.current;
    const hit = tl ? clipAtPlayhead(tl, curTime, "video") : null;
    const audioHit = tl ? clipAtPlayhead(tl, curTime, "audio") : null;

    if (hit && video && previewSrc) {
      video.muted = true;
      const needsStepped = !!hit.clip.reverse;

      if (needsStepped) {
        const clip = hit.clip;
        const wall0 = performance.now();
        const ph0 = playheadRef.current;
        const step = () => {
          if (!playingRef.current) return;
          const elapsed = (performance.now() - wall0) / 1000;
          const nextPh = ph0 + elapsed;
          const end = clip.start + clipTimelineDuration(clip);
          if (nextPh >= end - 0.02) {
            commitPlayhead(end, true);
            cancelAnimationFrame(reverseRafRef.current);
            reverseRafRef.current = 0;
            playingRef.current = false;
            setPlaying(false);
            audio?.pause();
            return;
          }
          commitPlayhead(nextPh, false);
          video.currentTime = mediaTimeForClip(clip, nextPh);
          applyPreviewFades(nextPh, clip, audioUnderRef.current?.clip ?? null);
          reverseRafRef.current = requestAnimationFrame(step);
        };
        playingRef.current = true;
        setPlaying(true);
        video.pause();
        if (timelineAudioSrc && audio) void audio.play().catch(() => undefined);
        reverseRafRef.current = requestAnimationFrame(step);
        return;
      }

      const speed = clipSpeed(hit.clip);
      try {
        video.playbackRate = speed;
      } catch {
        /* ignore */
      }
      void video.play().catch(() => undefined);
      playingRef.current = true;
      setPlaying(true);
      if (timelineAudioSrc && audio) void audio.play().catch(() => undefined);
      return;
    }

    if (audioHit && audio && (timelineAudioSrc || previewSrc)) {
      if (audio.paused) void audio.play().catch(() => undefined);
      playingRef.current = true;
      setPlaying(true);
      return;
    }

    // Sitting in a gap (no video clip under playhead)
    if (hasTimelineClips || dur > 0) {
      playingRef.current = true;
      setPlaying(true);
      if (video && !video.paused) video.pause();
      if (audioHit && audio && timelineAudioSrc) {
        if (audio.paused) void audio.play().catch(() => undefined);
      } else if (audio && !audio.paused) {
        audio.pause();
      }
    }
  }

  const seekTimeline = useCallback(
    (t: number) => {
      const next = Math.max(0, t);
      commitPlayhead(next, true);
      const tl = timelineRef.current;
      const videoHit = tl ? clipAtPlayhead(tl, next, "video") : null;
      const audioHit = tl ? clipAtPlayhead(tl, next, "audio") : null;
      if (videoHit && videoRef.current) {
        videoRef.current.muted = true;
        videoRef.current.currentTime = mediaTimeForClip(videoHit.clip, next);
        try {
          videoRef.current.playbackRate = videoHit.clip.reverse ? 1 : clipSpeed(videoHit.clip);
        } catch {
          /* ignore */
        }
      } else if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }
      if (audioHit && audioRef.current) {
        audioRef.current.currentTime = audioHit.clip.in_point + (next - audioHit.clip.start);
      } else if (audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
      }
      applyPreviewFades(next, videoHit?.clip ?? null, audioHit?.clip ?? null);
    },
    [commitPlayhead, applyPreviewFades],
  );

  // Pitch preview: set once when clip / pitch params change (not every playhead tick).
  const monitorPitchKey = useMemo(() => {
    const filters = (audioUnderPlayhead?.clip.filters ?? []) as FilterInstance[];
    const pitch = filters.find((f) => f.kind === "pitch" && f.enabled);
    const st =
      pitch && typeof pitch.params?.semitones === "number"
        ? (pitch.params.semitones as number)
        : 0;
    const clipId = audioUnderPlayhead?.clip.id ?? "none";
    return `${clipId}:${pitch ? "1" : "0"}:${st}`;
  }, [audioUnderPlayhead]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const filters = (audioUnderPlayhead?.clip.filters ?? []) as FilterInstance[];
    const rate = Math.max(0.5, Math.min(2, previewPitchRate(filters)));
    if (Math.abs(audio.playbackRate - rate) > 0.001) {
      audio.playbackRate = rate;
    }
  }, [monitorPitchKey, audioUnderPlayhead]);

  // Keep monitor opacity / volume in sync with playhead fades.
  useEffect(() => {
    applyPreviewFades(
      playhead,
      videoUnderPlayhead?.clip ?? null,
      audioUnderPlayhead?.clip ?? null,
    );
  }, [playhead, videoUnderPlayhead, audioUnderPlayhead, applyPreviewFades]);

  // Keyboard shortcuts (latest handlers via ref — attach once).
  const keyHandlersRef = useRef({
    togglePlay,
    onUndo,
    onRedo,
    splitAtPlayhead,
    setTool,
    setZoneIn,
    setZoneOut,
    onRemove,
    seekTimeline,
  });
  useEffect(() => {
    keyHandlersRef.current = {
      togglePlay,
      onUndo,
      onRedo,
      splitAtPlayhead,
      setTool,
      setZoneIn,
      setZoneOut,
      onRemove,
      seekTimeline,
    };
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const h = keyHandlersRef.current;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.code === "Space") {
        e.preventDefault();
        h.togglePlay();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        void h.onUndo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) {
        e.preventDefault();
        void h.onRedo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        void h.splitAtPlayhead();
      } else if (e.key === "s" || e.key === "S") {
        h.setTool("select");
      } else if (e.key === "x" || e.key === "X") {
        h.setTool("razor");
      } else if (e.key === "m" || e.key === "M") {
        h.setTool("spacer");
      } else if (e.key === "y" || e.key === "Y") {
        h.setTool("slip");
      } else if (e.key === "r" || e.key === "R") {
        h.setTool("ripple");
      } else if (e.key === "i" || e.key === "I") {
        void h.setZoneIn();
      } else if (e.key === "o" || e.key === "O") {
        void h.setZoneOut();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        void h.onRemove();
      } else if (e.key === "ArrowLeft") {
        h.seekTimeline(playheadRef.current - (e.shiftKey ? 1 : 1 / 30));
      } else if (e.key === "ArrowRight") {
        h.seekTimeline(playheadRef.current + (e.shiftKey ? 1 : 1 / 30));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleTimelineUpdate = useCallback((t: Timeline) => {
    setTimeline(normalizeTimeline(t));
  }, []);

  const handleRegisterPlayhead = useCallback((fn: ((t: number) => void) | null) => {
    movePlayheadRef.current = fn;
  }, []);

  if (!boot || !timeline) {
    return (
      <div className="shell boot">
        <div className="boot-card">
          <div className="logo big">YX</div>
          <h1>Project YX</h1>
          <p>{status}</p>
        </div>
      </div>
    );
  }

  const topbar = (
    <TopMenubar
      tier={boot.policy.tier}
      busy={busy}
      canExport={canExport}
      playing={playing}
      snap={snapOn}
      hasSelection={!!selectedClipId}
      clipLinked={Boolean(selectedClip?.clip.linked_clip_id)}
      clipMonitorOpen={clipMonitorOpen}
      onImport={() => void onImport()}
      onExport={openExportDialog}
      onUndo={() => void onUndo()}
      onRedo={() => void onRedo()}
      onDelete={() => void onRemove()}
      onRippleDelete={() => void onRippleDelete()}
      onSplitPlayhead={() => void splitAtPlayhead()}
      onToggleLink={() => void onToggleLink()}
      onLiftZone={() => void liftZone()}
      onExtractZone={() => void extractZone()}
      onAspect={setPreviewAspect}
      onZoomFit={() => viewControlsRef.current?.zoomFit()}
      onZoomIn={() => viewControlsRef.current?.zoomIn()}
      onZoomOut={() => viewControlsRef.current?.zoomOut()}
      onToggleSnap={() => {
        const next = !snapOn;
        setSnapOn(next);
        viewControlsRef.current?.setSnap(next);
        setStatus(next ? "Snap on" : "Snap off");
      }}
      onToggleClipMonitor={() => setClipMonitorOpen((v) => !v)}
      onTogglePlay={togglePlay}
      onCheckUpdates={() => setUpdateOpen(true)}
    />
  );

  return (
    <>
      <EditorShell
        topbar={topbar}
        bin={
          <div className={`bin-column ${binFilter === "applied" ? "applied-focus" : ""}`}>
            <ProjectBin
              library={library}
              selectedMediaId={selectedMediaId}
              filter={binFilter}
              onFilter={setBinFilter}
              onSelect={(id) => {
                setSelectedMediaId(id);
                setSelectedClipId(null);
              }}
              onImport={() => void onImport()}
              onAddToTimeline={(item) => void addMediaToTimeline(item)}
              onDropToTimeline={(item, clientX) => {
                const start = timelineDropRef.current?.(clientX) ?? playheadRef.current;
                void addMediaToTimeline(item, start);
              }}
              onDropToClipMonitor={(item) => {
                setClipMonitorOpen(true);
                setSelectedMediaId(item.id);
                setLibrary((prev) =>
                  prev.some((m) => m.id === item.id) ? prev : [item, ...prev],
                );
                setBinFilter(item.has_video ? "media" : "audio");
                setSelectedClipId(null);
                setStatus(`Clip Monitor · ${item.name}`);
              }}
              onRemoveFromBin={(item) => {
                const used = timeline?.tracks.some((t) =>
                  t.clips.some((c) => c.media_path === item.path),
                );
                if (used) {
                  if (
                    !window.confirm(
                      `${item.name} is used on the timeline. Remove from bin anyway? Timeline clips stay until deleted separately.`,
                    )
                  ) {
                    return;
                  }
                }
                setLibrary((prev) => prev.filter((m) => m.id !== item.id));
                if (selectedMediaId === item.id) setSelectedMediaId(null);
                setStatus(`Removed ${item.name} from bin`);
              }}
              onAdvancedAudio={(item, tab) => openAdvancedAudioForBin(item, tab)}
              busy={busy}
              dragOver={dragOver}
              effects={FILTERS.filter((e) => {
                const role = selectedClip?.clip.role;
                if (!role) return true;
                return e.roles.includes(role);
              })}
              effectsEnabled={!!selectedClipId}
              effectsAllowHeavy={boot.policy.preview_allows_heavy_filters}
              onApplyEffect={(id) => void onFilter(id)}
              selectedClipSummary={
                selectedClip ? fileName(selectedClip.clip.media_path) : null
              }
            />
            {binFilter === "applied" && (
              <EffectInspector
                clipId={selectedClipId}
                clipName={
                  selectedClip ? fileName(selectedClip.clip.media_path) : null
                }
                clipRole={selectedClip?.clip.role ?? null}
                filters={(selectedClip?.clip.filters ?? []).map((f) => ({
                  id: f.id,
                  kind: f.kind,
                  enabled: f.enabled,
                  params: (f.params ?? {}) as Record<string, unknown>,
                }))}
                focusFilterId={focusFilterId}
                fill
                onUpdate={(id, params) => void updateFilterParams(id, params)}
                onToggle={(id, en) => void toggleFilter(id, en)}
                onRemove={(id) => void removeFilter(id)}
              />
            )}
          </div>
        }
        clipMonitor={
          clipMonitorOpen ? (
            <ClipMonitor
              media={selectedMedia}
              aspect={previewAspect}
              onClose={() => setClipMonitorOpen(false)}
              onAddToTimeline={(item) => void addMediaToTimeline(item)}
            />
          ) : null
        }
        projectMonitor={
          <ProjectMonitor
            previewMode={previewMode}
            previewSrc={previewSrc}
            playing={playing}
            playhead={playhead}
            duration={projectDuration}
            previewError={previewError}
            aspect={previewAspect}
            onAspect={setPreviewAspect}
            videoRef={videoRef}
            shadowVideoRef={shadowVideoRef}
            audioRef={audioRef}
            onTogglePlay={togglePlay}
            onSeekRatio={(ratio) => seekTimeline(ratio * projectDuration)}
            volume={monitorVolume}
            muted={monitorMuted}
            onVolume={setMonitorVolume}
            onMuted={setMonitorMuted}
            cropTool={cropTool}
            onCropTool={setCropTool}
            cropDraft={
              (() => {
                const target = selectedClip?.clip ?? videoUnderPlayhead?.clip;
                const c = target?.filters?.find((f) => f.kind === "crop" && f.enabled);
                if (!c?.params) return null;
                const p = c.params as Record<string, number>;
                return {
                  left: p.left ?? 0,
                  top: p.top ?? 0,
                  right: p.right ?? 0,
                  bottom: p.bottom ?? 0,
                };
              })()
            }
            onCropCommit={(crop) => void commitCrop(crop)}
            chromakeyActive={Boolean(
              selectedClip?.clip.filters?.some((f) => f.kind === "chromakey" && f.enabled),
            )}
            onEyedropColor={(hex) => {
              const f = selectedClip?.clip.filters?.find((x) => x.kind === "chromakey");
              if (f) void updateFilterParams(f.id, { ...(f.params as object), color: hex });
            }}
            onShowClipMonitor={
              clipMonitorOpen ? undefined : () => setClipMonitorOpen(true)
            }
            hasTimelineClips={hasTimelineClips}
          />
        }
        timeline={
          <TimelinePanel
            timeline={timeline}
            library={library}
            selectedClipId={selectedClipId}
            playhead={playhead}
            playheadRef={playheadRef}
            tool={tool}
            status={status}
            tier={boot.policy.tier}
            onTool={setTool}
            onTimeline={handleTimelineUpdate}
            onSelectClip={setSelectedClipId}
            onSeek={seekTimeline}
            onStatus={setStatus}
            onEditMode={(m) => void setEditMode(m)}
            onSetZoneIn={() => void setZoneIn()}
            onSetZoneOut={() => void setZoneOut()}
            onLiftZone={() => void liftZone()}
            onExtractZone={() => void extractZone()}
            onAddMarker={() => void addMarkerAtPlayhead()}
            onUndo={() => void onUndo()}
            onRedo={() => void onRedo()}
            onRegisterDropResolver={(fn) => {
              timelineDropRef.current = fn;
            }}
            onRegisterViewControls={(api) => {
              viewControlsRef.current = api;
              if (api) setSnapOn(api.snap);
            }}
            onRegisterPlayhead={handleRegisterPlayhead}
            onAdvancedAudio={(clipId, tab) => openAdvancedAudioForClip(clipId, tab)}
            onAdvancedVideo={(clipId) => openAdvancedVideoForClip(clipId)}
          />
        }
      />
      {advancedAudio && (
        <AdvancedAudioDialog
          target={advancedAudio}
          onClose={() => setAdvancedAudio(null)}
          onSetFades={(fi, fo) => {
            if (advancedAudio.clipId) void setAudioFades(advancedAudio.clipId, fi, fo);
          }}
          onSetVolume={(gain) => {
            if (advancedAudio.clipId) void ensureVolumeGain(advancedAudio.clipId, gain);
          }}
          onApplyEffect={(kind, params) => {
            if (!advancedAudio.clipId) return Promise.resolve();
            return applyAudioEffectToClip(advancedAudio.clipId, kind, params);
          }}
          onRemoveEffect={(kind) => {
            if (!advancedAudio.clipId) return Promise.resolve();
            return removeEffectByKind(advancedAudio.clipId, kind);
          }}
          onCutSelection={(a, b) => {
            if (advancedAudio.clipId) void cutAudioSelection(advancedAudio.clipId, a, b);
          }}
          onStatus={setStatus}
        />
      )}
      {advancedVideo && (
        <AdvancedVideoDialog
          target={advancedVideo}
          onClose={() => setAdvancedVideo(null)}
          onSetFades={(fi, fo) => {
            if (advancedVideo.clipId) void setAudioFades(advancedVideo.clipId, fi, fo);
          }}
          onSetReverse={(rev) => {
            if (!advancedVideo.clipId) return Promise.resolve();
            return setClipReverse(advancedVideo.clipId, rev);
          }}
          onSetSpeed={(spd) => {
            if (!advancedVideo.clipId) return Promise.resolve();
            return setClipSpeed(advancedVideo.clipId, spd);
          }}
          onApplyEffect={(kind, params) => {
            if (!advancedVideo.clipId) return Promise.resolve();
            return applyAudioEffectToClip(advancedVideo.clipId, kind, params);
          }}
          onRemoveEffect={(kind) => {
            if (!advancedVideo.clipId) return Promise.resolve();
            return removeEffectByKind(advancedVideo.clipId, kind);
          }}
          onOpenApplied={() => {
            setBinFilter("applied");
            if (advancedVideo.clipId) setSelectedClipId(advancedVideo.clipId);
          }}
          onStatus={setStatus}
        />
      )}
      <ExportDialog
        open={exportOpen}
        busy={busy}
        progress={exportProgress}
        sourceName={
          hasTimelineClips
            ? "Timeline sequence (with cuts)"
            : exportSource
              ? fileName(exportSource)
              : null
        }
        sourceInfo={
          (() => {
            if (hasTimelineClips && timeline) {
              const fromLibrary =
                selectedMedia ??
                library.find((m) =>
                  timeline.tracks.some((t) =>
                    t.clips.some(
                      (c) =>
                        c.media_path === m.path ||
                        fileName(c.media_path) === fileName(m.path),
                    ),
                  ),
                ) ??
                null;
              return {
                width: fromLibrary?.width || timeline.width || 1920,
                height: fromLibrary?.height || timeline.height || 1080,
                frameRate: fromLibrary?.frame_rate || timeline.frame_rate || 30,
                duration: projectDuration,
              };
            }
            const item =
              library.find((m) => m.path === exportSource) ??
              (selectedMedia?.path === exportSource ? selectedMedia : null);
            if (!item || !item.has_video) return null;
            return {
              width: item.width,
              height: item.height,
              frameRate: item.frame_rate,
              duration: item.duration,
            };
          })()
        }
        tier={boot.policy.tier}
        preferHw={boot.policy.prefer_hw_encode}
        previewAspect={previewAspect}
        onClose={() => !busy && setExportOpen(false)}
        onExport={(settings) => void runExport(settings)}
      />
      <UpdateDialog open={updateOpen} onClose={() => setUpdateOpen(false)} />
    </>
  );
}

/** Ensure newer timeline fields exist when talking to older payloads. */
function normalizeTimeline(t: Timeline): Timeline {
  return {
    ...t,
    edit_mode: t.edit_mode ?? "normal",
    markers: t.markers ?? [],
    zone_in: t.zone_in ?? null,
    zone_out: t.zone_out ?? null,
    tracks: t.tracks.map((tr) => ({
      ...tr,
      hidden: tr.hidden ?? false,
      clips: tr.clips.map((c) => ({
        ...c,
        fade_in: c.fade_in ?? 0,
        fade_out: c.fade_out ?? 0,
        filters: (c.filters ?? []).map((f) => ({
          ...f,
          params: (f.params ?? {}) as Record<string, unknown>,
        })),
      })),
    })),
  };
}

export default App;
