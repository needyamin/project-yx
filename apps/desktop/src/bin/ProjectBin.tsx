import { formatTime, type LibraryItem } from "../timeline/types";

export type BinFilter = "media" | "audio";

type Props = {
  library: LibraryItem[];
  selectedMediaId: string | null;
  filter: BinFilter;
  onFilter: (f: BinFilter) => void;
  onSelect: (id: string) => void;
  onImport: () => void;
  onAddToTimeline: (item: LibraryItem) => void;
  busy: boolean;
  dragOver?: boolean;
};

export function ProjectBin({
  library,
  selectedMediaId,
  filter,
  onFilter,
  onSelect,
  onImport,
  onAddToTimeline,
  busy,
  dragOver = false,
}: Props) {
  const items =
    filter === "media"
      ? library.filter((m) => m.has_video)
      : library.filter((m) => m.has_audio && !m.has_video);

  const selected = library.find((m) => m.id === selectedMediaId) ?? null;
  const canAdd =
    selected &&
    ((filter === "media" && selected.has_video) ||
      (filter === "audio" && selected.has_audio && !selected.has_video));

  return (
    <aside className={`project-bin ${dragOver ? "drag-over" : ""}`}>
      <div className="bin-header">
        <strong>Bin</strong>
        <button className="bin-import" disabled={busy} onClick={onImport} title="Import media">
          Import
        </button>
      </div>

      <nav className="bin-tabs">
        <button className={filter === "media" ? "active" : ""} onClick={() => onFilter("media")}>
          Media
        </button>
        <button className={filter === "audio" ? "active" : ""} onClick={() => onFilter("audio")}>
          Audio
        </button>
      </nav>

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
          <button
            key={item.id}
            type="button"
            className={`bin-item ${selectedMediaId === item.id ? "selected" : ""}`}
            onClick={() => onSelect(item.id)}
            onDoubleClick={() => onAddToTimeline(item)}
            title="Double-click to add to timeline"
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
          </button>
        ))}
      </div>

      {dragOver && items.length > 0 && (
        <div className="bin-drop-overlay">Drop to import</div>
      )}

      {canAdd && selected && (
        <button
          className="full-btn bin-add"
          disabled={busy}
          onClick={() => onAddToTimeline(selected)}
        >
          Add to timeline
        </button>
      )}
    </aside>
  );
}
