import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ExportDialog, type ExportSettings } from "./export/ExportDialog";
import { ProjectBin, type BinFilter } from "./bin/ProjectBin";
import { EditorShell } from "./layout/EditorShell";
import { ClipMonitor } from "./monitors/ClipMonitor";
import { ProjectMonitor, type PreviewAspect } from "./monitors/ProjectMonitor";
import { TimelinePanel } from "./timeline/TimelinePanel";
import {
  clipAtPlayhead,
  fileName,
  timelineDuration,
  type BootInfo,
  type EditMode,
  type LibraryItem,
  type MediaInfo,
  type Timeline,
  type TimelineTool,
} from "./timeline/types";
import "./App.css";

type RightTab = "effects" | "adjust";

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

const FILTERS: { id: string; label: string; heavy?: boolean }[] = [
  { id: "exposure", label: "Exposure" },
  { id: "contrast", label: "Contrast" },
  { id: "fade", label: "Fade" },
  { id: "crop", label: "Crop" },
  { id: "text", label: "Text" },
  { id: "lut", label: "LUT", heavy: true },
  { id: "blur", label: "Blur", heavy: true },
  { id: "denoise", label: "Denoise", heavy: true },
];

function isMediaPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (MEDIA_EXTENSIONS as readonly string[]).includes(ext);
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [boot, setBoot] = useState<BootInfo | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [binFilter, setBinFilter] = useState<BinFilter>("media");
  const [rightTab, setRightTab] = useState<RightTab>("effects");
  const [tool, setTool] = useState<TimelineTool>("select");
  const [status, setStatus] = useState("Booting…");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewAspect, setPreviewAspect] = useState<PreviewAspect>("landscape");
  const [exportOpen, setExportOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  const refreshBoot = useCallback(async () => {
    const info = await invoke<BootInfo>("get_boot_info");
    setBoot(info);
    setTimeline(normalizeTimeline(info.timeline));
    setStatus(`Ready · ${info.policy.tier} tier · ${info.policy.proxy.height}p proxy`);
  }, []);

  useEffect(() => {
    refreshBoot().catch((e) => setStatus(String(e)));
  }, [refreshBoot]);

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

  const previewSrc = useMemo(() => {
    if (!previewPath) return null;
    try {
      return convertFileSrc(previewPath);
    } catch {
      return null;
    }
  }, [previewPath]);

  const projectDuration = useMemo(
    () => (timeline ? timelineDuration(timeline, 10) : 10),
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
    setPlaying(false);
    const video = videoRef.current;
    const audio = audioRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (!previewSrc) return;

    if (previewMode === "video" && video) {
      video.src = previewSrc;
      video.load();
      const onMeta = () => {
        if (videoUnderPlayhead) {
          const local =
            videoUnderPlayhead.clip.in_point + (playhead - videoUnderPlayhead.clip.start);
          video.currentTime = Math.max(videoUnderPlayhead.clip.in_point, local);
        }
      };
      video.addEventListener("loadedmetadata", onMeta);
      return () => video.removeEventListener("loadedmetadata", onMeta);
    }

    if (previewMode === "audio" && audio) {
      audio.src = previewSrc;
      audio.load();
      const onMeta = () => {
        if (audioUnderPlayhead) {
          const local =
            audioUnderPlayhead.clip.in_point + (playhead - audioUnderPlayhead.clip.start);
          audio.currentTime = Math.max(audioUnderPlayhead.clip.in_point, local);
        }
      };
      audio.addEventListener("loadedmetadata", onMeta);
      return () => audio.removeEventListener("loadedmetadata", onMeta);
    }
  }, [previewSrc, previewMode]);

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
        if (active.currentTime >= hit.clip.out_point - 0.02) {
          active.pause();
          setPlaying(false);
        }
      } else {
        setPlayhead(active.currentTime);
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
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
  }, [previewMode, videoUnderPlayhead, audioUnderPlayhead]);

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
      setStatus(`Added ${media.name} as ${kind}`);
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
    if (!selectedClipId) {
      setStatus("Select a timeline clip first");
      return;
    }
    try {
      setTimeline(
        normalizeTimeline(await invoke<Timeline>("add_filter", { clipId: selectedClipId, kind })),
      );
      setStatus(`Applied ${kind}`);
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

  function openExportDialog() {
    if (!exportSource) {
      setStatus("Import or select media to export");
      return;
    }
    setExportOpen(true);
  }

  async function runExport(settings: ExportSettings) {
    if (!exportSource) {
      setStatus("Import or select media to export");
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
          inputPath: exportSource,
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
          duration: sourceItem?.duration ?? null,
        });
        setExportProgress(1);
        setExportOpen(false);
        setStatus(`Exported ${settings.width}×${settings.height}`);
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
      setStatus(String(e));
    }
  }

  async function extractZone() {
    try {
      setTimeline(normalizeTimeline(await invoke<Timeline>("extract_zone")));
      setStatus("Extract zone");
    } catch (e) {
      setStatus(String(e));
    }
  }

  function togglePlay() {
    const el =
      previewMode === "video"
        ? videoRef.current
        : previewMode === "audio"
          ? audioRef.current
          : null;
    if (!el || !previewSrc) return;
    if (el.paused) void el.play();
    else el.pause();
  }

  function seekTimeline(t: number) {
    setPlayhead(Math.max(0, t));
    const videoHit = timeline ? clipAtPlayhead(timeline, t, "video") : null;
    const audioHit = timeline ? clipAtPlayhead(timeline, t, "audio") : null;
    if (videoHit && videoRef.current) {
      videoRef.current.currentTime = videoHit.clip.in_point + (t - videoHit.clip.start);
    } else if (audioHit && audioRef.current) {
      audioRef.current.currentTime = audioHit.clip.in_point + (t - audioHit.clip.start);
    }
  }

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
    <header className="topbar">
      <div className="brand">
        <span className="logo">YX</span>
        <div>
          <strong>Project YX</strong>
          <span className={`pill tier-${boot.policy.tier}`}>{boot.policy.tier}</span>
        </div>
      </div>

      <div className="top-tools">
        <button className="tool" onClick={() => void onUndo()} title="Undo (Ctrl+Z)">
          ↶
        </button>
        <button className="tool" onClick={() => void onRedo()} title="Redo (Ctrl+Y)">
          ↷
        </button>
      </div>

      <div className="top-actions">
        <button className="ghost-btn" disabled={busy} onClick={() => void onImport()}>
          Import
        </button>
        <button
          className="primary-btn"
          disabled={busy || !exportSource}
          onClick={openExportDialog}
        >
          Export
        </button>
      </div>
    </header>
  );

  const effects = (
    <aside className="right-rail">
      <nav className="rail-tabs">
        {(
          [
            ["effects", "Effects"],
            ["adjust", "Clip"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={rightTab === id ? "active" : ""}
            onClick={() => setRightTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="rail-body">
        {rightTab === "effects" && (
          <div className="effect-grid">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className={`effect-card ${f.heavy && !boot.policy.preview_allows_heavy_filters ? "heavy" : ""}`}
                disabled={!selectedClipId}
                onClick={() => void onFilter(f.id)}
              >
                <span className="effect-icon">{f.label.slice(0, 1)}</span>
                <span>{f.label}</span>
              </button>
            ))}
          </div>
        )}

        {rightTab === "adjust" && (
          <div className="adjust-panel">
            {selectedClip ? (
              <>
                <h3>{fileName(selectedClip.clip.media_path)}</h3>
                <dl>
                  <div>
                    <dt>Track</dt>
                    <dd>
                      {selectedClip.track.name} · {selectedClip.clip.role}
                    </dd>
                  </div>
                  <div>
                    <dt>Linked</dt>
                    <dd>{selectedClip.clip.linked_clip_id ? "Yes" : "No"}</dd>
                  </div>
                  <div>
                    <dt>Filters</dt>
                    <dd>
                      {selectedClip.clip.filters.map((f) => f.kind).join(", ") || "None"}
                    </dd>
                  </div>
                </dl>
              </>
            ) : (
              <p className="empty-hint">Select a timeline clip.</p>
            )}
            <div className="machine-card compact">
              <p>
                {boot.policy.tier} · proxy {boot.policy.proxy.height}p
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );

  return (
    <>
      <EditorShell
        topbar={topbar}
        bin={
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
            busy={busy}
            dragOver={dragOver}
          />
        }
        clipMonitor={
          selectedMedia ? (
            <ClipMonitor media={selectedMedia} aspect={previewAspect} />
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
          />
        }
        effects={effects}
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
          />
        }
      />
      <ExportDialog
        open={exportOpen}
        busy={busy}
        progress={exportProgress}
        sourceName={exportSource ? fileName(exportSource) : null}
        sourceInfo={
          (() => {
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
    tracks: t.tracks.map((tr) => ({ ...tr, hidden: tr.hidden ?? false })),
  };
}

export default App;
