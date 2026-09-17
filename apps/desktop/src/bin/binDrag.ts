import type { LibraryItem } from "../timeline/types";

export type BinPointerDragSession = {
  item: LibraryItem;
  clientX: number;
  clientY: number;
  /** True once movement exceeds the drag threshold. */
  active: boolean;
};

type Listener = (session: BinPointerDragSession | null) => void;

let session: BinPointerDragSession | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const cb of listeners) cb(session);
}

export function subscribeBinDrag(cb: Listener): () => void {
  listeners.add(cb);
  cb(session);
  return () => {
    listeners.delete(cb);
  };
}

export function getBinPointerDrag(): BinPointerDragSession | null {
  return session;
}

export function startBinPointerDrag(
  item: LibraryItem,
  clientX: number,
  clientY: number,
): void {
  session = { item, clientX, clientY, active: false };
  emit();
}

export function updateBinPointerDrag(clientX: number, clientY: number): void {
  if (!session) return;
  session = { ...session, clientX, clientY };
  emit();
}

export function activateBinPointerDrag(): void {
  if (!session || session.active) return;
  session = { ...session, active: true };
  emit();
}

export function endBinPointerDrag(): BinPointerDragSession | null {
  const ended = session;
  session = null;
  emit();
  return ended;
}

/** Hit-test target under point (call with ghost hidden / pointer-events none). */
export function hitBinDropTarget(
  clientX: number,
  clientY: number,
): "timeline" | "clip-monitor" | "project-monitor" | null {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;
  if (el.closest(".timeline-panel") || el.closest(".tl-scroller")) return "timeline";
  if (el.closest(".project-monitor .monitor-frame")) return "project-monitor";
  if (el.closest(".clip-monitor")) return "clip-monitor";
  return null;
}
