import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { subscribeBinDrag } from "../bin/binDrag";
import { formatTime, isImagePath, type LibraryItem } from "../timeline/types";
import { ContextMenuPopup, type ContextMenuItem } from "../ui/ContextMenu";
import type { PreviewAspect } from "./ProjectMonitor";

type Props = {
  media: LibraryItem | null;
  aspect: PreviewAspect;
  onClose?: () => void;
  onAddToTimeline?: (media: LibraryItem) => void;
};

export function ClipMonitor({ media, aspect, onClose, onAddToTimeline }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullView, setFullView] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);

  const isImage = isImagePath(media?.path);
  const mode = isImage
    ? ("image" as const)
    : media?.has_video
      ? ("video" as const)
      : media?.has_audio
        ? ("audio" as const)
        : ("empty" as const);

  const duration = Math.max(0.001, media?.duration ?? 0);

  const src = (() => {
    if (!media?.path) return null;
    try {
      return convertFileSrc(media.path);
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    return subscribeBinDrag((session) => {
      if (!session?.active) {
        setDragOver(false);
        return;
      }
      const el = document.elementFromPoint(session.clientX, session.clientY);
      setDragOver(Boolean(el?.closest(".clip-monitor")));
    });
  }, []);

  useEffect(() => {
    setPlaying(false);
    setTime(0);
    setError(null);
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
    if (!src) {
      if (media?.path) setError("Could not convert media path for preview.");
      return;
    }
    if (mode === "image") return;
    if (mode === "video" && video) {
      video.src = src;
      video.load();
    } else if (mode === "audio" && audio) {
      audio.src = src;
      audio.load();
    }
  }, [src, mode, media?.path]);

  useEffect(() => {
    if (mode === "image") return;
    const el = mode === "video" ? videoRef.current : mode === "audio" ? audioRef.current : null;
    if (!el) return;
    const onTime = () => setTime(el.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onErr = () => setError("Could not load clip preview.");
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("error", onErr);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("error", onErr);
    };
  }, [mode, src]);

  useEffect(() => {
    const gain = muted ? 0 : volume;
    if (videoRef.current) {
      videoRef.current.volume = gain;
      videoRef.current.muted = muted;
    }
    if (audioRef.current) {
      audioRef.current.volume = gain;
      audioRef.current.muted = muted;
    }
  }, [volume, muted, mode, src]);

  useEffect(() => {
    if (!fullView) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setFullView(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullView]);

  function togglePlay() {
    if (mode === "image") return;
    const el = mode === "video" ? videoRef.current : mode === "audio" ? audioRef.current : null;
    if (!el || !src) return;
    if (el.paused) void el.play();
    else el.pause();
  }

  function seekRatio(ratio: number) {
    if (mode === "image") return;
    const el = mode === "video" ? videoRef.current : mode === "audio" ? audioRef.current : null;
    if (!el || !src) return;
    el.currentTime = ratio * duration;
    setTime(el.currentTime);
  }

  const ctxItems: ContextMenuItem[] = [
    {
      type: "item",
      label: playing ? "Pause" : "Play",
      disabled: !src,
      action: () => togglePlay(),
    },
    {
      type: "item",
      label: fullView ? "Exit full view" : "Full view",
      action: () => setFullView((v) => !v),
    },
    ...(media && onAddToTimeline
      ? ([
          {
            type: "item" as const,
            label: "Add to timeline",
            action: () => onAddToTimeline(media),
          },
        ] as ContextMenuItem[])
      : []),
    ...(onClose
      ? ([
          { type: "sep" as const },
          {
            type: "item" as const,
            label: "Hide Clip Monitor",
            action: () => {
              setFullView(false);
              onClose();
            },
          },
        ] as ContextMenuItem[])
      : []),
  ];

  return (
    <div
      className={`monitor clip-monitor aspect-${aspect} ${dragOver ? "bin-drag-over" : ""} ${fullView ? "full-view" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="monitor-label">
        <span>Clip Monitor</span>
        {media && <span className="monitor-sub">{media.name}</span>}
        <div className="monitor-fs">
          <button
            type="button"
            className={`monitor-fs-btn ${fullView ? "active" : ""}`}
            title={fullView ? "Exit full view" : "Full view"}
            aria-label={fullView ? "Exit full view" : "Full view"}
            onClick={() => setFullView((v) => !v)}
          >
            <span className={`fs-icon ${fullView ? "exit" : ""}`} aria-hidden />
          </button>
          {onClose && (
            <button
              type="button"
              className="monitor-close-btn"
              title="Hide Clip Monitor"
              aria-label="Hide Clip Monitor"
              onClick={() => {
                setFullView(false);
                onClose();
              }}
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className="monitor-stage">
        <div className={`monitor-frame ${aspect === "tiktok" ? "phone" : "wide"}`}>
          <video
            ref={videoRef}
            className="monitor-video"
            playsInline
            preload="metadata"
            crossOrigin="anonymous"
            style={{ display: mode === "video" && src ? "block" : "none" }}
          />
          {mode === "image" && src && (
            <img className="monitor-video" src={src} alt={media?.name ?? "Image"} draggable={false} crossOrigin="anonymous" />
          )}
          <div
            className="monitor-audio-only"
            style={{ display: mode === "audio" && src ? "grid" : "none" }}
          >
            <div className="audio-orb small">♪</div>
            <p>{media?.name ?? "Audio"}</p>
            <audio ref={audioRef} preload="metadata" />
          </div>
          {mode === "empty" && (
            <div className="monitor-empty">
              <p>Select or drop a clip from the Project Bin</p>
            </div>
          )}
          {dragOver && <div className="monitor-drop-hint">Drop to preview</div>}
        </div>
        {error && <div className="preview-error">{error}</div>}
      </div>
      <div className="monitor-transport">
        <button type="button" className="play-btn sm" onClick={togglePlay} disabled={!src || mode === "image"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="timecode">{mode === "image" ? "Still" : formatTime(time)}</span>
        <input
          className="scrub"
          type="range"
          min={0}
          max={1000}
          value={Math.round((time / duration) * 1000)}
          disabled={!src || mode === "image"}
          onChange={(e) => seekRatio(Number(e.target.value) / 1000)}
        />
        <span className="timecode muted-tc">
          {mode === "image" ? "5s on timeline" : formatTime(media?.duration ?? 0)}
        </span>
        <button
          type="button"
          className={`vol-btn sm ${muted || volume === 0 ? "is-muted" : ""}`}
          title={muted || volume === 0 ? "Unmute" : "Mute"}
          aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
          disabled={!src}
          onClick={() => setMuted((m) => !m)}
        >
          {muted || volume === 0 ? "×" : "♪"}
        </button>
        <input
          className="vol-scrub"
          type="range"
          min={0}
          max={100}
          value={Math.round((muted ? 0 : volume) * 100)}
          disabled={!src}
          title="Volume"
          aria-label="Clip monitor volume"
          onChange={(e) => {
            const next = Number(e.target.value) / 100;
            setVolume(next);
            if (next > 0) setMuted(false);
          }}
        />
      </div>
      {ctx && (
        <ContextMenuPopup
          x={ctx.x}
          y={ctx.y}
          items={ctxItems}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  );
}
