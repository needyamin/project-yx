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
  /** Hidden second video used to preload the next clip for gapless cuts. */
  shadowVideoRef: RefObject<HTMLVideoElement | null>;
  audioRef: RefObject<HTMLAudioElement | null>;
  onTogglePlay: () => void;
  onSeekRatio: (ratio: number) => void;
  volume: number;
  muted: boolean;
  onVolume: (v: number) => void;
  onMuted: (m: boolean) => void;
  cropTool?: boolean;
  onCropTool?: (on: boolean) => void;
  cropDraft?: CropRect | null;
  onCropCommit?: (crop: CropRect) => void;
  chromakeyActive?: boolean;
  onEyedropColor?: (hex: string) => void;
  /** When Clip Monitor is hidden, show a control to restore it. */
  onShowClipMonitor?: () => void;
  /** Whether the project timeline contains any clips. */
  hasTimelineClips?: boolean;
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
  shadowVideoRef,
  audioRef,
  onTogglePlay,
  onSeekRatio,
  volume,
  muted,
  onVolume,
  onMuted,
  cropTool = false,
  onCropTool,
  cropDraft,
  onCropCommit,
  chromakeyActive = false,
  onEyedropColor,
  onShowClipMonitor,
  hasTimelineClips = false,
}: Props) {
  const safeDur = Math.max(0.001, duration);
  const tiktok = aspect === "tiktok";
  const frameRef = useRef<HTMLDivElement | null>(null);
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

  const [activeCrop, setActiveCrop] = useState<CropRect | null>(null);

  useEffect(() => {
    setActiveCrop(cropDraft ?? null);
  }, [cropDraft]);

  const currentCrop = activeCrop ?? cropDraft ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const cropWidth = Math.max(0.05, 1 - currentCrop.left - currentCrop.right);
  const cropHeight = Math.max(0.05, 1 - currentCrop.top - currentCrop.bottom);

  type DragMode = "body" | "new" | "tl" | "tr" | "bl" | "br" | "t" | "b" | "l" | "r";

  function startCropDrag(mode: DragMode, e: ReactPointerEvent) {
    if (!cropTool || previewMode !== "video") return;
    e.preventDefault();
    e.stopPropagation();

    const el = frameRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;

    const base = activeCrop ?? cropDraft ?? { left: 0, top: 0, right: 0, bottom: 0 };
    let current = { ...base };

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / Math.max(1, rect.width);
      const dy = (ev.clientY - startY) / Math.max(1, rect.height);
      let next = { ...base };

      if (mode === "body") {
        const w = 1 - base.left - base.right;
        const h = 1 - base.top - base.bottom;
        const newL = Math.max(0, Math.min(1 - w, base.left + dx));
        const newT = Math.max(0, Math.min(1 - h, base.top + dy));
        next = {
          left: newL,
          top: newT,
          right: Math.max(0, 1 - newL - w),
          bottom: Math.max(0, 1 - newT - h),
        };
      } else if (mode === "new") {
        const p0x = Math.max(0, Math.min(1, (startX - rect.left) / rect.width));
        const p0y = Math.max(0, Math.min(1, (startY - rect.top) / rect.height));
        const p1x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        const p1y = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
        const l = Math.min(p0x, p1x);
        const r = 1 - Math.max(p0x, p1x);
        const t = Math.min(p0y, p1y);
        const b = 1 - Math.max(p0y, p1y);
        if (1 - l - r >= 0.05 && 1 - t - b >= 0.05) {
          next = { left: l, top: t, right: r, bottom: b };
        }
      } else {
        if (mode.includes("l")) {
          next.left = Math.max(0, Math.min(1 - base.right - 0.05, base.left + dx));
        }
        if (mode.includes("r")) {
          next.right = Math.max(0, Math.min(1 - base.left - 0.05, base.right - dx));
        }
        if (mode.includes("t")) {
          next.top = Math.max(0, Math.min(1 - base.bottom - 0.05, base.top + dy));
        }
        if (mode.includes("b")) {
          next.bottom = Math.max(0, Math.min(1 - base.top - 0.05, base.bottom - dy));
        }
      }

      current = next;
      setActiveCrop(next);

      // Live visual preview on video element
      if (videoRef.current) {
        const topPct = (next.top * 100).toFixed(2);
        const rightPct = (next.right * 100).toFixed(2);
        const bottomPct = (next.bottom * 100).toFixed(2);
        const leftPct = (next.left * 100).toFixed(2);
        videoRef.current.style.clipPath = `inset(${topPct}% ${rightPct}% ${bottomPct}% ${leftPct}%)`;
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (onCropCommit) {
        onCropCommit(current);
      }
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

  const canPlay = Boolean(previewSrc || hasTimelineClips || duration > 0);

  const ctxItems: ContextMenuItem[] = [
    {
      type: "item",
      label: playing ? "Pause" : "Play",
      disabled: !canPlay,
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
          onPointerDown={(e) => startCropDrag("new", e)}
        >
          <video
            ref={videoRef}
            className="monitor-video is-front"
            playsInline
            muted
            preload="metadata"
            onClick={onVideoClick}
            style={{
              display: previewMode === "video" && previewSrc ? "block" : "none",
              cursor: chromakeyActive ? "crosshair" : undefined,
            }}
          />
          {/* Buffer: preloads the next clip so cuts don't stall the pipeline. */}
          <video
            ref={shadowVideoRef}
            className="monitor-video is-back"
            playsInline
            muted
            preload="metadata"
            style={{
              display: previewMode === "video" && previewSrc ? "block" : "none",
            }}
          />
          {cropTool && previewMode === "video" && (
            <div
              className="crop-box"
              style={{
                left: `${currentCrop.left * 100}%`,
                top: `${currentCrop.top * 100}%`,
                right: `${currentCrop.right * 100}%`,
                bottom: `${currentCrop.bottom * 100}%`,
              }}
            >
              {/* Body for moving the whole box */}
              <div
                className="crop-box-body"
                onPointerDown={(e) => startCropDrag("body", e)}
                title="Drag to move crop area"
              />

              {/* Rule of thirds grid lines */}
              <div className="crop-grid-h1" />
              <div className="crop-grid-h2" />
              <div className="crop-grid-v1" />
              <div className="crop-grid-v2" />

              {/* 4 Corner Resize Handles */}
              <div
                className="crop-handle crop-handle-tl"
                onPointerDown={(e) => startCropDrag("tl", e)}
                title="Resize Top-Left"
              />
              <div
                className="crop-handle crop-handle-tr"
                onPointerDown={(e) => startCropDrag("tr", e)}
                title="Resize Top-Right"
              />
              <div
                className="crop-handle crop-handle-bl"
                onPointerDown={(e) => startCropDrag("bl", e)}
                title="Resize Bottom-Left"
              />
              <div
                className="crop-handle crop-handle-br"
                onPointerDown={(e) => startCropDrag("br", e)}
                title="Resize Bottom-Right"
              />

              {/* 4 Edge Resize Handles */}
              <div
                className="crop-handle crop-handle-t"
                onPointerDown={(e) => startCropDrag("t", e)}
                title="Resize Top Edge"
              />
              <div
                className="crop-handle crop-handle-b"
                onPointerDown={(e) => startCropDrag("b", e)}
                title="Resize Bottom Edge"
              />
              <div
                className="crop-handle crop-handle-l"
                onPointerDown={(e) => startCropDrag("l", e)}
                title="Resize Left Edge"
              />
              <div
                className="crop-handle crop-handle-r"
                onPointerDown={(e) => startCropDrag("r", e)}
                title="Resize Right Edge"
              />

              {/* Information badge & Quick Actions */}
              <div className={`crop-info-badge ${currentCrop.top < 0.12 ? "flip-inside" : ""}`}>
                <span className="crop-dim-text">
                  Crop:
                  <span className="crop-dim-val">
                    {Math.round(cropWidth * 100)}% × {Math.round(cropHeight * 100)}%
                  </span>
                </span>
                <button
                  type="button"
                  className="crop-badge-btn"
                  title="Reset crop to full frame"
                  onClick={(e) => {
                    e.stopPropagation();
                    const zero = { left: 0, top: 0, right: 0, bottom: 0 };
                    setActiveCrop(zero);
                    if (videoRef.current) {
                      videoRef.current.style.clipPath = "";
                    }
                    onCropCommit?.(zero);
                  }}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="crop-badge-btn done"
                  title="Done cropping"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCropTool?.(false);
                  }}
                >
                  Done
                </button>
              </div>
            </div>
          )}
          <audio ref={audioRef} preload="metadata" className="monitor-timeline-audio" />
          <div
            className="monitor-audio-only"
            style={{ display: !hasTimelineClips && previewMode === "audio" && previewSrc ? "grid" : "none" }}
          >
            <div className="audio-orb small">♪</div>
            <h2>Audio preview</h2>
            <p>Playing timeline audio</p>
          </div>
          {previewMode === "empty" && !hasTimelineClips && (
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
        <button type="button" className="play-btn sm" onClick={onTogglePlay} disabled={!canPlay}>
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="timecode">{formatTime(playhead)}</span>
        <input
          className="scrub"
          type="range"
          min={0}
          max={1000}
          value={Math.round((playhead / safeDur) * 1000)}
          disabled={!canPlay}
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
