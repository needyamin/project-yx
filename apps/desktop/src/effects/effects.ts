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
  | "pitch"
  | "text"
  | "temperature"
  | "hue"
  | "vignette"
  | "sharpen"
  | "vdenoise"
  | "stabilize"
  | "lut3d"
  | "normalize"
  | "transition"
  | "shake"
  | "wiggle"
  | "bounce"
  | "zoompulse"
  | "zoomin"
  | "spin"
  | "rgbsplit"
  | "glitch"
  | "flash"
  | "pulse"
  | "glow"
  | "neon"
  | "vhs"
  | "motionblur"
  | "cinematic"
  | "dream"
  | "magic"
  | "magicremove"
  | "blurregion"
  | "bgmask";

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
  /** Category for grouped pickers (Motion, Shake, Glitch, Light, ...). */
  category?: string;
  /** Short editable-param summary for the inspector hint. */
  params?: string[];
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
    { id: "text", label: "Text / Title", roles: ["video"] },
    { id: "temperature", label: "Temperature", roles: ["video"] },
    { id: "hue", label: "Hue rotate", roles: ["video"] },
    { id: "vignette", label: "Vignette", roles: ["video"] },
    { id: "sharpen", label: "Sharpen", roles: ["video"] },
    { id: "vdenoise", label: "Video denoise", heavy: true, roles: ["video"] },
    { id: "stabilize", label: "Stabilize", heavy: true, roles: ["video"] },
    { id: "lut3d", label: "LUT (.cube)", heavy: true, roles: ["video"] },
    { id: "transition", label: "Cross Dissolve", roles: ["video"] },
    { id: "normalize", label: "Normalize (loudness)", roles: ["audio"] },

    /* --- Motion / Shake / Glitch / Light / Magic / Cinematic / Retro /
       Trending (live effects). All accept intensity, speed,
       duration and direction where meaningful. --- */
    { id: "shake", label: "Camera Shake", roles: ["video"], category: "Shake", params: ["intensity", "speed", "direction"] },
    { id: "wiggle", label: "Wiggle", roles: ["video"], category: "Shake", params: ["intensity", "speed"] },
    { id: "bounce", label: "Bounce", roles: ["video"], category: "Motion", params: ["intensity", "speed"] },
    { id: "zoompulse", label: "Zoom Pulse", roles: ["video"], category: "Motion", params: ["intensity", "speed"] },
    { id: "zoomin", label: "Dynamic Zoom", roles: ["video"], category: "Motion", params: ["intensity", "duration", "direction"] },
    { id: "spin", label: "Spin", roles: ["video"], category: "Motion", params: ["speed", "duration", "direction"] },
    { id: "motionblur", label: "Motion Blur", roles: ["video"], category: "Motion", params: ["intensity"] },
    { id: "rgbsplit", label: "RGB Split", roles: ["video"], category: "Glitch", params: ["intensity", "direction"] },
    { id: "glitch", label: "Glitch", roles: ["video"], category: "Glitch", params: ["intensity", "speed"] },
    { id: "flash", label: "Flash", roles: ["video"], category: "Light", params: ["intensity", "speed"] },
    { id: "pulse", label: "Beat Pulse", roles: ["video"], category: "Trending", params: ["intensity", "speed"] },
    { id: "glow", label: "Glow", roles: ["video"], category: "Light", params: ["intensity"] },
    { id: "neon", label: "Neon Cycle", roles: ["video"], category: "Light", params: ["intensity", "speed"] },
    { id: "vhs", label: "VHS Retro", roles: ["video"], category: "Retro", params: ["intensity"] },
    { id: "cinematic", label: "Cinematic", roles: ["video"], category: "Cinematic", params: ["intensity"] },
    { id: "dream", label: "Dream Bloom", roles: ["video"], category: "Magic", params: ["intensity"] },
    { id: "magic", label: "Magic Hue", roles: ["video"], category: "Magic", params: ["intensity", "speed"] },
    {
      id: "magicremove",
      label: "Magic Remove (AI Eraser)",
      heavy: true,
      roles: ["video"],
      category: "Magic",
      params: ["brushSize", "feather", "expand", "trackingAccuracy", "removalStrength"],
    },
    {
      id: "blurregion",
      label: "Blur Region",
      heavy: true,
      roles: ["video"],
      category: "Magic",
      params: ["shape", "intensity", "feather", "opacity", "rotation"],
    },
    {
      id: "bgmask",
      label: "Remove Background (Key)",
      heavy: true,
      roles: ["video"],
      category: "Magic",
      params: ["shapes", "feather", "invert"],
    },
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
    case "text":
      return { text: "Your title", size: 6, color: "#ffffff", x: 0, y: 0.55, box: true };
    case "temperature":
      return { kelvin: 6500 };
    case "hue":
      return { degrees: 0 };
    case "vignette":
      return { amount: 0.5 };
    case "sharpen":
      return { amount: 0.8 };
    case "vdenoise":
      return { amount: 4 };
    case "stabilize":
      return { strength: 64 };
    case "lut3d":
      return { path: "" };
    case "normalize":
      return { target: -16 };
    case "transition":
      return { kind: "dissolve", duration: 0.5 };
    case "shake":
      return { intensity: 0.06, speed: 8, direction: "both", duration: 0 };
    case "wiggle":
      return { intensity: 0.03, speed: 20, duration: 0 };
    case "bounce":
      return { intensity: 0.08, speed: 2, duration: 0 };
    case "zoompulse":
      return { intensity: 0.15, speed: 2, duration: 0 };
    case "zoomin":
      return { intensity: 0.3, duration: 5, direction: "in" };
    case "spin":
      return { speed: 0.25, duration: 3, direction: "cw" };
    case "rgbsplit":
      return { intensity: 6, direction: "horizontal", duration: 0 };
    case "glitch":
      return { intensity: 8, speed: 2, duration: 0 };
    case "flash":
      return { intensity: 0.25, speed: 2, duration: 0 };
    case "pulse":
      return { intensity: 0.12, speed: 2, duration: 0 };
    case "glow":
      return { intensity: 0.6, duration: 0 };
    case "neon":
      return { intensity: 0.5, speed: 0.25, duration: 0 };
    case "vhs":
      return { intensity: 5, duration: 0 };
    case "motionblur":
      return { intensity: 2, duration: 0 };
    case "cinematic":
      return { intensity: 0.5, duration: 0 };
    case "dream":
      return { intensity: 0.5, duration: 0 };
    case "magic":
      return { intensity: 0.3, speed: 0.25, duration: 0 };
    /* Magic Remove: brush radius/feather/expand are fractions of frame
       height; strokes/keyframes live in params (see MagicRemove tool).
       scopeIn/scopeOut bound the tracked+rendered window to the clip's
       source range (0/0 = whole media, the legacy shape). */
    case "magicremove":
      return {
        strokes: [],
        keyframes: [],
        anchorTime: 0,
        brushSize: 0.025,
        feather: 0.008,
        expand: 0.004,
        trackingAccuracy: "medium",
        removalStrength: 100,
        scopeIn: 0,
        scopeOut: 0,
        status: "idle",
        renderKey: "",
        resultPath: "",
      };
    /* Blur Region: geometry is normalized to the SOURCE frame (center x/y,
       full width/height as fractions, rotation degrees); intensity 0..1 maps
       to a gaussian sigma; feather is a fraction of the region's min
       dimension. Keyframes share the same fields sampled at clip-local
       source times — see regionStateAt / regionRenderKey. */
    case "blurregion":
      return {
        x: 0.5,
        y: 0.5,
        w: 0.3,
        h: 0.3,
        rotation: 0,
        shape: "rect",
        cornerRadius: 0.15,
        intensity: 0.5,
        feather: 0.08,
        opacity: 1,
        keyframes: [],
      };
    /* BG Key select-area removal: shapes rasterize to an alpha-mask PNG
       (maskPath, content-hashed maskKey) so preview and export share the
       exact same mask. */
    case "bgmask":
      return {
        shapes: [],
        feather: 0.01,
        invert: false,
        maskPath: "",
        maskKey: "",
      };
    default:
      return {};
  }
}

export function effectLabel(kind: string): string {
  return EFFECT_CATALOG.find((e) => e.id === kind)?.label ?? kind;
}

/** Category of an effect (Motion, Shake, Glitch, Light, ...). */
export function effectCategory(kind: string): string {
  return EFFECT_CATALOG.find((e) => e.id === kind)?.category ?? "Essentials";
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
    case "magicremove":
      return { glyph: "✷", hue: "#b76af0" };
    case "blurregion":
      return { glyph: "▢", hue: "#6ea8ff" };
    case "bgmask":
      return { glyph: "◫", hue: "#3dd68c" };
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
  boxShadow?: string;
  /** Crop preview: CSS object-view-box zooms the cropped region to fill the
   * frame — identical to the export's crop+scale behavior. */
  objectViewBox?: string;
  objectFit?: string;
} {
  const parts: string[] = [];
  let opacity = fadeGain;
  let scale = 1;
  let rotate = 0;
  let tx = 0;
  let ty = 0;
  let clipPath: string | undefined;
  let objectViewBox: string | undefined;
  let objectFit: string | undefined;
  let vignette = 0;

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
      case "hue": {
        const d = n(p, "degrees", 0);
        if (Math.abs(d) > 0.05) parts.push(`hue-rotate(${d}deg)`);
        break;
      }
      case "temperature": {
        const k = n(p, "kelvin", 6500);
        const delta = k - 6500;
        if (delta > 200) {
          parts.push(`sepia(${Math.min(0.35, delta / 20000).toFixed(3)}) saturate(1.08)`);
        } else if (delta < -200) {
          parts.push(`hue-rotate(${(delta / 1200).toFixed(2)}deg) saturate(1.05)`);
        }
        break;
      }
      case "vignette": {
        const a = n(p, "amount", 0);
        if (a > 0.01) {
          vignette = Math.round(20 + a * 90);
        }
        break;
      }
      case "crop": {
        const left = n(p, "left", 0) * 100;
        const top = n(p, "top", 0) * 100;
        const right = n(p, "right", 0) * 100;
        const bottom = n(p, "bottom", 0) * 100;
        if (left + top + right + bottom > 0.01) {
          // object-view-box shows just the cropped region, contain-fit so the
          // region keeps its true shape (orientation-aware: vertical stays
          // vertical, horizontal stays horizontal — never stretched),
          // matching the export's crop + aspect-preserving scale + pad.
          objectViewBox = `inset(${top.toFixed(3)}% ${right.toFixed(3)}% ${bottom.toFixed(3)}% ${left.toFixed(3)}%)`;
          objectFit = "contain";
        }
        break;
      }
      case "dream": {
        const intensity = n(p, "intensity", 0.5);
        if (intensity > 0.01) {
          parts.push(`brightness(${1 + intensity * 0.15}) saturate(${1 + intensity * 0.3}) contrast(${1 - intensity * 0.05})`);
        }
        break;
      }
      case "magic": {
        const intensity = n(p, "intensity", 0.3);
        if (intensity > 0.01) {
          parts.push(`hue-rotate(${intensity * 120}deg) saturate(${1 + intensity * 0.4})`);
        }
        break;
      }
      case "glow": {
        const intensity = n(p, "intensity", 0.6);
        if (intensity > 0.01) {
          parts.push(`brightness(${1 + intensity * 0.2}) contrast(${1 + intensity * 0.1})`);
        }
        break;
      }
      case "cinematic": {
        const intensity = n(p, "intensity", 0.5);
        if (intensity > 0.01) {
          parts.push(`contrast(${1 + intensity * 0.2}) saturate(${1 - intensity * 0.2})`);
        }
        break;
      }
      case "vhs": {
        const intensity = n(p, "intensity", 5);
        if (intensity > 0.01) {
          parts.push("contrast(1.1) saturate(1.4) sepia(0.1)");
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
    objectViewBox,
    objectFit,
    boxShadow:
      vignette > 0 ? `inset 0 0 ${Math.round(vignette * 1.4)}px rgba(0,0,0,${Math.min(0.9, vignette / 100)})` : undefined,
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

/* ---------------------------------------------------------------------- */
/* Magic Remove / AI Eraser helpers                                        */
/* ---------------------------------------------------------------------- */

export type MagicStroke = {
  /** Polyline points in normalized source coords ([x, y], fractions of
   * width/height) — matches the Rust engine's `[f64; 2]` shape. */
  points: [number, number][];
  /** Brush radius as a fraction of frame height. */
  radius: number;
  erase?: boolean;
};

export type MagicKeyframe = { t: number; dx: number; dy: number; manual?: boolean };

/** Find the enabled Magic Remove filter on a clip. */
export function findMagicRemove(
  filters: FilterInstance[] | undefined,
): FilterInstance | undefined {
  return filters?.find((f) => f.kind === "magicremove" && f.enabled);
}

/** Snapshot of everything that changes the rendered result — used to detect
 * when a stored resultPath sidecar is stale and must be re-rendered. */
export function magicRenderKey(params: Record<string, unknown> | null | undefined): string {
  if (!params) return "";
  return JSON.stringify({
    s: params.strokes ?? [],
    k: params.keyframes ?? [],
    f: params.feather,
    e: params.expand,
    a: params.trackingAccuracy,
    r: params.removalStrength,
  });
}

/** True when the clip has a completed, non-stale Magic Remove render.
 *
 * `clip` enables the scope-coverage check: a clip-scoped sidecar only covers
 * [scopeIn, scopeOut] of the source media (sidecar t=0 == scopeIn), so a
 * later trim past the rendered window must fall back to the original until
 * Remove runs again. Legacy params (no scope keys) always pass. */
export function magicResultReady(
  params: Record<string, unknown> | null | undefined,
  clip?: { in_point: number; out_point: number },
): string | null {
  if (!params) return null;
  const path = typeof params.resultPath === "string" ? params.resultPath : "";
  if (!path) return null;
  if (magicRenderKey(params) !== params.renderKey) return null;
  if (clip) {
    const sin = typeof params.scopeIn === "number" ? params.scopeIn : 0;
    const sout = typeof params.scopeOut === "number" ? params.scopeOut : 0;
    if (
      sout > sin + 1e-3 &&
      (clip.in_point < sin - 0.01 || clip.out_point > sout + 0.01)
    ) {
      return null;
    }
  }
  return path;
}

/** Additive shift mapping element time on a ready sidecar back to source
 * media time: sourceTime = elementTime + shift. 0 for the original media or
 * legacy (unscoped) sidecars — sidecar t=0 is `scopeIn` for scoped renders. */
export function magicScopeShift(
  params: Record<string, unknown> | null | undefined,
): number {
  const sin = typeof params?.scopeIn === "number" ? params.scopeIn : 0;
  return sin > 1e-3 ? sin : 0;
}

/** Linearly interpolated mask offset (normalized fractions) at media time t. */
export function magicOffsetAt(
  keyframes: MagicKeyframe[] | undefined,
  t: number,
): { dx: number; dy: number } {
  const kf = [...(keyframes ?? [])].sort((a, b) => a.t - b.t);
  if (kf.length === 0) return { dx: 0, dy: 0 };
  if (t <= kf[0].t) return { dx: kf[0].dx, dy: kf[0].dy };
  if (t >= kf[kf.length - 1].t) return { dx: kf[kf.length - 1].dx, dy: kf[kf.length - 1].dy };
  for (let i = 0; i < kf.length - 1; i++) {
    if (t >= kf[i].t && t <= kf[i + 1].t) {
      const span = Math.max(1e-6, kf[i + 1].t - kf[i].t);
      const f = (t - kf[i].t) / span;
      return {
        dx: kf[i].dx + (kf[i + 1].dx - kf[i].dx) * f,
        dy: kf[i].dy + (kf[i + 1].dy - kf[i].dy) * f,
      };
    }
  }
  return { dx: 0, dy: 0 };
}



/* ---------------------------------------------------------------------- */
/* Blur Region (Blur tool) helpers                                         */
/* ---------------------------------------------------------------------- */

export type BlurShape = "rect" | "rounded" | "circle" | "ellipse";

/** One animation key of a blur region. All geometry is normalized to the
 * SOURCE frame; `t` is clip-local source time (0 = clip in-point). */
export type BlurRegionKeyframe = {
  t: number;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  intensity: number;
  feather: number;
  opacity: number;
  /** Shape snaps to the nearest key (shapes don't crossfade). */
  shape?: BlurShape;
  cornerRadius?: number;
};

/** Fully-resolved blur region state at a moment in time. */
export type RegionState = {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  shape: BlurShape;
  cornerRadius: number;
  intensity: number;
  feather: number;
  opacity: number;
};

export function blurRegionDefaults(): RegionState {
  return {
    x: 0.5,
    y: 0.5,
    w: 0.3,
    h: 0.3,
    rotation: 0,
    shape: "rect",
    cornerRadius: 0.15,
    intensity: 0.5,
    feather: 0.08,
    opacity: 1,
  };
}

/** Parse one keyframe-ish param bag with fallbacks (shared by keys and the
 * static top-level params). */
function regionFrom(
  p: Record<string, unknown>,
  fallback: RegionState,
): RegionState {
  const num = (k: string, d: number) =>
    typeof p[k] === "number" && Number.isFinite(p[k] as number)
      ? (p[k] as number)
      : d;
  const shape = p.shape;
  return {
    x: num("x", fallback.x),
    y: num("y", fallback.y),
    w: num("w", fallback.w),
    h: num("h", fallback.h),
    rotation: num("rotation", fallback.rotation),
    shape:
      shape === "rounded" || shape === "circle" || shape === "ellipse"
        ? shape
        : "rect",
    cornerRadius: num("cornerRadius", fallback.cornerRadius),
    intensity: num("intensity", fallback.intensity),
    feather: num("feather", fallback.feather),
    opacity: num("opacity", fallback.opacity),
  };
}

function lerpField(
  keys: BlurRegionKeyframe[],
  t: number,
  field: keyof BlurRegionKeyframe,
): number {
  const kf = keys;
  if (t <= kf[0].t) return kf[0][field] as number;
  if (t >= kf[kf.length - 1].t) return kf[kf.length - 1][field] as number;
  for (let i = 0; i < kf.length - 1; i++) {
    if (t >= kf[i].t && t <= kf[i + 1].t) {
      const span = Math.max(1e-6, kf[i + 1].t - kf[i].t);
      const f = (t - kf[i].t) / span;
      return (
        (kf[i][field] as number) +
        ((kf[i + 1][field] as number) - (kf[i][field] as number)) * f
      );
    }
  }
  return kf[kf.length - 1][field] as number;
}

/** Resolve the effective region state at clip-local source time `t`,
 * interpolating keyframes linearly (shape snaps to the nearest key). */
export function regionStateAt(
  params: Record<string, unknown> | null | undefined,
  t: number,
): RegionState {
  const base = regionFrom((params ?? {}) as Record<string, unknown>, blurRegionDefaults());
  const raw = (params?.keyframes ?? []) as BlurRegionKeyframe[];
  const kf = raw
    .filter(
      (k) =>
        k &&
        typeof k.t === "number" &&
        Number.isFinite(k.t) &&
        typeof k.x === "number" &&
        typeof k.y === "number",
    )
    .sort((a, b) => a.t - b.t);
  if (kf.length === 0) return base;
  // Shape snaps to the nearest key (shapes don't crossfade).
  let shape = kf[0].shape ?? base.shape;
  let dist = Math.abs(kf[0].t - t);
  let cornerRadius = typeof kf[0].cornerRadius === "number" ? kf[0].cornerRadius : base.cornerRadius;
  for (const k of kf) {
    const d = Math.abs(k.t - t);
    if (d < dist) {
      dist = d;
      shape = k.shape ?? base.shape;
      cornerRadius =
        typeof k.cornerRadius === "number" ? k.cornerRadius : base.cornerRadius;
    }
  }
  return {
    x: lerpField(kf, t, "x"),
    y: lerpField(kf, t, "y"),
    w: lerpField(kf, t, "w"),
    h: lerpField(kf, t, "h"),
    rotation: lerpField(kf, t, "rotation"),
    shape,
    cornerRadius,
    intensity: lerpField(kf, t, "intensity"),
    feather: lerpField(kf, t, "feather"),
    opacity: lerpField(kf, t, "opacity"),
  };
}

/** Upsert a keyframe at time `t` with the given state (sorted, deduped). */
export function upsertRegionKeyframe(
  keys: BlurRegionKeyframe[] | undefined,
  t: number,
  state: RegionState,
): BlurRegionKeyframe[] {
  const next = (keys ?? []).filter((k) => Math.abs(k.t - t) > 1e-4);
  next.push({ t, ...state });
  next.sort((a, b) => a.t - b.t);
  return next;
}

/** Remove the keyframe nearest to `t` when within `eps` seconds. */
export function removeRegionKeyframe(
  keys: BlurRegionKeyframe[] | undefined,
  t: number,
  eps = 0.25,
): BlurRegionKeyframe[] {
  if (!keys?.length) return [];
  let best = 0;
  let bestD = Infinity;
  keys.forEach((k, i) => {
    const d = Math.abs(k.t - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (bestD > eps) return keys;
  return keys.filter((_, i) => i !== best);
}

/** Everything that changes the exported region — used to detect stale
 * state and (later) sidecar renders. */
export function regionRenderKey(
  params: Record<string, unknown> | null | undefined,
): string {
  if (!params) return "";
  return JSON.stringify({
    s: params.shape,
    c: params.cornerRadius,
    k: params.keyframes ?? [],
  });
}

/* ---------------------------------------------------------------------- */
/* Chroma key / BG mask canvas processing (KeyPreview)                      */
/* ---------------------------------------------------------------------- */

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").slice(0, 6).padEnd(6, "0");
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 255,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

/** Distance key with soft blend ramp + spill suppression (matches the
 * FFmpeg chromakey+despill export intent). Mutates `data` in place. */
export function applyChromakeyToImageData(
  data: ImageData,
  colorHex: string,
  similarity: number,
  blend: number,
  spill = 0,
): void {
  const [kr, kg, kb] = hexToRgb(colorHex);
  const thresh = Math.max(0, similarity) * 441.67; // ~sqrt(3*255^2)
  const soft = Math.max(1, Math.max(0, blend) * 441.67);
  const px = data.data;
  // Spill suppression targets the key color's dominant channel.
  const dom = kg >= kr && kg >= kb ? 1 : kb >= kr && kb >= kg ? 2 : 0;
  const others: [number, number] = dom === 1 ? [0, 2] : [0, 1];
  for (let i = 0; i < px.length; i += 4) {
    const dr = px[i] - kr;
    const dg = px[i + 1] - kg;
    const db = px[i + 2] - kb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    let alpha = 255;
    if (dist < thresh) {
      alpha = 0;
    } else if (dist < thresh + soft) {
      alpha = Math.round(255 * ((dist - thresh) / soft));
    }
    if (alpha < 255) {
      px[i + 3] = Math.min(px[i + 3], alpha);
    }
    if (spill > 0 && alpha > 0 && dom !== 0) {
      // Pull the dominant channel down toward the other two, scaled by the
      // spill amount — classic despill, applied where key contamination
      // dominates (weighted by closeness to the key color).
      const a = px[i + others[0]];
      const b = px[i + others[1]];
      const limit = Math.max(a, b);
      const d = px[i + dom] - limit;
      if (d > 0) {
        const closeness = 1 - Math.min(1, dist / (thresh + soft));
        px[i + dom] = Math.round(px[i + dom] - d * spill * (0.35 + 0.65 * closeness));
      }
    }
  }
}

/** A select-area shape in normalized source coordinates. */
export type BgMaskShape = {
  id: string;
  type: "rect" | "ellipse" | "lasso";
  mode: "add" | "sub";
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  points?: [number, number][];
};

/** Build the alpha mask canvas (white = keep) for a bgmask filter. */
export function rasterizeBgMask(
  w: number,
  h: number,
  shapes: BgMaskShape[],
  feather: number,
  invert: boolean,
): HTMLCanvasElement | null {
  if (!shapes.length) return null;
  const mask = document.createElement("canvas");
  mask.width = Math.max(1, w);
  mask.height = Math.max(1, h);
  const ctx = mask.getContext("2d");
  if (!ctx) return null;
  const featherPx = Math.max(0, feather) * Math.min(w, h);
  for (const s of shapes) {
    ctx.save();
    ctx.globalCompositeOperation =
      s.mode === "sub" ? "destination-out" : "source-over";
    if (featherPx > 0.5) ctx.filter = `blur(${featherPx.toFixed(2)}px)`;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    if (s.type === "rect") {
      const x = (s.x ?? 0) * w;
      const y = (s.y ?? 0) * h;
      const sw = (s.w ?? 0) * w;
      const sh = (s.h ?? 0) * h;
      ctx.rect(x - sw / 2, y - sh / 2, sw, sh);
    } else if (s.type === "ellipse") {
      const x = (s.x ?? 0) * w;
      const y = (s.y ?? 0) * h;
      ctx.ellipse(
        x, y,
        Math.max(1, ((s.w ?? 0) * w) / 2),
        Math.max(1, ((s.h ?? 0) * h) / 2),
        0, 0, Math.PI * 2,
      );
    } else if (s.points && s.points.length > 2) {
      ctx.moveTo(s.points[0][0] * w, s.points[0][1] * h);
      for (let i = 1; i < s.points.length; i++) {
        ctx.lineTo(s.points[i][0] * w, s.points[i][1] * h);
      }
      ctx.closePath();
    }
    ctx.fill();
    ctx.restore();
  }
  if (invert) {
    const inv = document.createElement("canvas");
    inv.width = mask.width;
    inv.height = mask.height;
    const ictx = inv.getContext("2d");
    if (!ictx) return mask;
    ictx.fillStyle = "#ffffff";
    ictx.fillRect(0, 0, inv.width, inv.height);
    ictx.globalCompositeOperation = "destination-out";
    ictx.drawImage(mask, 0, 0);
    return inv;
  }
  return mask;
}

/** Hash of everything a bgmask render depends on (mask PNG liveness). */
export function bgMaskRenderKey(
  params: Record<string, unknown> | null | undefined,
): string {
  if (!params) return "";
  return JSON.stringify({
    s: params.shapes ?? [],
    f: params.feather,
    i: params.invert === true,
  });
}

/** Find the enabled filter of a kind on a clip (or null). */
export function findEnabledFilter(
  filters: FilterInstance[] | undefined,
  kind: string,
): FilterInstance | undefined {
  return filters?.find((f) => f.kind === kind && f.enabled);
}
