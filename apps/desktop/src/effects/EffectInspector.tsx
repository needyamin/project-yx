import { useEffect, useState } from "react";
import { effectMeta, effectShortLabel, type FilterInstance } from "./effects";
import "./EffectInspector.css";

type Props = {
  clipId: string | null;
  clipRole: "video" | "audio" | null;
  filters: FilterInstance[];
  onUpdate: (filterId: string, params: Record<string, unknown>) => void;
  onToggle: (filterId: string, enabled: boolean) => void;
  onRemove: (filterId: string) => void;
};

export function EffectInspector({
  clipId,
  clipRole,
  filters,
  onUpdate,
  onToggle,
  onRemove,
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setExpandedId(null);
  }, [clipId]);

  useEffect(() => {
    if (expandedId && !filters.some((f) => f.id === expandedId)) {
      setExpandedId(null);
    }
  }, [filters, expandedId]);

  const expanded = filters.find((f) => f.id === expandedId) ?? null;

  if (!clipId) {
    return (
      <aside className="effect-inspector">
        <header className="ei-header">
          <span className="ei-title">Applied</span>
        </header>
        <p className="ei-hint">Select a clip to edit effects.</p>
      </aside>
    );
  }

  return (
    <aside className="effect-inspector">
      <header className="ei-header">
        <span className="ei-title">Applied</span>
        <span className="ei-count" aria-label={`${filters.length} effects`}>
          {filters.length}
        </span>
        {clipRole && <span className="ei-role">{clipRole}</span>}
      </header>

      {filters.length === 0 ? (
        <div className="ei-empty">
          <p>Drop / pick from Effects</p>
        </div>
      ) : (
        <div className="ei-body">
          <div className="ei-chip-grid">
            {filters.map((f) => {
              const meta = effectMeta(f.kind);
              const active = f.id === expandedId;
              return (
                <div
                  key={f.id}
                  className={`ei-chip ${f.enabled ? "on" : "off"} ${active ? "active" : ""}`}
                  style={{ ["--effect-hue" as string]: meta.hue }}
                >
                  <button
                    type="button"
                    className="ei-chip-main"
                    onClick={() => setExpandedId(active ? null : f.id)}
                    title={effectShortLabel(f.kind)}
                  >
                    <span className="ei-chip-icon" aria-hidden>
                      {meta.glyph}
                    </span>
                    <span className="ei-chip-name">{effectShortLabel(f.kind)}</span>
                  </button>
                  <div className="ei-chip-actions">
                    <label className="ei-chip-toggle" title={f.enabled ? "On" : "Off"}>
                      <input
                        type="checkbox"
                        checked={f.enabled}
                        onChange={(e) => onToggle(f.id, e.target.checked)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </label>
                    <button
                      type="button"
                      className="ei-remove"
                      title="Remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(f.id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {expanded && (
            <section
              className={`ei-detail ${expanded.enabled ? "on" : "off"}`}
              style={{ ["--effect-hue" as string]: effectMeta(expanded.kind).hue }}
            >
              <div className="ei-detail-head">
                <span className="ei-chip-icon" aria-hidden>
                  {effectMeta(expanded.kind).glyph}
                </span>
                <strong>{effectShortLabel(expanded.kind)}</strong>
                <button
                  type="button"
                  className="ei-collapse"
                  onClick={() => setExpandedId(null)}
                  title="Collapse"
                >
                  ▴
                </button>
              </div>
              <ParamEditors
                kind={expanded.kind}
                params={expanded.params ?? {}}
                onChange={(p) => onUpdate(expanded.id, p)}
              />
            </section>
          )}
        </div>
      )}
    </aside>
  );
}

function ParamEditors({
  kind,
  params,
  onChange,
}: {
  kind: string;
  params: Record<string, unknown>;
  onChange: (p: Record<string, unknown>) => void;
}) {
  const set = (key: string, value: unknown) => onChange({ ...params, [key]: value });
  const num = (key: string, d: number) =>
    typeof params[key] === "number" ? (params[key] as number) : d;

  switch (kind) {
    case "transform":
      return (
        <div className="ei-params">
          <Slider label="X" min={-1} max={1} step={0.01} value={num("x", 0)} onChange={(v) => set("x", v)} />
          <Slider label="Y" min={-1} max={1} step={0.01} value={num("y", 0)} onChange={(v) => set("y", v)} />
          <Slider label="Scale" min={0.1} max={4} step={0.01} value={num("scale", 1)} onChange={(v) => set("scale", v)} />
          <Slider label="Rotation" min={-180} max={180} step={1} value={num("rotation", 0)} onChange={(v) => set("rotation", v)} />
          <Slider label="Opacity" min={0} max={1} step={0.01} value={num("opacity", 1)} onChange={(v) => set("opacity", v)} />
        </div>
      );
    case "crop":
      return (
        <div className="ei-params">
          <Slider label="Left" min={0} max={0.45} step={0.01} value={num("left", 0)} onChange={(v) => set("left", v)} />
          <Slider label="Top" min={0} max={0.45} step={0.01} value={num("top", 0)} onChange={(v) => set("top", v)} />
          <Slider label="Right" min={0} max={0.45} step={0.01} value={num("right", 0)} onChange={(v) => set("right", v)} />
          <Slider label="Bottom" min={0} max={0.45} step={0.01} value={num("bottom", 0)} onChange={(v) => set("bottom", v)} />
        </div>
      );
    case "exposure":
      return (
        <div className="ei-params">
          <Slider label="Amount" min={-1} max={1} step={0.01} value={num("amount", 0)} onChange={(v) => set("amount", v)} />
        </div>
      );
    case "contrast":
    case "saturation":
      return (
        <div className="ei-params">
          <Slider label="Amount" min={0} max={3} step={0.01} value={num("amount", 1)} onChange={(v) => set("amount", v)} />
        </div>
      );
    case "blur":
      return (
        <div className="ei-params">
          <Slider label="Radius" min={0} max={40} step={0.5} value={num("radius", 0)} onChange={(v) => set("radius", v)} />
        </div>
      );
    case "flip":
      return (
        <div className="ei-params ei-checks">
          <label>
            <input
              type="checkbox"
              checked={!!params.horizontal}
              onChange={(e) => set("horizontal", e.target.checked)}
            />{" "}
            Horizontal
          </label>
          <label>
            <input
              type="checkbox"
              checked={!!params.vertical}
              onChange={(e) => set("vertical", e.target.checked)}
            />{" "}
            Vertical
          </label>
        </div>
      );
    case "chromakey":
      return (
        <div className="ei-params">
          <label className="ei-color">
            Key color
            <input
              type="color"
              value={typeof params.color === "string" ? params.color : "#00ff00"}
              onChange={(e) => set("color", e.target.value)}
            />
          </label>
          <Slider label="Similarity" min={0.01} max={1} step={0.01} value={num("similarity", 0.3)} onChange={(v) => set("similarity", v)} />
          <Slider label="Blend" min={0} max={1} step={0.01} value={num("blend", 0.1)} onChange={(v) => set("blend", v)} />
        </div>
      );
    case "volume":
      return (
        <div className="ei-params">
          <Slider label="Gain" min={0} max={2} step={0.01} value={num("gain", 1)} onChange={(v) => set("gain", v)} />
        </div>
      );
    default:
      return null;
  }
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="ei-slider">
      <span>
        {label} <em>{value.toFixed(2)}</em>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
