import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ContextMenuPopup, type ContextMenuItem } from "../ui/ContextMenu";
import {
  defaultParams,
  effectLabel,
  effectMeta,
  effectShortLabel,
  type FilterInstance,
} from "./effects";
import "./EffectInspector.css";

/** Effects that are not heard in the Project Monitor preview. */
const EXPORT_ONLY = new Set([
  "denoise",
  "equalizer",
  "compressor",
  "highpass",
  "lowpass",
  "gate",
  "limiter",
  "reverb",
  "invert",
  "normalize",
  "sharpen",
  "vdenoise",
  "stabilize",
  "lut3d",
]);

type Props = {
  clipId: string | null;
  clipName?: string | null;
  clipRole: "video" | "audio" | null;
  filters: FilterInstance[];
  /** Expand this filter when set (e.g. after Apply). */
  focusFilterId?: string | null;
  fill?: boolean;
  onUpdate: (filterId: string, params: Record<string, unknown>) => void;
  onToggle: (filterId: string, enabled: boolean) => void;
  onRemove: (filterId: string) => void;
};

export function EffectInspector({
  clipId,
  clipName = null,
  clipRole,
  filters,
  focusFilterId = null,
  fill = false,
  onUpdate,
  onToggle,
  onRemove,
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{
    x: number;
    y: number;
    filter: FilterInstance;
  } | null>(null);
  /** One-shot: only auto-expand when focusFilterId newly changes. */
  const lastFocusIdRef = useRef<string | null>(null);

  useEffect(() => {
    setExpandedId(null);
    lastFocusIdRef.current = null;
  }, [clipId]);

  useEffect(() => {
    if (!focusFilterId) {
      lastFocusIdRef.current = null;
      return;
    }
    // Only auto-expand when focus id newly changes — not on every filters[] identity churn.
    if (focusFilterId === lastFocusIdRef.current) return;
    if (!filters.some((f) => f.id === focusFilterId)) return;
    lastFocusIdRef.current = focusFilterId;
    setExpandedId(focusFilterId);
    // Intentionally depends on filters so a late-arriving filter can still open once.
  }, [focusFilterId, filters]);

  useEffect(() => {
    if (expandedId && !filters.some((f) => f.id === expandedId)) {
      setExpandedId(null);
    }
  }, [filters, expandedId]);

  if (!clipId) {
    return (
      <aside className={`effect-inspector ${fill ? "fill" : ""}`}>
        <header className="ei-header">
          <span className="ei-title">Effect Controls</span>
        </header>
        <p className="ei-hint">Select a timeline clip to edit applied effects.</p>
      </aside>
    );
  }

  const ctxItems: ContextMenuItem[] = ctx
    ? [
        {
          type: "item",
          label: ctx.filter.enabled ? "Disable" : "Enable",
          action: () => onToggle(ctx.filter.id, !ctx.filter.enabled),
        },
          {
            type: "item",
            label: "Reset to default",
            action: () => onUpdate(ctx.filter.id, defaultParams(ctx.filter.kind)),
          },
        { type: "sep" },
        {
          type: "item",
          label: "Remove",
          danger: true,
          action: () => onRemove(ctx.filter.id),
        },
      ]
    : [];

  return (
    <aside className={`effect-inspector ${fill ? "fill" : ""}`}>
      <header className="ei-header">
        <span className="ei-title">Effect Controls</span>
        <span className="ei-count" aria-label={`${filters.length} effects`}>
          {filters.length}
        </span>
        {clipRole && <span className="ei-role">{clipRole}</span>}
      </header>
      {clipName && <p className="ei-clip-name" title={clipName}>{clipName}</p>}

      {filters.length === 0 ? (
        <div className="ei-empty">
          <p>No effects on this clip.</p>
          <p className="ei-hint">Add from the Effects tab or Advanced Audio Tools.</p>
        </div>
      ) : (
        <div className="ei-body">
          <ul className="ei-stack">
            {filters.map((f) => {
              const meta = effectMeta(f.kind);
              const active = f.id === expandedId;
              const exportOnly = EXPORT_ONLY.has(f.kind);
              return (
                <li
                  key={f.id}
                  className={`ei-row ${f.enabled ? "on" : "off"} ${active ? "active" : ""}`}
                  style={{ ["--effect-hue" as string]: meta.hue }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCtx({ x: e.clientX, y: e.clientY, filter: f });
                  }}
                >
                  <div className="ei-row-head">
                    <button
                      type="button"
                      className={`ei-eye ${f.enabled ? "on" : ""}`}
                      title={f.enabled ? "Enabled" : "Disabled"}
                      onClick={() => onToggle(f.id, !f.enabled)}
                    >
                      {f.enabled ? "●" : "○"}
                    </button>
                    <button
                      type="button"
                      className="ei-row-main"
                      onClick={() => setExpandedId(active ? null : f.id)}
                    >
                      <span className="ei-row-name">{effectLabel(f.kind)}</span>
                      {exportOnly && (
                        <span className="ei-badge" title="Applies on export, not in monitor preview">
                          Export
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="ei-reset"
                      title="Reset to default"
                      onClick={() => onUpdate(f.id, defaultParams(f.kind))}
                    >
                      ↺
                    </button>
                    <button
                      type="button"
                      className="ei-remove"
                      title="Remove"
                      onClick={() => onRemove(f.id)}
                    >
                      ✕
                    </button>
                  </div>
                  {active && (
                    <div className="ei-row-params">
                      {exportOnly && (
                        <p className="ei-hint ei-export-hint">
                          Export only — not heard in Play/monitor.
                        </p>
                      )}
                      <div className="ei-param-actions">
                        <button
                          type="button"
                          className="ei-reset-full"
                          onClick={() => onUpdate(f.id, defaultParams(f.kind))}
                        >
                          Reset to default
                        </button>
                      </div>
                      <ParamEditors
                        kind={f.kind}
                        params={
                          f.kind === "denoise"
                            ? { ...defaultParams("denoise"), ...(f.params ?? {}) }
                            : (f.params ?? {})
                        }
                        onChange={(p) => onUpdate(f.id, p)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {ctx && (
        <ContextMenuPopup
          x={ctx.x}
          y={ctx.y}
          items={ctxItems}
          onClose={() => setCtx(null)}
        />
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
    case "equalizer":
      return (
        <div className="ei-params">
          <Slider label="Bass" min={-12} max={12} step={0.5} value={num("bass", 0)} onChange={(v) => set("bass", v)} />
          <Slider label="Mid" min={-12} max={12} step={0.5} value={num("mid", 0)} onChange={(v) => set("mid", v)} />
          <Slider label="Treble" min={-12} max={12} step={0.5} value={num("treble", 0)} onChange={(v) => set("treble", v)} />
        </div>
      );
    case "compressor":
      return (
        <div className="ei-params">
          <Slider label="Threshold" min={-60} max={0} step={1} value={num("threshold", -20)} onChange={(v) => set("threshold", v)} />
          <Slider label="Ratio" min={1} max={20} step={0.1} value={num("ratio", 4)} onChange={(v) => set("ratio", v)} />
          <Slider label="Attack" min={1} max={200} step={1} value={num("attack", 20)} onChange={(v) => set("attack", v)} />
          <Slider label="Release" min={10} max={1000} step={10} value={num("release", 250)} onChange={(v) => set("release", v)} />
        </div>
      );
    case "highpass":
      return (
        <div className="ei-params">
          <Slider label="Freq" min={20} max={4000} step={10} value={num("freq", 120)} onChange={(v) => set("freq", v)} />
        </div>
      );
    case "lowpass":
      return (
        <div className="ei-params">
          <Slider label="Freq" min={500} max={20000} step={50} value={num("freq", 12000)} onChange={(v) => set("freq", v)} />
        </div>
      );
    case "gate":
      return (
        <div className="ei-params">
          <Slider label="Threshold" min={-80} max={0} step={1} value={num("threshold", -40)} onChange={(v) => set("threshold", v)} />
          <Slider label="Ratio" min={1} max={50} step={0.5} value={num("ratio", 10)} onChange={(v) => set("ratio", v)} />
          <Slider label="Attack" min={1} max={100} step={1} value={num("attack", 10)} onChange={(v) => set("attack", v)} />
          <Slider label="Release" min={10} max={500} step={5} value={num("release", 100)} onChange={(v) => set("release", v)} />
        </div>
      );
    case "denoise":
      return (
        <div className="ei-params">
          <Slider label="Noise floor" min={-80} max={-20} step={1} value={num("nf", -25)} onChange={(v) => set("nf", v)} />
          <Slider label="Reduction" min={0.01} max={97} step={0.5} value={num("nr", 12)} onChange={(v) => set("nr", v)} />
        </div>
      );
    case "limiter":
      return (
        <div className="ei-params">
          <Slider label="Limit" min={0.1} max={1} step={0.01} value={num("limit", 0.95)} onChange={(v) => set("limit", v)} />
        </div>
      );
    case "reverb":
      return (
        <div className="ei-params">
          <Slider label="Delay ms" min={1} max={200} step={1} value={num("delay", 40)} onChange={(v) => set("delay", v)} />
          <Slider label="Decay" min={0} max={0.9} step={0.05} value={num("decay", 0.3)} onChange={(v) => set("decay", v)} />
        </div>
      );
    case "invert":
      return <p className="ei-hint">Inverts polarity (phase flip). No parameters.</p>;
    case "text":
      return (
        <div className="ei-params">
          <label className="ei-color">
            Text
            <input
              type="text"
              value={typeof params.text === "string" ? params.text : "Your title"}
              onChange={(e) => set("text", e.target.value)}
              style={{ width: "100%" }}
            />
          </label>
          <label className="ei-color">
            Color
            <input
              type="color"
              value={typeof params.color === "string" ? params.color : "#ffffff"}
              onChange={(e) => set("color", e.target.value)}
            />
          </label>
          <Slider label="Size (% frame height)" min={1} max={25} step={0.5} value={num("size", 6)} onChange={(v) => set("size", v)} />
          <Slider label="X position" min={-1} max={1} step={0.01} value={num("x", 0)} onChange={(v) => set("x", v)} />
          <Slider label="Y position" min={-1} max={1} step={0.01} value={num("y", 0.55)} onChange={(v) => set("y", v)} />
          <div className="ei-params ei-checks">
            <label>
              <input
                type="checkbox"
                checked={params.box !== false}
                onChange={(e) => set("box", e.target.checked)}
              />{" "}
              Background box
            </label>
          </div>
          <p className="ei-hint">Visible in the Project Monitor and burned in on export.</p>
        </div>
      );
    case "temperature":
      return (
        <div className="ei-params">
          <Slider label="Kelvin (6500 = neutral)" min={2000} max={40000} step={100} value={num("kelvin", 6500)} onChange={(v) => set("kelvin", v)} />
          <p className="ei-hint">Warm below 6500K, cool above. Preview is approximate; export is exact.</p>
        </div>
      );
    case "hue":
      return (
        <div className="ei-params">
          <Slider label="Degrees" min={-180} max={180} step={1} value={num("degrees", 0)} onChange={(v) => set("degrees", v)} />
        </div>
      );
    case "vignette":
      return (
        <div className="ei-params">
          <Slider label="Amount" min={0} max={1} step={0.01} value={num("amount", 0.5)} onChange={(v) => set("amount", v)} />
        </div>
      );
    case "sharpen":
      return (
        <div className="ei-params">
          <Slider label="Amount" min={0} max={3} step={0.05} value={num("amount", 0.8)} onChange={(v) => set("amount", v)} />
          <p className="ei-hint">Export only — applied when rendering the final video.</p>
        </div>
      );
    case "vdenoise":
      return (
        <div className="ei-params">
          <Slider label="Amount" min={0} max={10} step={0.5} value={num("amount", 4)} onChange={(v) => set("amount", v)} />
          <p className="ei-hint">Export only — grain/noise reduction applied on render.</p>
        </div>
      );
    case "stabilize":
      return (
        <div className="ei-params">
          <Slider label="Strength" min={16} max={256} step={8} value={num("strength", 64)} onChange={(v) => set("strength", v)} />
          <p className="ei-hint">Export only — basic shake reduction on render.</p>
        </div>
      );
    case "magicremove":
      return (
        <div className="ei-params">
          <p className="ei-hint">
            Brush the mask with the <strong>Remove</strong> tool in the Project
            Monitor — Auto Track follows motion, Remove rebuilds the background.
            Non-destructive: toggle off or delete anytime.
          </p>
          <Slider label="Feather (%)" min={0} max={0.04} step={0.002} value={num("feather", 0.008)} onChange={(v) => set("feather", v)} />
          <Slider label="Expand (%)" min={0} max={0.02} step={0.001} value={num("expand", 0.004)} onChange={(v) => set("expand", v)} />
          <Slider label="Strength (%)" min={10} max={100} step={5} value={num("removalStrength", 100)} onChange={(v) => set("removalStrength", v)} />
          <label className="ei-slider">
            <span>
              Tracking <em>{String(params.trackingAccuracy ?? "medium")}</em>
            </span>
            <select
              value={String(params.trackingAccuracy ?? "medium")}
              onChange={(e) => set("trackingAccuracy", e.target.value)}
            >
              <option value="low">Fast</option>
              <option value="medium">Balanced</option>
              <option value="high">Precise</option>
            </select>
          </label>
        </div>
      );
    case "lut3d":
      return (
        <div className="ei-params">
          <p className="ei-hint">
            {typeof params.path === "string" && params.path
              ? params.path
              : "No .cube file chosen yet."}
          </p>
          <div className="ei-param-actions">
            <button
              type="button"
              className="ei-reset-full"
              onClick={async () => {
                const picked = await open({
                  multiple: false,
                  filters: [{ name: "LUT", extensions: ["cube"] }],
                });
                if (typeof picked === "string") set("path", picked);
              }}
            >
              Choose .cube file…
            </button>
          </div>
          <p className="ei-hint">Export only — the look is applied when rendering.</p>
        </div>
      );
    case "normalize":
      return (
        <div className="ei-params">
          <Slider label="Target loudness (LUFS)" min={-30} max={-8} step={1} value={num("target", -16)} onChange={(v) => set("target", v)} />
          <p className="ei-hint">Export only — evens out quiet/loud voice to broadcast level.</p>
        </div>
      );
    case "transition":
      return (
        <div className="ei-params">
          <Slider label="Dissolve duration (s)" min={0.1} max={3} step={0.05} value={num("duration", 0.5)} onChange={(v) => set("duration", v)} />
          <p className="ei-hint">Best added via right-click → Add Cross Dissolve (creates the overlap automatically).</p>
        </div>
      );
    case "pitch":
      return (
        <div className="ei-params">
          <div className="ei-preset-row">
            {(
              [
                { id: "male", label: "Male", st: -4 },
                { id: "female", label: "Female", st: 4 },
                { id: "child", label: "Child", st: 7 },
              ] as const
            ).map((p) => {
              const active =
                (typeof params.preset === "string" && params.preset === p.id) ||
                Math.abs(num("semitones", 0) - p.st) < 0.05;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={active ? "active" : ""}
                  onClick={() => onChange({ ...params, semitones: p.st, preset: p.id })}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <Slider
            label="Semitones"
            min={-8}
            max={8}
            step={0.5}
            value={num("semitones", 0)}
            onChange={(v) =>
              onChange({
                ...params,
                semitones: v,
                preset:
                  Math.abs(v + 4) < 0.05
                    ? "male"
                    : Math.abs(v - 4) < 0.05
                      ? "female"
                      : Math.abs(v - 7) < 0.05
                        ? "child"
                        : "custom",
              })
            }
          />
          <p className="ei-hint">Heard on export. Preview voice in Advanced Audio Tools → Play.</p>
        </div>
      );
    default:
      return <p className="ei-hint">{effectShortLabel(kind)} — no editable params.</p>;
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
