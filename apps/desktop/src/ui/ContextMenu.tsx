import { useEffect, useRef, type ReactNode } from "react";

export type ContextMenuItem =
  | {
      type: "item";
      label: string;
      hint?: string;
      disabled?: boolean;
      danger?: boolean;
      action: () => void;
    }
  | { type: "sep" };

type Props = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  className?: string;
};

export function ContextMenuPopup({ x, y, items, onClose, className = "" }: Props) {
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

  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - Math.min(360, items.length * 28 + 16));

  return (
    <div
      ref={ref}
      className={`tl-context-menu ${className}`.trim()}
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
            {item.hint ? <kbd>{item.hint}</kbd> : null}
          </button>
        ),
      )}
    </div>
  );
}

export function menuItems(...parts: (ContextMenuItem | false | null | undefined)[]): ContextMenuItem[] {
  return parts.filter(Boolean) as ContextMenuItem[];
}

export type ContextMenuPortalProps = {
  children?: ReactNode;
};
