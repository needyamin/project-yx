import type { RefObject } from "react";
import { formatTime } from "../timeline/types";

export type PreviewMode = "video" | "audio" | "empty";
export type PreviewAspect = "landscape" | "tiktok";

type Props = {
  previewMode: PreviewMode;
  previewSrc: string | null;
  playing: boolean;
  playhead: number;
  duration: number;
  previewError?: string | null;
  aspect: PreviewAspect;
  onAspect: (a: PreviewAspect) => void;
  videoRef: RefObject<HTMLVideoElement | null>;
  audioRef: RefObject<HTMLAudioElement | null>;
  onTogglePlay: () => void;
  onSeekRatio: (ratio: number) => void;
};

export function ProjectMonitor({
  previewMode,
  previewSrc,
  playing,
  playhead,
  duration,
  previewError,
  aspect,
  onAspect,
  videoRef,
  audioRef,
  onTogglePlay,
  onSeekRatio,
}: Props) {
  const safeDur = Math.max(0.001, duration);
  const tiktok = aspect === "tiktok";

  return (
    <div className={`monitor project-monitor aspect-${aspect}`}>
      <div className="monitor-label">
        <span>Project Monitor</span>
        <div className="aspect-toggle" role="group" aria-label="Preview aspect">
          <button
            type="button"
            className={!tiktok ? "active" : ""}
            title="Landscape 16:9"
            onClick={() => onAspect("landscape")}
          >
            16:9
          </button>
          <button
            type="button"
            className={tiktok ? "active" : ""}
            title="TikTok vertical 9:16"
            onClick={() => onAspect("tiktok")}
          >
            9:16
          </button>
        </div>
      </div>
      <div className="monitor-stage">
        <div className={`monitor-frame ${tiktok ? "phone" : "wide"}`}>
          <video
            ref={videoRef}
            className="monitor-video"
            playsInline
            preload="metadata"
            style={{ display: previewMode === "video" && previewSrc ? "block" : "none" }}
          />
          <div
            className="monitor-audio-only"
            style={{ display: previewMode === "audio" && previewSrc ? "grid" : "none" }}
          >
            <div className="audio-orb small">♪</div>
            <h2>Audio preview</h2>
            <p>Playing timeline audio</p>
            <audio ref={audioRef} preload="metadata" />
          </div>
          {previewMode === "empty" && (
            <div className="monitor-empty">
              <div className="logo soft">YX</div>
              <p>
                {tiktok
                  ? "TikTok frame · import vertical or landscape clips"
                  : "Import media, then place clips on the timeline."}
              </p>
            </div>
          )}
        </div>
        {previewError && <div className="preview-error">{previewError}</div>}
      </div>
      <div className="monitor-transport">
        <button className="play-btn sm" onClick={onTogglePlay} disabled={!previewSrc}>
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="timecode">{formatTime(playhead)}</span>
        <input
          className="scrub"
          type="range"
          min={0}
          max={1000}
          value={Math.round((playhead / safeDur) * 1000)}
          disabled={!previewSrc && duration <= 0}
          onChange={(e) => onSeekRatio(Number(e.target.value) / 1000)}
        />
        <span className="timecode muted-tc">{formatTime(duration)}</span>
      </div>
    </div>
  );
}
