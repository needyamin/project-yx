import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { effectMeta, effectShortLabel } from "../effects/effects";
import { formatTime, type LibraryItem } from "../timeline/types";
import { ContextMenuPopup, type ContextMenuItem } from "../ui/ContextMenu";
import {
  activateBinPointerDrag,
  endBinPointerDrag,
  hitBinDropTarget,
  startBinPointerDrag,
  subscribeBinDrag,
  updateBinPointerDrag,
} from "./binDrag";

export type BinFilter = "media" | "audio" | "effects" | "applied";

export type EffectItem = {
  id: string;
  label: string;
  heavy?: boolean;
  roles?: ("video" | "audio")[];
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
  /** Drop onto the Project Monitor — places the item at the playhead. */
  onDropToProjectMonitor?: (item: LibraryItem) => void;
  onRemoveFromBin: (item: LibraryItem) => void;
  onAdvancedAudio?: (
    item: LibraryItem,
    tab?: "overview" | "waveform" | "effects",
  ) => void;
  busy: boolean;
  dragOver?: boolean;
  effects?: EffectItem[];
  effectsEnabled?: boolean;
  effectsAllowHeavy?: boolean;
  onApplyEffect?: (id: string) => void;
  selectedClipSummary?: string | null;
};

const DRAG_THRESHOLD_PX = 5;

type BinCtx =
  | { x: number; y: number; kind: "item"; item: LibraryItem }
  | { x: number; y: number; kind: "empty" }
  | { x: number; y: number; kind: "effect"; effectId: string; label: string };

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
  onDropToProjectMonitor,
  onRemoveFromBin,
  onAdvancedAudio,
  busy,
  dragOver = false,
  effects = [],
  effectsEnabled = false,
  effectsAllowHeavy = true,
  onApplyEffect,
  selectedClipSummary = null,
}: Props) {
  // Media tab = every imported asset (video, audio, images). Audio tab =
  // audio-only view. Nothing can "go missing" after import.
  const items =
    filter === "media"
      ? library
      : filter === "audio"
        ? library.filter((m) => m.has_audio && !m.has_video)
        : [];

  const selected = library.find((m) => m.id === selectedMediaId) ?? null;
  const canAdd =
    selected &&
    ((filter === "media" && (selected.has_video || selected.has_audio)) ||
      (filter === "audio" && selected.has_audio && !selected.has_video));

  const [ghost, setGhost] = useState<{
    item: LibraryItem;
    x: number;
    y: number;
  } | null>(null);
  const [ctx, setCtx] = useState<BinCtx | null>(null);
  const [effectSearch, setEffectSearch] = useState("");
  const [ghostOverTimeline, setGhostOverTimeline] = useState(false);
  const didDragRef = useRef(false);

  useEffect(() => {
    return subscribeBinDrag((session) => {
      if (!session?.active) {
        setGhostOverTimeline(false);
        return;
      }
      setGhostOverTimeline(hitBinDropTarget(session.clientX, session.clientY) === "timeline");
    });
  }, []);

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
      } else if (target === "project-monitor" && onDropToProjectMonitor) {
        onDropToProjectMonitor(ended.item);
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

  async function revealInFolder(path: string) {
    try {
      // Opens the OS file manager with the file selected (Explorer/Finder).
      await revealItemInDir(path);
    } catch {
      // Fallback: open the containing folder.
      try {
        const normalized = path.replace(/\\/g, "/");
        const slash = normalized.lastIndexOf("/");
        const dir = slash >= 0 ? normalized.slice(0, slash) : normalized;
        await openPath(dir);
      } catch {
        /* ignore */
      }
    }
  }

  function binMenuItems(): ContextMenuItem[] {
    if (!ctx) return [];
    if (ctx.kind === "empty") {
      return [
        {
          type: "item",
          label: "Import…",
          disabled: busy,
          action: () => onImport(),
        },
      ];
    }
    if (ctx.kind === "effect") {
      return [
        {
          type: "item",
          label: `Apply ${ctx.label}`,
          disabled: !effectsEnabled,
          action: () => onApplyEffect?.(ctx.effectId),
        },
      ];
    }
    const item = ctx.item;
    const items: ContextMenuItem[] = [
      {
        type: "item",
        label: "Add to timeline",
        action: () => onAddToTimeline(item),
      },
      {
        type: "item",
        label: "Preview in Clip Monitor",
        action: () => onDropToClipMonitor(item),
      },
      { type: "sep" },
      {
        type: "item",
        label: "Reveal in folder",
        action: () => revealInFolder(item.path),
      },
      {
        type: "item",
        label: "Remove from bin",
        danger: true,
        action: () => onRemoveFromBin(item),
      },
    ];
    if (item.has_audio && !item.has_video) {
      items.splice(
        2,
        0,
        { type: "sep" },
        {
          type: "item",
          label: "Advanced Audio Tools…",
          action: () => onAdvancedAudio?.(item, "overview"),
        },
        {
          type: "item",
          label: "Open Waveform Editor…",
          action: () => onAdvancedAudio?.(item, "waveform"),
        },
      );
    }
    return items;
  }

  return (
    <aside className={`project-bin ${dragOver ? "drag-over" : ""}`}>
      <nav className="bin-tabs four">
        <button
          type="button"
          className={filter === "media" ? "active" : ""}
          onClick={() => onFilter("media")}
        >
          All
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
        <button
          type="button"
          className={filter === "applied" ? "active" : ""}
          onClick={() => onFilter("applied")}
        >
          Applied
        </button>
      </nav>

      {filter === "applied" ? null : filter === "effects" ? (
        <div
          className="bin-list effects-list"
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest(".effect-card")) return;
            e.preventDefault();
            setCtx({ x: e.clientX, y: e.clientY, kind: "empty" });
          }}
        >
          {!effectsEnabled && (
            <p className="empty-hint">Select a timeline clip to apply effects.</p>
          )}
          <input
            type="search"
            className="effect-search"
            placeholder="Search effects…"
            value={effectSearch}
            onChange={(e) => setEffectSearch(e.target.value)}
          />
          <div className="effect-grid">
            {effects
              .filter(
                (f) =>
                  !effectSearch.trim() ||
                  f.label.toLowerCase().includes(effectSearch.trim().toLowerCase()) ||
                  effectShortLabel(f.id).toLowerCase().includes(effectSearch.trim().toLowerCase()),
              )
              .map((f) => {
              const meta = effectMeta(f.id);
              return (
                <button
                  key={f.id}
                  type="button"
                  className={`effect-card ${f.heavy && !effectsAllowHeavy ? "heavy" : ""}`}
                  disabled={!effectsEnabled}
                  onClick={() => onApplyEffect?.(f.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCtx({
                      x: e.clientX,
                      y: e.clientY,
                      kind: "effect",
                      effectId: f.id,
                      label: f.label,
                    });
                  }}
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
          {effects.every(
            (f) =>
              effectSearch.trim() !== "" &&
              !f.label.toLowerCase().includes(effectSearch.trim().toLowerCase()) &&
              !effectShortLabel(f.id).toLowerCase().includes(effectSearch.trim().toLowerCase()),
          ) && <p className="empty-hint">No effects match “{effectSearch}”.</p>}
          {selectedClipSummary && (
            <p className="bin-clip-hint">Target: {selectedClipSummary}</p>
          )}
        </div>
      ) : (
        <>
          <div
            className="bin-list"
            onContextMenu={(e) => {
              if ((e.target as HTMLElement).closest(".bin-item")) return;
              e.preventDefault();
              setCtx({ x: e.clientX, y: e.clientY, kind: "empty" });
            }}
          >
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
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSelect(item.id);
                  setCtx({ x: e.clientX, y: e.clientY, kind: "item", item });
                }}
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

      {ghost && !ghostOverTimeline && (
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

      {ctx && (
        <ContextMenuPopup
          x={ctx.x}
          y={ctx.y}
          items={binMenuItems()}
          onClose={() => setCtx(null)}
        />
      )}
    </aside>
  );
}
