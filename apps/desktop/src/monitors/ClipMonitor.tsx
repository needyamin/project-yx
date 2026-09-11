import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { formatTime, type LibraryItem } from "../timeline/types";
import type { PreviewAspect } from "./ProjectMonitor";

type Props = {
  media: LibraryItem | null;
  aspect: PreviewAspect;
};

export function ClipMonitor({ media, aspect }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mode =
    media?.has_video ? ("video" as const) : media?.has_audio ? ("audio" as const) : ("empty" as const);

  const src = (() => {
    if (!media?.path) return null;
    try {
      return convertFileSrc(media.path);
    } catch {
      return null;
    }
  })();

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
    if (mode === "video" && video) {
      video.src = src;
      video.load();
    } else if (mode === "audio" && audio) {
      audio.src = src;
      audio.load();
    }
  }, [src, mode, media?.path]);

  useEffect(() => {
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

  function togglePlay() {
    const el = mode === "video" ? videoRef.current : mode === "audio" ? audioRef.current : null;
    if (!el || !src) return;
    if (el.paused) void el.play();
    else el.pause();
  }

  return (
    <div className={`monitor clip-monitor aspect-${aspect}`}>
      <div className="monitor-label">Clip Monitor</div>
      <div className="monitor-stage">
        <div className={`monitor-frame ${aspect === "tiktok" ? "phone" : "wide"}`}>
          <video
            ref={videoRef}
            className="monitor-video"
            playsInline
            preload="metadata"
            style={{ display: mode === "video" && src ? "block" : "none" }}
          />
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
              <p>Select a clip in the Project Bin</p>
            </div>
          )}
        </div>
        {error && <div className="preview-error">{error}</div>}
      </div>
      <div className="monitor-transport">
        <button className="play-btn sm" onClick={togglePlay} disabled={!src}>
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="timecode">{formatTime(time)}</span>
        <span className="timecode muted-tc">
          / {formatTime(media?.duration ?? 0)}
        </span>
      </div>
    </div>
  );
}
