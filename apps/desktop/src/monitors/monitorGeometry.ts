/**
 * Shared monitor geometry — the single source of truth for mapping between
 * screen pixels and source-media coordinates inside a monitor frame.
 *
 * Why this exists: the monitor frame is a fixed-aspect box (16:9 or 9:16)
 * while the media inside it is displayed with `object-fit: contain` or
 * `cover`. Crop fractions, transform offsets and color-picks must all be
 * expressed relative to the SOURCE media (object-view-box percentages and
 * the FFmpeg `crop=iw*w:ih*h:...` filter are both source-relative), so every
 * pointer interaction has to go through the displayed content rect below.
 * Mapping straight from the frame box silently breaks for any source whose
 * aspect ratio differs from the frame.
 */

/** Displayed content rect as fractions of the monitor frame box. */
export type ContentRect = { x: number; y: number; w: number; h: number };

export type FitMode = "contain" | "cover";

/**
 * Rect of the media content actually painted inside the frame, as fractions
 * of the frame (`x`/`y` may be negative and `w`/`h` may exceed 1 for
 * `cover`, where content paints past the frame edges).
 */
export function displayedContentRect(
  frameW: number,
  frameH: number,
  naturalW: number,
  naturalH: number,
  fit: FitMode,
): ContentRect {
  if (
    frameW <= 0 ||
    frameH <= 0 ||
    naturalW <= 0 ||
    naturalH <= 0 ||
    !Number.isFinite(frameW) ||
    !Number.isFinite(frameH) ||
    !Number.isFinite(naturalW) ||
    !Number.isFinite(naturalH)
  ) {
    return { x: 0, y: 0, w: 1, h: 1 };
  }
  const scale =
    fit === "cover"
      ? Math.max(frameW / naturalW, frameH / naturalH)
      : Math.min(frameW / naturalW, frameH / naturalH);
  // For "cover" these legitimately exceed 1 (content paints past the frame).
  const w = Math.max(1e-6, (naturalW * scale) / frameW);
  const h = Math.max(1e-6, (naturalH * scale) / frameH);
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/** Map a point (frame-relative fractions) to source fractions, clamped in. */
export function frameFractionToSource(
  fx: number,
  fy: number,
  content: ContentRect,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(1, (fx - content.x) / content.w)),
    y: Math.max(0, Math.min(1, (fy - content.y) / content.h)),
  };
}

/** Map a client point to source fractions via the frame's client rect. */
export function clientToSource(
  clientX: number,
  clientY: number,
  frameRect: { left: number; top: number; width: number; height: number },
  content: ContentRect,
): { x: number; y: number } {
  const fx = (clientX - frameRect.left) / Math.max(1, frameRect.width);
  const fy = (clientY - frameRect.top) / Math.max(1, frameRect.height);
  return frameFractionToSource(fx, fy, content);
}

/**
 * Position a source-relative crop box over the frame: returns the frame-
 * relative insets (percent) that render the box exactly over the content
 * region it selects. With a matching source/frame aspect this equals the
 * raw crop percentages.
 */
export function cropBoxFrameInsets(
  crop: { left: number; top: number; right: number; bottom: number },
  content: ContentRect,
): { left: string; top: string; right: string; bottom: string } {
  const l = (content.x + crop.left * content.w) * 100;
  const t = (content.y + crop.top * content.h) * 100;
  const r = (1 - content.x - content.w + crop.right * content.w) * 100;
  const b = (1 - content.y - content.h + crop.bottom * content.h) * 100;
  const pct = (v: number) => `${v.toFixed(3)}%`;
  return { left: pct(l), top: pct(t), right: pct(r), bottom: pct(b) };
}

/** Is a client point inside the given element's client rect? */
export function pointInElement(
  clientX: number,
  clientY: number,
  el: Element | null | undefined,
): boolean {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return (
    clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom
  );
}
