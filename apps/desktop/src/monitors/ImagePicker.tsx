import { IMAGE_EXTENSIONS } from "../timeline/types";

export type MonitorImageItem = {
  id: string;
  name: string;
  path: string;
  src: string;
};

/** The image-side twin of the text style picker: pick an image already in
 * the project, or browse the disk — the picked image lands in the monitor
 * as an overlay, ready to drag/resize. */
export function ImagePicker({
  images,
  contextLabel,
  onPick,
  onBrowse,
  onClose,
}: {
  images: MonitorImageItem[];
  /** Tells the user what the image will land on at the playhead. */
  contextLabel?: string;
  onPick: (item: MonitorImageItem) => void;
  onBrowse: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="picker-backdrop"
      onPointerDown={onClose}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="picker-panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <strong>Add an image</strong>
          <button type="button" className="picker-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <button type="button" className="image-picker-browse" onClick={onBrowse}>
          <span className="image-picker-browse-icon">🖼</span>
          <span>
            Browse from disk…
            <small>PNG · JPG · WEBP · BMP · GIF — placed at the playhead</small>
          </span>
        </button>

        {images.length > 0 ? (
          <>
            <div className="picker-section-label">In this project</div>
            <div className="image-picker-grid">
              {images.map((img) => (
                <button
                  key={img.id}
                  type="button"
                  className="image-picker-card"
                  title={`Add ${img.name} over the video`}
                  onClick={() => onPick(img)}
                >
                  <img src={img.src} alt="" loading="lazy" draggable={false} />
                  <span className="image-picker-name">{img.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="image-picker-empty">
            No images in this project yet — browse your disk to add one.
          </div>
        )}

        {contextLabel && <div className="image-picker-context">{contextLabel}</div>}
      </div>
    </div>
  );
}

export const IMAGE_PICKER_EXTENSIONS = IMAGE_EXTENSIONS;
