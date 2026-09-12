import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { formatTime } from "../timeline/types";
import { ContextMenuPopup, type ContextMenuItem } from "../ui/ContextMenu";
import "./ProjectMonitor.css";

export type PreviewMode = "video" | "audio" | "empty";
export type PreviewAspect = "landscape" | "tiktok";

export type CropRect = { left: number; top: number; right: number; bottom: number };

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
  volume: number;
  muted: boolean;
  onVolume: (v: number) => void;
  onMuted: (m: boolean) => void;
  /** Live CSS preview matching export effects. */
  videoStyle?: {
    filter: string;
    transform: string;
    opacity: number;
    clipPath?: string;
  };
  cropTool?: boolean;
  onCropTool?: (on: boolean) => void;
  cropDraft?: CropRect | null;
  onCropCommit?: (crop: CropRect) => void;
  chromakeyActive?: boolean;
  onEyedropColor?: (hex: string) => void;
  /** When Clip Monitor is hidden, show a control to restore it. */
  onShowClipMonitor?: () => void;
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
  volume,
  muted,
  onVolume,
  onMuted,
  videoStyle,
  cropTool = false,
  onCropTool,
  cropDraft,
  onCropCommit,
  chromakeyActive = false,
  onEyedropColor,
  onShowClipMonitor,
}: Props) {
  const safeDur = Math.max(0.001, duration);
  const tiktok = aspect === "tiktok";
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const [fullView, setFullView] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);

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

  function clientToNorm(clientX: number, clientY: number) {
    const el = frameRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))),
      y: Math.max(0, Math.min(1, (clientY - r.top) / Math.max(1, r.height))),
    };
  }

  function beginCrop(e: ReactPointerEvent) {
    if (!cropTool || previewMode !== "video") return;
    e.preventDefault();
    const p = clientToNorm(e.clientX, e.clientY);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });

    const onMove = (ev: PointerEvent) => {
      const q = clientToNorm(ev.clientX, ev.clientY);
      setDrag((d) => (d ? { ...d, x1: q.x, y1: q.y } : d));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrag((d) => {
        if (d && onCropCommit) {
          const left = Math.min(d.x0, d.x1);
          const right = 1 - Math.max(d.x0, d.x1);
          const top = Math.min(d.y0, d.y1);
          const bottom = 1 - Math.max(d.y0, d.y1);
          if (1 - left - right > 0.05 && 1 - top - bottom > 0.05) {
            onCropCommit({ left, top, right, bottom });
          }
        }
        return null;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onVideoClick(e: React.MouseEvent<HTMLVideoElement>) {
    if (!chromakeyActive || !onEyedropColor || !videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 2;
    canvas.height = video.videoHeight || 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    const rect = video.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * canvas.width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * canvas.height);
    const px = ctx.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data;
    const hex = `#${[px[0], px[1], px[2]].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    onEyedropColor(hex);
  }

  const liveCrop = drag
    ? {
        left: Math.min(drag.x0, drag.x1),
        top: Math.min(drag.y0, drag.y1),
        right: 1 - Math.max(drag.x0, drag.x1),
        bottom: 1 - Math.max(drag.y0, drag.y1),
      }
    : cropDraft;

  const ctxItems: ContextMenuItem[] = [
    {
      type: "item",
      label: playing ? "Pause" : "Play",
      disabled: !previewSrc,
      action: () => onTogglePlay(),
    },
    {
      type: "item",
      label: cropTool ? "Disable crop tool" : "Crop tool",
      action: () => onCropTool?.(!cropTool),
    },
    { type: "sep" },
    {
      type: "item",
      label: "Aspect 16:9",
      action: () => onAspect("landscape"),
    },
    {
      type: "item",
      label: "Aspect 9:16",
      action: () => onAspect("tiktok"),
    },
    { type: "sep" },
    {
      type: "item",
      label: fullView ? "Exit full view" : "Full view",
      action: () => setFullView((v) => !v),
    },
    ...(onShowClipMonitor
      ? ([
          {
            type: "item" as const,
            label: "Show Clip Monitor",
            action: () => onShowClipMonitor(),
          },
        ] as ContextMenuItem[])
      : []),
  ];

  return (
    <div
      className={`monitor project-monitor aspect-${aspect} ${fullView ? "full-view" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="monitor-label">
        <span>Project Monitor</span>
        <div className="monitor-tools">
          {onShowClipMonitor && (
            <button
              type="button"
              title="Show Clip Monitor"
              aria-label="Show Clip Monitor"
              onClick={onShowClipMonitor}
            >
              Clip
            </button>
          )}
          <button
            type="button"
            className={cropTool ? "active" : ""}
            title="Crop tool — drag on video"
            onClick={() => onCropTool?.(!cropTool)}
          >
            Crop
          </button>
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
              title="Vertical 9:16"
              onClick={() => onAspect("tiktok")}
            >
              9:16
            </button>
          </div>
        </div>
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
        </div>
      </div>
      <div className="monitor-stage">
        <div
          ref={frameRef}
          className={`monitor-frame ${tiktok ? "phone" : "wide"} ${cropTool ? "crop-mode" : ""}`}
          onPointerDown={beginCrop}
        >
          <video
            ref={videoRef}
            className="monitor-video"
            playsInline
            muted
            preload="metadata"
            onClick={onVideoClick}
            style={{
              display: previewMode === "video" && previewSrc ? "block" : "none",
              filter: videoStyle?.filter,
              transform: videoStyle?.transform,
              opacity: videoStyle?.opacity ?? 1,
              clipPath: videoStyle?.clipPath,
              cursor: chromakeyActive ? "crosshair" : undefined,
            }}
          />
          {liveCrop && previewMode === "video" && (
            <div
              className="crop-overlay"
              style={{
                left: `${liveCrop.left * 100}%`,
                top: `${liveCrop.top * 100}%`,
                right: `${liveCrop.right * 100}%`,
                bottom: `${liveCrop.bottom * 100}%`,
              }}
            />
          )}
          <audio ref={audioRef} preload="metadata" className="monitor-timeline-audio" />
          <div
            className="monitor-audio-only"
            style={{ display: previewMode === "audio" && previewSrc ? "grid" : "none" }}
          >
            <div className="audio-orb small">♪</div>
            <h2>Audio preview</h2>
            <p>Playing timeline audio</p>
          </div>
          {previewMode === "empty" && (
            <div className="monitor-empty">
              <p>
                {tiktok
                  ? "Vertical frame · import media and edit on the timeline"
                  : "Import media, then place clips on the timeline"}
              </p>
            </div>
          )}
        </div>
        {previewError && <div className="preview-error">{previewError}</div>}
      </div>
      <div className="monitor-transport">
        <button type="button" className="play-btn sm" onClick={onTogglePlay} disabled={!previewSrc}>
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
        <button
          type="button"
          className={`vol-btn sm ${muted || volume === 0 ? "is-muted" : ""}`}
          title={muted || volume === 0 ? "Unmute" : "Mute"}
          aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
          onClick={() => onMuted(!muted)}
        >
          {muted || volume === 0 ? "×" : "♪"}
        </button>
        <input
          className="vol-scrub"
          type="range"
          min={0}
          max={100}
          value={Math.round((muted ? 0 : volume) * 100)}
          title="Volume"
          aria-label="Project monitor volume"
          onChange={(e) => {
            const next = Number(e.target.value) / 100;
            onVolume(next);
            if (next > 0) onMuted(false);
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
