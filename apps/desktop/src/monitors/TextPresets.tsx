import { useEffect, useRef, useState } from "react";

/** A title style: everything the drawtext export understands, so the card
 * you pick is exactly what exports. */
export type TextPresetParams = {
  size: number;
  color: string;
  x?: number;
  y: number;
  box: boolean;
  boxcolor?: string;
  boxborderw?: number;
  borderw?: number;
  bordercolor?: string;
  shadow?: boolean;
};

export type TextPreset = {
  id: string;
  name: string;
  params: TextPresetParams;
};

/** Popular title styles (VITA-style gallery). Colors are #RRGGBB[AA] so
 * preview (CSS) and export (FFmpeg) read the same value. */
export const TEXT_PRESETS: TextPreset[] = [
  { id: "clean", name: "Clean White", params: { size: 8, color: "#FFFFFF", y: 0.55, box: false, shadow: true } },
  { id: "highlight", name: "Highlight", params: { size: 7, color: "#111111", y: 0.55, box: true, boxcolor: "#FFD400E6", boxborderw: 18, shadow: false } },
  { id: "subtitle", name: "Subtitle Bar", params: { size: 4.5, color: "#FFFFFF", y: 0.72, box: true, boxcolor: "#000000B3", boxborderw: 12, shadow: false } },
  { id: "outline", name: "Outline Pop", params: { size: 8, color: "#FFFFFF", y: 0.5, box: false, borderw: 6, bordercolor: "#000000", shadow: true } },
  { id: "impact", name: "Impact Red", params: { size: 10, color: "#FF3B30", y: -0.35, box: false, borderw: 8, bordercolor: "#1A0505", shadow: false } },
  { id: "gold", name: "Gold Title", params: { size: 9, color: "#FFC93C", y: -0.35, box: false, borderw: 5, bordercolor: "#2A1B06", shadow: true } },
  { id: "pink", name: "Pink Pop", params: { size: 7, color: "#E0357F", y: 0.55, box: true, boxcolor: "#FFFFFFE6", boxborderw: 16, shadow: false } },
  { id: "chip", name: "Dark Chip", params: { size: 6, color: "#FFFFFF", y: 0.62, box: true, boxcolor: "#16161CE6", boxborderw: 14, shadow: true } },
];

/** CSS preview of a preset (approximates the drawtext render). */
export function presetSampleStyle(params: TextPresetParams): React.CSSProperties {
  return {
    color: params.color,
    background: params.box ? (params.boxcolor ?? "rgba(0,0,0,0.45)") : undefined,
    WebkitTextStroke:
      params.borderw && params.borderw > 0
        ? `${Math.max(1, params.borderw / 4)}px ${params.bordercolor ?? "#000000"}`
        : undefined,
    textShadow: params.shadow === false ? undefined : "2px 2px 4px rgba(0,0,0,0.55)",
    padding: params.box ? "2px 10px" : undefined,
    borderRadius: 4,
  };
}

export function TextPresetPicker({
  onApply,
  onClose,
}: {
  onApply: (preset: TextPreset, text: string) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<TextPreset | null>(null);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (picked) inputRef.current?.focus();
  }, [picked]);

  const canAdd = picked != null && text.trim().length > 0;

  return (
    <div
      className="picker-backdrop"
      onPointerDown={onClose}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="picker-panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <strong>{picked ? "Type your text" : "Choose a text style"}</strong>
          <button type="button" className="picker-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        {!picked ? (
          <div className="text-picker-grid">
            {TEXT_PRESETS.map((p) => (
              <button key={p.id} type="button" className="text-preset-card" onClick={() => setPicked(p)}>
                <span className="text-preset-sample" style={presetSampleStyle(p.params)}>
                  Aa
                </span>
                <span className="text-preset-name">{p.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="text-picker-type">
            <div className="text-preset-preview">
              <span style={presetSampleStyle(picked.params)}>{text.trim() || "Your title"}</span>
            </div>
            <input
              ref={inputRef}
              className="text-picker-input"
              value={text}
              maxLength={200}
              placeholder="Type your text…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && canAdd) {
                  e.preventDefault();
                  onApply(picked, text);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                }
              }}
            />
            <div className="text-picker-actions">
              <button type="button" onClick={() => setPicked(null)}>
                Back
              </button>
              <button
                type="button"
                className="primary"
                disabled={!canAdd}
                onClick={() => canAdd && onApply(picked, text)}
              >
                Add to monitor
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
