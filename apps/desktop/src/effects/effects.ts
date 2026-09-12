/** Shared effect catalog + preview helpers (WYSIWYG with FFmpeg export). */

export type EffectKind =
  | "transform"
  | "crop"
  | "exposure"
  | "contrast"
  | "saturation"
  | "blur"
  | "flip"
  | "chromakey"
  | "volume"
  | "equalizer"
  | "compressor"
  | "highpass"
  | "lowpass"
  | "gate"
  | "denoise"
  | "limiter"
  | "reverb"
  | "invert"
  | "pitch";

export type FilterInstance = {
  id: string;
  kind: string;
  enabled: boolean;
  params?: Record<string, unknown>;
};

export const EFFECT_CATALOG: {
  id: EffectKind;
  label: string;
  heavy?: boolean;
  roles: ("video" | "audio")[];
}[] = [
  { id: "transform", label: "Transform", roles: ["video"] },
  { id: "crop", label: "Crop", roles: ["video"] },
  { id: "exposure", label: "Exposure", roles: ["video"] },
  { id: "contrast", label: "Contrast", roles: ["video"] },
  { id: "saturation", label: "Saturation", roles: ["video"] },
  { id: "blur", label: "Blur", heavy: true, roles: ["video"] },
  { id: "flip", label: "Flip", roles: ["video"] },
  { id: "chromakey", label: "Chroma Key (BG remove)", heavy: true, roles: ["video"] },
  { id: "volume", label: "Volume", roles: ["audio"] },
  { id: "equalizer", label: "Equalizer", roles: ["audio"] },
  { id: "compressor", label: "Compressor", roles: ["audio"] },
  { id: "highpass", label: "High-pass", roles: ["audio"] },
  { id: "lowpass", label: "Low-pass", roles: ["audio"] },
  { id: "gate", label: "Noise gate", roles: ["audio"] },
  { id: "denoise", label: "Noise remove", heavy: true, roles: ["audio"] },
  { id: "limiter", label: "Limiter", roles: ["audio"] },
  { id: "reverb", label: "Reverb", roles: ["audio"] },
  { id: "invert", label: "Invert phase", roles: ["audio"] },
  { id: "pitch", label: "Change voice", roles: ["audio"] },
];

export function defaultParams(kind: string): Record<string, unknown> {
  switch (kind) {
    case "transform":
      return { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
    case "crop":
      return { left: 0, top: 0, right: 0, bottom: 0 };
    case "exposure":
      return { amount: 0 };
    case "contrast":
      return { amount: 1 };
    case "saturation":
      return { amount: 1 };
    case "blur":
      return { radius: 0 };
    case "flip":
      return { horizontal: false, vertical: false };
    case "chromakey":
      return { color: "#00ff00", similarity: 0.3, blend: 0.1 };
    case "volume":
      return { gain: 1 };
    case "equalizer":
      return { bass: 0, mid: 0, treble: 0 };
    case "compressor":
      return { threshold: -20, ratio: 4, attack: 20, release: 250 };
    case "highpass":
      return { freq: 120 };
    case "lowpass":
      return { freq: 12000 };
    case "gate":
      return { threshold: -40, ratio: 10, attack: 10, release: 100 };
    case "denoise":
      return { nf: -25, nr: 12 };
    case "limiter":
      return { limit: 0.95 };
    case "reverb":
      return { delay: 40, decay: 0.3 };
    case "invert":
      return {};
    case "pitch":
      return { semitones: 0, preset: "custom" };
    default:
      return {};
  }
}

export function effectLabel(kind: string): string {
  return EFFECT_CATALOG.find((e) => e.id === kind)?.label ?? kind;
}

/** Short label for dense 2-column cards. */
export function effectShortLabel(kind: string): string {
  switch (kind) {
    case "chromakey":
      return "Chroma";
    case "saturation":
      return "Saturate";
    case "transform":
      return "Transform";
    case "exposure":
      return "Exposure";
    case "contrast":
      return "Contrast";
    case "volume":
      return "Volume";
    case "equalizer":
      return "EQ";
    case "compressor":
      return "Compress";
    case "highpass":
      return "High-pass";
    case "lowpass":
      return "Low-pass";
    case "gate":
      return "Gate";
    case "denoise":
      return "Denoise";
    case "limiter":
      return "Limiter";
    case "reverb":
      return "Reverb";
    case "invert":
      return "Invert";
    case "pitch":
      return "Voice";
    case "blur":
      return "Blur";
    case "crop":
      return "Crop";
    case "flip":
      return "Flip";
    default:
      return effectLabel(kind);
  }
}

/** Glyph + accent hue for bin cards and applied chips. */
export function effectMeta(kind: string): { glyph: string; hue: string } {
  switch (kind) {
    case "transform":
      return { glyph: "⧉", hue: "#5b8def" };
    case "crop":
      return { glyph: "▭", hue: "#7c6af0" };
    case "exposure":
      return { glyph: "☀", hue: "#e6b84d" };
    case "contrast":
      return { glyph: "◐", hue: "#d4a017" };
    case "saturation":
      return { glyph: "◉", hue: "#e85d75" };
    case "blur":
      return { glyph: "◌", hue: "#6ec6ff" };
    case "flip":
      return { glyph: "⇄", hue: "#4ecdc4" };
    case "chromakey":
      return { glyph: "◆", hue: "#3dd68c" };
    case "volume":
      return { glyph: "♪", hue: "#f0a35e" };
    case "equalizer":
      return { glyph: "▥", hue: "#6ec6ff" };
    case "compressor":
      return { glyph: "⇕", hue: "#9b7bff" };
    case "highpass":
      return { glyph: "↗", hue: "#4ecdc4" };
    case "lowpass":
      return { glyph: "↘", hue: "#3dd68c" };
    case "gate":
      return { glyph: "▣", hue: "#e85d75" };
    case "denoise":
      return { glyph: "⌀", hue: "#8ab4f8" };
    case "limiter":
      return { glyph: "⊤", hue: "#f0a35e" };
    case "reverb":
      return { glyph: "≋", hue: "#9b7bff" };
    case "invert":
      return { glyph: "⇅", hue: "#4ecdc4" };
    case "pitch":
      return { glyph: "♫", hue: "#f0a35e" };
    default:
      return { glyph: "✦", hue: "#9a9aa4" };
  }
}

function n(p: Record<string, unknown>, key: string, d: number): number {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

function b(p: Record<string, unknown>, key: string, d: boolean): boolean {
  const v = p[key];
  return typeof v === "boolean" ? v : d;
}

/** CSS filter + transform for Project Monitor (matches export intent). */
export function previewVideoStyle(
  filters: FilterInstance[],
  fadeGain: number,
): {
  filter: string;
  transform: string;
  opacity: number;
  clipPath?: string;
} {
  const parts: string[] = [];
  let opacity = fadeGain;
  let scale = 1;
  let rotate = 0;
  let tx = 0;
  let ty = 0;
  let clipPath: string | undefined;

  for (const f of filters) {
    if (!f.enabled) continue;
    const p = f.params ?? {};
    switch (f.kind) {
      case "exposure": {
        const a = n(p, "amount", 0);
        parts.push(`brightness(${1 + a})`);
        break;
      }
      case "contrast":
        parts.push(`contrast(${n(p, "amount", 1)})`);
        break;
      case "saturation":
        parts.push(`saturate(${n(p, "amount", 1)})`);
        break;
      case "blur": {
        const r = n(p, "radius", 0);
        if (r > 0.05) parts.push(`blur(${r}px)`);
        break;
      }
      case "flip": {
        if (b(p, "horizontal", false)) scale = -Math.abs(scale) || -1;
        // vertical handled via rotateX in transform
        break;
      }
      case "transform": {
        scale *= n(p, "scale", 1);
        rotate += n(p, "rotation", 0);
        tx += n(p, "x", 0) * 50;
        ty += n(p, "y", 0) * 50;
        opacity *= n(p, "opacity", 1);
        break;
      }
      case "crop": {
        const left = n(p, "left", 0) * 100;
        const top = n(p, "top", 0) * 100;
        const right = n(p, "right", 0) * 100;
        const bottom = n(p, "bottom", 0) * 100;
        if (left + top + right + bottom > 0.01) {
          clipPath = `inset(${top}% ${right}% ${bottom}% ${left}%)`;
        }
        break;
      }
      default:
        break;
    }
  }

  const flipH = filters.some(
    (f) => f.enabled && f.kind === "flip" && b(f.params ?? {}, "horizontal", false),
  );
  const flipV = filters.some(
    (f) => f.enabled && f.kind === "flip" && b(f.params ?? {}, "vertical", false),
  );

  const transforms = [
    `translate(${tx}%, ${ty}%)`,
    `rotate(${rotate}deg)`,
    `scale(${flipH ? -Math.abs(scale) : Math.abs(scale)}, ${flipV ? -Math.abs(scale) : Math.abs(scale)})`,
  ];

  return {
    filter: parts.length ? parts.join(" ") : "none",
    transform: transforms.join(" "),
    opacity: Math.max(0, Math.min(1, opacity)),
    clipPath,
  };
}

export function previewVolumeGain(filters: FilterInstance[], fadeGain: number): number {
  let g = fadeGain;
  for (const f of filters) {
    if (!f.enabled || f.kind !== "volume") continue;
    g *= n(f.params ?? {}, "gain", 1);
  }
  return Math.max(0, Math.min(4, g));
}

/** Monitor pitch preview via HTMLMediaElement.playbackRate (same approach as Advanced Audio). */
export function previewPitchRate(filters: FilterInstance[]): number {
  for (const f of filters) {
    if (!f.enabled || f.kind !== "pitch") continue;
    const st = n(f.params ?? {}, "semitones", 0);
    if (Math.abs(st) < 0.05) return 1;
    return Math.pow(2, Math.max(-12, Math.min(12, st)) / 12);
  }
  return 1;
}

/** Apply chromakey on a canvas frame (simple distance key). */
export function applyChromakeyToImageData(
  data: ImageData,
  colorHex: string,
  similarity: number,
  blend: number,
): void {
  const hex = colorHex.replace("#", "");
  const kr = parseInt(hex.slice(0, 2), 16) || 0;
  const kg = parseInt(hex.slice(2, 4), 16) || 255;
  const kb = parseInt(hex.slice(4, 6), 16) || 0;
  const thresh = similarity * 441.67; // ~sqrt(3*255^2)
  const soft = Math.max(1, blend * 441.67);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const dr = px[i] - kr;
    const dg = px[i + 1] - kg;
    const db = px[i + 2] - kb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist < thresh) {
      px[i + 3] = 0;
    } else if (dist < thresh + soft) {
      px[i + 3] = Math.round(255 * ((dist - thresh) / soft));
    }
  }
}
