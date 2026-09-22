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
import { pointInElement } from "./monitors/monitorGeometry";
import type { TextPresetParams } from "./monitors/TextPresets";
import { EffectInspector } from "./effects/EffectInspector";
import {
  EFFECT_CATALOG,
  defaultParams,
  effectLabel,
  findMagicRemove,
  magicRenderKey,
  magicResultReady,
  magicScopeShift,
  previewPitchRate,
  previewVideoStyle,
  previewVolumeGain,
  regionStateAt,
  type FilterInstance,
  type MagicKeyframe,
  type MagicStroke,
  type RegionState,
} from "./effects/effects";
import type { KeyToolMode } from "./monitors/KeyTools";
import {
  AdvancedAudioDialog,
  type AdvancedAudioTarget,
} from "./audio/AdvancedAudioDialog";
import {
  AdvancedVideoDialog,
  type AdvancedVideoTarget,
} from "./video/AdvancedVideoDialog";
import "./monitors/ProjectMonitor.css";
import { MagicProgressDialog } from "./monitors/MagicProgressDialog";
import { TimelinePanel } from "./timeline/TimelinePanel";
import { reconcileTimeline } from "./timeline/reconcile";
import {
  engineEdit,
  invalidatePending,
  isCurrent,
  nextSeq,
  recordEngine,
} from "./timeline/engineSync";
import { playbackClock } from "./playback/playbackClock";
import {
  clipAtPlayhead,
  clipFadeGain,
  clipTimelineDuration,
  fileName,
  findLinkPartner,
  formatTime,
  IMAGE_EXTENSIONS,
  isImagePath,
  mediaTimeForClip,
  nextClipAfter,
  videoStackAtPlayhead,
  timelineDuration,
  type BootInfo,
  type Clip,
  type EditMode,
  type LibraryItem,
  type MediaInfo,
  type Timeline,
  type TimelineTool,
} from "./timeline/types";
import "./App.css";

/** Compact length for notices ("1m 24s"). */
function fmtLen(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

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
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "gif",
] as const;

const UPSERT_FILTER_KINDS = new Set([
  "denoise",
  "pitch",
  "volume",
  "equalizer",
  "compressor",
  "highpass",
  "gate",
  "normalize",
  "deesser",
  "magicremove",
  "blurregion",
  "bgmask",
]);

/** React-state playhead refresh while playing is handled by the playback
 * clock store (src/playback/playbackClock.ts): time-displaying leaves
 * subscribe to it directly, so playback never re-renders the project tree. */

type UnderPlayhead = NonNullable<ReturnType<typeof clipAtPlayhead>>;

/** Second audio clip under the playhead on a DIFFERENT track (overdub layer,
 * e.g. voiceover over music) — null when none exists. */
function secondAudioAt(
  timeline: Timeline | null,
  t: number,
  primaryClipId: string | null,
) {
  if (!timeline) return null;
  for (const track of timeline.tracks) {
    if (track.kind !== "audio" || track.muted || track.hidden) continue;
    for (const clip of track.clips) {
      if (primaryClipId && clip.id === primaryClipId) continue;
      const end = clip.start + clipTimelineDuration(clip);
      if (t >= clip.start && t < end) return { track, clip };
    }
  }
  return null;
}

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

const TEXT_EXTENSIONS = ["txt", "text"] as const;

/** Plain-text files droppable onto the Project Monitor (become a title). */
function isTextPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (TEXT_EXTENSIONS as readonly string[]).includes(ext);
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const shadowVideoRef = useRef<HTMLVideoElement | null>(null);
  const monitorImageRef = useRef<HTMLImageElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audio2Ref = useRef<HTMLAudioElement | null>(null);
  const lastAudio2Volume = useRef(-1);
  const resumePlayRef = useRef(false);
  const transitioningRef = useRef(false);
  const playheadRef = useRef(0);
  const playingRef = useRef(false);
  const reverseRafRef = useRef(0);
  const movePlayheadRef = useRef<((t: number) => void) | null>(null);
  const previewModeRef = useRef<PreviewMode>("empty");
  const videoUnderRef = useRef<UnderPlayhead | null>(null);
  const audioUnderRef = useRef<UnderPlayhead | null>(null);
  const audioUnder2Ref = useRef<UnderPlayhead | null>(null);
  const videoStackRef = useRef<UnderPlayhead[]>([]);
  const cropToolRef = useRef(false);
  const selectedClipIdRef = useRef<string | null>(null);
  const monitorVolumeRef = useRef(1);
  const monitorMutedRef = useRef(false);
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
  /** Clips under the playhead — updated ONLY when the set of covering clips
   * changes (boundary crossings), never per playback tick. The live position
   * lives in playheadRef + the playback clock; time displays subscribe there. */
  const [videoStack, setVideoStack] = useState<UnderPlayhead[]>([]);
  const [audioUnderPlayhead, setAudioUnderPlayhead] = useState<UnderPlayhead | null>(null);
  const [audioUnderPlayhead2, setAudioUnderPlayhead2] = useState<UnderPlayhead | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewAspect, setPreviewAspect] = useState<PreviewAspect>("landscape");
  const [exportOpen, setExportOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /** OS file drag hovering the Project Monitor frame (routed drop target). */
  const [monitorFileDrop, setMonitorFileDrop] = useState(false);
  const [monitorFileDropLabel, setMonitorFileDropLabel] = useState<string | null>(null);
  const monitorFrameRef = useRef<HTMLDivElement | null>(null);
  const monitorDropPathsRef = useRef<string[] | null>(null);
  const [exportProgress, setExportProgress] = useState(0);
  const [cropTool, setCropTool] = useState(false);
  /** Magic Remove (AI Eraser) tool + pipeline progress. */
  const [magicTool, setMagicTool] = useState(false);
  const magicToolRef = useRef(magicTool);
  magicToolRef.current = magicTool;
  const [magicBusy, setMagicBusy] = useState<{ phase: string; percent: number } | null>(null);
  const [magicStatus, setMagicStatus] = useState<string | null>(null);
  /** Panel values before the filter exists (first stroke creates it). */
  const [magicDraft, setMagicDraft] = useState<Record<string, unknown> | null>(null);
  /* --- Blur Region + BG Key tools --- */
  const [blurTool, setBlurTool] = useState(false);
  const [blurBusy, setBlurBusy] = useState<{ phase: string; percent: number } | null>(null);
  const [blurStatus, setBlurStatus] = useState<string | null>(null);
  const [keyTool, setKeyTool] = useState<KeyToolMode | null>(null);
  const magicDraftRef = useRef<Record<string, unknown> | null>(null);
  /** Serializes ALL filter-param commits (magic panel, blur region, BG key,
   * inspector) through queueFilterCommit below: two rapid stroke commits used
   * to both see "no filter yet" and create DUPLICATE filters — downstream
   * reads only the first one, so extra brushed regions were silently not
   * removed. */
  const magicStatusTickRef = useRef(0);
  /** When the current Magic Remove job started (epoch ms). */
  const [magicStartedAt, setMagicStartedAt] = useState(0);
  /** Last Magic Remove failure, shown in the floating window for a few
   * seconds — failures must never be silent. */
  const [magicError, setMagicError] = useState<string | null>(null);
  const [snapOn, setSnapOn] = useState(true);
  const snapOnRef = useRef(true);
  useEffect(() => {
    snapOnRef.current = snapOn;
  }, [snapOn]);
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

  /** Merge a fresh backend timeline into state: identity-preserving
   * reconciliation (memoized clips only re-render when their content
   * actually changed) + synchronous ref update so subsequent handlers and
   * the playback loop always see the latest timeline. */
  function normalizeTimeline(t: Timeline): Timeline {
    const next = reconcileTimeline(timelineRef.current, t);
    timelineRef.current = next;
    return next;
  }


  const autoPipDoneRef = useRef<Set<string>>(new Set()); useEffect(() => {
    if (!timeline) return;
    const videoTracks = timeline.tracks.filter((t) => t.kind === "video" && !t.hidden);
    const targets: string[] = [];
    videoTracks.forEach((track, vi) => {
      for (const clip of track.clips) {
        if (autoPipDoneRef.current.has(clip.id)) continue;
        if (!isImagePath(clip.media_path)) {
          autoPipDoneRef.current.add(clip.id); // videos never auto-PiP
          continue;
        }
        if ((clip.filters ?? []).some((f) => f.kind === "transform")) {
          autoPipDoneRef.current.add(clip.id); // already has intent
          continue;
        }
        const start = clip.start;
        const end = clip.start + clipTimelineDuration(clip);
        const overVideoContent = videoTracks
          .slice(0, vi)
          .some((lower) =>
            lower.clips.some(
              (c) => c.start < end && c.start + clipTimelineDuration(c) > start,
            ),
          );
        if (overVideoContent) targets.push(clip.id);
      }
    });
    if (targets.length === 0) return;
    void (async () => {
      for (const clipId of targets) {
        const updated = await engineEdit<Timeline>(
          "add_filter",
          {
            clipId,
            kind: "transform",
            params: { x: 0, y: 0, scale: 0.5, rotation: 0, opacity: 1 },
          },
          { onError: (e) => setStatus(String(e)) },
        );
        if (!updated) continue;
        autoPipDoneRef.current.add(clipId);
        setTimeline(normalizeTimeline(updated));
        setStatus("Overlay image sized to fit — drag it in the monitor to position");
      }
    })();
  }, [timeline]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    cropToolRef.current = cropTool;
  }, [cropTool]);
  useEffect(() => {
    monitorVolumeRef.current = monitorVolume;
    monitorMutedRef.current = monitorMuted;
  }, [monitorVolume, monitorMuted]);

  const refreshBoot = useCallback(async () => {
    const info = await invoke<BootInfo>("get_boot_info");
    setBoot(info);
    // Every launch starts fresh — the boot timeline from the engine is the
    // whole project. Nothing is persisted or restored behind the user's back
    // (explicit Save/Open .yxp files are the only persistence).
    const next = normalizeTimeline(info.timeline);
    recordEngine(next);
    setTimeline(next);
    setStatus(`Ready · ${info.policy.tier} tier · ${info.policy.proxy.height}p proxy`);
  }, []);

  useEffect(() => {
    refreshBoot().catch((e) => setStatus(String(e)));
  }, [refreshBoot]);

  // Magic Remove pipeline progress (tracking / background reconstruction).
  useEffect(() => {
    if (magicBusy && !magicStartedAt) setMagicStartedAt(Date.now());
    if (!magicBusy && magicStartedAt) setMagicStartedAt(0);
  }, [magicBusy, magicStartedAt]);

  useEffect(() => {
    if (!magicError) return;
    const id = window.setTimeout(() => setMagicError(null), 8000);
    return () => window.clearTimeout(id);
  }, [magicError]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ percent: number; phase: string }>("magic-progress", (event) => {
      const { percent, phase } = event.payload;
      if (phase === "done") {
        setMagicBusy(null);
        setStatus("✨ Magic Remove finished — the monitor now previews the cleaned video.");
        return;
      }
      setMagicBusy({ phase, percent });
      // Mirror progress into the status bar (throttled) so it stays visible
      // even when the Magic Remove panel is closed.
      const now = Date.now();
      if (now - magicStatusTickRef.current > 700) {
        magicStatusTickRef.current = now;
        setStatus(
          `✨ Magic Remove ${phase === "tracking" ? "tracking mask" : "rebuilding background"}… ${Math.round(percent * 100)}%`,
        );
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Blur tool auto-track progress (own event so the Magic panel stays quiet).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ percent: number; phase: string }>("blur-progress", (event) => {
      const { percent, phase } = event.payload;
      if (phase === "done") {
        setBlurBusy(null);
        return;
      }
      setBlurBusy({ phase, percent });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Background proxy finished → hot-swap timeline clips onto the proxy so
  // playback gets smoother without any user action.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ sourcePath: string; proxyPath: string }>("proxy-ready", (event) => {
      const { sourcePath, proxyPath } = event.payload;
      void engineEdit<Timeline>("swap_timeline_media", { sourcePath, proxyPath }).then((next) => {
        if (next) {
          setTimeline(normalizeTimeline(next));
          setStatus("Proxy ready — preview now plays the proxy file");
        }
      });
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

  /** Base (bottom-most) video clip under the playhead; overlays stack above. */
  const videoUnderPlayhead = videoStack[0] ?? null;

  const timelineAudio2Src = useMemo(() => {
    const clip = audioUnderPlayhead2?.clip;
    if (!clip) return null;
    try {
      return convertFileSrc(clip.media_path);
    } catch {
      return null;
    }
  }, [audioUnderPlayhead2]);

  // Refs are already updated synchronously where the under-playhead sets are
  // detected (commitPlayhead / timeline resync); this effect mirrors the
  // remaining render-phase values.
  useEffect(() => {
    selectedClipIdRef.current = selectedClipId;
    previewModeRef.current = videoUnderPlayhead
      ? "video"
      : audioUnderPlayhead
        ? "audio"
        : "empty";
  }, [selectedClipId, videoUnderPlayhead, audioUnderPlayhead, audioUnderPlayhead2]);

  const previewMode: PreviewMode = videoUnderPlayhead
    ? "video"
    : audioUnderPlayhead
      ? "audio"
      : "empty";

  const previewPath = useMemo(() => {
    if (previewMode === "video") {
      const clip = videoUnderPlayhead?.clip;
      if (clip) {
        // Magic Remove: once a removal render exists (and is not stale), the
        // monitor plays the pre-inpainted sidecar — WYSIWYG, non-destructive.
        // While the tool is open we show the ORIGINAL so the mask can be
        // edited against the real content.
        if (!magicTool) {
          const rp = magicResultReady(
            (findMagicRemove(clip.filters)?.params ?? null) as Record<string, unknown> | null,
            clip,
          );
          if (rp) return rp;
        }
        return clip.media_path;
      }
      return null;
    }
    if (previewMode === "audio") return audioUnderPlayhead?.clip.media_path ?? null;
    return null;
  }, [previewMode, videoUnderPlayhead, audioUnderPlayhead, magicTool]);

  const previewIsImage = useMemo(() => isImagePath(previewPath), [previewPath]);

  /** Overlay layers: every video-track clip under the playhead ABOVE the
   * base clip. The base (bottom-most, on the main video element) keeps
   * playing normally underneath — overlays composite on top, exactly like
   * the export overlay chain. Recomputed only when the covering-clip set
   * changes, not per playback tick. */
  const monitorLayers = useMemo(() => {
    if (!timeline) return [] as { clip: Clip; src: string; isImage: boolean }[];
    const out: { clip: Clip; src: string; isImage: boolean }[] = [];
    for (const { clip } of videoStack.slice(1)) {
      // Magic Remove overlay layers preview through their sidecar too.
      const params = (findMagicRemove(clip.filters)?.params ??
        null) as Record<string, unknown> | null;
      const rp = magicResultReady(params, clip);
      const path = rp ?? clip.media_path;
      // Scoped sidecar: remap the layer's in/out into sidecar time so the
      // layer's element-time mapping (mediaTimeForClip) lines up.
      const shift = rp ? magicScopeShift(params) : 0;
      const view =
        shift > 0
          ? { ...clip, in_point: clip.in_point - shift, out_point: clip.out_point - shift }
          : clip;
      let src: string | null = null;
      try {
        src = convertFileSrc(path);
      } catch {
        src = null;
      }
      if (src) out.push({ clip: view, src, isImage: isImagePath(path) });
    }
    return out;
  }, [timeline, videoStack]);

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
   * Directly controls the primary video element for reliable, stutter-free playback.
   */
  useEffect(() => {
    const audio = audioRef.current;
    const video = videoRef.current;
    const shouldResume = resumePlayRef.current;
    resumePlayRef.current = false;

    if (previewMode === "empty") {
      if (video && !video.paused) video.pause();
      if (audio && !audio.paused) audio.pause();
      return;
    }
    if (previewMode === "audio") {
      if (video && !video.paused) video.pause();
    }

    const wantAudioSrc = timelineAudioSrc ?? (previewMode === "audio" ? previewSrc : null);
    const audio2 = audio2Ref.current;
    const wantAudio2Src = timelineAudio2Src;
    const syncAudio2 = () => {
      if (!audio2) return;
      const hit = audioUnder2Ref.current;
      if (!wantAudio2Src || !hit) {
        if (audio2.getAttribute("src")) {
          audio2.pause();
          audio2.removeAttribute("src");
          audio2.load();
        }
        return;
      }
      if (audio2.getAttribute("src") !== wantAudio2Src) {
        audio2.src = wantAudio2Src;
        audio2.load();
      }
      const want = Math.max(
        hit.clip.in_point,
        Math.min(
          hit.clip.in_point + (playheadRef.current - hit.clip.start),
          hit.clip.out_point - 0.01,
        ),
      );
      try {
        if (Math.abs(audio2.currentTime - want) > 0.15) audio2.currentTime = want;
      } catch {
        /* metadata not ready yet */
      }
      if (playingRef.current && audio2.paused) {
        void audio2.play().catch(() => undefined);
      }
    };

    const syncAudioLocal = () => {
      const audioHit = audioUnderRef.current;
      if (!audio || !audioHit || !wantAudioSrc) return;
      const t = playheadRef.current;
      audio.currentTime = Math.max(
        audioHit.clip.in_point,
        Math.min(audioHit.clip.in_point + (t - audioHit.clip.start), audioHit.clip.out_point - 0.01),
      );
    };

    syncAudio2();

    const needVideoLoad =
      previewMode === "video" &&
      !!previewSrc &&
      !isImagePath(previewSrc) &&
      video?.getAttribute("src") !== previewSrc;

    const needAudioLoad = Boolean(
      wantAudioSrc && audio && audio.getAttribute("src") !== wantAudioSrc,
    );

    if (needAudioLoad && audio && wantAudioSrc) {
      audio.src = wantAudioSrc;
      audio.load();
    }

    if (needVideoLoad && previewMode === "video" && previewSrc && video) {
      video.src = previewSrc;
      video.muted = true;
      video.load();
      const onMeta = () => {
        const ph = playheadRef.current;
        const tl = timelineRef.current;
        const hit = tl ? clipAtPlayhead(tl, ph, "video") : videoUnderRef.current;
        if (hit) {
          const target = previewTarget(hit.clip);
          video.currentTime =
            mediaTimeForClip(hit.clip, ph) - (target.path === previewPath ? target.shift : 0);
        }
        syncAudioLocal();
        syncAudio2();
        if (shouldResume || playingRef.current) {
          void video
            .play()
            .then(() => setPlaying(true))
            .catch((err: unknown) => {
              // An interrupted play() request (a boundary paused the element
              // again) must never tear down the whole playback session.
              if ((err as { name?: string } | null)?.name === "AbortError") return;
              setPlaying(false);
            });
          if (wantAudioSrc && audio) {
            void audio.play().catch(() => undefined);
          }
        }
      };
      video.addEventListener("loadedmetadata", onMeta, { once: true });
      return () => video.removeEventListener("loadedmetadata", onMeta);
    }

    if (!needVideoLoad && !needAudioLoad) {
      // Sources already loaded — seek only when out of sync (no reload).
      if (previewMode === "video" && video) {
        const ph = playheadRef.current;
        const tl = timelineRef.current;
        const hit = tl ? clipAtPlayhead(tl, ph, "video") : videoUnderRef.current;
        if (hit) {
          const target = previewTarget(hit.clip);
          const want =
            mediaTimeForClip(hit.clip, ph) - (target.path === previewPath ? target.shift : 0);
          if (Math.abs(video.currentTime - want) > 0.05) {
            video.currentTime = want;
          }
        }
        if (shouldResume && video.paused) {
          void video
            .play()
            .then(() => setPlaying(true))
            .catch((err: unknown) => {
              // An interrupted play() request (a boundary paused the element
              // again) must never tear down the whole playback session.
              if ((err as { name?: string } | null)?.name === "AbortError") return;
              setPlaying(false);
            });
          if (wantAudioSrc && audio && audio.paused) {
            void audio.play().catch(() => undefined);
          }
        }
        // The A-track clip ended (timelineAudioSrc cleared) while the video
        // keeps previewing: stop the element — it must never outlive its clip.
        if (!wantAudioSrc && audio && !audio.paused) {
          audio.pause();
        }
      }
      if (previewMode === "audio" && audio) {
        syncAudioLocal();
        if (shouldResume && audio.paused) {
          void audio
            .play()
            .then(() => setPlaying(true))
            .catch((err: unknown) => {
              if ((err as { name?: string } | null)?.name === "AbortError") return;
              setPlaying(false);
            });
        }
      }
      return;
    }

    if (previewMode === "audio" && needAudioLoad && audio && wantAudioSrc) {
      const onMeta = () => {
        syncAudioLocal();
        if (shouldResume || playingRef.current) {
          void audio
            .play()
            .then(() => setPlaying(true))
            .catch((err: unknown) => {
              if ((err as { name?: string } | null)?.name === "AbortError") return;
              setPlaying(false);
            });
        }
      };
      audio.addEventListener("loadedmetadata", onMeta, { once: true });
      return () => audio.removeEventListener("loadedmetadata", onMeta);
    }
  }, [previewSrc, previewPath, timelineAudioSrc, timelineAudio2Src, previewMode, audioUnderPlayhead2]);

  /** Re-detect which clips cover the playhead. Runs on every seek frame and
   * playback tick, but only touches React state when the covering set actually
   * changes (clip boundary crossings / timeline edits replacing clip objects). */
  const updateUnderPlayhead = useCallback((t: number) => {
    const tl = timelineRef.current;
    if (!tl) {
      if (videoStackRef.current.length !== 0) {
        videoStackRef.current = [];
        videoUnderRef.current = null;
        setVideoStack([]);
      }
      if (audioUnderRef.current) {
        audioUnderRef.current = null;
        setAudioUnderPlayhead(null);
      }
      if (audioUnder2Ref.current) {
        audioUnder2Ref.current = null;
        setAudioUnderPlayhead2(null);
      }
      return;
    }
    const stack = videoStackAtPlayhead(tl, t);
    const prevStack = videoStackRef.current;
    // Compare OBJECT identity, not just ids: reconcile replaces the clip
    // object whenever its content changed (filter edits — blur region, BG
    // key, transform, text), keeping the id. An id-only compare left the
    // React state on the pre-edit clip, so every monitor tool derived from
    // it (blurRegion/keyFilters/transform/text) rendered stale params and
    // committed gestures snapped back.
    const stackChanged =
      stack.length !== prevStack.length ||
      stack.some((s, i) => s.clip !== prevStack[i]?.clip);
    videoUnderRef.current = stack[0] ?? null;
    if (stackChanged) {
      videoStackRef.current = stack;
      setVideoStack(stack);
    }
    const aHit = clipAtPlayhead(tl, t, "audio");
    if (
      (aHit?.clip.id ?? null) !== (audioUnderRef.current?.clip.id ?? null) ||
      (aHit && aHit.clip !== audioUnderRef.current?.clip)
    ) {
      audioUnderRef.current = aHit;
      setAudioUnderPlayhead(aHit);
    }
    const a2 = secondAudioAt(tl, t, aHit?.clip.id ?? null);
    if (
      (a2?.clip.id ?? null) !== (audioUnder2Ref.current?.clip.id ?? null) ||
      (a2 && a2.clip !== audioUnder2Ref.current?.clip)
    ) {
      audioUnder2Ref.current = a2;
      setAudioUnderPlayhead2(a2);
    }
  }, []);

  const commitPlayhead = useCallback(
    (t: number, immediate = false) => {
      const next = Math.max(0, t);
      playheadRef.current = next;
      // Live playhead line moves with zero React involvement.
      movePlayheadRef.current?.(next);
      updateUnderPlayhead(next);
      // Time displays (timecodes, sliders, overlay-layer styles) subscribe to
      // the clock store. Playback publishes are throttled internally to
      // PLAYHEAD_UI_MS; paused seeks publish immediately so they are exact.
      playbackClock.publish(next, immediate || !playingRef.current);
    },
    [updateUnderPlayhead],
  );

  /** Timeline edits can move/replace clips under a stationary playhead —
   * refresh the covering set whenever the timeline changes. */
  useEffect(() => {
    updateUnderPlayhead(playheadRef.current);
  }, [timeline, updateUnderPlayhead]);


  /** Master playback clock — ONE self-sufficient loop (see the tick below).
   *
   * Video mode uses requestVideoFrameCallback when available: each PRESENTED
   * decoded frame carries its media timestamp, so the playhead is derived
   * from actual frame delivery — no sampling jitter, correct behavior for
   * 23.976/29.97/50/59.94/60 fps content. rAF sampling remains the fallback,
   * and the same loop drives audio-only playback, gaps and still images. */
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let stopped = false;
    let lastWall = performance.now();

    /** Shared per-frame advance: map a media-file time to the timeline,
     * keep A-track/overdub audio locked, and handle cuts / gaps / end. */
    const advance = (mode: "video" | "audio", active: HTMLMediaElement, mediaTime: number) => {
      const tl = timelineRef.current;
      // The covering clip is maintained by commitPlayhead's boundary
      // detection — no per-frame timeline scan needed here.
      const hit =
        mode === "video" ? videoUnderRef.current : audioUnderRef.current;
      if (!hit) return;

      // Still images have no media clock — the wall path advances the
      // playhead across them while the monitor shows the picture.
      if (mode === "video" && isImagePath(hit.clip.media_path)) return;

      const speed = clipSpeed(hit.clip);
      // Clip-scoped sidecar: element time runs in sidecar time (t=0 is
      // scopeIn); convert to source media time before mapping to the timeline.
      // The shift only applies once the element actually plays the sidecar —
      // between a render finishing and the source swap landing, the element
      // still holds the original, whose time needs no shift.
      const target = previewTarget(hit.clip);
      const elSrc = active.getAttribute("src");
      const shift =
        elSrc && convertFileSrcSafe(target.path) === elSrc ? target.shift : 0;
      const srcMedia = mediaTime + shift;
      const reversed = mode === "video" && !!hit.clip.reverse;
      const localMedia = reversed
        ? hit.clip.out_point - srcMedia
        : srcMedia - hit.clip.in_point;
      const timelineTime = hit.clip.start + localMedia / speed;
      commitPlayhead(Math.max(hit.clip.start, timelineTime), false);

      // Keep A-track audio locked to the video clock (and the overdub layer
      // in every mode — the same timeline-time → media-time mapping applies).
      const audio = audioRef.current;
      const audioHit = audioUnderRef.current;
      // Overdub layer (voiceover on another track) follows the same clock.
      const audio2 = audio2Ref.current;
      const audioHit2 = audioUnder2Ref.current;
      if (audio2 && audioHit2) {
        const want2 = audioHit2.clip.in_point + (timelineTime - audioHit2.clip.start);
        const clamped2 = Math.max(
          audioHit2.clip.in_point,
          Math.min(want2, audioHit2.clip.out_point - 0.01),
        );
        if (audio2.getAttribute("src")) {
          if (audio2.paused) {
            if (playingRef.current) void audio2.play().catch(() => undefined);
          } else if (Math.abs(audio2.currentTime - clamped2) > 0.12) {
            audio2.currentTime = clamped2;
          }
        }
      }
      if (audio && audioHit && !audio.paused) {
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
      } else if (mode === "video" && audio && !audioHit && !audio.paused) {
        // The A-track audio clip ended (or none covers the playhead) while
        // the video clock keeps driving: stop the element — audio must never
        // outlive its clip, or it keeps playing the raw file for minutes.
        audio.pause();
      }

      // Cut / gap / end-of-clip handling. `active.ended` covers media whose
      // file ends (a hair) before the clip's out_point — without it the
      // boundary never fires and the playhead pins at the last mapped frame.
      const clipEnd = hit.clip.start + clipTimelineDuration(hit.clip);
      if (
        timelineTime >= clipEnd - 0.02 ||
        active.currentTime >= hit.clip.out_point - shift - 0.02 ||
        active.ended
      ) {
        const next = tl
          ? nextClipAfter(tl, clipEnd, mode === "video" ? "video" : "audio")
          : null;
        if (next && next.clip.id !== hit.clip.id) {
          const nextTarget = previewTarget(next.clip);
          // "Same media" means the same PLAYING file: two adjacent instances
          // of one source can carry different scoped sidecars, and those must
          // take the cut path (source swap) instead of an in-file seek.
          const isSameMedia = nextTarget.path === target.path;
          const isContiguousTimeline = next.clip.start <= clipEnd + 0.04;
          const isContinuousMedia =
            Math.abs(hit.clip.out_point - next.clip.in_point) < 0.05;

          if (isSameMedia && isContiguousTimeline && isContinuousMedia) {
            // Seamless continuous playback across the split point: the source
            // file is continuous, so the element keeps rolling. Commit the
            // mapped position — never jump the playhead backwards to the
            // boundary, which stuttered at every split.
            if (active.ended) {
              // The file ended exactly at the boundary: restart into the
              // next clip's source range.
              try {
                active.currentTime = next.clip.in_point - nextTarget.shift;
              } catch {
                /* metadata not ready */
              }
              if (playingRef.current) void active.play().catch(() => undefined);
            }
            commitPlayhead(Math.max(next.clip.start, timelineTime), false);
            return;
          } else if (isSameMedia && isContiguousTimeline) {
            // Same media, in_point jumped: seek within the loaded file.
            try {
              active.currentTime = next.clip.in_point - nextTarget.shift;
            } catch {
              /* metadata not ready */
            }
            if (active.ended && playingRef.current) {
              void active.play().catch(() => undefined);
            }
            commitPlayhead(next.clip.start, false);
            return;
          } else if (isContiguousTimeline) {
            // Cut to different media
            resumePlayRef.current = playingRef.current;
            transitioningRef.current = true;
            active.pause();
            audioRef.current?.pause();
            audio2Ref.current?.pause();
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
        // Keep the A-track/overdub elements rolling when their clips still
        // cover the boundary — the wall path owns them from here; killing
        // them here made every video-end → audio-continues handoff blip.
        const audioCovered = tl ? clipAtPlayhead(tl, clipEnd, "audio") : null;
        if (!audioCovered) audioRef.current?.pause();
        const audio2Covered = tl
          ? secondAudioAt(tl, clipEnd, audioCovered?.clip.id ?? null)
          : null;
        if (!audio2Covered) audio2Ref.current?.pause();
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

    /** The ONE self-sufficient playback loop. Runs in every preview mode for
     * the whole session and decides per tick who owns the playhead:
     *  1. real video under the playhead with frames flowing → the presented-
     *     frame chain (below), with this loop as its 100 ms fallback sampler;
     *  2. an audio clip under the playhead with the element playing → the
     *     media-element clock via advance();
     *  3. everything else (gaps, still images, empty stretches, media paused
     *     mid-handoff) → wall-clock advance with media play/pause hand-off.
     *
     * Boundary continuation must never depend on React effects re-running:
     * the old split (master clock + gap ticker keyed on previewMode) froze
     * playback whenever a clip boundary left previewMode unchanged (multi-
     * track overlaps) and double-drove the playhead in audio mode. */
    let lastFrameClockCommit = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (stopped || !playingRef.current) return;
      // Reverse playback (own rAF stepper) and source swaps (load effect)
      // own the media while their windows are open.
      if (reverseRafRef.current) return;
      if (transitioningRef.current) return;
      const tl = timelineRef.current;
      if (!tl) return;

      const vUnder = videoUnderRef.current;
      const video = videoRef.current;
      const audio = audioRef.current;

      // 1. Real video playing → the presented-frame clock rules.
      if (
        vUnder &&
        !isImagePath(vUnder.clip.media_path) &&
        video &&
        !video.paused &&
        !video.ended
      ) {
        if (performance.now() - lastFrameClockCommit >= 100) {
          advance("video", video, video.currentTime);
        }
        return;
      }

      // 2. Audio-only stretch with the element playing → element clock.
      const aUnder = audioUnderRef.current;
      if (
        !vUnder &&
        aUnder &&
        audio &&
        !audio.paused &&
        !audio.ended &&
        audio.getAttribute("src")
      ) {
        advance("audio", audio, audio.currentTime);
        return;
      }

      // 3. Wall-clock path.
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastWall) / 1000);
      lastWall = now;
      const t = playheadRef.current + dt;
      const dur = timelineDuration(tl, 10);
      if (t >= dur) {
        commitPlayhead(dur, true);
        playingRef.current = false;
        setPlaying(false);
        videoRef.current?.pause();
        audioRef.current?.pause();
        audio2Ref.current?.pause();
        return;
      }

      const vHit = clipAtPlayhead(tl, t, "video");
      const handOffToVideo = !!vHit && !isImagePath(vHit.clip.media_path);
      if (handOffToVideo) resumePlayRef.current = true;
      commitPlayhead(t, handOffToVideo);
      if (handOffToVideo && vHit) {
        // Reached real video again — hand the clock back to the element
        // (idempotent with the load effect; covers same-file handoffs where
        // no source change re-runs it).
        ensureVideoPlaying(vHit.clip, t);
      }
      syncPlaybackAudio(tl, t);
    };
    raf = requestAnimationFrame(tick);

    /** Presented-frame chain: superseded chains (after a source swap or a
     * re-arm) go inert via the generation guard instead of piling up. */
    let chainId = 0;
    const armFrameClock = () => {
      const v = videoRef.current;
      if (!v || stopped) return;
      if (!("requestVideoFrameCallback" in v)) return;
      const my = ++chainId;
      const step = (_now: number, meta: { mediaTime: number }) => {
        if (stopped || !playingRef.current || my !== chainId) return;
        if (previewModeRef.current === "video" && !v.paused) {
          lastFrameClockCommit = performance.now();
          advance("video", v, meta.mediaTime);
        }
        v.requestVideoFrameCallback(step);
      };
      v.requestVideoFrameCallback(step);
    };
    armFrameClock();

    // After a mid-playback source swap (cut to different media) the old
    // chain dies with the element's source; restart it when frames flow.
    const videoEl = videoRef.current;
    const onFramesFlowing = () => {
      if (playingRef.current) armFrameClock();
    };
    videoEl?.addEventListener("playing", onFramesFlowing);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      videoEl?.removeEventListener("playing", onFramesFlowing);
    };
  }, [playing, commitPlayhead]);

  // Media element state listeners (play/pause/error).
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
      if (!isActiveElement(ev)) return;
      // The engine pauses media deliberately at cuts/gaps while the session
      // keeps playing — only a pause with no live session stops playback.
      if (playingRef.current || transitioningRef.current) return;
      cancelAnimationFrame(reverseRafRef.current);
      reverseRafRef.current = 0;
      playingRef.current = false;
      setPlaying(false);
      audio?.pause();
      audio2Ref.current?.pause();
      commitPlayhead(playheadRef.current, true);
    };
    const onErr = (ev: Event) => {
      if (!isActiveElement(ev)) return;
      setPreviewError("Could not load preview.");
    };
    // Buffer starvation: surface it, never freeze the clock — the playhead
    // resumes with the media element ('playing' fires when frames return).
    let bufferingTicked = false;
    const onWaiting = () => {
      if (!playingRef.current || bufferingTicked) return;
      bufferingTicked = true;
      setStatus("Buffering…");
    };
    const onRecover = () => {
      if (bufferingTicked) {
        bufferingTicked = false;
        setStatus("");
      }
    };

    active.addEventListener("play", onPlay);
    active.addEventListener("pause", onPause);
    active.addEventListener("error", onErr);
    active.addEventListener("waiting", onWaiting);
    active.addEventListener("stalled", onWaiting);
    active.addEventListener("playing", onRecover);
    return () => {
      active.removeEventListener("play", onPlay);
      active.removeEventListener("pause", onPause);
      active.removeEventListener("error", onErr);
      active.removeEventListener("waiting", onWaiting);
      active.removeEventListener("stalled", onWaiting);
      active.removeEventListener("playing", onRecover);
    };
  }, [previewMode, timelineAudioSrc, commitPlayhead]);

  async function importPaths(paths: string[]) {
    const mediaPaths = paths.filter(isMediaPath);
    if (mediaPaths.length === 0) {
      setStatus("No supported media files");
      return;
    }
    try {
      setBusy(true);
      const imported: LibraryItem[] = [];
      let skipped = 0;
      for (const path of mediaPaths) {
        // Already in the bin? Reuse it instead of creating a duplicate entry.
        if (library.some((m) => m.path === path)) {
          imported.push(library.find((m) => m.path === path)!);
          skipped += 1;
          continue;
        }
        setStatus(`Importing ${fileName(path)}…`);
        const info = await invoke<MediaInfo>("import_media", { path });
        imported.push({
          ...info,
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: fileName(path),
        });
      }
      // Dedupe inside the updater so rapid consecutive imports can't double-add.
      setLibrary((prev) => {
        const known = new Set(prev.map((m) => m.path));
        const fresh = imported.filter((m) => !known.has(m.path));
        return fresh.length > 0 ? [...fresh, ...prev] : prev;
      });
      const last = imported[0];
      if (last) {
        setSelectedMediaId(last.id);
        setBinFilter("media");
      }
      const base =
        imported.length === 1
          ? `Imported ${imported[0].name}`
          : `Imported ${imported.length} files`;
      setStatus(skipped > 0 ? `${base} · ${skipped} already in project` : base);
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Drop routed to the Project Monitor: images become timeline clips at the
   * playhead (imported to the bin like any media), text files become a Text
   * filter on the clip under the playhead. Other files fall back to the bin. */
  async function handleMonitorDrop(paths: string[]) {
    const images = paths.filter((p) => isImagePath(p));
    const texts = paths.filter((p) => isTextPath(p));
    const others = paths.filter((p) => !isImagePath(p) && !isTextPath(p));
    if (images.length > 0) {
      await importPaths(images);
      await dropImagesOnMonitor(images);
    }
    for (const p of texts) {
      await dropTextOnMonitor(p);
    }
    if (others.length > 0) {
      await importPaths(others);
    }
  }

  /** Place dropped images sequentially on the timeline starting at the
   * playhead, chaining each next start after the previous clip's end. When
   * video is under the playhead the image becomes an overlay layer, so give
   * it a sensible PiP size instead of covering the whole frame. */
  async function dropImagesOnMonitor(paths: string[]) {
    const overVideo = hasVideoAtPlayhead();
    let cursor = playheadRef.current;
    for (const path of paths) {
      const next = await engineEdit<Timeline>(
        "add_media_to_timeline",
        {
          mediaPath: path,
          start: cursor,
        },
        { onError: (e) => setStatus(String(e)) },
      );
      if (!next) continue;
      const tl = normalizeTimeline(next);
      setTimeline(tl);
      const placed = tl.tracks
        .flatMap((t) => t.clips)
        .filter((c) => c.media_path === path)
        .sort((a, b) => a.start - b.start)[0];
      if (placed) {
        cursor = placed.start + clipTimelineDuration(placed);
        setSelectedClipId(placed.id);
        if (overVideo && !(placed.filters ?? []).some((f) => f.kind === "transform")) {
          const withTf = await engineEdit<Timeline>("add_filter", {
            clipId: placed.id,
            kind: "transform",
            params: { x: 0, y: 0, scale: 0.5, rotation: 0, opacity: 1 },
          });
          if (withTf) setTimeline(normalizeTimeline(withTf));
          /* overlay still works full-frame without the default size */
        }
      }
      setStatus(
        overVideo
          ? `Placed ${fileName(path)} over the video — drag it in the monitor to position it`
          : `Placed ${fileName(path)} on the timeline`,
      );
    }
  }

  /** Turn a dropped text file into a Text (drawtext) filter on the clip under
   * the playhead, preserving any existing text styling. */  async function dropTextOnMonitor(path: string) {
    const clip = videoUnderRef.current?.clip;
    if (!clip) {
      setStatus("Park the playhead on a clip, then drop the text file to add a title");
      return;
    }
    let content: string;
    try {
      content = await invoke<string>("read_text_file", { path });
    } catch (e) {
      setStatus(String(e));
      return;
    }
    const text = content.replace(/\r\n/g, "\n").trim();
    if (!text) {
      setStatus(`${fileName(path)} is empty`);
      return;
    }
    // Keep the drawtext payload within sane filtergraph sizes.
    const clipped = text.length > 2000 ? text.slice(0, 2000) : text;
    const filters = clip.filters ?? [];
    const existing = filters.find((f) => f.kind === "text");
    const prevParams = (existing?.params ?? {}) as Record<string, unknown>;
    const params = {
      size: 6,
      color: "#ffffff",
      x: 0,
      y: 0.55,
      box: true,
      ...prevParams,
      text: clipped,
    };
    const updated = existing
      ? await engineEdit<Timeline>(
          "update_filter",
          {
            clipId: clip.id,
            filterId: existing.id,
            params,
          },
          { onError: (e) => setStatus(String(e)) },
        )
      : await engineEdit<Timeline>(
          "add_filter",
          {
            clipId: clip.id,
            kind: "text",
            params,
          },
          { onError: (e) => setStatus(String(e)) },
        );
    if (!updated) return;
    setTimeline(normalizeTimeline(updated));
    setSelectedClipId(clip.id);
    setStatus(existing ? `Title updated from ${fileName(path)}` : `Added title from ${fileName(path)}`);
  }

  /** Images from the project bin for the monitor's image picker — deduped
   * by path so the same file never shows twice. */
  const monitorImages = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; name: string; path: string; src: string }[] = [];
    for (const m of library) {
      if (!isImagePath(m.path) || seen.has(m.path)) continue;
      seen.add(m.path);
      let src = m.path;
      try {
        src = convertFileSrc(m.path);
      } catch {
        /* fall back to the raw path */
      }
      out.push({ id: m.id, name: m.name, path: m.path, src });
    }
    return out;
  }, [library]);

  /** Picker context: what will the image land on at the playhead? */
  const imagePickerContext = videoUnderPlayhead
    ? `Will place over "${fileName(videoUnderPlayhead.clip.media_path)}" — drag it in the monitor after`
    : hasTimelineClips
      ? "The playhead is in a gap — the image will attach to the nearest video"
      : "It will be placed at the playhead";

  /** Fresh check: does ANY visible video clip cover the playhead? Reads the
   * latest timeline ref — the React-state mirror (videoUnderRef) lags one
   * render behind, which silently skipped the PiP default on placements. */
  function hasVideoAtPlayhead(): boolean {
    const tl = timelineRef.current;
    const ph = playheadRef.current;
    if (!tl) return false;
    return tl.tracks.some(
      (t) =>
        t.kind === "video" &&
        !t.hidden &&
        t.clips.some((c) => ph >= c.start && ph < c.start + clipTimelineDuration(c)),
    );
  }

  /** When the playhead sits in a gap, snap image placements onto the nearest
   * video clip so overlays always land over visible content. */
  function nearestVideoTargetTime(): number | null {
    if (videoUnderRef.current) return null; // already over video
    const tl = timelineRef.current;
    if (!tl) return null;
    const clips = tl.tracks
      .filter((t) => t.kind === "video" && !t.hidden)
      .flatMap((t) => t.clips);
    if (clips.length === 0) return null;
    const ph = playheadRef.current;
    const nearest = clips.reduce((best, c) => {
      const end = c.start + clipTimelineDuration(c);
      const dist = ph < c.start ? c.start - ph : ph > end ? ph - end : 0;
      return dist < best.dist ? { c, dist } : best;
    }, { c: clips[0], dist: Number.MAX_VALUE }).c;
    const end = nearest.start + clipTimelineDuration(nearest);
    return Math.max(nearest.start, Math.min(ph, end - 0.1));
  }

  /** Image picker "Browse from disk": pick files, import to the bin, place
   * them at the playhead as overlays. Snaps to the nearest video when the
   * playhead is in a gap so the overlay lands over visible content. */
  async function browseAndPlaceImages() {
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "Images", extensions: [...IMAGE_EXTENSIONS] }],
      });
      if (!selected) return;
      const paths = (Array.isArray(selected) ? selected : [selected]).filter((p) =>
        isImagePath(p),
      );
      if (paths.length === 0) {
        setStatus("No image files selected");
        return;
      }
      const targetTime = nearestVideoTargetTime();
      if (targetTime != null) seekTimeline(targetTime);
      await handleMonitorDrop(paths);
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function onImport() {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          { name: "All Media", extensions: [...MEDIA_EXTENSIONS] },
          {
            name: "Video",
            extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v"],
          },
          { name: "Audio", extensions: ["mp3", "wav", "aac", "m4a", "flac", "ogg"] },
          { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await importPaths(paths);
    } catch (e) {
      setStatus(String(e));
    }
  }

  /** Cache the webview client-area offset (physical px) once so drag-drop
   * positions can be converted to CSS client coordinates. */
  const registerMonitorDropTarget = useCallback((el: HTMLDivElement | null) => {
    monitorFrameRef.current = el;
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    /** Drag-drop positions arrive in physical px relative to the webview
     * surface; CSS client px are logical, so divide by the device scale. */
    const dragEventToClient = (pos: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1;
      return { x: pos.x / dpr, y: pos.y / dpr };
    };

    const monitorDropLabel = (paths: string[]): string | null => {
      const hasImg = paths.some((p) => isImagePath(p));
      const hasTxt = paths.some((p) => isTextPath(p));
      if (hasImg && hasTxt) return "Drop images & text — images place at the playhead, text becomes a title";
      if (hasImg) return "Drop to place images on the timeline at the playhead";
      if (hasTxt) return "Drop to add a title from the text file";
      return null;
    };

    const updateHover = (paths: string[] | null, pos: { x: number; y: number } | null) => {
      if (!paths || !pos) {
        setMonitorFileDrop(false);
        setMonitorFileDropLabel(null);
        setDragOver(false);
        return;
      }
      const label = monitorDropLabel(paths);
      const overMonitor = !!label && pointInElement(pos.x, pos.y, monitorFrameRef.current);
      setMonitorFileDrop(overMonitor);
      setMonitorFileDropLabel(label);
      setDragOver(!overMonitor);
    };

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const { type } = event.payload;
        if (type === "enter") {
          monitorDropPathsRef.current = [...event.payload.paths];
          updateHover(monitorDropPathsRef.current, dragEventToClient(event.payload.position));
        } else if (type === "over") {
          updateHover(monitorDropPathsRef.current, dragEventToClient(event.payload.position));
        } else if (type === "leave") {
          monitorDropPathsRef.current = null;
          updateHover(null, null);
        } else if (type === "drop") {
          const paths = event.payload.paths;
          const pos = dragEventToClient(event.payload.position);
          const overMonitor =
            !!monitorDropLabel(paths) && pointInElement(pos.x, pos.y, monitorFrameRef.current);
          monitorDropPathsRef.current = null;
          setMonitorFileDrop(false);
          setMonitorFileDropLabel(null);
          setDragOver(false);
          if (overMonitor) {
            void handleMonitorDrop(paths);
          } else {
            void importPaths(paths);
          }
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

  async function addMediaToTimeline(media: LibraryItem, explicitStart?: number) {
    const overVideo = hasVideoAtPlayhead();
    const tl = timelineRef.current;
    let start = explicitStart;
    if (start == null && tl) {
      const vEnd = tl.tracks
        .filter((t) => t.kind === "video" && !t.hidden && !t.locked)
        .flatMap((t) => t.clips)
        .reduce((max, c) => Math.max(max, c.start + clipTimelineDuration(c)), 0);
      const aEnd = tl.tracks
        .filter((t) => t.kind === "audio" && !t.hidden && !t.locked)
        .flatMap((t) => t.clips)
        .reduce((max, c) => Math.max(max, c.start + clipTimelineDuration(c)), 0);
      start = Math.max(vEnd, aEnd);
    }
    const targetStart = start ?? playheadRef.current;
    try {
      setBusy(true);
      const next = await engineEdit<Timeline>(
        "add_media_to_timeline",
        {
          mediaPath: media.path,
          start: targetStart,
        },
        { onError: (e) => setStatus(String(e)) },
      );
      if (!next) return;
      let tlUpdated = normalizeTimeline(next);
      // Select the clip that was actually placed (Rust stores the playback
      // path, so match on the original source_path).
      const placed =
        tlUpdated.tracks
          .flatMap((t) => t.clips)
          .find(
            (c) =>
              (c.source_path === media.path || c.media_path === media.path) &&
              Math.abs(c.start - targetStart) < 0.05,
          ) ??
        tlUpdated.tracks.flatMap((t) => t.clips).sort((a, b) => b.start - a.start)[0];
      if (placed) {
        setSelectedClipId(placed.id);
        // Images dropped over video become PiP: give them a sensible size.
        if (
          overVideo &&
          isImagePath(media.path) &&
          !(placed.filters ?? []).some((f) => f.kind === "transform")
        ) {
          const withTf = await engineEdit<Timeline>(
            "add_filter",
            {
              clipId: placed.id,
              kind: "transform",
              params: { x: 0, y: 0, scale: 0.5, rotation: 0, opacity: 1 },
            },
          );
          if (withTf) {
            tlUpdated = normalizeTimeline(withTf);
            setTimeline(tlUpdated);
          }
          /* overlay still works full-frame without the default size */
        }
        seekTimeline(placed.start);
      }
      setTimeline(tlUpdated);
      const kind =
        media.has_video && media.has_audio
          ? "linked V+A"
          : media.has_video
            ? "video"
            : "audio";
      setStatus(`Added ${media.name} as ${kind} at ${formatTime(placed ? placed.start : targetStart)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onUndo() {
    const seq = nextSeq();
    try {
      const next = normalizeTimeline(await invoke<Timeline>("undo"));
      if (!isCurrent(seq)) return; // a newer edit superseded this undo
      recordEngine(next);
      setTimeline(next);
      setStatus("Undo");
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function onRedo() {
    const seq = nextSeq();
    try {
      const next = normalizeTimeline(await invoke<Timeline>("redo"));
      if (!isCurrent(seq)) return; // a newer edit superseded this redo
      recordEngine(next);
      setTimeline(next);
      setStatus("Redo");
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function onRemove() {
    if (!selectedClipId) return;
    const next = await engineEdit<Timeline>(
      "remove_clip",
      {
        clipId: selectedClipId,
        removeLinked: true,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!next) return;
    setTimeline(normalizeTimeline(next));
    setSelectedClipId(null);
    setStatus("Clip deleted");
  }

  async function onRippleDelete() {
    if (!selectedClipId) return;
    const next = await engineEdit<Timeline>(
      "ripple_delete",
      {
        clipId: selectedClipId,
        removeLinked: true,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!next) return;
    setTimeline(normalizeTimeline(next));
    setSelectedClipId(null);
    setStatus("Ripple delete");
  }

  async function onToggleLink() {
    if (!selectedClipId || !selectedClip || !timeline) return;
    if (selectedClip.clip.linked_clip_id) {
      const next = await engineEdit<Timeline>(
        "unlink_clip",
        { clipId: selectedClipId },
        { onError: (e) => setStatus(String(e)) },
      );
      if (!next) return;
      setTimeline(normalizeTimeline(next));
      setStatus("Unlinked");
      return;
    }
    const partner = findLinkPartner(timeline, selectedClip.clip, playheadRef.current);
    if (!partner) {
      setStatus("No audio/video partner found to link");
      return;
    }
    const next = await engineEdit<Timeline>(
      "link_clips",
      {
        clipA: selectedClip.clip.id,
        clipB: partner.id,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!next) return;
    setTimeline(normalizeTimeline(next));
    setStatus("Linked A/V");
  }

  async function onFilter(kind: string) {
    if (!selectedClipId || !selectedClip) {
      setStatus("Select a timeline clip first");
      return;
    }
    // Magic Remove is a monitor tool, not a slider effect: opening the tool
    // is the whole flow (the filter is created on the first brush stroke).
    if (kind === "magicremove") {
      toggleMagicTool(true);
      return;
    }
    // The Blur Region and BG Key tools likewise live in the Project Monitor.
    if (kind === "blurregion") {
      toggleBlurTool(true);
      return;
    }
    if (kind === "bgmask") {
      toggleKeyTool("area");
      return;
    }
    if (kind === "chromakey") {
      toggleKeyTool("chroma");
      return;
    }
    const roles = EFFECT_CATALOG.find((e) => e.id === kind)?.roles;
    if (roles && !roles.includes(selectedClip.clip.role)) {
      setStatus(`${kind} is for ${roles.join("/")} clips`);
      return;
    }
    if (kind === "pitch") {
      setStatus(
        "Add Change voice, then set semitones under Applied (or use Advanced Audio Tools)",
      );
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
    const onError = (e: unknown) => setStatus(String(e));
    if (kind === "volume") {
      const gain =
        typeof params?.gain === "number" ? (params.gain as number) : 1;
      let vol = hit.clip.filters?.find((f) => f.kind === "volume");
      let next: Timeline | null;
      if (!vol) {
        next = await engineEdit<Timeline>(
          "add_filter",
          {
            clipId,
            kind: "volume",
            params: { gain },
          },
          { onError },
        );
        if (!next) return null;
        next = normalizeTimeline(next);
        vol = next.tracks
          .flatMap((t) => t.clips)
          .find((c) => c.id === clipId)
          ?.filters?.find((f) => f.kind === "volume");
      } else {
        next = await engineEdit<Timeline>(
          "update_filter",
          {
            clipId,
            filterId: vol.id,
            params: { gain },
          },
          { onError },
        );
        if (!next) return null;
        next = normalizeTimeline(next);
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
        const resp = await engineEdit<Timeline>(
          "update_filter",
          {
            clipId,
            filterId: existing.id,
            params: nextParams,
          },
          { onError },
        );
        if (!resp) return null;
        const next = normalizeTimeline(resp);
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

    const resp = await engineEdit<Timeline>(
      "add_filter",
      {
        clipId,
        kind,
        params: { ...defaultParams(kind), ...(params ?? {}) },
      },
      { onError },
    );
    if (!resp) return null;
    const next = normalizeTimeline(resp);
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
  }

  /** Filter-param commits MUST be serialized and merged into the SAVED
   * params read fresh from timelineRef — never into render-state props.
   * Sliders and overlay gestures fire faster than the IPC round-trip;
   * merging into a stale snapshot silently reverted every earlier change in
   * a burst (the UI kept the value, the clip did not — the classic "slider
   * moved but nothing happened" bug). One global chain keeps every filter
   * commit (magic panel, blur region, BG key, inspector) strictly ordered:
   * each applies on top of the previous response. */
  const filterCommitChainRef = useRef<Promise<unknown>>(Promise.resolve());

  function queueFilterCommit<T>(fn: () => Promise<T>): Promise<T> {
    const chained = filterCommitChainRef.current.then(fn, fn);
    filterCommitChainRef.current = chained.catch(() => {});
    return chained;
  }

  /** The engine-confirmed params of a filter, read at commit time. */
  function savedFilterParams(
    clipId: string,
    filterId: string,
  ): { params: Record<string, unknown>; kind: string } | null {
    const clip = timelineRef.current?.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId);
    const f = clip?.filters?.find((x) => x.id === filterId);
    if (!f) return null;
    return {
      params: (f.params ?? {}) as Record<string, unknown>,
      kind: f.kind,
    };
  }

  /** Merge a patch into a filter's SAVED params (queued, fresh-read). */
  async function commitFilterParamsOnClip(
    clipId: string,
    filterId: string,
    patch: Record<string, unknown>,
  ): Promise<Timeline | null> {
    return queueFilterCommit(async () => {
      const saved = savedFilterParams(clipId, filterId);
      if (!saved) return null;
      const merged = { ...saved.params, ...patch };
      invalidateStaleMagicRender(saved.kind, patch, merged);
      return updateFilterParamsOnClip(clipId, filterId, merged);
    });
  }

  /** Magic Remove bakes its result into a sidecar whose identity is the
   * render key (strokes/keyframes/feather/expand/accuracy/strength). When one
   * of those changes, a stored render no longer matches: drop it so preview
   * AND export fall back to the original instead of exporting a stale mask.
   * `status: "stale"` keeps the "press ✨ Remove to re-render" hint visible. */
  const MAGIC_RENDER_KEYS = [
    "strokes",
    "keyframes",
    "feather",
    "expand",
    "trackingAccuracy",
    "removalStrength",
  ] as const;

  function invalidateStaleMagicRender(
    kind: string,
    patch: Record<string, unknown>,
    merged: Record<string, unknown>,
  ) {
    if (kind !== "magicremove") return;
    if ("resultPath" in patch || "renderKey" in patch) return;
    const touchesRender = Object.keys(patch).some((k) =>
      (MAGIC_RENDER_KEYS as readonly string[]).includes(k),
    );
    if (!touchesRender) return;
    if (!merged.resultPath) return;
    merged.resultPath = "";
    merged.renderKey = "";
    merged.status = "stale";
  }

  async function updateFilterParams(
    filterId: string,
    params: Record<string, unknown>,
    replace = false,
  ) {
    if (!selectedClipId) return;
    const clipId = selectedClipId;
    await queueFilterCommit(async () => {
      const saved = savedFilterParams(clipId, filterId);
      if (!saved) return;
      // Patch mode (slider edits): apply only the changed keys on top of the
      // saved params so concurrent/rapid edits never clobber each other and
      // opaque blobs like magic strokes survive. Replace mode (Reset to
      // default): the incoming object IS the new state.
      const merged = replace ? params : { ...saved.params, ...params };
      invalidateStaleMagicRender(saved.kind, replace ? {} : params, merged);
      await updateFilterParamsOnClip(clipId, filterId, merged);
    });
  }

  async function toggleFilter(filterId: string, enabled: boolean) {
    if (!selectedClipId) return;
    const next = await engineEdit<Timeline>(
      "set_filter_enabled",
      {
        clipId: selectedClipId,
        filterId,
        enabled,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (next) setTimeline(normalizeTimeline(next));
  }

  async function removeFilter(filterId: string) {
    if (!selectedClipId) return;
    const next = await engineEdit<Timeline>(
      "remove_filter",
      {
        clipId: selectedClipId,
        filterId,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!next) return;
    setTimeline(normalizeTimeline(next));
    setStatus("Effect removed");
  }

  function findClipById(clipId: string) {
    if (!timeline) return null;
    for (const track of timeline.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return { track, clip };
    }
    return null;
  }

  /* --- Magic Remove / AI Eraser ------------------------------------- */

  /** The video clip the Magic Remove tool edits. Resolved FRESH from the
   * timeline + imperative playhead on every call — never from memoized
   * state — so commits can't race playhead moves or in-flight timeline
   * writes and land on a stale clip (which used to duplicate filters). */
  function resolveMagicTarget(): Clip | null {
    const tl = timelineRef.current;
    if (!tl) return null;
    const hit = clipAtPlayhead(tl, playheadRef.current, "video");
    if (hit && !isImagePath(hit.clip.media_path)) return hit.clip;
    if (selectedClipId) {
      const sel = tl.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === selectedClipId && c.role === "video" && !isImagePath(c.media_path));
      if (sel) {
        seekTimeline(sel.start);
        return sel;
      }
    }
    return null;
  }

  /** Preview source for a clip: the ready Magic Remove sidecar (WYSIWYG) or
   * the original media, plus the additive element→source time shift for
   * clip-scoped sidecars (sidecar t=0 == scopeIn). Single source of truth for
   * every monitor source swap and element-time mapping — the playback clock,
   * seeks and reverse stepping all go through this, so a scoped sidecar is
   * time-aligned exactly like the original file would be. */
  function previewTarget(clip: Clip): { path: string; shift: number } {
    if (magicToolRef.current) return { path: clip.media_path, shift: 0 };
    const params = (findMagicRemove(clip.filters)?.params ??
      null) as Record<string, unknown> | null;
    const rp = magicResultReady(params, clip);
    if (!rp) return { path: clip.media_path, shift: 0 };
    return { path: rp, shift: magicScopeShift(params) };
  }

  /** Element-src comparison for the sidecar-shift guard (never throws). */
  function convertFileSrcSafe(path: string): string {
    try {
      return convertFileSrc(path);
    } catch {
      return "";
    }
  }

  /** Hand the playhead back to real video after a gap / still-image stretch:
   * load the clip's source if needed, seek, and resume playback. Idempotent —
   * the load effect performs the same steps on source changes, and the guards
   * make double calls harmless (the playback loop also calls this for
   * same-file handoffs where no source change would re-run the load effect). */
  function ensureVideoPlaying(clip: Clip, t: number) {
    const video = videoRef.current;
    if (!video || !playingRef.current) return;
    if (video.ended) {
      // The file is exhausted before the clip's out_point: leave the last
      // frame up — the wall path keeps the playhead moving to the clip end,
      // where boundary handling takes over. Re-seeking here every tick would
      // storm the element and freeze the picture anyway.
      return;
    }
    const target = previewTarget(clip);
    const wantSrc = convertFileSrcSafe(target.path);
    if (!wantSrc) return;
    video.muted = true;
    const start = () => {
      try {
        const want =
          mediaTimeForClip(clip, t) -
          (convertFileSrcSafe(target.path) === video.getAttribute("src")
            ? target.shift
            : 0);
        if (Math.abs(video.currentTime - want) > 0.05) {
          video.currentTime = want;
        }
      } catch {
        /* metadata not ready */
      }
      try {
        video.playbackRate = clip.reverse ? 1 : clipSpeed(clip);
      } catch {
        /* ignore */
      }
      if (playingRef.current && video.paused) {
        void video
          .play()
          .then(() => setPlaying(true))
          .catch((err: unknown) => {
            // An interrupted play() request (a boundary paused the element
            // again) must never tear down the whole playback session —
            // that desynced "media plays, playhead frozen" states.
            if ((err as { name?: string } | null)?.name === "AbortError") return;
            setPlaying(false);
          });
      }
    };
    if (video.getAttribute("src") !== wantSrc) {
      video.src = wantSrc;
      video.load();
      video.addEventListener("loadedmetadata", start, { once: true });
    } else {
      start();
    }
  }

  /** Wall-path audio management: keep the A-track and overdub elements
   * exactly covering the timeline position `t` — correct source, position,
   * play while a clip covers, pause when none does. Audio must never outlive
   * its clip (the old path left the element running to the file's end). */
  function syncPlaybackAudio(tl: Timeline, t: number) {
    const syncOne = (
      el: HTMLAudioElement | null,
      hit: { clip: Clip } | null,
    ) => {
      if (!el) return;
      const src = hit ? convertFileSrcSafe(hit.clip.media_path) : "";
      if (hit && src) {
        if (el.getAttribute("src") !== src) {
          el.src = src;
          el.load();
        }
        const want = Math.max(
          hit.clip.in_point,
          Math.min(
            hit.clip.in_point + (t - hit.clip.start),
            hit.clip.out_point - 0.01,
          ),
        );
        try {
          if (el.ended) {
            // The file is exhausted before the clip's out_point: leave it
            // silent — the wall clock keeps the playhead moving, and a fresh
            // clip (new src) resets `ended`. Seeking back here every tick
            // would storm the element with corrective seeks.
          } else if (el.paused) {
            if (Math.abs(el.currentTime - want) > 0.05) el.currentTime = want;
            void el.play().catch(() => undefined);
          } else if (Math.abs(el.currentTime - want) > 0.25) {
            el.currentTime = want;
          }
        } catch {
          /* metadata not ready — the next tick corrects */
        }
      } else if (!el.paused) {
        el.pause();
      }
    };
    const aHit = clipAtPlayhead(tl, t, "audio");
    syncOne(audioRef.current, aHit);
    syncOne(audio2Ref.current ?? null, secondAudioAt(tl, t, aHit?.clip.id ?? null));
  }

  /** Clip-scoped filter param update (updateFilterParams is bound to the
   * selected clip, which may differ from the clip under the playhead).
   * Returns the fresh Timeline so callers can read back the saved filter
   * without racing React state. */
  async function updateFilterParamsOnClip(
    clipId: string,
    filterId: string,
    params: Record<string, unknown>,
  ): Promise<Timeline | null> {
    // Central path for transform/text-overlay drags, effect sliders and
    // magic commits — rapid-fire update_filter invokes whose responses can
    // complete out of order. Latest-wins: older responses are dropped.
    const seq = nextSeq();
    try {
      const next = normalizeTimeline(
        await invoke<Timeline>("update_filter", { clipId, filterId, params }),
      );
      if (!isCurrent(seq)) return null; // superseded by a newer commit
      recordEngine(next);
      setTimeline(next);
      return next;
    } catch (e) {
      setStatus(String(e));
      return null;
    }
  }

  /** Find the magicremove filter in a Timeline RESPONSE (never stale). */
  function findMagicIn(tl: Timeline | null, clipId: string) {
    if (!tl) return null;
    const clip = tl.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    const f = clip?.filters?.find((x) => x.kind === "magicremove");
    return f
      ? { filterId: f.id, params: (f.params ?? {}) as Record<string, unknown> }
      : null;
  }

  /** Strip Rust error noise for user-facing messages. */
  function cleanMagicErr(msg: string): string {
    return msg
      .replace(/^\s*Error:\s*/i, "")
      .replace(/^"|"$/g, "")
      .trim()
      .slice(0, 200);
  }

  /** Run a magic commit after every previously queued filter commit has
   * settled, so timelineRef is up to date when the "existing filter?" check
   * runs. Same chain as every other filter commit — strictly ordered. */
  function queueMagic<T>(fn: () => Promise<T>): Promise<T> {
    return queueFilterCommit(fn);
  }

  /** Merge every magicremove filter on a clip into the FIRST one (union of
   * strokes) and remove the rest. Earlier builds could stack duplicates via
   * the commit race; render/export read only the first filter, so the extra
   * filters' regions were never removed. */
  async function consolidateMagicFilters(clipId: string): Promise<string | null> {
    const clip =
      timelineRef.current?.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId) ??
      null;
    const dups = (clip?.filters ?? []).filter((f) => f.kind === "magicremove");
    if (dups.length <= 1) return dups[0]?.id ?? null;
    const [first, ...rest] = dups;
    const mergedStrokes = dups.flatMap((f) => {
      const s = (f.params as Record<string, unknown> | undefined)?.strokes;
      return Array.isArray(s) ? s : [];
    });
    await updateFilterParamsOnClip(clipId, first.id, {
      ...((first.params ?? {}) as Record<string, unknown>),
      strokes: mergedStrokes,
    });
    for (const dup of rest) {
      const next = await engineEdit<Timeline>("remove_filter", {
        clipId,
        filterId: dup.id,
      });
      /* already gone */
      if (next) setTimeline(normalizeTimeline(next));
    }
    setStatus(`✨ Magic Remove: merged ${dups.length} masks into one`);
    return first.id;
  }

  /** Add or update the magicremove filter and return the SAVED filter read
   * from the invoke response — immune to stale timeline state. */
  async function commitMagicFilter(
    clipId: string,
    patch: Record<string, unknown>,
  ): Promise<{ filterId: string; params: Record<string, unknown> } | null> {
    return queueMagic(() => commitMagicFilterNow(clipId, patch));
  }

  async function commitMagicFilterNow(
    clipId: string,
    patch: Record<string, unknown>,
  ): Promise<{ filterId: string; params: Record<string, unknown> } | null> {
    await consolidateMagicFilters(clipId);
    const tl = timelineRef.current;
    const clip = tl?.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    const existing = clip?.filters?.find((x) => x.kind === "magicremove");
    if (existing) {
      const merged = {
        ...((existing.params ?? {}) as Record<string, unknown>),
        ...patch,
      };
      invalidateStaleMagicRender("magicremove", patch, merged);
      const next = await updateFilterParamsOnClip(clipId, existing.id, merged);
      return findMagicIn(next, clipId);
    }
    const hasStrokes = Array.isArray(patch.strokes) && patch.strokes.length > 0;
    if (!hasStrokes) return null; // nothing durable to persist yet
    const resp = await engineEdit<Timeline>(
      "add_filter",
      {
        clipId,
        kind: "magicremove",
        params: { ...defaultParams("magicremove"), ...magicDraftRef.current, ...patch },
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!resp) return null;
    const next = normalizeTimeline(resp);
    setTimeline(next);
    setMagicDraft(null);
    magicDraftRef.current = null;
    return findMagicIn(next, clipId);
  }

  /** Find the magicremove filter on a clip object. */
  function magicFilterOf(clip: Clip | null) {
    return clip?.filters?.find((x) => x.kind === "magicremove") ?? null;
  }

  /** Merge a patch into the target clip's magicremove filter. The filter is
   * created ONLY on the first stroke commit (a single invoke, no race) —
   * slider tweaks before that live in the local draft. */
  async function upsertMagicParams(patch: Record<string, unknown>) {
    return queueMagic(() => upsertMagicParamsNow(patch));
  }

  async function upsertMagicParamsNow(patch: Record<string, unknown>) {
    const target = resolveMagicTarget();
    if (!target) {
      setStatus("No video clip under the playhead");
      return;
    }
    await consolidateMagicFilters(target.id);
    const existing = magicFilterOf(
      timelineRef.current?.tracks.flatMap((t) => t.clips).find((c) => c.id === target.id) ??
        null,
    );
    if (existing) {
      const merged = {
        ...((existing.params ?? {}) as Record<string, unknown>),
        ...patch,
      };
      invalidateStaleMagicRender("magicremove", patch, merged);
      await updateFilterParamsOnClip(target.id, existing.id, merged);
      return;
    }
    const hasStrokes = Array.isArray(patch.strokes) && patch.strokes.length > 0;
    if (!hasStrokes) {
      // Nothing to persist yet — keep slider changes in the draft so the
      // panel controls still respond.
      setMagicDraft((d) => ({ ...(d ?? {}), ...patch }));
      magicDraftRef.current = { ...(magicDraftRef.current ?? {}), ...patch };
      return;
    }
    const params = {
      ...defaultParams("magicremove"),
      ...magicDraftRef.current,
      ...patch,
    };
    setMagicDraft(null);
    magicDraftRef.current = null;
    const resp = await engineEdit<Timeline>(
      "add_filter",
      {
        clipId: target.id,
        kind: "magicremove",
        params,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!resp) return;
    const next = normalizeTimeline(resp);
    setTimeline(next);
    const added = magicFilterOf(
      next.tracks.flatMap((t) => t.clips).find((c) => c.id === target.id) ?? null,
    );
    if (added) setFocusFilterId(added.id);
  }

  function toggleMagicTool(on: boolean) {
    if (on) {
      const target = resolveMagicTarget();
      if (!target) {
        setStatus("Select or scrub to a video clip to use Magic Remove");
        return;
      }
      setCropTool(false);
      setBlurTool(false);
      setKeyTool(null);
      if (playingRef.current) {
        if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
        if (audioRef.current && !audioRef.current.paused) audioRef.current.pause();
        playingRef.current = false;
        setPlaying(false);
      }
      if (selectedClipId !== target.id) setSelectedClipId(target.id);
      // Heal duplicates: earlier builds could stack several magicremove
      // filters on a clip (commit race). Merge their strokes into the first
      // and drop the rest — only the first filter is ever rendered.
      if ((target.filters ?? []).filter((f) => f.kind === "magicremove").length > 1) {
        void queueMagic(() => consolidateMagicFilters(target.id));
      }
    }
    setMagicTool(on);
    if (on) setMagicStatus(null);
  }

  function commitMagic(patch: {
    strokes?: MagicStroke[];
    keyframes?: MagicKeyframe[];
    anchorTime?: number;
  }) {
    const cleared = Array.isArray(patch.strokes) && patch.strokes.length === 0;
    void upsertMagicParams(
      cleared ? { ...patch, resultPath: "", renderKey: "", status: "idle" } : patch,
    );
    if (cleared) {
      setMagicStatus(null);
    } else if (patch.strokes) {
      setMagicStatus("Mask updated — press ✨ Remove to render the removal.");
    }
  }

  async function runMagicTrack(mask?: {
    strokes?: MagicStroke[];
    anchorTime?: number | null;
  }) {
    const clip = resolveMagicTarget();
    if (!clip) {
      setMagicError("Scrub the playhead over a video clip first, then brush and track.");
      return;
    }
    // Window FIRST — the user must immediately see that something happened.
    setMagicBusy({ phase: "tracking", percent: 0 });
    setMagicStatus(null);
    setStatus("✨ Magic Remove: tracking the mask across the clip — watch it follow on the timeline.");
    try {
      let f = findMagicIn(timelineRef.current, clip.id);
      // Self-heal: mask visible in the panel but not saved yet (commit race
      // or earlier failure) → save the panel's mask now, then continue.
      if (!f || !(Array.isArray(f.params.strokes) && f.params.strokes.length)) {
        if (!mask?.strokes?.length) {
          throw new Error("No mask saved — brush over the element first, then try again");
        }
        f = await commitMagicFilter(clip.id, {
          strokes: mask.strokes,
          ...(mask.anchorTime != null ? { anchorTime: mask.anchorTime } : {}),
        });
        if (!f) throw new Error("Could not save the mask — brush again and retry");
      }
      const p = f.params;
      // Clip-scoped work window: track (and later render) only the source
      // range this clip instance actually uses — keyframe times stay
      // source-absolute so the Adjust tool and overlay need no remapping.
      const scope = { scopeIn: clip.in_point, scopeOut: clip.out_point };
      const res = await invoke<{ keyframes: MagicKeyframe[] }>("magic_remove_track", {
        source: clip.media_path,
        params: { ...p, ...scope },
      });
      await queueFilterCommit(() =>
        updateFilterParamsOnClip(clip.id, f.filterId, {
          ...p,
          ...scope,
          keyframes: res.keyframes ?? [],
          status: "tracked",
          resultPath: "",
          renderKey: "",
        }),
      );
      setMagicStatus(
        "Tracked across the clip — press ✨ Remove, or use Adjust to correct the mask.",
      );
      setStatus("✨ Magic Remove: mask tracked across the clip.");
    } catch (e) {
      handleMagicError(e, "Tracking");
    } finally {
      setMagicBusy(null);
    }
  }

  async function runMagicRemoveRender(mask?: {
    strokes?: MagicStroke[];
    anchorTime?: number | null;
  }) {
    const clip = resolveMagicTarget();
    if (!clip) {
      setMagicError("Scrub the playhead over a video clip first, then brush and press Remove.");
      return;
    }
    // Window FIRST — the user must immediately see that Remove is working.
    setMagicBusy({ phase: "inpainting", percent: 0 });
    setMagicStatus(null);
    try {
      let f = findMagicIn(timelineRef.current, clip.id);
      // Self-heal: mask visible in the panel but not saved yet → save it now.
      if (!f || !(Array.isArray(f.params.strokes) && f.params.strokes.length)) {
        if (!mask?.strokes?.length) {
          throw new Error("No mask saved — brush over the element first, then press Remove again");
        }
        f = await commitMagicFilter(clip.id, {
          strokes: mask.strokes,
          ...(mask.anchorTime != null ? { anchorTime: mask.anchorTime } : {}),
        });
        if (!f) throw new Error("Could not save the mask — brush again and retry");
      }
      const p = f.params;
      const scope = { scopeIn: clip.in_point, scopeOut: clip.out_point };
      const clipLen = clipTimelineDuration(clip);
      setStatus(
        `✨ Magic Remove: rebuilding the background across ${fmtLen(clipLen)} of this clip — longer clips take longer. Keep editing; progress shows on the monitor.`,
      );
      const path = await invoke<string>("magic_remove_render", {
        source: clip.media_path,
        params: { ...p, ...scope },
        keyframes: Array.isArray(p.keyframes) ? p.keyframes : [],
      });
      const saved = await queueFilterCommit(() =>
        updateFilterParamsOnClip(clip.id, f.filterId, {
          ...p,
          ...scope,
          resultPath: path,
          renderKey: magicRenderKey(p),
          status: "ready",
        }),
      );
      if (!saved) {
        throw new Error(
          "Render finished but saving failed — press Remove again (the render is cached and will be instant)",
        );
      }
      setMagicStatus("Removed ✓ — scrub or play to preview; export bakes it in.");
      setStatus("✨ Magic Remove finished — the monitor now previews the cleaned video (original file untouched).");
      // Auto-apply: leave the tool the moment the render is saved so the
      // monitor swaps to the cleaned sidecar immediately — no Done click.
      setMagicTool(false);
    } catch (e) {
      handleMagicError(e, "Removal");
    } finally {
      setMagicBusy(null);
    }
  }

  /** Every Magic Remove failure lands somewhere visible: floating error
   * card, tool panel line and the status bar — never a silent return. */
  function handleMagicError(e: unknown, what: string) {
    const msg = cleanMagicErr(String(e));
    if (msg.toLowerCase().includes("cancelled")) {
      setMagicStatus(`${what} cancelled — nothing changed.`);
      setStatus(`✨ Magic Remove ${what.toLowerCase()} cancelled — nothing changed.`);
      return;
    }
    setMagicStatus(`${what} failed: ${msg}`);
    setMagicError(`${what} failed — ${msg}`);
    setStatus(`✨ Magic Remove ${what.toLowerCase()} failed: ${msg}`);
  }

  function cancelMagic() {
    void invoke("magic_remove_cancel").catch(() => undefined);
  }

  /* --- Blur Region tool ---------------------------------------------- */

  /** Video OR image clip under the playhead (region effects apply to both). */
  function resolveVisualTarget(): Clip | null {
    const tl = timelineRef.current;
    if (!tl) return null;
    const hit = clipAtPlayhead(tl, playheadRef.current, "video");
    if (hit) return hit.clip;
    if (selectedClipId) {
      const sel = tl.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === selectedClipId && c.role === "video");
      if (sel) {
        seekTimeline(sel.start);
        return sel;
      }
    }
    return null;
  }

  /** Pause playback for interactive region tools (same as Magic Remove). */
  function pauseForRegionTool() {
    if (playingRef.current) {
      if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
      if (audioRef.current && !audioRef.current.paused) audioRef.current.pause();
      playingRef.current = false;
      setPlaying(false);
    }
  }

  function toggleBlurTool(on: boolean) {
    if (on) {
      const target = resolveVisualTarget();
      if (!target) {
        setStatus("Park the playhead on a video or image clip to use the Blur tool");
        return;
      }
      setCropTool(false);
      setKeyTool(null);
      pauseForRegionTool();
      if (selectedClipId !== target.id) setSelectedClipId(target.id);
      const existing = (target.filters ?? []).find((f) => f.kind === "blurregion");
      if (!existing) {
        void engineEdit<Timeline>(
          "add_filter",
          { clipId: target.id, kind: "blurregion", params: defaultParams("blurregion") },
          { onError: (e) => setStatus(String(e)) },
        ).then((next) => {
          if (next) setTimeline(normalizeTimeline(next));
        });
      } else if (!existing.enabled) {
        void engineEdit<Timeline>(
          "set_filter_enabled",
          { clipId: target.id, filterId: existing.id, enabled: true },
          { onError: (e) => setStatus(String(e)) },
        ).then((next) => {
          if (next) setTimeline(normalizeTimeline(next));
        });
      }
    }
    setBlurTool(on);
    if (on) setBlurStatus(null);
  }

  /** Enabled blurregion filter on the clip under the playhead. */
  const monitorBlurRegion = useMemo(() => {
    const clip = videoUnderPlayhead?.clip;
    if (!clip) return null;
    const f = (clip.filters ?? []).find((x) => x.kind === "blurregion" && x.enabled);
    if (!f) return null;
    return {
      clipId: clip.id,
      filterId: f.id,
      params: (f.params ?? {}) as Record<string, unknown>,
      clip,
    };
  }, [videoUnderPlayhead]);
  const blurRegionRef = useRef(monitorBlurRegion);
  blurRegionRef.current = monitorBlurRegion;

  async function commitBlurRegion(patch: Record<string, unknown>) {
    const br = blurRegionRef.current;
    if (!br) return;
    // Patch-only commit, merged into the SAVED params by the per-filter
    // queue (the old render-state merge silently dropped every change in a
    // rapid burst except the last one).
    const saved = await commitFilterParamsOnClip(br.clipId, br.filterId, patch);
    if (!saved) setBlurStatus("Could not save the region — try again");
  }

  /** Auto-track: follow the region content across the clip and store
   * position keyframes (size/rotation/intensity stay as set). */
  async function runBlurTrack() {
    const clip = resolveVisualTarget();
    const br = blurRegionRef.current;
    if (!clip || !br) return;
    if (isImagePath(clip.media_path)) {
      setBlurStatus("Auto Track needs a video clip");
      return;
    }
    setBlurBusy({ phase: "tracking", percent: 0 });
    setBlurStatus(null);
    try {
      const t = Math.max(
        0,
        mediaTimeForClip(clip, playheadRef.current) - clip.in_point,
      );
      const anchor: RegionState = regionStateAt(br.params, t);
      const res = await invoke<{ keyframes: MagicKeyframe[] }>("blur_region_track", {
        source: clip.media_path,
        region: {
          x: anchor.x,
          y: anchor.y,
          w: anchor.w,
          h: anchor.h,
          anchorTime: t,
          scopeIn: clip.in_point,
          scopeOut: clip.out_point,
          accuracy: "medium",
        },
      });
      const kfs = (res.keyframes ?? []).map((k) => ({
        t: k.t,
        x: anchor.x + k.dx,
        y: anchor.y + k.dy,
        w: anchor.w,
        h: anchor.h,
        rotation: anchor.rotation,
        intensity: anchor.intensity,
        feather: anchor.feather,
        opacity: anchor.opacity,
      }));
      if (!kfs.length) {
        setBlurStatus("Tracking produced no keyframes — try a larger region");
        return;
      }
      const saved = await queueFilterCommit(() =>
        updateFilterParamsOnClip(clip.id, br.filterId, {
          ...br.params,
          keyframes: kfs,
        }),
      );
      if (!saved) throw new Error("could not save the tracked keyframes");
      setBlurStatus(
        "Tracked across the clip - " +
          kfs.length +
          " keyframes. Scrub to check; moving the region edits the key at the playhead.",
      );
    } catch (e) {
      setBlurStatus("Tracking failed: " + cleanMagicErr(String(e)));
    } finally {
      setBlurBusy(null);
    }
  }

  function cancelBlurTrack() {
    void invoke("magic_remove_cancel").catch(() => undefined);
  }

  async function removeBlurRegion() {
    const br = blurRegionRef.current;
    if (!br) return;
    const next = await engineEdit<Timeline>(
      "remove_filter",
      { clipId: br.clipId, filterId: br.filterId },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!next) return;
    setTimeline(normalizeTimeline(next));
    setBlurTool(false);
    setStatus("Blur region removed");
  }

  /* --- BG Key tool (chroma key + select-area removal) ----------------- */

  function toggleKeyTool(mode: KeyToolMode | null) {
    if (mode) {
      const target = resolveVisualTarget();
      if (!target) {
        setStatus("Park the playhead on a video or image clip to remove a background");
        return;
      }
      setCropTool(false);
      setBlurTool(false);
      pauseForRegionTool();
      if (selectedClipId !== target.id) setSelectedClipId(target.id);
      const kind = mode === "chroma" ? "chromakey" : "bgmask";
      const existing = (target.filters ?? []).find((f) => f.kind === kind);
      if (!existing) {
        void engineEdit<Timeline>(
          "add_filter",
          { clipId: target.id, kind, params: defaultParams(kind) },
          { onError: (e) => setStatus(String(e)) },
        ).then((next) => {
          if (next) setTimeline(normalizeTimeline(next));
        });
      } else if (!existing.enabled) {
        void engineEdit<Timeline>(
          "set_filter_enabled",
          { clipId: target.id, filterId: existing.id, enabled: true },
          { onError: (e) => setStatus(String(e)) },
        ).then((next) => {
          if (next) setTimeline(normalizeTimeline(next));
        });
      }
    }
    setKeyTool(mode);
  }

  /** Enabled chromakey + bgmask params on the displayed clip (live preview
   * + tool panel run off these). */
  const monitorKeyFilters = useMemo(() => {
    const clip = videoUnderPlayhead?.clip;
    const ck = clip
      ? (clip.filters ?? []).find((f) => f.kind === "chromakey" && f.enabled)
      : undefined;
    const bm = clip
      ? (clip.filters ?? []).find((f) => f.kind === "bgmask" && f.enabled)
      : undefined;
    return {
      chroma: ck ? ((ck.params ?? {}) as Record<string, unknown>) : null,
      mask: bm ? ((bm.params ?? {}) as Record<string, unknown>) : null,
    };
  }, [videoUnderPlayhead]);
  const keyFilterIdsRef = useRef<{
    clipId?: string;
    chroma?: string;
    chromaParams?: Record<string, unknown>;
    mask?: string;
    maskParams?: Record<string, unknown>;
  }>({});
  useEffect(() => {
    const clip = videoUnderPlayhead?.clip;
    const ck = clip
      ? (clip.filters ?? []).find((f) => f.kind === "chromakey" && f.enabled)
      : undefined;
    const bm = clip
      ? (clip.filters ?? []).find((f) => f.kind === "bgmask" && f.enabled)
      : undefined;
    keyFilterIdsRef.current = {
      clipId: clip?.id,
      chroma: ck?.id,
      chromaParams: ck ? ((ck.params ?? {}) as Record<string, unknown>) : undefined,
      mask: bm?.id,
      maskParams: bm ? ((bm.params ?? {}) as Record<string, unknown>) : undefined,
    };
  }, [monitorKeyFilters, videoUnderPlayhead]);

  async function commitChromaParams(patch: Record<string, unknown>) {
    const ids = keyFilterIdsRef.current;
    if (!ids.clipId || !ids.chroma) return;
    await commitFilterParamsOnClip(ids.clipId, ids.chroma, patch);
  }

  async function commitMaskParams(patch: Record<string, unknown>) {
    const ids = keyFilterIdsRef.current;
    if (!ids.clipId || !ids.mask) return;
    await commitFilterParamsOnClip(ids.clipId, ids.mask, patch);
  }

  /** Receives the rasterized mask PNG from the monitor (same canvas code the
   * preview uses), persists it in the derived cache and points the filter at
   * it — export and preview then share the exact mask. */
  async function rasterizeMaskSaved(maskKey: string, dataUrl: string) {
    try {
      const path = await invoke<string>("save_bg_mask", { data: dataUrl });
      await commitMaskParams({ maskPath: path, maskKey });
    } catch (e) {
      setStatus("Could not save the selection mask: " + cleanMagicErr(String(e)));
    }
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
      audioFilters: (hit.clip.filters ?? []) as FilterInstance[],
      initialSemitones,
      initialVoicePreset,
      initialTab: tab,
    });
    if (resolvedFromVideo) {
      setStatus("Advanced Audio Tools edits the linked audio clip (not video)");
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
      audioFilters: [],
      initialTab: tab,
    });
  }

  async function removeEffectByKind(clipId: string, kind: string) {
    const hit = findClipById(clipId);
    if (!hit) return;
    const filters = (hit.clip.filters ?? []).filter((f) => f.kind === kind);
    if (filters.length === 0) return;
    let next: Timeline | null = null;
    for (const f of filters) {
      const removed = await engineEdit<Timeline>(
        "remove_filter",
        {
          clipId,
          filterId: f.id,
        },
        { onError: (e) => setStatus(String(e)) },
      );
      if (!removed) return;
      next = normalizeTimeline(removed);
    }
    if (next) setTimeline(next);
    setStatus(`${effectLabel(kind)} removed`);
  }

  async function ensureVolumeGain(clipId: string, gain: number) {
    const hit = findClipById(clipId);
    if (!hit) return;
    let filters = hit.clip.filters ?? [];
    let vol = filters.find((f) => f.kind === "volume");
    if (!vol) {
      const resp = await engineEdit<Timeline>(
        "add_filter",
        { clipId, kind: "volume" },
        { onError: (e) => setStatus(String(e)) },
      );
      if (!resp) return;
      const next = normalizeTimeline(resp);
      setTimeline(next);
      const again = next.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
      vol = again?.filters?.find((f) => f.kind === "volume");
    }
    if (!vol) return;
    const updated = await engineEdit<Timeline>(
      "update_filter",
      {
        clipId,
        filterId: vol.id,
        params: { gain },
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (updated) setTimeline(normalizeTimeline(updated));
  }

  async function setAudioFades(clipId: string, fadeIn: number, fadeOut: number) {
    const next = await engineEdit<Timeline>(
      "set_clip_fades",
      {
        clipId,
        fadeIn,
        fadeOut,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (next) setTimeline(normalizeTimeline(next));
  }

  async function setClipReverse(clipId: string, reverse: boolean) {
    const next = await engineEdit<Timeline>(
      "set_clip_reverse",
      {
        clipId,
        reverse,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (next) setTimeline(normalizeTimeline(next));
  }

  async function setClipSpeed(clipId: string, speed: number) {
    const next = await engineEdit<Timeline>(
      "set_clip_speed",
      {
        clipId,
        speed,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (next) setTimeline(normalizeTimeline(next));
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

  // Keep Advanced Audio state in sync with timeline writes (fades, gain,
  // applied kinds and filter params).
  useEffect(() => {
    if (!advancedAudio?.clipId || !timeline) return;
    let found: (typeof timeline.tracks)[0]["clips"][0] | null = null;
    for (const track of timeline.tracks) {
      const c = track.clips.find((x) => x.id === advancedAudio.clipId);
      if (c) {
        found = c;
        break;
      }
    }
    if (!found || found.role !== "audio") return;
    const volFilter = (found.filters ?? []).find((f) => f.kind === "volume");
    const gainVal =
      volFilter && typeof (volFilter.params ?? {}).gain === "number"
        ? ((volFilter.params as Record<string, number>).gain as number)
        : null;
    const appliedKinds = [
      ...new Set((found.filters ?? []).map((f) => f.kind).filter(Boolean)),
    ];
    setAdvancedAudio((prev) => {
      if (!prev || prev.clipId !== found!.id) return prev;
      const fadeIn = found!.fade_in ?? prev.fadeIn;
      const fadeOut = found!.fade_out ?? prev.fadeOut;
      const filtersChanged = (prev.audioFilters ?? []) !== (found!.filters ?? []);
      if (
        prev.fadeIn === fadeIn &&
        prev.fadeOut === fadeOut &&
        gainVal !== null &&
        Math.abs(prev.volumeGain - gainVal) < 1e-6 &&
        (prev.appliedKinds ?? []).join(",") === appliedKinds.join(",") &&
        !filtersChanged
      ) {
        return prev;
      }
      return {
        ...prev,
        fadeIn,
        fadeOut,
        volumeGain: gainVal ?? prev.volumeGain,
        appliedKinds,
        audioFilters: (found!.filters ?? []) as FilterInstance[],
      };
    });
  }, [timeline, advancedAudio?.clipId]);

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
    // Split at end, then at start, then remove middle piece.
    const first = await engineEdit<Timeline>(
      "split_clip_at",
      {
        clipId,
        at: absB,
        syncLinked,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!first) return;
    let tl = normalizeTimeline(first);
    setTimeline(tl);
    const second = await engineEdit<Timeline>(
      "split_clip_at",
      {
        clipId,
        at: absA,
        syncLinked,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!second) return;
    tl = normalizeTimeline(second);
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
      const third = await engineEdit<Timeline>(
        "ripple_delete",
        {
          clipId: mid.id,
          removeLinked: syncLinked,
        },
        { onError: (e) => setStatus(String(e)) },
      );
      if (!third) return;
      tl = normalizeTimeline(third);
      setTimeline(tl);
      setSelectedClipId(null);
      setAdvancedAudio(null);
      setStatus("Selection cut");
    } else {
      setStatus("Cut splits done — select middle clip to delete if needed");
    }
  }

  async function applyAudioEffectToClip(
    clipId: string,
    kind: string,
    params?: Record<string, unknown>,
  ) {
    await upsertClipFilter(clipId, kind, params);
  }

  /** Serialized crop commits: reads fresh state from timelineRef on each run
   * so a Done click racing an in-flight commit can never create a duplicate
   * crop filter (double-crop = double zoom in export). */
  const cropCommitChain = useRef<Promise<void>>(Promise.resolve());
  function commitCrop(crop: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }) {
    const run = async () => {
      // Crop is a main-preview tool: always target the clip under the
      // playhead, never whichever overlay happens to be selected.
      const targetClip = videoUnderRef.current?.clip ?? null;
      if (!targetClip) {
        setStatus("No video under playhead to crop");
        return;
      }
      const filters = targetClip.filters ?? [];
      const cropFilter = filters.find((f) => f.kind === "crop");
      const isZero =
        crop.left <= 0.001 &&
        crop.top <= 0.001 &&
        crop.right <= 0.001 &&
        crop.bottom <= 0.001;

      let updated: Timeline | null;
      if (!cropFilter) {
        if (isZero) return;
        updated = await engineEdit<Timeline>(
          "add_filter",
          {
            clipId: targetClip.id,
            kind: "crop",
            params: crop,
          },
          { onError: (e) => setStatus(String(e)) },
        );
        if (!updated) return;
        updated = normalizeTimeline(updated);
      } else {
        updated = await engineEdit<Timeline>(
          "update_filter",
          {
            clipId: targetClip.id,
            filterId: cropFilter.id,
            params: crop,
          },
          { onError: (e) => setStatus(String(e)) },
        );
        if (!updated) return;
        updated = normalizeTimeline(updated);
      }
      if (updated) setTimeline(updated);
      if (selectedClipId !== targetClip.id) {
        setSelectedClipId(targetClip.id);
      }
      setStatus("Crop updated");
    };
    cropCommitChain.current = cropCommitChain.current
      .then(run)
      .catch((e) => setStatus(String(e)));
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

  /** Snapshot of the current monitor frame for the export output preview. */
  const captureExportFrame = useCallback(async (): Promise<string | null> => {
    const video = videoRef.current;
    const img = monitorImageRef.current;
    const isVideo = !!video && video.videoWidth > 0;
    const srcEl: HTMLVideoElement | HTMLImageElement | null = isVideo
      ? video
      : img && img.naturalWidth > 0
        ? img
        : null;
    if (!srcEl) return null;
    const w = isVideo ? (video as HTMLVideoElement).videoWidth : (img as HTMLImageElement).naturalWidth;
    const h = isVideo ? (video as HTMLVideoElement).videoHeight : (img as HTMLImageElement).naturalHeight;
    const assetSrc = srcEl.getAttribute("src");
    const draw = (el: HTMLVideoElement | HTMLImageElement): string => {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 960 / Math.max(w, h));
      canvas.width = Math.max(2, Math.round(w * scale));
      canvas.height = Math.max(2, Math.round(h * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.85);
    };
    try {
      return draw(srcEl);
    } catch {
      /* frame is CORS-tainted — retry with a clean cross-origin probe */
    }
    if (!assetSrc) return null;
    return new Promise<string | null>((resolve) => {
      const probe = document.createElement("video");
      probe.crossOrigin = "anonymous";
      probe.muted = true;
      probe.preload = "auto";
      const finish = (result: string | null) => {
        window.clearTimeout(timer);
        resolve(result);
      };
      const timer = window.setTimeout(() => finish(null), 4000);
      probe.addEventListener(
        "loadeddata",
        () => {
          window.setTimeout(() => {
            try {
              finish(draw(probe));
            } catch {
              finish(null);
            }
          }, 80);
        },
        { once: true },
      );
      probe.addEventListener("error", () => finish(null), { once: true });
      probe.src = assetSrc;
    });
  }, []);

  const [exportPreviewFrame, setExportPreviewFrame] = useState<string | null>(null);

  function openExportDialog() {
    if (!canExport) {
      setStatus("Add media to the timeline (or select a file) to export");
      return;
    }
    setExportOpen(true);
    void captureExportFrame()
      .then((frame) => setExportPreviewFrame(frame))
      .catch(() => setExportPreviewFrame(null));
  }

  /** Open a .yxp project file (replaces the in-memory project; undo history
   * resets with it). Playback stops first so media elements are quiescent. */
  async function openProject() {
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "Project YX", extensions: ["yxp", "json"] }],
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      stopPlayback();
      // The project is being replaced: responses from edits of the previous
      // project must never land on the new state.
      invalidatePending();
      const tl = await invoke<Timeline>("load_project", { path });
      const next = normalizeTimeline(tl);
      recordEngine(next);
      setTimeline(next);
      setSelectedClipId(null);
      seekTimeline(0);
      setStatus(`Opened ${fileName(path)}`);
    } catch (e) {
      setStatus(String(e));
    }
  }

  /** Save the project as a .yxp file (atomic write on the Rust side). */
  async function saveProjectAs() {
    try {
      const path = await save({
        filters: [{ name: "Project YX", extensions: ["yxp", "json"] }],
        defaultPath: "project.yxp",
      });
      if (!path) return;
      await invoke("save_project", { path });
      setStatus(`Project saved → ${fileName(path)}`);
    } catch (e) {
      setStatus(String(e));
    }
  }

  /** Start a fresh project: resets the engine timeline (undo history resets
   * with it). */
  async function newProject() {
    if (
      timeline?.tracks.some((t) => t.clips.length > 0) &&
      !window.confirm("Start a new project? The current timeline will be cleared.")
    ) {
      return;
    }
    try {
      stopPlayback();
      invalidatePending();
      const tl = await invoke<Timeline>("new_project");
      const next = normalizeTimeline(tl);
      recordEngine(next);
      setTimeline(next);
      setSelectedClipId(null);
      seekTimeline(0);
      setStatus("New project");
    } catch (e) {
      setStatus(String(e));
    }
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
      // "cancelled" comes from the Rust MediaError::Cancelled display when
      // the user aborts the encode — not an error to alarm about.
      const msg = String(e);
      setStatus(/^cancel/i.test(msg) ? "Export cancelled — partial output discarded" : msg);
    } finally {
      setBusy(false);
      setExportProgress(0);
    }
  }

  async function setEditMode(mode: EditMode) {
    const next = await engineEdit<Timeline>(
      "set_edit_mode",
      { mode },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!next) return;
    setTimeline(normalizeTimeline(next));
    setStatus(`Edit mode: ${mode}`);
  }

  async function addMarkerAtPlayhead() {
    const next = await engineEdit<Timeline>(
      "add_marker",
      {
        time: playheadRef.current,
        label: `M${(timeline?.markers?.length ?? 0) + 1}`,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!next) return;
    setTimeline(normalizeTimeline(next));
    setStatus("Marker added");
  }

  async function setZoneIn() {
    const next = await engineEdit<Timeline>(
      "set_zone",
      {
        zoneIn: playheadRef.current,
        zoneOut: timeline?.zone_out ?? null,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!next) return;
    setTimeline(normalizeTimeline(next));
    setStatus(`Zone in ${playheadRef.current.toFixed(2)}s`);
  }

  async function setZoneOut() {
    const next = await engineEdit<Timeline>(
      "set_zone",
      {
        zoneIn: timeline?.zone_in ?? null,
        zoneOut: playheadRef.current,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!next) return;
    setTimeline(normalizeTimeline(next));
    setStatus(`Zone out ${playheadRef.current.toFixed(2)}s`);
  }

  async function liftZone() {
    const next = await engineEdit<Timeline>("lift_zone", undefined, {
      onError: (e) => {
        const msg = String(e);
        setStatus(/no zone/i.test(msg) ? "No zone set" : msg);
      },
    });
    if (!next) return;
    setTimeline(normalizeTimeline(next));
    setStatus("Lift zone");
  }

  async function extractZone() {
    const next = await engineEdit<Timeline>("extract_zone", undefined, {
      onError: (e) => {
        const msg = String(e);
        setStatus(/no zone/i.test(msg) ? "No zone set" : msg);
      },
    });
    if (!next) return;
    setTimeline(normalizeTimeline(next));
    setStatus("Extract zone");
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
    const next = await engineEdit<Timeline>(
      "split_clip_at",
      {
        clipId: clip.id,
        at: ph,
        syncLinked: true,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!next) return;
    setTimeline(normalizeTimeline(next));
    setStatus(`Split at ${ph.toFixed(2)}s`);
  }

  /** Enabled Text filter on the clip under the playhead — monitor overlay. */
  const monitorText = useMemo(() => {
    const clip = videoUnderPlayhead?.clip;
    if (!clip) return null;
    const f = (clip.filters ?? []).find((x) => x.kind === "text" && x.enabled);
    if (!f) return null;
    const p = (f.params ?? {}) as Record<string, unknown>;
    const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v : d);
    const num = (v: unknown, d: number) =>
      typeof v === "number" && Number.isFinite(v) ? v : d;
    return {
      clipId: clip.id,
      filterId: f.id,
      text: str(p.text, "Your title"),
      size: num(p.size, 6),
      color: str(p.color, "#ffffff"),
      x: num(p.x, 0),
      y: num(p.y, 0.55),
      box: p.box !== false,
      boxcolor: str(p.boxcolor, "#00000073"),
      borderw: num(p.borderw, 0),
      bordercolor: str(p.bordercolor, "#000000"),
      shadow: p.shadow !== false,
    };
  }, [videoUnderPlayhead]);

  /** The clip the Project Monitor displays — selected clip only when it IS
   * the one under the playhead (keeps gestures WYSIWYG with the preview). */
  const monitorTargetClip = useMemo(() => {
    return selectedClip &&
      selectedClip.clip.role === "video" &&
      selectedClip.clip.id === videoUnderPlayhead?.clip.id
      ? selectedClip.clip
      : (videoUnderPlayhead?.clip ?? null);
  }, [selectedClip, videoUnderPlayhead]);

  /** Transform filter on the displayed clip — drives the monitor drag/scale
   * interactions; export reads the same filter (WYSIWYG). */
  const monitorTransform = useMemo(() => {
    const target = monitorTargetClip;
    if (!target) return null;
    const f = (target.filters ?? []).find((x) => x.kind === "transform" && x.enabled);
    if (!f) return null;
    const p = (f.params ?? {}) as Record<string, unknown>;
    const num = (v: unknown, d: number) =>
      typeof v === "number" && Number.isFinite(v) ? v : d;
    return {
      clipId: target.id,
      filterId: f.id,
      x: num(p.x, 0),
      y: num(p.y, 0),
      scale: num(p.scale, 1),
      rotation: num(p.rotation, 0),
      opacity: num(p.opacity, 1),
    };
  }, [monitorTargetClip]);

  /** The Magic Remove tool's target: the video clip under the playhead.
   * Images are excluded — masks are defined against real video frames. */
  const magicTarget =
    videoUnderPlayhead && !isImagePath(videoUnderPlayhead.clip.media_path)
      ? videoUnderPlayhead
      : null;

  // Tool stays in sync with the monitor: it only exists over a video clip.
  // Leaving video mode (gap, audio clip, image) closes it so the toolbar
  // button, frame class and gesture ownership can never go stale.
  useEffect(() => {
    if (magicTool && !magicTarget) setMagicTool(false);
  }, [magicTool, magicTarget]);

  const magicParams = useMemo(() => {
    const clip = magicTarget?.clip;
    const f = magicFilterOf(clip ?? null);
    if (f) return (f.params ?? {}) as Record<string, unknown>;
    // No filter yet — the panel runs on the local draft until the first
    // stroke commit creates it.
    return magicDraft;
  }, [magicTarget, magicDraft]);

  /** Stale-render indicator: the stored sidecar no longer matches the mask
   * settings (render key changed, or the change explicitly marked it stale). */
  const magicStale = useMemo(() => {
    if (!magicParams) return false;
    const p = magicParams as Record<string, unknown>;
    return p.status === "stale" || (Boolean(p.resultPath) && magicResultReady(p) === null);
  }, [magicParams]);

  // Escape exits the Magic Remove tool.
  useEffect(() => {
    if (!magicTool) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMagicTool(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [magicTool]);

  // Region tools only exist over a visual clip — leaving video mode closes
  // them so the toolbar buttons and gesture ownership never go stale.
  useEffect(() => {
    if (blurTool && !videoUnderPlayhead) setBlurTool(false);
    if (keyTool && !videoUnderPlayhead) setKeyTool(null);
  }, [blurTool, keyTool, videoUnderPlayhead]);

  // Escape exits the Blur Region / BG Key tools.
  useEffect(() => {
    if (!blurTool && !keyTool) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setBlurTool(false);
        setKeyTool(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [blurTool, keyTool]);

  /** Persist a monitor transform gesture on a specific clip. Creates the
   * Transform filter on demand when the clip has none (drag/wheel work
   * without setup), and re-enables a disabled filter instead of ignoring
   * the gesture. */
  const commitTransformForClip = useCallback(
    async (
      clipId: string,
      patch: { x?: number; y?: number; scale?: number; opacity?: number },
    ) => {
      const num = (v: unknown, d: number) =>
        typeof v === "number" && Number.isFinite(v) ? v : d;
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      const clip = timelineRef.current?.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === clipId);
      if (!clip) return;
      const tf = (clip.filters ?? []).find((f) => f.kind === "transform");
      let updated: Timeline | null;
      if (tf) {
        const prev = (tf.params ?? {}) as Record<string, unknown>;
        const params = {
          x: clamp(patch.x ?? num(prev.x, 0), -1, 1),
          y: clamp(patch.y ?? num(prev.y, 0), -1, 1),
          scale: clamp(patch.scale ?? num(prev.scale, 1), 0.05, 8),
          rotation: num(prev.rotation, 0),
          opacity: clamp(patch.opacity ?? num(prev.opacity, 1), 0, 1),
        };
        updated = await engineEdit<Timeline>(
          "update_filter",
          {
            clipId,
            filterId: tf.id,
            params,
          },
          { onError: (e) => setStatus(String(e)) },
        );
        if (!updated) return;
        updated = normalizeTimeline(updated);
        if (!tf.enabled) {
          updated = await engineEdit<Timeline>(
            "set_filter_enabled",
            {
              clipId,
              filterId: tf.id,
              enabled: true,
            },
            { onError: (e) => setStatus(String(e)) },
          );
          if (!updated) return;
          updated = normalizeTimeline(updated);
        }
      } else {
        const params = {
          x: clamp(patch.x ?? 0, -1, 1),
          y: clamp(patch.y ?? 0, -1, 1),
          scale: clamp(patch.scale ?? 1, 0.05, 8),
          rotation: 0,
          opacity: 1,
        };
        updated = await engineEdit<Timeline>(
          "add_filter",
          {
            clipId,
            kind: "transform",
            params,
          },
          { onError: (e) => setStatus(String(e)) },
        );
        if (!updated) return;
        updated = normalizeTimeline(updated);
      }
      if (updated) setTimeline(updated);
      if (selectedClipId !== clipId) {
        setSelectedClipId(clipId);
      }
    },
    [selectedClipId],
  );

  /** Main-preview transform gestures (target resolved in the monitor). */
  const commitTransform = useCallback(
    async (patch: { x?: number; y?: number; scale?: number; opacity?: number }) => {
      const target = monitorTargetClip;
      if (!target) return;
      await commitTransformForClip(target.id, patch);
    },
    [monitorTargetClip, commitTransformForClip],
  );

  /** Monitor "Text" button flow: a preset style + typed text from the picker
   * becomes (or replaces) the Text filter on the displayed clip. */
  const addStyledTextFromMonitor = useCallback(async (style: TextPresetParams & { text: string }) => {
    const clip = videoUnderRef.current?.clip;
    if (!clip) {
      setStatus("Park the playhead on a clip to add a title");
      return;
    }
    const text = style.text.trim();
    if (!text) {
      setStatus("Type the title text first");
      return;
    }
    const params = {
      text,
      size: Math.max(1, Math.min(30, style.size)),
      color: style.color,
      x: Math.max(-1, Math.min(1, style.x ?? 0)),
      y: Math.max(-1, Math.min(1, style.y)),
      box: style.box,
      ...(style.box ? { boxcolor: style.boxcolor ?? "#00000073" } : {}),
      ...(style.box ? { boxborderw: style.boxborderw ?? 14 } : {}),
      ...(style.borderw && style.borderw > 0
        ? { borderw: style.borderw, bordercolor: style.bordercolor ?? "#000000" }
        : {}),
      shadow: style.shadow !== false,
    };
    const existing = (clip.filters ?? []).find((f) => f.kind === "text");
    const onError = (e: unknown) => setStatus(String(e));
    let updated = existing
      ? await engineEdit<Timeline>(
          "update_filter",
          {
            clipId: clip.id,
            filterId: existing.id,
            params,
          },
          { onError },
        )
      : await engineEdit<Timeline>(
          "add_filter",
          {
            clipId: clip.id,
            kind: "text",
            params,
          },
          { onError },
        );
    if (!updated) return;
    updated = normalizeTimeline(updated);
    if (existing && !existing.enabled) {
      updated = await engineEdit<Timeline>(
        "set_filter_enabled",
        {
          clipId: clip.id,
          filterId: existing.id,
          enabled: true,
        },
        { onError },
      );
      if (!updated) return;
      updated = normalizeTimeline(updated);
    }
    setTimeline(updated);
    setSelectedClipId(clip.id);
    setStatus(existing ? "Title updated — drag to move, corner handles to resize" : "Title added — drag to move, corner handles to resize");
  }, []);

  /** Commit monitor text-overlay gestures (drag position / handle resize /
   * double-click inline edit). Preserves the picked style fields. */
  const commitTextOverlay = useCallback(
    async (patch: { x?: number; y?: number; size?: number; text?: string }) => {
      const t = monitorText;
      if (!t) return;
      const nextText =
        typeof patch.text === "string" && patch.text.trim() ? patch.text : t.text;
      const params = {
        text: nextText,
        size: Math.max(1, Math.min(30, patch.size ?? t.size)),
        color: t.color,
        x: Math.max(-1, Math.min(1, patch.x ?? t.x)),
        y: Math.max(-1, Math.min(1, patch.y ?? t.y)),
        box: t.box,
        ...(t.box ? { boxcolor: t.boxcolor } : {}),
        ...(t.borderw > 0 ? { borderw: t.borderw, bordercolor: t.bordercolor } : {}),
        shadow: t.shadow,
      };
      const next = await engineEdit<Timeline>(
        "update_filter",
        {
          clipId: t.clipId,
          filterId: t.filterId,
          params,
        },
        { onError: (e) => setStatus(String(e)) },
      );
      if (next) setTimeline(normalizeTimeline(next));
    },
    [monitorText],
  );

  /** Delete the clip the monitor currently targets (selected overlay or the
   * clip under the playhead) — the context-menu / Delete-key action. */
  const removeTargetClip = useCallback(async () => {
    const target = monitorTargetClip;
    if (!target) return;
    const next = await engineEdit<Timeline>(
      "remove_clip",
      {
        clipId: target.id,
        removeLinked: true,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!next) return;
    setTimeline(normalizeTimeline(next));
    if (selectedClipId === target.id) {
      setSelectedClipId(null);
    }
    setStatus("Clip deleted");
  }, [monitorTargetClip, selectedClipId]);

  /** Monitor context menu: remove the Text (title) filter from the
   * displayed clip — titles are filters, not clips, so they get their own
   * delete action. */
  const removeTitleFromMonitor = useCallback(async () => {
    const clip = videoUnderRef.current?.clip;
    if (!clip) return;
    const f = (clip.filters ?? []).find((x) => x.kind === "text");
    if (!f) return;
    const next = await engineEdit<Timeline>(
      "remove_filter",
      {
        clipId: clip.id,
        filterId: f.id,
      },
      { onError: (e) => setStatus(String(e)) },
    );
    if (!next) return;
    setTimeline(normalizeTimeline(next));
    setStatus("Title removed");
  }, []);

  /** Place any file path (e.g. a saved voiceover) on the timeline. */
  const addMediaPathToTimeline = useCallback(
    async (path: string, start: number, label: string) => {
      const next = await engineEdit<Timeline>(
        "add_media_to_timeline",
        {
          mediaPath: path,
          start,
        },
        { onError: (e) => setStatus(String(e)) },
      );
      if (!next) return;
      setTimeline(normalizeTimeline(next));
      const first = next.tracks
        .flatMap((tr) => tr.clips)
        .sort((a, b) => b.start - a.start)[0];
      if (first) setSelectedClipId(first.id);
      setStatus(label);
    },
    [],
  );

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
      const applyVisual = (el: HTMLElement | null) => {
        if (!el) return;
        const fade = videoClip ? clipFadeGain(videoClip, t) : 1;
        // Cross-dissolve ramp: fade the incoming clip in over the overlap.
        let transitionRamp = 1;
        if (videoClip) {
          const tr = (videoClip.filters ?? []).find(
            (f) => f.kind === "transition" && f.enabled,
          );
          if (tr) {
            const d =
              typeof (tr.params ?? {}).duration === "number"
                ? ((tr.params as Record<string, number>).duration as number)
                : 0.5;
            const local = t - videoClip.start;
            if (local < d) transitionRamp = Math.max(0.04, local / d);
          }
        }
        const style = previewVideoStyle(
          (videoClip?.filters ?? []) as FilterInstance[],
          fade * transitionRamp,
        );
        const opacity = String(style.opacity);
        const clipPath = style.clipPath ?? "";
        const isCropping = cropToolRef.current;
        const objectViewBox = isCropping ? "" : (style.objectViewBox ?? "");
        const objectFit = isCropping ? "" : (style.objectFit ?? "");

        if (el.style.filter !== style.filter) {
          el.style.filter = style.filter;
        }
        if (el.style.transform !== style.transform) {
          el.style.transform = style.transform;
        }
        if (el.style.opacity !== opacity) {
          el.style.opacity = opacity;
        }
        if (el.style.clipPath !== clipPath) {
          el.style.clipPath = clipPath;
        }
        // Crop fills the frame exactly like the export (crop + scale-to-fill).
        if (el.style.getPropertyValue("object-view-box") !== objectViewBox) {
          if (objectViewBox) {
            el.style.setProperty("object-view-box", objectViewBox);
          } else {
            el.style.removeProperty("object-view-box");
          }
        }
        if (el.style.objectFit !== objectFit) {
          el.style.objectFit = objectFit;
        }
        const shadow = style.boxShadow ?? "";
        if ((el.dataset.shadow ?? "") !== shadow) {
          el.style.boxShadow = shadow;
          el.dataset.shadow = shadow;
        }
      };
      const video = videoRef.current;
      const audio = audioRef.current;
      if (video) {
        applyVisual(video);
      }
      applyVisual(monitorImageRef.current);
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
      const audio2 = audio2Ref.current;
      if (audio2) {
        const clip2 = audioUnder2Ref.current?.clip ?? null;
        const fade2 = clip2 ? clipFadeGain(clip2, t) : 1;
        const vol2 = monitorMutedRef.current
          ? 0
          : Math.min(
            1,
            previewVolumeGain((clip2?.filters ?? []) as FilterInstance[], fade2) *
            monitorVolumeRef.current,
          );
        if (Math.abs(lastAudio2Volume.current - vol2) > 0.001) {
          audio2.volume = vol2;
          lastAudio2Volume.current = vol2;
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
      playingRef.current = false;
      setPlaying(false);
      video?.pause();
      audio?.pause();
      audio2Ref.current?.pause();
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

    if (hit && video && !isImagePath(hit.clip.media_path)) {
      video.muted = true;
      const target = previewTarget(hit.clip);
      const wantSrc = convertFileSrc(target.path);
      if (wantSrc && video.getAttribute("src") !== wantSrc) {
        video.src = wantSrc;
        video.load();
      }
      try {
        const wantTime = mediaTimeForClip(hit.clip, curTime) - target.shift;
        if (Math.abs(video.currentTime - wantTime) > 0.05) {
          video.currentTime = wantTime;
        }
      } catch {
        /* ignore */
      }
      const needsStepped = !!hit.clip.reverse;

      if (needsStepped) {
        const clip = hit.clip;
        const shift = target.shift;
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
          video.currentTime = mediaTimeForClip(clip, nextPh) - shift;
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
      const audio2 = audio2Ref.current;
      const audioHit2 = secondAudioAt(timelineRef.current, playheadRef.current, audioHit.clip.id);
      if (audio2 && audioHit2 && audio2.getAttribute("src")) {
        const want = Math.max(
          audioHit2.clip.in_point,
          Math.min(
            audioHit2.clip.in_point + (playheadRef.current - audioHit2.clip.start),
            audioHit2.clip.out_point - 0.01,
          ),
        );
        try {
          if (Math.abs(audio2.currentTime - want) > 0.15) audio2.currentTime = want;
        } catch {
          /* ignore */
        }
        if (audio2.paused) void audio2.play().catch(() => undefined);
      }
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
      const audio2 = audio2Ref.current;
      const audioHit2 = secondAudioAt(timelineRef.current, playheadRef.current, audioHit?.clip.id ?? null);
      if (audio2 && audioHit2 && audio2.getAttribute("src")) {
        if (audio2.paused) void audio2.play().catch(() => undefined);
      } else if (audio2 && !audio2.paused) {
        audio2.pause();
      }
    }
  }

  /** Standalone stop (K / programmatic) — pauses all media elements. */
  function stopPlayback() {
    cancelAnimationFrame(reverseRafRef.current);
    reverseRafRef.current = 0;
    playingRef.current = false;
    setPlaying(false);
    videoRef.current?.pause();
    audioRef.current?.pause();
    audio2Ref.current?.pause();
    if (videoRef.current) {
      try {
        videoRef.current.playbackRate = 1;
      } catch {
        /* ignore */
      }
    }
    if (audioRef.current) {
      try {
        audioRef.current.playbackRate = 1;
      } catch {
        /* ignore */
      }
    }
  }

  /** Clear every clip from every track (engine command; one undo step).
   * Stops playback first — the session would otherwise "play" an empty
   * timeline until its fallback duration. Confirms when clips exist. */
  function clearTimelineAll() {
    const hasClips = timelineRef.current?.tracks.some((t) => t.clips.length > 0);
    if (hasClips && !window.confirm("Remove every clip from the timeline?")) {
      return;
    }
    stopPlayback();
    void engineEdit<Timeline>("clear_timeline", undefined, {
      onError: (e) => setStatus(String(e)),
    }).then((next) => {
      if (!next) return;
      setTimeline(normalizeTimeline(next));
      setStatus("Cleared all clips from the timeline");
    });
  }

  /** Clear every clip from one track (engine command; one undo step).
   * Locked tracks are refused by the engine. Confirms when clips exist. */
  function clearTrackClips(trackId: string) {
    const track = timelineRef.current?.tracks.find((t) => t.id === trackId);
    if (!track) return;
    if (
      track.clips.length > 0 &&
      !window.confirm(`Remove every clip from ${track.name}?`)
    ) {
      return;
    }
    stopPlayback();
    void engineEdit<Timeline>("clear_track", { trackId }, {
      onError: (e) => setStatus(String(e)),
    }).then((next) => {
      if (!next) return;
      setTimeline(normalizeTimeline(next));
      setStatus("Cleared all clips from the track");
    });
  }

  /** Reverse playback (J): steps the video's currentTime backwards on an
   * rAF loop — HTML5 media can't play backwards natively. Audio is muted
   * and paused during the reverse pass (professional NLEs do the same). */
  function playReverse() {
    const video = videoRef.current;
    if (playingRef.current) {
      stopPlayback();
      return;
    }
    const tl = timelineRef.current;
    const ph = playheadRef.current;
    const hit = tl ? clipAtPlayhead(tl, ph, "video") : null;
    if (!hit || isImagePath(hit.clip.media_path) || !video) {
      // No video here: nudge the playhead back a second.
      seekTimeline(Math.max(0, ph - 1));
      return;
    }
    const clip = hit.clip;
    const target = previewTarget(clip);
    const wantSrc = convertFileSrc(target.path);
    if (wantSrc && video.getAttribute("src") !== wantSrc) {
      video.src = wantSrc;
      video.load();
    }
    try {
      video.currentTime = mediaTimeForClip(clip, ph) - target.shift;
    } catch {
      /* metadata not ready */
    }
    playingRef.current = true;
    setPlaying(true);
    audioRef.current?.pause();
    audio2Ref.current?.pause();
    const wall0 = performance.now();
    const ph0 = ph;
    const step = () => {
      if (!playingRef.current) return;
      const elapsed = (performance.now() - wall0) / 1000;
      const nextPh = Math.max(clip.start, ph0 - elapsed);
      commitPlayhead(nextPh, false);
      try {
        video.currentTime = mediaTimeForClip(clip, nextPh) - target.shift;
      } catch {
        /* ignore */
      }
      applyPreviewFades(nextPh, clip, audioUnderRef.current?.clip ?? null);
      if (nextPh <= clip.start + 0.02) {
        reverseRafRef.current = 0;
        stopPlayback();
        return;
      }
      reverseRafRef.current = requestAnimationFrame(step);
    };
    reverseRafRef.current = requestAnimationFrame(step);
  }

  /** Shuttle forward (L): start playback, or double the rate while playing. */
  function shuttleForward() {
    const video = videoRef.current;
    if (!playingRef.current) {
      togglePlay();
      return;
    }
    const next = Math.min(4, (video?.playbackRate ?? 1) * 2);
    try {
      if (video) video.playbackRate = next;
    } catch {
      /* ignore */
    }
  }

  /** Toggle snapping (N) — kept current via the keyHandlers ref. */
  function toggleSnap() {
    const next = !snapOnRef.current;
    setSnapOn(next);
    viewControlsRef.current?.setSnap(next);
  }

  const seekTimeline = useCallback(
    (t: number, immediate = true) => {
      const next = Math.max(0, t);
      commitPlayhead(next, immediate);
      const tl = timelineRef.current;
      const videoHit = tl ? clipAtPlayhead(tl, next, "video") : null;
      const audioHit = tl ? clipAtPlayhead(tl, next, "audio") : null;
      if (videoHit && videoRef.current && !isImagePath(videoHit.clip.media_path)) {
        const video = videoRef.current;
        const target = previewTarget(videoHit.clip);
        const wantSrc = convertFileSrc(target.path);
        if (wantSrc && video.getAttribute("src") !== wantSrc) {
          video.src = wantSrc;
          video.load();
        }
        video.muted = true;
        try {
          video.currentTime = mediaTimeForClip(videoHit.clip, next) - target.shift;
        } catch {
          /* ignore */
        }
        try {
          video.playbackRate = videoHit.clip.reverse ? 1 : clipSpeed(videoHit.clip);
        } catch {
          /* ignore */
        }
      } else if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
      }
      if (audioHit && audioRef.current) {
        const audio = audioRef.current;
        const wantAudio = convertFileSrc(audioHit.clip.media_path);
        if (wantAudio && audio.getAttribute("src") !== wantAudio) {
          audio.src = wantAudio;
          audio.load();
        }
        try {
          audio.currentTime = audioHit.clip.in_point + (next - audioHit.clip.start);
        } catch {
          /* ignore */
        }
      } else if (audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
      }
      const audio2 = audio2Ref.current;
      const audioHit2 = secondAudioAt(tl, next, audioHit?.clip.id ?? null);
      if (audio2) {
        if (audioHit2) {
          const want2Src = convertFileSrc(audioHit2.clip.media_path);
          if (want2Src && audio2.getAttribute("src") !== want2Src) {
            audio2.src = want2Src;
            audio2.load();
          }
          const want = Math.max(
            audioHit2.clip.in_point,
            Math.min(
              audioHit2.clip.in_point + (next - audioHit2.clip.start),
              audioHit2.clip.out_point - 0.01,
            ),
          );
          try {
            if (audio2.getAttribute("src") && Math.abs(audio2.currentTime - want) > 0.15) {
              audio2.currentTime = want;
            }
          } catch {
            /* ignore */
          }
        } else if (!audio2.paused) {
          audio2.pause();
        }
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

  // Keep monitor opacity / volume in sync with playhead fades: driven by the
  // playback clock (imperative DOM writes — no React re-render per tick).
  useEffect(() => {
    applyPreviewFades(
      playbackClock.get(),
      videoUnderRef.current?.clip ?? null,
      audioUnderRef.current?.clip ?? null,
    );
    return playbackClock.subscribe((t) => {
      applyPreviewFades(
        t,
        videoUnderRef.current?.clip ?? null,
        audioUnderRef.current?.clip ?? null,
      );
    });
  }, [videoUnderPlayhead, audioUnderPlayhead, applyPreviewFades]);

  // When timeline structure changes (clip trimmed, split, moved, rate stretched, deleted, undo/redo),
  // immediately resynchronize the monitor video/audio to match the playhead position.
  useEffect(() => {
    if (!timeline || playingRef.current) return;
    const ph = playheadRef.current;
    const vHit = clipAtPlayhead(timeline, ph, "video");
    const aHit = clipAtPlayhead(timeline, ph, "audio");
    const video = videoRef.current;
    const audio = audioRef.current;

    if (vHit && video && !isImagePath(vHit.clip.media_path)) {
      const target = previewTarget(vHit.clip);
      const wantSrc = convertFileSrc(target.path);
      if (wantSrc && video.getAttribute("src") !== wantSrc) {
        video.src = wantSrc;
        video.load();
      }
      const want = mediaTimeForClip(vHit.clip, ph) - target.shift;
      try {
        if (Math.abs(video.currentTime - want) > 0.04) {
          video.currentTime = want;
        }
      } catch {
        /* ignore */
      }
      try {
        video.playbackRate = vHit.clip.reverse ? 1 : clipSpeed(vHit.clip);
      } catch {
        /* ignore */
      }
    } else if (!vHit && video && !video.paused) {
      video.pause();
    }

    if (aHit && audio) {
      const wantA = Math.max(
        aHit.clip.in_point,
        Math.min(aHit.clip.in_point + (ph - aHit.clip.start), aHit.clip.out_point - 0.01),
      );
      try {
        if (Math.abs(audio.currentTime - wantA) > 0.05) {
          audio.currentTime = wantA;
        }
      } catch {
        /* ignore */
      }
    }

    applyPreviewFades(ph, vHit?.clip ?? null, aHit?.clip ?? null);
  }, [timeline, applyPreviewFades]);

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
    saveProjectAs,
    openProject,
    newProject,
    playReverse,
    stopPlayback,
    shuttleForward,
    toggleSnap,
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
      saveProjectAs,
      openProject,
      newProject,
      playReverse,
      stopPlayback,
      shuttleForward,
      toggleSnap,
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
      } else if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey) {
        h.setTool("select");
      } else if ((e.key === "x" || e.key === "X") && !e.ctrlKey && !e.metaKey) {
        h.setTool("razor");
      } else if ((e.key === "m" || e.key === "M") && !e.ctrlKey && !e.metaKey) {
        h.setTool("spacer");
      } else if ((e.key === "y" || e.key === "Y") && !e.ctrlKey && !e.metaKey) {
        h.setTool("slip");
      } else if ((e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey) {
        h.setTool("ripple");
      } else if ((e.key === "i" || e.key === "I") && !e.ctrlKey && !e.metaKey) {
        void h.setZoneIn();
      } else if ((e.key === "o" || e.key === "O") && !e.ctrlKey && !e.metaKey) {
        void h.setZoneOut();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        void h.onRemove();
      } else if (e.key === "ArrowLeft") {
        // Frame-accurate stepping: 1 frame of the PROJECT frame rate
        // (correct for 23.976/25/29.97/50/59.94/60 — not a hardcoded 30).
        const fps = timelineRef.current?.frame_rate || 30;
        h.seekTimeline(playheadRef.current - (e.shiftKey ? 1 : 1 / fps));
      } else if (e.key === "ArrowRight") {
        const fps = timelineRef.current?.frame_rate || 30;
        h.seekTimeline(playheadRef.current + (e.shiftKey ? 1 : 1 / fps));
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void h.saveProjectAs();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        void h.openProject();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        void h.newProject();
      } else if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        h.playReverse();
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        h.stopPlayback();
      } else if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        h.shuttleForward();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        h.toggleSnap();
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
          <p className="boot-by">by ANSNEW TECH.</p>
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
      onNewProject={() => void newProject()}
      onOpenProject={() => void openProject()}
      onSaveProject={() => void saveProjectAs()}
      onUndo={() => void onUndo()}
      onRedo={() => void onRedo()}
      onDelete={() => void onRemove()}
      onRippleDelete={() => void onRippleDelete()}
      onSplitPlayhead={() => void splitAtPlayhead()}
      onToggleLink={() => void onToggleLink()}
      onLiftZone={() => void liftZone()}
      onExtractZone={() => void extractZone()}
      onClearTimeline={clearTimelineAll}
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
              onDropToProjectMonitor={(item) => {
                void addMediaToTimeline(item, playheadRef.current);
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
                onUpdate={(id, params, replace) =>
                  void updateFilterParams(id, params, replace === true)
                }
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
            duration={projectDuration}
            previewError={previewError}
            aspect={previewAspect}
            onAspect={setPreviewAspect}
            videoRef={videoRef}
            shadowVideoRef={shadowVideoRef}
            imageRef={monitorImageRef}
            previewIsImage={previewIsImage}
            audioRef={audioRef}
            audio2Ref={audio2Ref}
            textOverlay={monitorText}
            onTextCommit={(patch) => void commitTextOverlay(patch)}
            transformParams={
              monitorTransform
                ? {
                  x: monitorTransform.x,
                  y: monitorTransform.y,
                  scale: monitorTransform.scale,
                  rotation: monitorTransform.rotation,
                }
                : null
            }
            transformActive={!cropTool}
            onTransformCommit={(patch) => void commitTransform(patch)}
            onAddTextStyled={(style) => void addStyledTextFromMonitor(style)}
            onRemoveTitle={() => void removeTitleFromMonitor()}
            mediaImages={monitorImages}
            imagePickerContext={imagePickerContext}
            onPickImageItem={(item) => {
              const lib = library.find((m) => m.path === item.path);
              if (!lib) return;
              const targetTime = nearestVideoTargetTime();
              if (targetTime != null) seekTimeline(targetTime);
              void addMediaToTimeline(lib, targetTime ?? playheadRef.current);
            }}
            onBrowseImages={() => void browseAndPlaceImages()}
            removeTargetLabel={
              monitorTargetClip ? fileName(monitorTargetClip.media_path) : null
            }
            onRemoveTarget={() => void removeTargetClip()}
            onTogglePlay={togglePlay}
            onSeekRatio={(ratio) => seekTimeline(ratio * projectDuration)}
            volume={monitorVolume}
            muted={monitorMuted}
            onVolume={setMonitorVolume}
            onMuted={setMonitorMuted}
            cropTool={cropTool}
            onCropTool={(on) => {
              // Crop is a main-preview tool: select the clip under the
              // playhead so the crop acts on what the monitor shows.
              if (on && videoUnderPlayhead && selectedClipId !== videoUnderPlayhead.clip.id) {
                setSelectedClipId(videoUnderPlayhead.clip.id);
              }
              setCropTool(on);
            }}
            cropDraft={
              (() => {
                // Crop always targets the MAIN clip under the playhead — the
                // visual the crop box is drawn over — never a selected overlay.
                const c = videoUnderPlayhead?.clip.filters?.find(
                  (f) => f.kind === "crop" && f.enabled,
                );
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
            onEyedropColor={(hex) => {
              // Only reachable while the BG Key chroma mode is open (the
              // monitor scopes eyedropping to the open tool).
              void commitChromaParams({ color: hex });
            }}
            magicTool={magicTool}
            onMagicTool={toggleMagicTool}
            magicParams={magicParams}
            magicClip={magicTarget?.clip ?? null}
            magicBusy={magicBusy}
            magicStatus={
              magicStatus ?? (magicStale ? "Settings changed — press ✨ Remove to re-render." : null)
            }
            onMagicCommit={commitMagic}
            onMagicParamChange={(patch) => void upsertMagicParams(patch)}
            onMagicTrack={(m) => void runMagicTrack(m)}
            onMagicRemove={(m) => void runMagicRemoveRender(m)}
            onMagicCancel={cancelMagic}
            blurRegion={monitorBlurRegion}
            blurTool={blurTool}
            onBlurTool={(on) => toggleBlurTool(on)}
            onBlurCommit={(patch) => void commitBlurRegion(patch)}
            onBlurTrack={() => void runBlurTrack()}
            onBlurCancelTrack={cancelBlurTrack}
            onBlurRemove={() => void removeBlurRegion()}
            blurBusy={blurBusy}
            blurStatus={blurStatus}
            keyTool={keyTool}
            onKeyTool={(mode) => toggleKeyTool(mode)}
            keyFilters={monitorKeyFilters}
            onChromaChange={(patch) => void commitChromaParams(patch)}
            onMaskChange={(patch) => void commitMaskParams(patch)}
            onKeyMaskSaved={(maskKey, dataUrl) =>
              void rasterizeMaskSaved(maskKey, dataUrl)
            }
            onShowClipMonitor={
              clipMonitorOpen ? undefined : () => setClipMonitorOpen(true)
            }
            hasTimelineClips={hasTimelineClips}
            layers={monitorLayers}
            selectedClipId={selectedClipId}
            onSelectLayer={(clipId) => setSelectedClipId(clipId)}
            onLayerTransformCommit={(clipId, patch) =>
              void commitTransformForClip(clipId, patch)
            }
            onRegisterDropTarget={registerMonitorDropTarget}
            fileDropActive={monitorFileDrop}
            fileDropLabel={monitorFileDropLabel}
          />
        }
        timeline={
          <TimelinePanel
            timeline={timeline}
            library={library}
            selectedClipId={selectedClipId}
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
            onAddMediaPath={(path, start, label) =>
              void addMediaPathToTimeline(path, start, label)
            }
            onAdvancedAudio={(clipId, tab) => openAdvancedAudioForClip(clipId, tab)}
            onAdvancedVideo={(clipId) => openAdvancedVideoForClip(clipId)}
            onClearTimeline={clearTimelineAll}
            onClearTrack={clearTrackClips}
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
      {(magicBusy || magicError) && (
        <MagicProgressDialog
          phase={magicBusy?.phase ?? "inpainting"}
          percent={magicBusy?.percent ?? 0}
          startedAt={magicStartedAt || Date.now()}
          error={magicError}
          onCancel={() => {
            if (magicBusy) cancelMagic();
            else setMagicError(null);
          }}
        />
      )}
      <ExportDialog
        open={exportOpen}
        busy={busy}
        progress={exportProgress}
        onCancelExport={() => void invoke("cancel_export")}
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
        previewFrame={exportPreviewFrame}
        onClose={() => !busy && setExportOpen(false)}
        onExport={(settings) => void runExport(settings)}
      />
      <UpdateDialog open={updateOpen} onClose={() => setUpdateOpen(false)} />
    </>
  );
}

/** Ensure newer timeline fields exist when talking to older payloads:
 * normalization now happens inside reconcileTimeline (src/timeline/reconcile.ts). */
export default App;
