import { useEffect, useRef } from "react";

export type ContextTarget =
  | {
      kind: "clip";
      clipId: string;
      trackId: string;
      linked: boolean;
      role: "video" | "audio";
      at: number;
      clipStart: number;
      clipEnd: number;
    }
  | {
      kind: "lane";
      trackId: string;
      trackKind: "video" | "audio";
      at: number;
    }
  | {
      kind: "track";
      trackId: string;
      trackKind: "video" | "audio";
      muted: boolean;
      locked: boolean;
      hidden: boolean;
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
  onClose: () => void;
  onSplitAt: (clipId: string, at: number) => void;
  onSplitPlayhead: () => void;
  onDelete: (clipId: string) => void;
  onRippleDelete: (clipId: string) => void;
  onToggleLink: (clipId: string) => void;
  onCloseGapAt: (at: number, trackId: string | null) => void;
  onFillGapsFrom: (from: number, trackId: string | null) => void;
  onInsertSpaceAt: (at: number, trackId: string | null) => void;
  onSeek: (t: number) => void;
  onSetZoneIn: () => void;
  onSetZoneOut: () => void;
  onAddMarker: () => void;
  onAddVideoTrack: () => void;
  onAddAudioTrack: () => void;
  onRemoveTrack: (trackId: string) => void;
  onMuteTrack: (trackId: string, muted: boolean) => void;
  onLockTrack: (trackId: string, locked: boolean) => void;
  onHideTrack: (trackId: string, hidden: boolean) => void;
  onAdvancedAudio?: (clipId: string, tab?: "overview" | "waveform" | "effects") => void;
  onAdvancedVideo?: (clipId: string) => void;
  /** Cross dissolve with the previous clip on the same track. */
  onAddTransition?: (clipId: string, duration: number) => void;
  /** Remove every clip from every track (one undo step). */
  onClearTimeline?: () => void;
  /** Remove every clip from one track (one undo step). */
  onClearTrack?: (trackId: string) => void;
};

export function TimelineContextMenu({
  menu,
  onClose,
  onSplitAt,
  onSplitPlayhead,
  onDelete,
  onRippleDelete,
  onToggleLink,
  onCloseGapAt,
  onFillGapsFrom,
  onInsertSpaceAt,
  onSeek,
  onSetZoneIn,
  onSetZoneOut,
  onAddMarker,
  onAddVideoTrack,
  onAddAudioTrack,
  onRemoveTrack,
  onMuteTrack,
  onLockTrack,
  onHideTrack,
  onAdvancedAudio,
  onAdvancedVideo,
  onAddTransition,
  onClearTimeline,
  onClearTrack,
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
    onSplitAt,
    onSplitPlayhead,
    onDelete,
    onRippleDelete,
    onToggleLink,
    onCloseGapAt,
    onFillGapsFrom,
    onInsertSpaceAt,
    onSeek,
    onSetZoneIn,
    onSetZoneOut,
    onAddMarker,
    onAddVideoTrack,
    onAddAudioTrack,
    onRemoveTrack,
    onMuteTrack,
    onLockTrack,
    onHideTrack,
    onAdvancedAudio,
    onAdvancedVideo,
    onAddTransition,
    onClearTimeline,
    onClearTrack,
  });

  const left = Math.min(menu.x, window.innerWidth - 220);
  const top = Math.min(menu.y, window.innerHeight - Math.min(360, items.length * 28 + 16));

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
  onSplitAt: (clipId: string, at: number) => void;
  onSplitPlayhead: () => void;
  onDelete: (clipId: string) => void;
  onRippleDelete: (clipId: string) => void;
  onToggleLink: (clipId: string) => void;
  onCloseGapAt: (at: number, trackId: string | null) => void;
  onFillGapsFrom: (from: number, trackId: string | null) => void;
  onInsertSpaceAt: (at: number, trackId: string | null) => void;
  onSeek: (t: number) => void;
  onSetZoneIn: () => void;
  onSetZoneOut: () => void;
  onAddMarker: () => void;
  onAddVideoTrack: () => void;
  onAddAudioTrack: () => void;
  onRemoveTrack: (trackId: string) => void;
  onMuteTrack: (trackId: string, muted: boolean) => void;
  onLockTrack: (trackId: string, locked: boolean) => void;
  onHideTrack: (trackId: string, hidden: boolean) => void;
  onAdvancedAudio?: (clipId: string, tab?: "overview" | "waveform" | "effects") => void;
  onAdvancedVideo?: (clipId: string) => void;
  onAddTransition?: (clipId: string, duration: number) => void;
  onClearTimeline?: () => void;
  onClearTrack?: (trackId: string) => void;
}): Item[] {
  const { menu } = p;
  const t = menu.target;

  if (t.kind === "track") {
    return [
      {
        type: "item",
        label: t.muted ? "Unmute" : "Mute",
        action: () => p.onMuteTrack(t.trackId, !t.muted),
      },
      {
        type: "item",
        label: t.locked ? "Unlock" : "Lock",
        action: () => p.onLockTrack(t.trackId, !t.locked),
      },
      {
        type: "item",
        label: t.hidden ? "Show track" : "Hide track",
        action: () => p.onHideTrack(t.trackId, !t.hidden),
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
        label: "Clear All from Track",
        danger: true,
        disabled: t.locked,
        action: () => p.onClearTrack?.(t.trackId),
      },
      {
        type: "item",
        label: "Clear All from Timeline",
        danger: true,
        action: () => p.onClearTimeline?.(),
      },
      {
        type: "item",
        label: `Delete ${t.trackKind} track`,
        danger: true,
        disabled: !t.canDelete,
        action: () => p.onRemoveTrack(t.trackId),
      },
    ];
  }

  if (t.kind === "clip") {
    const items: Item[] = [
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
        label: "Add Cross Dissolve (0.5s)",
        action: () => p.onAddTransition?.(t.clipId, 0.5),
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
    ];
    if (t.role === "audio" || t.role === "video") {
      items.push({ type: "sep" });
      if (t.role === "video") {
        items.push({
          type: "item",
          label: "Advanced Video…",
          action: () => p.onAdvancedVideo?.(t.clipId),
        });
      }
      items.push(
        {
          type: "item",
          label:
            t.role === "video"
              ? "Advanced Audio Tools (linked)…"
              : "Advanced Audio Tools…",
          action: () => p.onAdvancedAudio?.(t.clipId, "overview"),
        },
        {
          type: "item",
          label: "Open Waveform Editor…",
          action: () => p.onAdvancedAudio?.(t.clipId, "waveform"),
        },
      );
    }
    return items;
  }

  if (t.kind === "lane") {
    return [
      {
        type: "item",
        label: "Seek here",
        action: () => p.onSeek(t.at),
      },
      {
        type: "item",
        label: "Insert Space",
        action: () => p.onInsertSpaceAt(t.at, t.trackId),
      },
      {
        type: "item",
        label: "Remove Space",
        action: () => p.onCloseGapAt(t.at, t.trackId),
      },
      {
        type: "item",
        label: "Remove Space in All Tracks",
        action: () => p.onCloseGapAt(t.at, null),
      },
      {
        type: "item",
        label: "Remove All Spaces After Cursor",
        action: () => p.onFillGapsFrom(t.at, t.trackId),
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
        label: "Clear All from Track",
        danger: true,
        action: () => p.onClearTrack?.(t.trackId),
      },
      {
        type: "item",
        label: "Clear All from Timeline",
        danger: true,
        action: () => p.onClearTimeline?.(),
      },
    ];
  }

  // ruler
  return [
    {
      type: "item",
      label: "Seek here",
      action: () => p.onSeek(t.at),
    },
    {
      type: "item",
      label: "Insert Space",
      action: () => p.onInsertSpaceAt(t.at, null),
    },
    {
      type: "item",
      label: "Remove Space in All Tracks",
      action: () => p.onCloseGapAt(t.at, null),
    },
    {
      type: "item",
      label: "Remove All Spaces After Cursor",
      action: () => p.onFillGapsFrom(t.at, null),
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
      label: "Add marker",
      action: () => {
        p.onSeek(t.at);
        p.onAddMarker();
      },
    },
    { type: "sep" },
    {
      type: "item",
      label: "Clear All from Timeline",
      danger: true,
      action: () => p.onClearTimeline?.(),
    },
  ];
}
