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
import { ProjectMonitor, type PreviewAspect } from "./monitors/ProjectMonitor";
import { EffectInspector } from "./effects/EffectInspector";
import {
  EFFECT_CATALOG,
  previewVideoStyle,
  previewVolumeGain,
  type FilterInstance,
} from "./effects/effects";
import "./monitors/ProjectMonitor.css";
import { TimelinePanel } from "./timeline/TimelinePanel";
import {
  clipAtPlayhead,
  clipFadeGain,
  fileName,
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

const FILTERS = EFFECT_CATALOG.map((e) => ({
  id: e.id,
  label: e.label,
  heavy: e.heavy,
}));

function isMediaPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (MEDIA_EXTENSIONS as readonly string[]).includes(ext);
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const resumePlayRef = useRef(false);
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
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [binFilter, setBinFilter] = useState<BinFilter>("media");
  const [tool, setTool] = useState<TimelineTool>("select");
  const [status, setStatus] = useState("Booting…");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
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

  const refreshBoot = useCallback(async () => {
    const info = await invoke<BootInfo>("get_boot_info");
    setBoot(info);
    setTimeline(normalizeTimeline(info.timeline));
    setStatus(`Ready · ${info.policy.tier} tier · ${info.policy.proxy.height}p proxy`);
  }, []);

  useEffect(() => {
    refreshBoot().catch((e) => setStatus(String(e)));
  }, [refreshBoot]);

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

  const videoUnderPlayhead = useMemo(() => {
    if (!timeline) return null;
    return clipAtPlayhead(timeline, playhead, "video");
  }, [timeline, playhead]);

  const audioUnderPlayhead = useMemo(() => {
    if (!timeline) return null;
    return clipAtPlayhead(timeline, playhead, "audio");
  }, [timeline, playhead]);

  const previewMode = useMemo(() => {
    if (videoUnderPlayhead) return "video" as const;
    if (audioUnderPlayhead) return "audio" as const;
    return "empty" as const;
  }, [videoUnderPlayhead, audioUnderPlayhead]);

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

  const previewClipId = useMemo(() => {
    if (previewMode === "video") return videoUnderPlayhead?.clip.id ?? null;
    if (previewMode === "audio") return audioUnderPlayhead?.clip.id ?? null;
    return null;
  }, [previewMode, videoUnderPlayhead, audioUnderPlayhead]);

  const previewInPoint = useMemo(() => {
    if (previewMode === "video") return videoUnderPlayhead?.clip.in_point ?? null;
    if (previewMode === "audio") return audioUnderPlayhead?.clip.in_point ?? null;
    return null;
  }, [previewMode, videoUnderPlayhead, audioUnderPlayhead]);

  const audioClipId = audioUnderPlayhead?.clip.id ?? null;

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

  // Load media into the project monitor elements
  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    const shouldResume = resumePlayRef.current;
    resumePlayRef.current = false;

    if (!shouldResume) {
      setPlaying(false);
    }
    if (video) {
      video.pause();
      video.muted = true;
      video.removeAttribute("src");
      video.load();
    }
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (!previewSrc && !timelineAudioSrc) return;

    const syncAudioLocal = () => {
      if (!audio || !audioUnderPlayhead || !timelineAudioSrc) return;
      const local =
        audioUnderPlayhead.clip.in_point + (playhead - audioUnderPlayhead.clip.start);
      audio.currentTime = Math.max(
        audioUnderPlayhead.clip.in_point,
        Math.min(local, audioUnderPlayhead.clip.out_point - 0.01),
      );
    };

    if (previewMode === "video" && video && previewSrc) {
      video.src = previewSrc;
      video.muted = true;
      video.load();
      if (timelineAudioSrc && audio) {
        audio.src = timelineAudioSrc;
        audio.load();
      }
      const onMeta = () => {
        if (videoUnderPlayhead) {
          const local =
            videoUnderPlayhead.clip.in_point + (playhead - videoUnderPlayhead.clip.start);
          video.currentTime = Math.max(
            videoUnderPlayhead.clip.in_point,
            Math.min(local, videoUnderPlayhead.clip.out_point - 0.01),
          );
        }
        syncAudioLocal();
        if (shouldResume) {
          void video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
          if (timelineAudioSrc && audio) {
            void audio.play().catch(() => undefined);
          }
        }
      };
      video.addEventListener("loadedmetadata", onMeta);
      return () => video.removeEventListener("loadedmetadata", onMeta);
    }

    if (previewMode === "audio" && audio && (timelineAudioSrc || previewSrc)) {
      audio.src = timelineAudioSrc ?? previewSrc!;
      audio.load();
      const onMeta = () => {
        syncAudioLocal();
        if (shouldResume) {
          void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
        }
      };
      audio.addEventListener("loadedmetadata", onMeta);
      return () => audio.removeEventListener("loadedmetadata", onMeta);
    }
  }, [previewSrc, timelineAudioSrc, previewMode, previewClipId, previewInPoint, audioClipId]);

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    const active = previewMode === "video" ? video : previewMode === "audio" ? audio : null;
    if (!active) return;

    const onTime = () => {
      const hit = previewMode === "video" ? videoUnderPlayhead : audioUnderPlayhead;
      if (hit) {
        const timelineTime = hit.clip.start + (active.currentTime - hit.clip.in_point);
        setPlayhead(Math.max(hit.clip.start, timelineTime));
        // Keep A-track audio locked to the playhead while video drives clock.
        if (previewMode === "video" && audio && audioUnderPlayhead && !audio.paused) {
          const want =
            audioUnderPlayhead.clip.in_point + (timelineTime - audioUnderPlayhead.clip.start);
          if (Math.abs(audio.currentTime - want) > 0.12) {
            audio.currentTime = Math.max(
              audioUnderPlayhead.clip.in_point,
              Math.min(want, audioUnderPlayhead.clip.out_point - 0.01),
            );
          }
        }
        if (active.currentTime >= hit.clip.out_point - 0.02) {
          const clipEnd = hit.clip.start + (hit.clip.out_point - hit.clip.in_point);
          const next =
            timeline != null
              ? nextClipAfter(timeline, clipEnd, previewMode === "video" ? "video" : "audio")
              : null;
          if (next && next.clip.id !== hit.clip.id) {
            resumePlayRef.current = !active.paused || playing;
            active.pause();
            audio?.pause();
            setPlayhead(next.clip.start);
          } else {
            active.pause();
            audio?.pause();
            setPlaying(false);
            setPlayhead(clipEnd);
          }
        }
      } else {
        setPlayhead(active.currentTime);
      }
    };
    const onPlay = () => {
      setPlaying(true);
      if (previewMode === "video" && audio && timelineAudioSrc && audio.paused) {
        void audio.play().catch(() => undefined);
      }
    };
    const onPause = () => {
      setPlaying(false);
      audio?.pause();
    };
    const onErr = () => setPreviewError("Could not load preview.");

    active.addEventListener("timeupdate", onTime);
    active.addEventListener("play", onPlay);
    active.addEventListener("pause", onPause);
    active.addEventListener("error", onErr);
    return () => {
      active.removeEventListener("timeupdate", onTime);
      active.removeEventListener("play", onPlay);
      active.removeEventListener("pause", onPause);
      active.removeEventListener("error", onErr);
    };
  }, [
    previewMode,
    videoUnderPlayhead,
    audioUnderPlayhead,
    timeline,
    playing,
    timelineAudioSrc,
  ]);

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
    try {
      setTimeline(
        normalizeTimeline(await invoke<Timeline>("add_filter", { clipId: selectedClipId, kind })),
      );
      setStatus(`Applied ${kind}`);
      setBinFilter("effects");
    } catch (e) {
      setStatus(String(e));
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

  async function commitCrop(crop: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }) {
    if (!selectedClipId || !selectedClip) {
      setStatus("Select a clip to crop");
      return;
    }
    try {
      let filters = selectedClip.clip.filters ?? [];
      let cropFilter = filters.find((f) => f.kind === "crop");
      if (!cropFilter) {
        const next = normalizeTimeline(
          await invoke<Timeline>("add_filter", { clipId: selectedClipId, kind: "crop" }),
        );
        setTimeline(next);
        const clip = next.tracks.flatMap((t) => t.clips).find((c) => c.id === selectedClipId);
        cropFilter = clip?.filters.find((f) => f.kind === "crop");
        filters = clip?.filters ?? [];
      }
      if (!cropFilter) return;
      setTimeline(
        normalizeTimeline(
          await invoke<Timeline>("update_filter", {
            clipId: selectedClipId,
            filterId: cropFilter.id,
            params: crop,
          }),
        ),
      );
      setCropTool(false);
      setStatus("Crop applied");
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
            time: playhead,
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
            zoneIn: playhead,
            zoneOut: timeline?.zone_out ?? null,
          }),
        ),
      );
      setStatus(`Zone in ${playhead.toFixed(2)}s`);
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
            zoneOut: playhead,
          }),
        ),
      );
      setStatus(`Zone out ${playhead.toFixed(2)}s`);
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
    if (!timeline) return;
    const under =
      clipAtPlayhead(timeline, playhead, "video") ??
      clipAtPlayhead(timeline, playhead, "audio");
    const selectedUnder =
      selectedClip &&
      playhead > selectedClip.clip.start &&
      playhead <
        selectedClip.clip.start +
          (selectedClip.clip.out_point - selectedClip.clip.in_point)
        ? selectedClip.clip
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
            at: playhead,
            syncLinked: true,
          }),
        ),
      );
      setStatus(`Split at ${playhead.toFixed(2)}s`);
    } catch (e) {
      setStatus(String(e));
    }
  }

  function togglePlay() {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (previewMode === "video" && video && previewSrc) {
      if (video.paused) {
        video.muted = true;
        void video.play();
        if (timelineAudioSrc && audio) void audio.play().catch(() => undefined);
      } else {
        video.pause();
        audio?.pause();
      }
      return;
    }
    if (previewMode === "audio" && audio && (timelineAudioSrc || previewSrc)) {
      if (audio.paused) void audio.play();
      else audio.pause();
    }
  }

  function seekTimeline(t: number) {
    setPlayhead(Math.max(0, t));
    const videoHit = timeline ? clipAtPlayhead(timeline, t, "video") : null;
    const audioHit = timeline ? clipAtPlayhead(timeline, t, "audio") : null;
    if (videoHit && videoRef.current) {
      videoRef.current.muted = true;
      videoRef.current.currentTime = videoHit.clip.in_point + (t - videoHit.clip.start);
    }
    if (audioHit && audioRef.current) {
      audioRef.current.currentTime = audioHit.clip.in_point + (t - audioHit.clip.start);
    }
    applyPreviewFades(t, videoHit?.clip ?? null, audioHit?.clip ?? null);
  }

  function applyPreviewFades(
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
  ) {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (video) {
      const fade = videoClip ? clipFadeGain(videoClip, t) : 1;
      const style = previewVideoStyle(
        (videoClip?.filters ?? []) as FilterInstance[],
        fade,
      );
      video.style.filter = style.filter;
      video.style.transform = style.transform;
      video.style.opacity = String(style.opacity);
      video.style.clipPath = style.clipPath ?? "";
    }
    if (audio) {
      const fade = audioClip ? clipFadeGain(audioClip, t) : 1;
      audio.volume = monitorMuted
        ? 0
        : Math.min(
            1,
            previewVolumeGain((audioClip?.filters ?? []) as FilterInstance[], fade) *
              monitorVolume,
          );
    }
  }

  // Keep monitor opacity / volume in sync with playhead fades.
  useEffect(() => {
    applyPreviewFades(
      playhead,
      videoUnderPlayhead?.clip ?? null,
      audioUnderPlayhead?.clip ?? null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, videoUnderPlayhead, audioUnderPlayhead, monitorVolume, monitorMuted]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        void onUndo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) {
        e.preventDefault();
        void onRedo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        void splitAtPlayhead();
      } else if (e.key === "s" || e.key === "S") {
        setTool("select");
      } else if (e.key === "x" || e.key === "X") {
        setTool("razor");
      } else if (e.key === "m" || e.key === "M") {
        setTool("spacer");
      } else if (e.key === "y" || e.key === "Y") {
        setTool("slip");
      } else if (e.key === "r" || e.key === "R") {
        setTool("ripple");
      } else if (e.key === "i" || e.key === "I") {
        void setZoneIn();
      } else if (e.key === "o" || e.key === "O") {
        void setZoneOut();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        void onRemove();
      } else if (e.key === "ArrowLeft") {
        seekTimeline(playhead - (e.shiftKey ? 1 : 1 / 30));
      } else if (e.key === "ArrowRight") {
        seekTimeline(playhead + (e.shiftKey ? 1 : 1 / 30));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
      onImport={() => void onImport()}
      onExport={openExportDialog}
      onUndo={() => void onUndo()}
      onRedo={() => void onRedo()}
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
      onTogglePlay={togglePlay}
      onCheckUpdates={() => setUpdateOpen(true)}
    />
  );

  return (
    <>
      <EditorShell
        topbar={topbar}
        bin={
          <div className="bin-column">
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
                const start = timelineDropRef.current?.(clientX) ?? playhead;
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
              busy={busy}
              dragOver={dragOver}
              effects={FILTERS}
              effectsEnabled={!!selectedClipId}
              effectsAllowHeavy={boot.policy.preview_allows_heavy_filters}
              onApplyEffect={(id) => void onFilter(id)}
              selectedClipSummary={
                selectedClip ? fileName(selectedClip.clip.media_path) : null
              }
            />
            <EffectInspector
              clipId={selectedClipId}
              clipRole={selectedClip?.clip.role ?? null}
              filters={(selectedClip?.clip.filters ?? []).map((f) => ({
                id: f.id,
                kind: f.kind,
                enabled: f.enabled,
                params: (f.params ?? {}) as Record<string, unknown>,
              }))}
              onUpdate={(id, params) => void updateFilterParams(id, params)}
              onToggle={(id, en) => void toggleFilter(id, en)}
              onRemove={(id) => void removeFilter(id)}
            />
          </div>
        }
        clipMonitor={
          clipMonitorOpen ? (
            <ClipMonitor
              media={selectedMedia}
              aspect={previewAspect}
              onClose={() => setClipMonitorOpen(false)}
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
                const c = selectedClip?.clip.filters?.find((f) => f.kind === "crop" && f.enabled);
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
          />
        }
        timeline={
          <TimelinePanel
            timeline={timeline}
            selectedClipId={selectedClipId}
            playhead={playhead}
            tool={tool}
            status={status}
            tier={boot.policy.tier}
            onTool={setTool}
            onTimeline={(t) => setTimeline(normalizeTimeline(t))}
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
          />
        }
      />
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
