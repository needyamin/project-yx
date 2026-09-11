import { useEffect, useRef } from "react";
import type { EditMode, TimelineTool } from "./types";

export type ContextTarget =
  | {
      kind: "clip";
      clipId: string;
      trackId: string;
      linked: boolean;
      at: number;
      clipStart: number;
      clipEnd: number;
    }
  | {
      kind: "lane";
      trackId: string;
      trackKind: "video" | "audio";
      at: number;
      canDelete: boolean;
    }
  | {
      kind: "ruler";
      at: number;
    };

export type ContextMenuState = {
  x: number;
  y: number;
  target: ContextTarget;
};

type Item =
  | { type: "item"; label: string; hint?: string; disabled?: boolean; danger?: boolean; action: () => void }
  | { type: "sep" };

type Props = {
  menu: ContextMenuState;
  tool: TimelineTool;
  editMode: EditMode;
  onClose: () => void;
  onTool: (t: TimelineTool) => void;
  onEditMode: (m: EditMode) => void;
  onSplitAt: (clipId: string, at: number) => void;
  onSplitPlayhead: () => void;
  onDelete: (clipId: string) => void;
  onRippleDelete: (clipId: string) => void;
  onToggleLink: (clipId: string) => void;
  onSeek: (t: number) => void;
  onSetZoneIn: () => void;
  onSetZoneOut: () => void;
  onLiftZone: () => void;
  onExtractZone: () => void;
  onAddMarker: () => void;
  onAddVideoTrack: () => void;
  onAddAudioTrack: () => void;
  onRemoveTrack: (trackId: string) => void;
  canDeleteTrack?: (trackId: string) => boolean;
  onZoomFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onUndo: () => void;
  onRedo: () => void;
};

export function TimelineContextMenu({
  menu,
  tool,
  editMode,
  onClose,
  onTool,
  onEditMode,
  onSplitAt,
  onSplitPlayhead,
  onDelete,
  onRippleDelete,
  onToggleLink,
  onSeek,
  onSetZoneIn,
  onSetZoneOut,
  onLiftZone,
  onExtractZone,
  onAddMarker,
  onAddVideoTrack,
  onAddAudioTrack,
  onRemoveTrack,
  canDeleteTrack,
  onZoomFit,
  onZoomIn,
  onZoomOut,
  onUndo,
  onRedo,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const items = buildItems({
    menu,
    tool,
    editMode,
    onTool,
    onEditMode,
    onSplitAt,
    onSplitPlayhead,
    onDelete,
    onRippleDelete,
    onToggleLink,
    onSeek,
    onSetZoneIn,
    onSetZoneOut,
    onLiftZone,
    onExtractZone,
    onAddMarker,
    onAddVideoTrack,
    onAddAudioTrack,
    onRemoveTrack,
    canDeleteTrack,
    onZoomFit,
    onZoomIn,
    onZoomOut,
    onUndo,
    onRedo,
    onClose,
  });

  // Keep menu on screen
  const left = Math.min(menu.x, window.innerWidth - 220);
  const top = Math.min(menu.y, window.innerHeight - Math.min(480, items.length * 28));

  return (
    <div
      ref={ref}
      className="tl-context-menu"
      style={{ left, top }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.type === "sep" ? (
          <div key={`sep-${i}`} className="tl-ctx-sep" />
        ) : (
          <button
            key={`${item.label}-${i}`}
            type="button"
            role="menuitem"
            className={`tl-ctx-item ${item.danger ? "danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              item.action();
              onClose();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <kbd>{item.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

function buildItems(p: {
  menu: ContextMenuState;
  tool: TimelineTool;
  editMode: EditMode;
  onTool: (t: TimelineTool) => void;
  onEditMode: (m: EditMode) => void;
  onSplitAt: (clipId: string, at: number) => void;
  onSplitPlayhead: () => void;
  onDelete: (clipId: string) => void;
  onRippleDelete: (clipId: string) => void;
  onToggleLink: (clipId: string) => void;
  onSeek: (t: number) => void;
  onSetZoneIn: () => void;
  onSetZoneOut: () => void;
  onLiftZone: () => void;
  onExtractZone: () => void;
  onAddMarker: () => void;
  onAddVideoTrack: () => void;
  onAddAudioTrack: () => void;
  onRemoveTrack: (trackId: string) => void;
  onZoomFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onClose: () => void;
  canDeleteTrack?: (trackId: string) => boolean;
}): Item[] {
  const { menu } = p;
  const items: Item[] = [];

  if (menu.target.kind === "clip") {
    const t = menu.target;
    const canDeleteTrack = p.canDeleteTrack?.(t.trackId) ?? false;
    items.push(
      {
        type: "item",
        label: "Split at cursor",
        hint: "X",
        action: () => p.onSplitAt(t.clipId, t.at),
      },
      {
        type: "item",
        label: "Split at playhead",
        hint: "Ctrl+B",
        action: () => p.onSplitPlayhead(),
      },
      { type: "sep" },
      {
        type: "item",
        label: "Go to clip start",
        action: () => p.onSeek(t.clipStart),
      },
      {
        type: "item",
        label: "Go to clip end",
        action: () => p.onSeek(Math.max(0, t.clipEnd - 0.01)),
      },
      { type: "sep" },
      {
        type: "item",
        label: t.linked ? "Unlink A/V" : "Link A/V",
        action: () => p.onToggleLink(t.clipId),
      },
      {
        type: "item",
        label: "Delete clip",
        danger: true,
        hint: "Del",
        action: () => p.onDelete(t.clipId),
      },
      {
        type: "item",
        label: "Ripple delete",
        danger: true,
        action: () => p.onRippleDelete(t.clipId),
      },
      {
        type: "item",
        label: "Delete track",
        danger: true,
        disabled: !canDeleteTrack,
        action: () => p.onRemoveTrack(t.trackId),
      },
      { type: "sep" },
    );
  } else if (menu.target.kind === "lane") {
    const t = menu.target;
    items.push(
      {
        type: "item",
        label: "Seek here",
        action: () => p.onSeek(t.at),
      },
      {
        type: "item",
        label: `Delete ${t.trackKind} track`,
        danger: true,
        disabled: !t.canDelete,
        action: () => p.onRemoveTrack(t.trackId),
      },
      { type: "sep" },
    );
  } else {
    items.push(
      {
        type: "item",
        label: "Seek here",
        action: () => p.onSeek(menu.target.at),
      },
      { type: "sep" },
    );
  }

  const mark = (active: boolean, label: string) =>
    active ? `✓ ${label}` : label;

  items.push(
    {
      type: "item",
      label: mark(p.tool === "select", "Select tool"),
      hint: "S",
      action: () => p.onTool("select"),
    },
    {
      type: "item",
      label: mark(p.tool === "razor", "Razor tool"),
      hint: "X",
      action: () => p.onTool("razor"),
    },
    {
      type: "item",
      label: mark(p.tool === "spacer", "Spacer tool"),
      hint: "M",
      action: () => p.onTool("spacer"),
    },
    {
      type: "item",
      label: mark(p.tool === "slip", "Slip tool"),
      hint: "Y",
      action: () => p.onTool("slip"),
    },
    {
      type: "item",
      label: mark(p.tool === "ripple", "Ripple tool"),
      hint: "R",
      action: () => p.onTool("ripple"),
    },
    { type: "sep" },
    {
      type: "item",
      label: mark(p.editMode === "normal", "Mode: Normal"),
      action: () => p.onEditMode("normal"),
    },
    {
      type: "item",
      label: mark(p.editMode === "insert", "Mode: Insert"),
      action: () => p.onEditMode("insert"),
    },
    {
      type: "item",
      label: mark(p.editMode === "overwrite", "Mode: Overwrite"),
      action: () => p.onEditMode("overwrite"),
    },
    { type: "sep" },
    {
      type: "item",
      label: "Set zone in",
      hint: "I",
      action: () => p.onSetZoneIn(),
    },
    {
      type: "item",
      label: "Set zone out",
      hint: "O",
      action: () => p.onSetZoneOut(),
    },
    {
      type: "item",
      label: "Lift zone",
      action: () => p.onLiftZone(),
    },
    {
      type: "item",
      label: "Extract zone",
      action: () => p.onExtractZone(),
    },
    {
      type: "item",
      label: "Add marker",
      action: () => {
        p.onSeek(menu.target.at);
        p.onAddMarker();
      },
    },
    { type: "sep" },
    {
      type: "item",
      label: "Add video track",
      action: () => p.onAddVideoTrack(),
    },
    {
      type: "item",
      label: "Add audio track",
      action: () => p.onAddAudioTrack(),
    },
    { type: "sep" },
    {
      type: "item",
      label: "Zoom fit",
      action: () => p.onZoomFit(),
    },
    {
      type: "item",
      label: "Zoom in",
      action: () => p.onZoomIn(),
    },
    {
      type: "item",
      label: "Zoom out",
      action: () => p.onZoomOut(),
    },
    { type: "sep" },
    {
      type: "item",
      label: "Undo",
      hint: "Ctrl+Z",
      action: () => p.onUndo(),
    },
    {
      type: "item",
      label: "Redo",
      hint: "Ctrl+Y",
      action: () => p.onRedo(),
    },
  );

  return items;
}
