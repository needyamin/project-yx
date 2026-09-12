import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { effectMeta, effectShortLabel } from "../effects/effects";
import { formatTime, type LibraryItem } from "../timeline/types";
import {
  activateBinPointerDrag,
  endBinPointerDrag,
  hitBinDropTarget,
  startBinPointerDrag,
  updateBinPointerDrag,
} from "./binDrag";

export type BinFilter = "media" | "audio" | "effects";

export type EffectItem = {
  id: string;
  label: string;
  heavy?: boolean;
};

type Props = {
  library: LibraryItem[];
  selectedMediaId: string | null;
  filter: BinFilter;
  onFilter: (f: BinFilter) => void;
  onSelect: (id: string) => void;
  onImport: () => void;
  onAddToTimeline: (item: LibraryItem) => void;
  /** Drop onto timeline at client X (panel converts to time). */
  onDropToTimeline: (item: LibraryItem, clientX: number) => void;
  /** Drop onto Clip Monitor for source preview. */
  onDropToClipMonitor: (item: LibraryItem) => void;
  busy: boolean;
  dragOver?: boolean;
  effects?: EffectItem[];
  effectsEnabled?: boolean;
  effectsAllowHeavy?: boolean;
  onApplyEffect?: (id: string) => void;
  selectedClipSummary?: string | null;
};

const DRAG_THRESHOLD_PX = 5;

export function ProjectBin({
  library,
  selectedMediaId,
  filter,
  onFilter,
  onSelect,
  onImport,
  onAddToTimeline,
  onDropToTimeline,
  onDropToClipMonitor,
  busy,
  dragOver = false,
  effects = [],
  effectsEnabled = false,
  effectsAllowHeavy = true,
  onApplyEffect,
  selectedClipSummary = null,
}: Props) {
  const items =
    filter === "media"
      ? library.filter((m) => m.has_video)
      : filter === "audio"
        ? library.filter((m) => m.has_audio && !m.has_video)
        : [];

  const selected = library.find((m) => m.id === selectedMediaId) ?? null;
  const canAdd =
    selected &&
    ((filter === "media" && selected.has_video) ||
      (filter === "audio" && selected.has_audio && !selected.has_video));

  const [ghost, setGhost] = useState<{
    item: LibraryItem;
    x: number;
    y: number;
  } | null>(null);
  const didDragRef = useRef(false);

  function beginItemPointer(e: ReactPointerEvent, item: LibraryItem) {
    if (e.button !== 0 || busy) return;
    e.preventDefault();
    const originX = e.clientX;
    const originY = e.clientY;
    let dragging = false;
    didDragRef.current = false;

    startBinPointerDrag(item, originX, originY);
    onSelect(item.id);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - originX;
      const dy = ev.clientY - originY;
      if (!dragging && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        dragging = true;
        didDragRef.current = true;
        activateBinPointerDrag();
      }
      if (!dragging) return;
      updateBinPointerDrag(ev.clientX, ev.clientY);
      setGhost({ item, x: ev.clientX, y: ev.clientY });
    };

    const finish = (ev: PointerEvent, cancelled = false) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);

      const ended = endBinPointerDrag();
      setGhost(null);

      if (cancelled || !dragging || !ended) return;

      const target = hitBinDropTarget(ev.clientX, ev.clientY);
      if (target === "timeline") {
        onDropToTimeline(ended.item, ev.clientX);
      } else if (target === "clip-monitor") {
        onDropToClipMonitor(ended.item);
      }
    };

    const onUp = (ev: PointerEvent) => finish(ev, false);
    const onCancel = (ev: PointerEvent) => finish(ev, true);

    const onKey = (kev: KeyboardEvent) => {
      if (kev.key === "Escape") {
        finish(
          new PointerEvent("pointerup", { clientX: originX, clientY: originY }),
          true,
        );
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
  }

  return (
    <aside className={`project-bin ${dragOver ? "drag-over" : ""}`}>
      <div className="bin-header">
        <strong>Project Bin</strong>
        <button className="bin-import" disabled={busy} onClick={onImport} title="Import media">
          Import
        </button>
      </div>

      <nav className="bin-tabs three">
        <button
          type="button"
          className={filter === "media" ? "active" : ""}
          onClick={() => onFilter("media")}
        >
          Media
        </button>
        <button
          type="button"
          className={filter === "audio" ? "active" : ""}
          onClick={() => onFilter("audio")}
        >
          Audio
        </button>
        <button
          type="button"
          className={filter === "effects" ? "active" : ""}
          onClick={() => onFilter("effects")}
        >
          Effects
        </button>
      </nav>

      {filter === "effects" ? (
        <div className="bin-list effects-list">
          {!effectsEnabled && (
            <p className="empty-hint">Select a timeline clip to apply effects.</p>
          )}
          <div className="effect-grid">
            {effects.map((f) => {
              const meta = effectMeta(f.id);
              return (
                <button
                  key={f.id}
                  type="button"
                  className={`effect-card ${f.heavy && !effectsAllowHeavy ? "heavy" : ""}`}
                  disabled={!effectsEnabled}
                  onClick={() => onApplyEffect?.(f.id)}
                  title={f.label}
                  style={{ ["--effect-hue" as string]: meta.hue }}
                >
                  <span className="effect-icon" aria-hidden>
                    {meta.glyph}
                  </span>
                  <span className="effect-label">{effectShortLabel(f.id)}</span>
                </button>
              );
            })}
          </div>
          {selectedClipSummary && (
            <p className="bin-clip-hint">Target: {selectedClipSummary}</p>
          )}
        </div>
      ) : (
        <>
          <div className="bin-list">
            {items.length === 0 && (
              <div className="bin-drop-hint">
                <p>Drop media here</p>
                <small>
                  {filter === "media" ? "MP4, MOV, MKV…" : "MP3, WAV, AAC…"}
                </small>
              </div>
            )}
            {items.map((item) => (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                className={`bin-item ${selectedMediaId === item.id ? "selected" : ""} ${ghost?.item.id === item.id ? "dragging" : ""}`}
                onClick={() => {
                  if (didDragRef.current) {
                    didDragRef.current = false;
                    return;
                  }
                  onSelect(item.id);
                }}
                onDoubleClick={() => onAddToTimeline(item)}
                onPointerDown={(e) => beginItemPointer(e, item)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(item.id);
                  }
                }}
                title="Drag to timeline or Clip Monitor · double-click to add"
              >
                <div className={`bin-thumb ${item.has_video ? "" : "audio"}`}>
                  {item.has_video ? (
                    <span>
                      {item.width}×{item.height}
                    </span>
                  ) : (
                    <span>♪</span>
                  )}
                </div>
                <div className="bin-meta">
                  <strong>{item.name}</strong>
                  <small>
                    {formatTime(item.duration)}
                    {item.has_video && item.has_audio
                      ? " · A/V"
                      : item.has_video
                        ? " · V"
                        : " · A"}
                  </small>
                </div>
              </div>
            ))}
          </div>

          {dragOver && items.length > 0 && (
            <div className="bin-drop-overlay">Drop to import</div>
          )}

          {selected && (
            <div className="bin-detail">
              <strong>{selected.name}</strong>
              <small>
                {selected.has_video
                  ? `${selected.width}×${selected.height} · ${selected.frame_rate.toFixed(2)} fps · `
                  : ""}
                {formatTime(selected.duration)}
              </small>
            </div>
          )}

          {canAdd && selected && (
            <button
              type="button"
              className="full-btn bin-add"
              disabled={busy}
              onClick={() => onAddToTimeline(selected)}
            >
              Add to timeline
            </button>
          )}
        </>
      )}

      {ghost && (
        <div
          className="bin-drag-ghost"
          style={{ left: ghost.x + 12, top: ghost.y + 12 }}
          aria-hidden
        >
          <div className={`bin-thumb ${ghost.item.has_video ? "" : "audio"}`}>
            {ghost.item.has_video ? (
              <span>
                {ghost.item.width}×{ghost.item.height}
              </span>
            ) : (
              <span>♪</span>
            )}
          </div>
          <strong>{ghost.item.name}</strong>
        </div>
      )}
    </aside>
  );
}
