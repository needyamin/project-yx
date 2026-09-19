import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject, type WheelEvent as ReactWheelEvent } from "react";
import { clipFadeGain, formatTime, mediaTimeForClip, type Clip } from "../timeline/types";
import { ContextMenuPopup, type ContextMenuItem } from "../ui/ContextMenu";
import {
  previewVideoStyle,
  bgMaskRenderKey,
  rasterizeBgMask,
  type BgMaskShape,
  type FilterInstance,
} from "../effects/effects";
import { subscribeBinDrag } from "../bin/binDrag";
import { usePlayheadTime } from "../playback/playbackClock";
import { TextPresetPicker, type TextPresetParams } from "./TextPresets";
import { ImagePicker, type MonitorImageItem } from "./ImagePicker";
import { MagicRemoveOverlay } from "./MagicRemove";
import { BlurRegionOverlayMemo } from "./BlurRegion";
import {
  BackgroundKeyPanel,
  KeyPreviewCanvas,
  type KeyFilterState,
  type KeyToolMode,
} from "./KeyTools";
import type { MagicKeyframe, MagicStroke } from "../effects/effects";
import {
  clientToSource,
  cropBoxFrameInsets,
  displayedContentRect,
  pointInElement,
  type ContentRect,
  type FitMode,
  type MirrorTransform,
} from "./monitorGeometry";
import "./ProjectMonitor.css";

export type PreviewMode = "video" | "audio" | "empty";
export type PreviewAspect = "landscape" | "tiktok";

export type CropRect = { left: number; top: number; right: number; bottom: number };

/** A video-track clip UNDER the playhead that renders beneath the main
 * (top-most) preview — overlay stack, bottom → top. */
export type MonitorLayerClip = {
  clip: Clip;
  src: string;
  isImage: boolean;
};

type Props = {
  previewMode: PreviewMode;
  previewSrc: string | null;
  playing: boolean;
  duration: number;
  previewError?: string | null;
  aspect: PreviewAspect;
  onAspect: (a: PreviewAspect) => void;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Optional hidden/secondary video ref preserved for backwards compatibility */
  shadowVideoRef?: RefObject<HTMLVideoElement | null>;
  /** Still-image preview element (image/gif clips). */
  imageRef?: RefObject<HTMLImageElement | null>;
  /** When true the under-playhead visual is a still image, not a video. */
  previewIsImage?: boolean;
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Overdub layer: second simultaneous audio clip (voiceover over music). */
  audio2Ref?: RefObject<HTMLAudioElement | null>;
  /** Enabled Text filter on the previewed clip — burned-in overlay preview. */
  textOverlay?: {
    text: string;
    size: number;
    color: string;
    x: number;
    y: number;
    box: boolean;
    boxcolor?: string;
    borderw?: number;
    bordercolor?: string;
    shadow?: boolean;
    clipId?: string;
    filterId?: string;
  } | null;
  /** Commit text overlay patches (x/y normalized -1..1 of half frame, size %
   * of frame height, text content). */
  onTextCommit?: (patch: { x?: number; y?: number; size?: number; text?: string }) => void;
  /** Apply a picked text style + typed text to the displayed clip. */
  onAddTextStyled?: (style: TextPresetParams & { text: string }) => void;
  /** Remove the Text (title) filter from the displayed clip. */
  onRemoveTitle?: () => void;
  /** Images available in the project bin (for the image picker). */
  mediaImages?: MonitorImageItem[];
  /** Tells the user what the image will land on at the playhead. */
  imagePickerContext?: string;
  /** Place a bin image over the video at the playhead. */
  onPickImageItem?: (item: MonitorImageItem) => void;
  /** Browse the disk for images and place them at the playhead. */
  onBrowseImages?: () => void;
  /** Label of the clip the monitor currently targets (selected overlay or
   * the clip under the playhead) — enables Delete in the context menu. */
  removeTargetLabel?: string | null;
  /** Delete the targeted clip. */
  onRemoveTarget?: () => void;
  /** Live transform filter params for the selected/under-playhead clip. */
  transformParams?: {
    x: number;
    y: number;
    scale: number;
    rotation: number;
    opacity?: number;
  } | null;
  /** Transform gestures enabled (crop tool off); they auto-create the filter. */
  transformActive?: boolean;
  /** Commit transform patches (x/y normalized -1..1, scale, opacity 0..1).
   * Creates the Transform filter on demand when the clip has none. */
  onTransformCommit?: (patch: {
    x?: number;
    y?: number;
    scale?: number;
    opacity?: number;
  }) => void;
  onTogglePlay: () => void;
  onSeekRatio: (ratio: number) => void;
  volume: number;
  muted: boolean;
  onVolume: (v: number) => void;
  onMuted: (m: boolean) => void;
  cropTool?: boolean;
  onCropTool?: (on: boolean) => void;
  cropDraft?: CropRect | null;
  onCropCommit?: (crop: CropRect) => void;
  onEyedropColor?: (hex: string) => void;
  /** Magic Remove (AI Eraser) tool state + params of the target clip. */
  magicTool?: boolean;
  onMagicTool?: (on: boolean) => void;
  magicParams?: Record<string, unknown> | null;
  /** The video clip under the playhead — the tool's target. The overlay
   * derives its drawing time from the playback clock itself and remounts
   * (keyed by clip id) so mask state never leaks across clips. */
  magicClip?: Clip | null;
  magicBusy?: { phase: string; percent: number } | null;
  magicStatus?: string | null;
  onMagicCommit?: (patch: {
    strokes?: MagicStroke[];
    keyframes?: MagicKeyframe[];
    anchorTime?: number;
  }) => void;
  onMagicParamChange?: (patch: Record<string, unknown>) => void;
  onMagicTrack?: (mask: {
    strokes: MagicStroke[];
    anchorTime: number | null;
  }) => void;
  onMagicRemove?: (mask: {
    strokes: MagicStroke[];
    anchorTime: number | null;
  }) => void;
  onMagicCancel?: () => void;
  /** Blur Region tool: the enabled blurregion filter on the displayed clip. */
  blurRegion?: {
    clipId: string;
    filterId: string;
    params: Record<string, unknown>;
    /** The clip the filter lives on (time mapping for keyframes). */
    clip: Clip;
  } | null;
  blurTool?: boolean;
  onBlurTool?: (on: boolean) => void;
  /** Commit blur-region patches (geometry, sliders, keyframes). */
  onBlurCommit?: (patch: Record<string, unknown>) => void;
  onBlurTrack?: () => void;
  onBlurCancelTrack?: () => void;
  onBlurRemove?: () => void;
  blurBusy?: { phase: string; percent: number } | null;
  blurStatus?: string | null;
  /** BG Key tool: which mode is open (null = closed). */
  keyTool?: KeyToolMode | null;
  onKeyTool?: (mode: KeyToolMode | null) => void;
  /** Enabled chromakey + bgmask params on the displayed clip. */
  keyFilters?: KeyFilterState;
  onChromaChange?: (patch: Record<string, unknown>) => void;
  onMaskChange?: (patch: Record<string, unknown>) => void;
  onKeyMaskSaved?: (maskKey: string, maskPath: string) => void;
  /** When Clip Monitor is hidden, show a control to restore it. */
  onShowClipMonitor?: () => void;
  /** Whether the project timeline contains any clips. */
  hasTimelineClips?: boolean;
  /** Overlay layers: video-track clips under the playhead ABOVE the base
   * clip, composited on top of the main preview (PiP stack). */
  layers?: MonitorLayerClip[];
  /** Selected timeline clip — when it is one of the layers, gestures target it. */
  selectedClipId?: string | null;
  /** Select a layer clip directly from a monitor click (VN-style). */
  onSelectLayer?: (clipId: string) => void;
  /** Commit a transform gesture on a specific layer clip. */
  onLayerTransformCommit?: (
    clipId: string,
    patch: { x?: number; y?: number; scale?: number; opacity?: number },
  ) => void;
  /** Register the monitor frame element so App can hit-test OS file drops. */
  onRegisterDropTarget?: (el: HTMLDivElement | null) => void;
  /** True while an OS file drag hovers this monitor (App resolves the position). */
  fileDropActive?: boolean;
  /** Hint text shown for the hovering OS file drag. */
  fileDropLabel?: string | null;
};

/** Crop limits as fractions of the SOURCE frame — kept identical to the
 * FFmpeg export clamps in build_video_effect_chain so preview == export. */
const MIN_CROP = 0.02;
const MAX_INSET = 0.49;

/** Transform limits — identical to the FFmpeg export clamps. */
const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const DEFAULT_TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
/** Pointer travel (px) before a press counts as a move gesture — prevents
 * stray clicks from creating a Transform filter. */
const MOVE_THRESHOLD_PX = 3;

/** Enabled transform filter params on a clip (null when it has none). */
function parseClipTransform(
  clip: Clip,
): { x: number; y: number; scale: number; rotation: number; opacity: number } | null {
  const f = (clip.filters ?? []).find((x) => x.kind === "transform" && x.enabled);
  if (!f) return null;
  const p = (f.params ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  return {
    x: num(p.x, 0),
    y: num(p.y, 0),
    scale: num(p.scale, 1),
    rotation: num(p.rotation, 0),
    opacity: num(p.opacity, 1),
  };
}

/** True when a clip has a non-zero enabled crop (content fills the frame). */
function clipCropApplied(clip: Clip): boolean {
  const f = (clip.filters ?? []).find((x) => x.kind === "crop" && x.enabled);
  if (!f) return false;
  const p = (f.params ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  return num(p.left, 0) + num(p.top, 0) + num(p.right, 0) + num(p.bottom, 0) > 0.001;
}

/** File name from a media path (for the selection panel label). */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/* Toolbar icons (16×16 stroke style, matching timeline/icons.tsx). */
function MonitorIcon({ size = 13, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function IconCrop() {
  return (
    <MonitorIcon>
      <path d="M5 1.5v9a.9.9 0 0 0 .9.9H14.5" />
      <path d="M1.5 5h9a.9.9 0 0 1 .9.9V14.5" />
    </MonitorIcon>
  );
}

function IconType() {
  return (
    <MonitorIcon>
      <path d="M3 4.5V3h10v1.5" />
      <path d="M6.3 13h3.4" />
      <path d="M8 3v10" />
    </MonitorIcon>
  );
}

function IconImage() {
  return (
    <MonitorIcon>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <circle cx="5.7" cy="5.9" r="1" />
      <path d="M14 10.6l-3.1-3.1-6 5.5" />
    </MonitorIcon>
  );
}

function IconMagic() {
  return (
    <MonitorIcon>
      <path d="M9.5 2.5l1 2.3 2.3 1-2.3 1-1 2.3-1-2.3-2.3-1 2.3-1z" />
      <path d="M3.5 9.5l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z" />
      <path d="M11.8 10.2l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
    </MonitorIcon>
  );
}

function IconBlur() {
  return (
    <MonitorIcon>
      <rect x="2.5" y="4.5" width="11" height="7" rx="2" strokeDasharray="2.4 1.6" />
      <path d="M6 8h4" />
      <path d="M9.5 6.2c.9 1.1.9 2.5 0 3.6" />
    </MonitorIcon>
  );
}

function IconKey() {
  return (
    <MonitorIcon>
      <circle cx="5.5" cy="8" r="2.6" />
      <path d="M8.1 8h5.4" />
      <path d="M11.2 8v2.2" />
      <path d="M13 8v1.6" />
    </MonitorIcon>
  );
}

function IconAspectWide() {
  return (
    <MonitorIcon>
      <rect x="1.5" y="4" width="13" height="8" rx="1.2" />
      <path d="M1.5 9.5l3.2-2.8 3.3 2.8" />
      <circle cx="10.4" cy="7" r="0.9" />
    </MonitorIcon>
  );
}

function IconAspectTall() {
  return (
    <MonitorIcon>
      <rect x="4.5" y="1.5" width="7" height="13" rx="1.2" />
      <circle cx="7.6" cy="4.8" r="0.9" />
      <path d="M11.5 11l-2.4-2.4-4.6 4.2" />
    </MonitorIcon>
  );
}

export function ProjectMonitor({
  previewMode,
  previewSrc,
  playing,
  duration,
  previewError,
  aspect,
  onAspect,
  videoRef,
  imageRef,
  previewIsImage = false,
  audioRef,
  audio2Ref,
  textOverlay = null,
  onTextCommit,
  onAddTextStyled,
  onRemoveTitle,
  mediaImages = [],
  imagePickerContext,
  onPickImageItem,
  onBrowseImages,
  removeTargetLabel = null,
  onRemoveTarget,
  transformParams = null,
  transformActive = false,
  onTransformCommit,
  onTogglePlay,
  onSeekRatio,
  volume,
  muted,
  onVolume,
  onMuted,
  cropTool = false,
  onCropTool,
  cropDraft,
  onCropCommit,
  onEyedropColor,
  magicTool = false,
  onMagicTool,
  magicParams = null,
  magicClip = null,
  magicBusy = null,
  magicStatus = null,
  onMagicCommit,
  onMagicParamChange,
  onMagicTrack,
  onMagicRemove,
  onMagicCancel,
  blurRegion = null,
  blurTool = false,
  onBlurTool,
  onBlurCommit,
  onBlurTrack,
  onBlurCancelTrack,
  onBlurRemove,
  blurBusy = null,
  blurStatus = null,
  keyTool = null,
  onKeyTool,
  keyFilters,
  onChromaChange,
  onMaskChange,
  onKeyMaskSaved,
  onShowClipMonitor,
  hasTimelineClips = false,
  layers = [],
  selectedClipId = null,
  onSelectLayer,
  onLayerTransformCommit,
  onRegisterDropTarget,
  fileDropActive = false,
  fileDropLabel = null,
}: Props) {
  const tiktok = aspect === "tiktok";
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [fullView, setFullView] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!fullView) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setFullView(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullView]);

  const [activeCrop, setActiveCrop] = useState<CropRect | null>(null);
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
  /** Natural size of the active visual (video or image) — drives the
   * object-fit content mapping for all pointer interactions. */
  const [mediaSize, setMediaSize] = useState<{ w: number; h: number } | null>(null);
  const [binDragOver, setBinDragOver] = useState(false);
  const textOverlayRef = useRef<HTMLDivElement | null>(null);
  const [textDragging, setTextDragging] = useState(false);
  const [textEditing, setTextEditing] = useState(false);
  const [textDraft, setTextDraft] = useState("");
  const textEditRef = useRef<HTMLTextAreaElement | null>(null);
  const [textPickerOpen, setTextPickerOpen] = useState(false);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const textWheelSizeRef = useRef<number | null>(null);
  const textWheelTimer = useRef(0);
  /** Mirror of the media transform — the scale-handle frame tracks it. */
  const tfFrameRef = useRef<HTMLDivElement | null>(null);
  /** Live feedback while resizing media ("Scale 140%") or text ("Text 8%"). */
  const [gestureBadge, setGestureBadge] = useState<string | null>(null);
  /** Opacity slider draft (percent) while the user drags it. */
  const [opacityPct, setOpacityPct] = useState<number | null>(null);
  const opacityCommitTimer = useRef(0);
  /** Measured text overlay box (px, frame-relative) — anchors text handles. */
  const [textBox, setTextBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [textHover, setTextHover] = useState(false);
  const [textResizing, setTextResizing] = useState(false);
  /** Hiding hover handles immediately breaks the pointer's trip from the
   * text to a corner handle — hide on a short delay instead. */
  const textHoverTimer = useRef(0);
  function setTextHoverSticky(v: boolean) {
    window.clearTimeout(textHoverTimer.current);
    if (v) {
      setTextHover(true);
    } else {
      textHoverTimer.current = window.setTimeout(() => setTextHover(false), 300);
    }
  }
  /** Layer (PiP) element registry + natural sizes for gesture targeting. */
  const layerElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const [layerSizes, setLayerSizes] = useState<Map<string, { w: number; h: number }>>(new Map());
  /** Guards the cropDraft sync while a crop gesture is in flight. */
  const cropDraggingRef = useRef(false);
  /** Latest gesture state committed on pointerup / wheel debounce. */
  const currentTransformRef = useRef<{ x: number; y: number; scale: number; rotation: number } | null>(null);
  const wheelCommitTimer = useRef(0);
  /** Target of the pending wheel-zoom stream (element-aware commit). */
  const wheelTargetRef = useRef<TransformTarget | null>(null);
  /** The keyed preview canvas element (blur region mirrors it when active). */
  const keyCanvasRef = useRef<HTMLCanvasElement | null>(null);

  /** Eyedropper is active ONLY while the BG Key chroma mode is open. Tying
   * it to "a chromakey filter exists on the selected clip" permanently
   * hijacked every monitor press after applying BG key — transform/drag
   * gestures became impossible until deselecting (the inspector edits key
   * color through a color input, so it never needs the monitor eyedropper). */
  const eyedropActive = keyTool === "chroma";
  /** The keyed preview replaces the base visual whenever a chromakey or
   * bgmask filter is enabled on the displayed clip (WYSIWYG alpha). */
  const keyPreviewActive = !!(keyFilters?.chroma || keyFilters?.mask);

  /** Persist the bgmask alpha mask: whenever shapes/feather/invert changed
   * (maskKey != render key), rasterize at source resolution and hand the PNG
   * to App (which writes it to the derived cache via save_bg_mask). The
   * export path reads the SAME file, so preview == export exactly. */
  const maskSig = keyFilters?.mask ? bgMaskRenderKey(keyFilters.mask) : "";
  const rasterizeTimer = useRef(0);
  const saveMaskRef = useRef(onKeyMaskSaved);
  saveMaskRef.current = onKeyMaskSaved;
  useEffect(() => {
    const mask = keyFilters?.mask;
    if (!mask || !maskSig || !saveMaskRef.current) return;
    if (maskSig === mask.maskKey) return;
    const shapes = (Array.isArray(mask.shapes) ? mask.shapes : []) as BgMaskShape[];
    if (!shapes.length) return;
    window.clearTimeout(rasterizeTimer.current);
    rasterizeTimer.current = window.setTimeout(() => {
      const size = liveMediaSize() ?? mediaSize;
      if (!size || size.w < 2 || size.h < 2) return;
      const w = Math.min(2048, Math.round(size.w));
      const h = Math.max(2, Math.round((w * size.h) / size.w));
      const canvas = rasterizeBgMask(
        w,
        h,
        shapes,
        typeof mask.feather === "number" ? mask.feather : 0.01,
        mask.invert === true,
      );
      if (!canvas) return;
      saveMaskRef.current?.(maskSig, canvas.toDataURL("image/png"));
    }, 350);
    return () => window.clearTimeout(rasterizeTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maskSig, keyFilters?.mask, mediaSize]);

  const cropZero: CropRect = { left: 0, top: 0, right: 0, bottom: 0 };
  const currentCrop = activeCrop ?? cropDraft ?? cropZero;

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setFrameSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // Never stomp an in-flight drag gesture with the (stale) committed draft.
    if (cropDraggingRef.current) return;
    setActiveCrop(cropDraft ?? null);
  }, [cropDraft]);

  function activeVisualEl(): HTMLElement | null {
    return previewIsImage
      ? (imageRef?.current ?? null)
      : (videoRef.current ?? null);
  }

  /** Natural size of the active visual, read live from the DOM element. */
  function liveMediaSize(): { w: number; h: number } | null {
    const el = activeVisualEl();
    if (!el) return null;
    if (el instanceof HTMLImageElement) {
      return el.naturalWidth > 0 ? { w: el.naturalWidth, h: el.naturalHeight } : null;
    }
    const v = el as HTMLVideoElement;
    return v.videoWidth > 0 ? { w: v.videoWidth, h: v.videoHeight } : null;
  }

  // New media source: preserve live element size if available, otherwise clear until metadata loads.
  useEffect(() => {
    const live = liveMediaSize();
    if (live) {
      setMediaSize(live);
    } else {
      setMediaSize(null);
    }
  }, [previewSrc]);

  // Keep mediaSize synchronized directly from the DOM video element whenever it loads metadata.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        setMediaSize({ w: v.videoWidth, h: v.videoHeight });
      }
    };
    if (v.videoWidth > 0 && v.videoHeight > 0) {
      setMediaSize({ w: v.videoWidth, h: v.videoHeight });
    }
    v.addEventListener("loadedmetadata", onMeta);
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, [previewSrc, videoRef]);

  // Highlight while a library item is dragged over the monitor frame.
  useEffect(() => {
    return subscribeBinDrag((session) => {
      if (!session?.active) {
        setBinDragOver(false);
        return;
      }
      setBinDragOver(pointInElement(session.clientX, session.clientY, frameRef.current));
    });
  }, []);

  // Immediately synchronize crop visual style on the active video/image element
  useEffect(() => {
    const visual = previewIsImage ? (imageRef?.current ?? null) : videoRef.current;
    if (!visual) return;
    if (cropTool) {
      // In interactive crop editing mode: show full uncropped frame so user can position the crop box accurately
      visual.style.removeProperty("object-view-box");
      visual.style.objectFit = "";
    } else if (
      currentCrop &&
      (currentCrop.left > 0.001 || currentCrop.top > 0.001 || currentCrop.right > 0.001 || currentCrop.bottom > 0.001)
    ) {
      // Uses the live draft so Done/exit shows the new crop immediately,
      // without waiting for the backend commit round-trip. Contain-fit keeps
      // the cropped region's own shape (no stretch at any orientation).
      const topPct = (currentCrop.top * 100).toFixed(3);
      const rightPct = (currentCrop.right * 100).toFixed(3);
      const bottomPct = (currentCrop.bottom * 100).toFixed(3);
      const leftPct = (currentCrop.left * 100).toFixed(3);
      visual.style.setProperty("object-view-box", `inset(${topPct}% ${rightPct}% ${bottomPct}% ${leftPct}%)`);
      visual.style.objectFit = "contain";
    } else {
      visual.style.removeProperty("object-view-box");
      visual.style.objectFit = "";
    }
  }, [cropTool, currentCrop, previewIsImage, videoRef, imageRef]);

  // Keyboard shortcuts while crop tool is active
  useEffect(() => {
    if (!cropTool) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        exitCrop();
      } else if (e.key === "Enter") {
        e.preventDefault();
        exitCrop();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropTool, activeCrop, cropDraft, onCropCommit, onCropTool]);

  const fit: FitMode = tiktok ? "cover" : "contain";
  const effectiveMediaSize = mediaSize ?? liveMediaSize();
  const content: ContentRect = displayedContentRect(
    frameSize.w,
    frameSize.h,
    effectiveMediaSize?.w ?? 0,
    effectiveMediaSize?.h ?? 0,
    fit,
  );

  /** Transform gestures are available whenever media is displayed and the
   * crop tool is off — committing a gesture auto-creates the filter. */
  const transformEnabled = transformActive && previewMode === "video" && !!previewSrc;
  /** Visible content rect for the scale handles: with an applied crop the
   * preview fills the whole element (object-view-box + fill). */
  const cropApplied =
    !cropTool &&
    !!cropDraft &&
    cropDraft.left + cropDraft.top + cropDraft.right + cropDraft.bottom > 0.001;
  /** Region overlays are stored relative to the VISIBLE frame: with an
   * applied crop the element content fills the frame box, so overlays map
   * 1:1 and the draw source is the crop sub-rect of the media. */
  const visibleContent: ContentRect = cropApplied ? { x: 0, y: 0, w: 1, h: 1 } : content;
  const srcRect = cropApplied
    ? {
      left: cropDraft?.left ?? 0,
      top: cropDraft?.top ?? 0,
      right: cropDraft?.right ?? 0,
      bottom: cropDraft?.bottom ?? 0,
    }
    : undefined;
  const manipulableLayer = selectedClipId
    ? (layers.find((l) => l.clip.id === selectedClipId) ?? null)
    : null;
  const layerSize = manipulableLayer
    ? (layerSizes.get(manipulableLayer.clip.id) ?? null)
    : null;
  const layerContent = displayedContentRect(
    frameSize.w,
    frameSize.h,
    layerSize?.w ?? 0,
    layerSize?.h ?? 0,
    "contain",
  );
  const tfRect: ContentRect = manipulableLayer
    ? (clipCropApplied(manipulableLayer.clip) ? { x: 0, y: 0, w: 1, h: 1 } : layerContent)
    : (cropApplied ? { x: 0, y: 0, w: 1, h: 1 } : content);
  const tfTransform = transformCss(
    manipulableLayer
      ? (parseClipTransform(manipulableLayer.clip) ?? DEFAULT_TRANSFORM)
      : (transformParams ?? DEFAULT_TRANSFORM),
  );

  /** Live transform of the BASE preview for the mirror canvases (key/blur):
   * the pending gesture values while the base element is the drag target,
   * else the committed Transform filter of the base clip. Null = identity
   * (also when a PiP layer is selected — its transform lives on its own
   * element, never on the base mirrors). Read per frame by the canvases'
   * render loops, so transform gestures are visible without re-renders. */
  function baseMirrorTransform(): MirrorTransform | null {
    if (manipulableLayer) return null;
    const live =
      liveElRef.current === activeVisualEl() ? currentTransformRef.current : null;
    const p = live ?? transformParams;
    if (!p) return null;
    if (
      Math.abs(p.x) < 1e-4 &&
      Math.abs(p.y) < 1e-4 &&
      Math.abs(p.scale - 1) < 1e-4 &&
      Math.abs(p.rotation) < 1e-4
    ) {
      return null;
    }
    return { x: p.x, y: p.y, scale: p.scale, rotation: p.rotation };
  }

  /** A freshly committed transform (edit, undo, reconcile) supersedes the
   * pending live gesture values the mirror canvases read — otherwise an
   * undo would leave the mirrors on the pre-undo transform. Keyed by value
   * signature: the prop object is fresh on every App render. */
  const transformSig = transformParams
    ? `${transformParams.x}|${transformParams.y}|${transformParams.scale}|${transformParams.rotation}`
    : "";
  const lastTransformSigRef = useRef("");
  useEffect(() => {
    if (transformSig === lastTransformSigRef.current) return;
    lastTransformSigRef.current = transformSig;
    currentTransformRef.current = null;
    liveElRef.current = null;
  }, [transformSig]);

  const textDraggable = !!onTextCommit && !!textOverlay && !cropTool && previewMode === "video";
  /** Text resize handles show on hover/interaction and take priority over
   * the media handles so both never clutter the frame at once. */
  const textHandlesActive = textDraggable && !textEditing && (textHover || textDragging || textResizing);
  // Magic Remove owns the frame while open — the brush overlay is the only
  // interaction; transform handles + the opacity HUD would just clutter it.
  const handlesVisible =
    transformEnabled && (manipulableLayer != null || !!effectiveMediaSize) && !textHandlesActive && !magicTool && !blurTool && !keyTool;
  const currentOpacityPct = Math.round(
    (manipulableLayer
      ? (parseClipTransform(manipulableLayer.clip)?.opacity ?? 1)
      : (transformParams?.opacity ?? 1)) * 100,
  );

  /** Displayed content rect from live DOM state (accurate at gesture start). */
  function liveContent(): ContentRect {
    const frame = frameRef.current;
    const size = liveMediaSize() ?? mediaSize;
    if (!frame || !size) return { x: 0, y: 0, w: 1, h: 1 };
    return displayedContentRect(frame.clientWidth, frame.clientHeight, size.w, size.h, fit);
  }

  function onVisualMetadata(el: HTMLVideoElement) {
    if (el.videoWidth > 0) setMediaSize({ w: el.videoWidth, h: el.videoHeight });
  }

  const registerLayerEl = useCallback((clipId: string, el: HTMLElement | null) => {
    if (el) layerElsRef.current.set(clipId, el);
    else layerElsRef.current.delete(clipId);
  }, []);

  const onLayerMediaSize = useCallback((clipId: string, w: number, h: number) => {
    setLayerSizes((prev) => {
      const cur = prev.get(clipId);
      if (cur && cur.w === w && cur.h === h) return prev;
      const next = new Map(prev);
      next.set(clipId, { w, h });
      return next;
    });
  }, []);

  /* --- Transform: drag to move, wheel or handles to scale, double-click to
     reset. The gesture targets the SELECTED clip when it is a layer under
     the playhead (select it in the timeline), otherwise the main preview.
     Committing creates the Transform filter on demand (WYSIWYG: the gesture
     is already visible; the commit persists it). --- */

  function transformCss(p: { x: number; y: number; scale: number; rotation: number }) {
    return `translate(${(p.x * 50).toFixed(3)}%, ${(p.y * 50).toFixed(3)}%) rotate(${p.rotation}deg) scale(${p.scale.toFixed(4)})`;
  }

  type TransformTarget = {
    /** null = main preview clip; string = layer clip id. */
    clipId: string | null;
    el: HTMLElement | null;
    base: { x: number; y: number; scale: number; rotation: number; opacity: number };
    hasFilter: boolean;
    commit: (patch: {
      x?: number;
      y?: number;
      scale?: number;
      opacity?: number;
    }) => void;
  };

  /** Apply a transform to the target element and the handle mirror frame. */
  function setTransformLive(target: TransformTarget, p: { x: number; y: number; scale: number; rotation: number }) {
    if (target.el) target.el.style.transform = transformCss(p);
    if (tfFrameRef.current) tfFrameRef.current.style.transform = transformCss(p);
  }

  /** The clip monitor gestures manipulate: the selected timeline clip when
   * it is one of the under-layers, else the main (top-most) preview clip. */
  function resolveTransformTarget(): TransformTarget | null {
    if (!transformEnabled) return null;
    const selectedLayer = selectedClipId
      ? layers.find((l) => l.clip.id === selectedClipId)
      : undefined;
    if (selectedLayer) {
      const el = layerElsRef.current.get(selectedLayer.clip.id) ?? null;
      if (!el) return null;
      const parsed = parseClipTransform(selectedLayer.clip);
      return {
        clipId: selectedLayer.clip.id,
        el,
        base: parsed ?? DEFAULT_TRANSFORM,
        hasFilter: parsed != null,
        commit: (patch) => onLayerTransformCommit?.(selectedLayer.clip.id, patch),
      };
    }
    const el = activeVisualEl();
    if (!el) return null;
    return {
      clipId: null,
      el,
      base: {
        x: transformParams?.x ?? 0,
        y: transformParams?.y ?? 0,
        scale: transformParams?.scale ?? 1,
        rotation: transformParams?.rotation ?? 0,
        opacity: transformParams?.opacity ?? 1,
      },
      hasFilter: !!transformParams,
      commit: (patch) => onTransformCommit?.(patch),
    };
  }

  /* --- Direct manipulation ( VN style): the layer under the
     pointer is the gesture target — clicking an image selects it and the
     drag moves it in one press. No timeline selection round-trip. --- */

  /** Content box of a layer in frame px, with its live transform applied
   * (translate in px + uniform scale around the frame center). */
  function layerHitBox(
    l: MonitorLayerClip,
  ): { cx: number; cy: number; w: number; h: number } | null {
    const frame = frameRef.current;
    const size = layerSizes.get(l.clip.id);
    if (!frame || !size) return null;
    const W = frame.clientWidth;
    const H = frame.clientHeight;
    const content: ContentRect = clipCropApplied(l.clip)
      ? { x: 0, y: 0, w: 1, h: 1 }
      : displayedContentRect(W, H, size.w, size.h, "contain");
    const t = parseClipTransform(l.clip) ?? DEFAULT_TRANSFORM;
    return {
      cx: (content.x + content.w / 2) * W + t.x * 0.5 * W,
      cy: (content.y + content.h / 2) * H + t.y * 0.5 * H,
      w: content.w * W * t.scale,
      h: content.h * H * t.scale,
    };
  }

  /** Topmost layer whose displayed content contains the pointer. */
  function hitTestLayer(clientX: number, clientY: number): MonitorLayerClip | null {
    const frame = frameRef.current;
    if (!frame) return null;
    const r = frame.getBoundingClientRect();
    const fx = clientX - r.left;
    const fy = clientY - r.top;
    for (let i = layers.length - 1; i >= 0; i--) {
      const box = layerHitBox(layers[i]);
      if (!box) continue;
      if (Math.abs(fx - box.cx) <= box.w / 2 + 3 && Math.abs(fy - box.cy) <= box.h / 2 + 3) {
        return layers[i];
      }
    }
    return null;
  }

  /** Gesture target for a pointer at (x,y): the layer under the pointer
   * (selected on the fly), else the current selection / main preview. */
  function resolveGestureTarget(clientX: number, clientY: number): TransformTarget | null {
    if (!transformEnabled) return null;
    const hit = hitTestLayer(clientX, clientY);
    if (hit) {
      const el = layerElsRef.current.get(hit.clip.id) ?? null;
      if (el) {
        if (selectedClipId !== hit.clip.id) onSelectLayer?.(hit.clip.id);
        const parsed = parseClipTransform(hit.clip);
        return {
          clipId: hit.clip.id,
          el,
          base: parsed ?? DEFAULT_TRANSFORM,
          hasFilter: parsed != null,
          commit: (patch) => onLayerTransformCommit?.(hit.clip.id, patch),
        };
      }
    }
    return resolveTransformTarget();
  }

  /** Element the pending (uncommitted) live transform belongs to — lets a
   * new gesture continue from what is on screen instead of stale props. */
  const liveElRef = useRef<HTMLElement | null>(null);

  function beginTransformDrag(e: ReactPointerEvent) {
    const target = resolveGestureTarget(e.clientX, e.clientY);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    // Continue from the on-screen state: a wheel zoom still inside its
    // commit debounce must not snap back when the press begins.
    const base =
      liveElRef.current === target.el && currentTransformRef.current
        ? { ...target.base, ...currentTransformRef.current }
        : target.base;
    let current = { ...base };
    let moved = false;
    let raf = 0;
    let pending: { x: number; y: number } | null = null;

    const applyFrame = () => {
      raf = 0;
      if (!pending) return;
      current = { ...base, x: pending.x, y: pending.y };
      setTransformLive(target, current);
      currentTransformRef.current = current;
    };

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > MOVE_THRESHOLD_PX) {
        moved = true;
        frame.classList.add("transform-dragging");
        if (target.el) target.el.style.willChange = "transform";
        if (tfFrameRef.current) tfFrameRef.current.style.willChange = "transform";
      }
      if (!moved) return;
      // One style write per display frame keeps the drag butter-smooth even
      // when pointer events arrive faster than the compositor paints.
      pending = {
        x: Math.max(
          -1,
          Math.min(1, base.x + ((ev.clientX - startX) / Math.max(1, rect.width)) * 2),
        ),
        y: Math.max(
          -1,
          Math.min(1, base.y + ((ev.clientY - startY) / Math.max(1, rect.height)) * 2),
        ),
      };
      if (!raf) raf = requestAnimationFrame(applyFrame);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (raf) cancelAnimationFrame(raf);
      frame.classList.remove("transform-dragging");
      if (target.el) target.el.style.willChange = "";
      if (tfFrameRef.current) tfFrameRef.current.style.willChange = "";
      const end = currentTransformRef.current;
      if (moved) {
        liveElRef.current = target.el;
        if (end && (Math.abs(end.x - base.x) > 0.001 || Math.abs(end.y - base.y) > 0.001)) {
          target.commit({ x: end.x, y: end.y });
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  /** Commit any pending wheel-zoom stream (target-aware: scrolling over a
   * different layer first settles the previous one). */
  function flushWheelCommit() {
    window.clearTimeout(wheelCommitTimer.current);
    const end = currentTransformRef.current;
    const t = wheelTargetRef.current;
    currentTransformRef.current = null;
    wheelTargetRef.current = null;
    liveElRef.current = null;
    setGestureBadge(null);
    if (!t || !end) return;
    // Creating a filter from scratch requires a deliberate scroll (2%);
    // updating an existing one commits any real change.
    const minDelta = t.hasFilter ? 0.001 : 0.02;
    if (Math.abs(end.scale - t.base.scale) > minDelta) {
      t.commit({ scale: end.scale });
    }
  }

  function onFrameWheel(e: ReactWheelEvent) {
    const target = resolveGestureTarget(e.clientX, e.clientY);
    if (!target) return;
    e.preventDefault();
    if (wheelTargetRef.current?.el !== target.el) {
      flushWheelCommit();
      wheelTargetRef.current = target;
      liveElRef.current = target.el;
    }
    // Clamp the per-event factor so trackpad inertia / line-mode deltas
    // cannot rocket the scale — zoom stays proportional to the scroll.
    const dy = Math.max(-60, Math.min(60, e.deltaY));
    const factor = Math.exp(-dy * 0.0015);
    const base = currentTransformRef.current ?? target.base;
    const next = {
      ...base,
      scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, base.scale * factor)),
    };
    setTransformLive(target, next);
    currentTransformRef.current = next;
    setGestureBadge(`Scale ${Math.round(next.scale * 100)}%`);
    window.clearTimeout(wheelCommitTimer.current);
    wheelCommitTimer.current = window.setTimeout(flushWheelCommit, 400);
  }

  function onFrameDoubleClick() {
    const target = resolveTransformTarget();
    if (!target || !target.hasFilter) return;
    flushWheelCommit();
    const reset = { x: 0, y: 0, scale: 1, rotation: target.base.rotation };
    setTransformLive(target, reset);
    setGestureBadge(null);
    target.commit({ x: 0, y: 0, scale: 1 });
  }

  /** Corner-handle resize: drag outward/inward from the frame center. */
  function beginScaleDrag(e: ReactPointerEvent) {
    const target = resolveGestureTarget(e.clientX, e.clientY);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    const frame = frameRef.current;
    if (!frame) return;
    const frameRect = frame.getBoundingClientRect();
    const cx = frameRect.left + frameRect.width / 2;
    const cy = frameRect.top + frameRect.height / 2;
    const baseDist = Math.max(8, Math.hypot(e.clientX - cx, e.clientY - cy));
    // Continue from the on-screen state (pending wheel zoom included).
    const base =
      liveElRef.current === target.el && currentTransformRef.current
        ? { ...target.base, ...currentTransformRef.current }
        : target.base;
    window.clearTimeout(wheelCommitTimer.current);
    liveElRef.current = target.el;
    let current = { ...base };
    let raf = 0;
    let pendingScale: number | null = null;
    frame.classList.add("transform-dragging");
    if (target.el) target.el.style.willChange = "transform";
    setGestureBadge(`Scale ${Math.round(base.scale * 100)}%`);

    const applyFrame = () => {
      raf = 0;
      if (pendingScale == null) return;
      current = { ...base, scale: pendingScale };
      setTransformLive(target, current);
      currentTransformRef.current = current;
      setGestureBadge(`Scale ${Math.round(current.scale * 100)}%`);
    };
    const onMove = (ev: PointerEvent) => {
      const dist = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      pendingScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, base.scale * (dist / baseDist)));
      if (!raf) raf = requestAnimationFrame(applyFrame);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (raf) cancelAnimationFrame(raf);
      frame.classList.remove("transform-dragging");
      if (target.el) target.el.style.willChange = "";
      setGestureBadge(null);
      if (Math.abs(current.scale - base.scale) > 0.001) {
        target.commit({ scale: current.scale });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  /** Opacity slider (selection panel): preview live on the element, commit
   * the filter value on a short debounce — same pattern as text resize. */
  function onOpacityInput(e: React.ChangeEvent<HTMLInputElement>) {
    const pct = Number(e.target.value);
    setOpacityPct(pct);
    const target = resolveTransformTarget();
    if (!target) return;
    if (target.el) target.el.style.opacity = String(pct / 100);
    window.clearTimeout(opacityCommitTimer.current);
    opacityCommitTimer.current = window.setTimeout(() => {
      target.commit({ opacity: pct / 100 });
      setOpacityPct(null);
    }, 350);
  }

  /* --- Text overlay: drag to position, handles/wheel to resize --- */

  function beginTextEdit() {
    if (!textDraggable || !textOverlay) return;
    setTextDraft(textOverlay.text);
    setTextEditing(true);
  }

  function commitTextEdit() {
    if (!textOverlay || !onTextCommit) {
      setTextEditing(false);
      return;
    }
    const next = textDraft.trim();
    setTextEditing(false);
    if (next && next !== textOverlay.text) {
      onTextCommit({ text: textDraft });
    }
  }

  // Focus + select the text when entering edit mode.
  useEffect(() => {
    if (!textEditing) return;
    const el = textEditRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [textEditing]);

  // Measure the text overlay box so resize handles can hug it.
  useLayoutEffect(() => {
    if (!textOverlay || textEditing) {
      setTextBox(null);
      return;
    }
    const el = textOverlayRef.current;
    const frame = frameRef.current;
    if (!el || !frame) {
      setTextBox(null);
      return;
    }
    const fr = frame.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setTextBox({ x: r.left - fr.left, y: r.top - fr.top, w: r.width, h: r.height });
  }, [textOverlay, textEditing, frameSize]);

  /** Re-measure the text box after an imperative style change. */
  function remeasureTextBox() {
    const el = textOverlayRef.current;
    const frame = frameRef.current;
    if (!el || !frame) return;
    const fr = frame.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setTextBox({ x: r.left - fr.left, y: r.top - fr.top, w: r.width, h: r.height });
  }

  /** Corner-handle text resize: scale font size by distance from the text's
   * own center — the same model media handles use, clamped to the drawtext
   * export range (1..30% of frame height). */
  function beginTextScaleDrag(e: ReactPointerEvent) {
    if (!textDraggable || !textOverlay || !onTextCommit) return;
    e.preventDefault();
    e.stopPropagation();
    const el = textOverlayRef.current;
    const frame = frameRef.current;
    const box = textBox;
    if (!el || !frame || !box) return;
    const fr = frame.getBoundingClientRect();
    const cx = fr.left + box.x + box.w / 2;
    const cy = fr.top + box.y + box.h / 2;
    const baseDist = Math.max(8, Math.hypot(e.clientX - cx, e.clientY - cy));
    const base = textWheelSizeRef.current ?? textOverlay.size;
    // Box grows/shrinks around its center with the font ratio — computed,
    // not measured (no per-move reflow); exact box returns via the layout
    // effect once the size commits.
    const box0 = textBox;
    const cx0 = box0 ? box0.x + box0.w / 2 : 0;
    const cy0 = box0 ? box0.y + box0.h / 2 : 0;
    let current = base;
    let textRaf = 0;
    setTextResizing(true);
    setGestureBadge(`Text ${Math.round(base * 10) / 10}%`);

    const onMove = (ev: PointerEvent) => {
      const dist = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      current = Math.max(1, Math.min(30, base * (dist / baseDist)));
      el.style.fontSize = `${Math.max(10, (current / 100) * frameSize.h).toFixed(2)}px`;
      if (box0) {
        const r = current / base;
        const nb = {
          x: cx0 - (box0.w * r) / 2,
          y: cy0 - (box0.h * r) / 2,
          w: box0.w * r,
          h: box0.h * r,
        };
        if (!textRaf) {
          textRaf = requestAnimationFrame(() => {
            textRaf = 0;
            setTextBox(nb);
          });
        }
      }
      setGestureBadge(`Text ${Math.round(current * 10) / 10}%`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (textRaf) {
        cancelAnimationFrame(textRaf);
        textRaf = 0;
      }
      setTextResizing(false);
      setGestureBadge(null);
      textWheelSizeRef.current = null;
      if (Math.abs(current - base) > 0.05) {
        onTextCommit({ size: current });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function beginTextDrag(e: ReactPointerEvent) {
    if (!textDraggable || !textOverlay || !onTextCommit) return;
    e.preventDefault();
    e.stopPropagation();
    const frame = frameRef.current;
    const el = textOverlayRef.current;
    if (!frame || !el) return;
    const rect = frame.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const base = { x: textOverlay.x, y: textOverlay.y };
    // Track the box arithmetically during the gesture — the text moves 1:1
    // with the pointer in px, so no per-move getBoundingClientRect (reflow).
    const box0 = textBox ?? { x: 0, y: 0, w: 0, h: 0 };
    let boxCur = box0;
    let textRaf = 0;
    let last = base;
    setTextDragging(true);

    const onMove = (ev: PointerEvent) => {
      // x/y are offsets from the frame center in half-frame units — the same
      // space the drawtext export uses ((w/2)+x*w/2), so preview == export.
      const x = Math.max(-1, Math.min(1, base.x + ((ev.clientX - startX) / Math.max(1, rect.width)) * 2));
      const y = Math.max(-1, Math.min(1, base.y + ((ev.clientY - startY) / Math.max(1, rect.height)) * 2));
      last = { x, y };
      el.style.left = `${(50 + x * 50).toFixed(3)}%`;
      el.style.top = `${(50 + y * 50).toFixed(3)}%`;
      boxCur = { ...boxCur, x: box0.x + (ev.clientX - startX), y: box0.y + (ev.clientY - startY) };
      if (!textRaf) {
        textRaf = requestAnimationFrame(() => {
          textRaf = 0;
          setTextBox({ ...boxCur });
        });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (textRaf) {
        cancelAnimationFrame(textRaf);
        textRaf = 0;
      }
      setTextDragging(false);
      remeasureTextBox();
      if (Math.abs(last.x - base.x) > 0.001 || Math.abs(last.y - base.y) > 0.001) {
        onTextCommit({ x: last.x, y: last.y });
      } else {
        el.style.left = `${(50 + base.x * 50).toFixed(3)}%`;
        el.style.top = `${(50 + base.y * 50).toFixed(3)}%`;
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function onTextWheel(e: ReactWheelEvent) {
    if (!textDraggable || !textOverlay || !onTextCommit) return;
    e.preventDefault();
    e.stopPropagation();
    const el = textOverlayRef.current;
    if (!el) return;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const base = textWheelSizeRef.current ?? textOverlay.size;
    const next = Math.max(1, Math.min(30, base * factor));
    textWheelSizeRef.current = next;
    el.style.fontSize = `${Math.max(10, (next / 100) * frameSize.h).toFixed(2)}px`;
    remeasureTextBox();
    setGestureBadge(`Text ${Math.round(next * 10) / 10}%`);
    window.clearTimeout(textWheelTimer.current);
    textWheelTimer.current = window.setTimeout(() => {
      textWheelSizeRef.current = null;
      setGestureBadge(null);
      onTextCommit({ size: next });
    }, 400);
  }

  /* --- Crop: content-rect aware selection box --- */

  type DragMode = "body" | "new" | "tl" | "tr" | "bl" | "br" | "t" | "b" | "l" | "r";

  function startCropDrag(mode: DragMode, e: ReactPointerEvent) {
    if (!cropTool || previewMode !== "video") return;
    e.preventDefault();
    e.stopPropagation();

    const frame = frameRef.current;
    if (!frame) return;
    const frameRect = frame.getBoundingClientRect();
    // Sync render-time geometry with the live element before measuring.
    const liveSize = liveMediaSize();
    if (liveSize) setMediaSize(liveSize);
    const content = liveContent();
    const contentPxW = Math.max(1, content.w * frameRect.width);
    const contentPxH = Math.max(1, content.h * frameRect.height);
    const startX = e.clientX;
    const startY = e.clientY;

    const base = activeCrop ?? cropDraft ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const baseIsUncropped =
      base.left <= 0.001 &&
      base.top <= 0.001 &&
      base.right <= 0.001 &&
      base.bottom <= 0.001;
    const effectiveMode = mode === "body" && baseIsUncropped ? "new" : mode;
    let current = { ...base };
    cropDraggingRef.current = true;
    // Coalesce pointermove updates to one setState per frame — React renders
    // at most 60Hz no matter how fast the pointer events arrive.
    let cropRaf = 0;

    const onMove = (ev: PointerEvent) => {
      // Deltas are fractions of the DISPLAYED CONTENT, i.e. of the source
      // frame — matching how object-view-box and the FFmpeg crop filter
      // interpret the values. Using the raw frame box here was the root
      // cause of crops landing on the wrong region whenever the source
      // aspect ratio differs from the monitor frame.
      const dx = (ev.clientX - startX) / contentPxW;
      const dy = (ev.clientY - startY) / contentPxH;
      let next = { ...base };

      if (effectiveMode === "body") {
        const w = 1 - base.left - base.right;
        const h = 1 - base.top - base.bottom;
        const newL = Math.max(0, Math.min(1 - w, base.left + dx));
        const newT = Math.max(0, Math.min(1 - h, base.top + dy));
        next = {
          left: newL,
          top: newT,
          right: Math.max(0, 1 - newL - w),
          bottom: Math.max(0, 1 - newT - h),
        };
      } else if (effectiveMode === "new") {
        const p0 = clientToSource(startX, startY, frameRect, content);
        const p1 = clientToSource(ev.clientX, ev.clientY, frameRect, content);
        const l = Math.min(p0.x, p1.x);
        const r = 1 - Math.max(p0.x, p1.x);
        const t = Math.min(p0.y, p1.y);
        const b = 1 - Math.max(p0.y, p1.y);
        if (1 - l - r >= MIN_CROP && 1 - t - b >= MIN_CROP) {
          next = {
            left: Math.min(MAX_INSET, l),
            top: Math.min(MAX_INSET, t),
            right: Math.min(MAX_INSET, r),
            bottom: Math.min(MAX_INSET, b),
          };
        }
      } else {
        if (effectiveMode.includes("l")) {
          next.left = Math.max(0, Math.min(MAX_INSET, 1 - base.right - MIN_CROP, base.left + dx));
        }
        if (effectiveMode.includes("r")) {
          next.right = Math.max(0, Math.min(MAX_INSET, 1 - base.left - MIN_CROP, base.right - dx));
        }
        if (effectiveMode.includes("t")) {
          next.top = Math.max(0, Math.min(MAX_INSET, 1 - base.bottom - MIN_CROP, base.top + dy));
        }
        if (effectiveMode.includes("b")) {
          next.bottom = Math.max(0, Math.min(MAX_INSET, 1 - base.top - MIN_CROP, base.bottom - dy));
        }
      }

      current = next;
      if (!cropRaf) {
        cropRaf = requestAnimationFrame(() => {
          cropRaf = 0;
          setActiveCrop({ ...current });
        });
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (cropRaf) {
        cancelAnimationFrame(cropRaf);
        cropRaf = 0;
      }
      cropDraggingRef.current = false;
      // Draft only — the crop is committed on Done / Enter / exiting the
      // tool (exitCrop). Committing every drag end caused duplicate filter
      // writes and racing backend updates (the "crop without Done" bugs).
      setActiveCrop({ ...current });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function cropEquals(a: CropRect | null, b: CropRect | null): boolean {
    const aa = a ?? cropZero;
    const bb = b ?? cropZero;
    return (
      Math.abs(aa.left - bb.left) < 1e-4 &&
      Math.abs(aa.top - bb.top) < 1e-4 &&
      Math.abs(aa.right - bb.right) < 1e-4 &&
      Math.abs(aa.bottom - bb.bottom) < 1e-4
    );
  }

  /** Leave the crop tool, committing the draft box when it differs from the
   * committed crop. Nothing is lost by exiting without pressing Done. */
  function exitCrop() {
    if (!cropEquals(activeCrop, cropDraft ?? null)) {
      onCropCommit?.(activeCrop ?? cropZero);
    }
    onCropTool?.(false);
  }

  /** Eyedrop the color under the pointer from the active visual (video or
   * image — the element may be visually hidden behind the key canvas, it
   * still decodes). Runs on frame pointer-down while eyedropActive. */
  function pickColorAt(e: ReactPointerEvent) {
    if (!eyedropActive || !onEyedropColor) return;
    const el = activeVisualEl();
    const frame = frameRef.current;
    if (!el || !frame) return;
    let srcW = 0;
    let srcH = 0;
    if (el instanceof HTMLVideoElement) {
      srcW = el.videoWidth;
      srcH = el.videoHeight;
    } else if (el instanceof HTMLImageElement) {
      srcW = el.naturalWidth;
      srcH = el.naturalHeight;
    }
    if (!srcW || !srcH) return;
    const canvas = document.createElement("canvas");
    canvas.width = srcW;
    canvas.height = srcH;
    const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx2d) return;
    ctx2d.drawImage(el as CanvasImageSource, 0, 0);
    const frameRect = frame.getBoundingClientRect();
    // Map the click through the displayed content rect; when a crop filter
    // zooms the visible region (object-view-box + fill), the visible frame
    // maps linearly onto that crop sub-rect of the source.
    const cropApplied =
      !cropTool &&
      !!cropDraft &&
      cropDraft.left + cropDraft.top + cropDraft.right + cropDraft.bottom > 0.001;
    let src: { x: number; y: number };
    if (cropApplied && cropDraft) {
      const fx = Math.max(0, Math.min(1, (e.clientX - frameRect.left) / Math.max(1, frameRect.width)));
      const fy = Math.max(0, Math.min(1, (e.clientY - frameRect.top) / Math.max(1, frameRect.height)));
      src = {
        x: cropDraft.left + fx * (1 - cropDraft.left - cropDraft.right),
        y: cropDraft.top + fy * (1 - cropDraft.top - cropDraft.bottom),
      };
    } else {
      src = clientToSource(e.clientX, e.clientY, frameRect, liveContent());
    }
    const x = Math.floor(src.x * (canvas.width - 1));
    const y = Math.floor(src.y * (canvas.height - 1));
    const px = ctx2d.getImageData(x, y, 1, 1).data;
    const hex = `#${[px[0], px[1], px[2]].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    onEyedropColor(hex);
  }

  function onVideoClick(e: React.MouseEvent<HTMLVideoElement>) {
    if (!eyedropActive || !onEyedropColor) return;
    pickColorAt(e as unknown as ReactPointerEvent);
  }

  const canPlay = Boolean(previewSrc || hasTimelineClips || duration > 0);

  const ctxItems: ContextMenuItem[] = [
    {
      type: "item",
      label: playing ? "Pause" : "Play",
      disabled: !canPlay,
      action: () => onTogglePlay(),
    },
    ...(onRemoveTarget && removeTargetLabel
      ? ([
        { type: "sep" as const },
        {
          type: "item" as const,
          label: `Delete "${removeTargetLabel}" (Del)`,
          action: () => onRemoveTarget(),
        },
      ] as ContextMenuItem[])
      : []),
    ...(onRemoveTitle && textOverlay
      ? ([
        {
          type: "item" as const,
          label: "Remove title",
          action: () => onRemoveTitle(),
        },
      ] as ContextMenuItem[])
      : []),
    { type: "sep" },
    {
      type: "item",
      label: cropTool ? "Disable crop tool" : "Crop tool",
      action: () => (cropTool ? exitCrop() : onCropTool?.(true)),
    },
    {
      type: "item",
      label: magicTool ? "Exit Magic Remove" : "Magic Remove (AI Eraser)",
      action: () => onMagicTool?.(!magicTool),
    },
    {
      type: "item",
      label: blurTool ? "Exit Blur Region" : "Blur Region",
      action: () => onBlurTool?.(!blurTool),
    },
    {
      type: "item",
      label: keyTool ? "Exit Remove Background" : "Remove Background (Key)",
      action: () => onKeyTool?.(keyTool ? null : "chroma"),
    },
    { type: "sep" },
    {
      type: "item",
      label: "Aspect 16:9",
      action: () => onAspect("landscape"),
    },
    {
      type: "item",
      label: "Aspect 9:16",
      action: () => onAspect("tiktok"),
    },
    { type: "sep" },
    {
      type: "item",
      label: fullView ? "Exit full view" : "Full view",
      action: () => setFullView((v) => !v),
    },
    ...(onShowClipMonitor
      ? ([
        {
          type: "item" as const,
          label: "Show Clip Monitor",
          action: () => onShowClipMonitor(),
        },
      ] as ContextMenuItem[])
      : []),
  ];

  const isAtTop = currentCrop.top <= 0.005;
  const isAtBottom = currentCrop.bottom <= 0.005;
  const isAtLeft = currentCrop.left <= 0.005;
  const isAtRight = currentCrop.right <= 0.005;
  const isUncropped =
    currentCrop.left <= 0.001 &&
    currentCrop.top <= 0.001 &&
    currentCrop.right <= 0.001 &&
    currentCrop.bottom <= 0.001;
  const cropWidth = Math.max(0, 1 - currentCrop.left - currentCrop.right);
  const cropHeight = Math.max(0, 1 - currentCrop.top - currentCrop.bottom);
  const boxInsets = cropBoxFrameInsets(currentCrop, content);
  const dropTarget = fileDropActive || binDragOver;

  /** Shared text style — mirrors the drawtext export (color, box bar,
   * outline stroke, shadow) so the overlay is WYSIWYG. */
  const textStyle: React.CSSProperties = textOverlay
    ? {
      left: `${50 + textOverlay.x * 50}%`,
      top: `${50 + textOverlay.y * 50}%`,
      transform: "translate(-50%, -50%)",
      fontSize: `${Math.max(10, (textOverlay.size / 100) * frameSize.h)}px`,
      color: textOverlay.color,
      background: textOverlay.box
        ? (textOverlay.boxcolor ?? "rgba(0,0,0,0.45)")
        : "transparent",
      textShadow:
        textOverlay.shadow === false ? "none" : "3px 3px 6px rgba(0,0,0,0.55)",
      WebkitTextStroke:
        textOverlay.borderw && textOverlay.borderw > 0
          ? `${Math.max(1, (textOverlay.borderw * frameSize.h) / 1080).toFixed(2)}px ${textOverlay.bordercolor ?? "#000000"}`
          : undefined,
    }
    : {};

  return (
    <div
      className={`monitor project-monitor aspect-${aspect} ${fullView ? "full-view" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="monitor-label">
        <span>Project Monitor</span>
        <div className="monitor-tools">
          {onShowClipMonitor && (
            <button
              type="button"
              title="Show Clip Monitor"
              aria-label="Show Clip Monitor"
              onClick={onShowClipMonitor}
            >
              Clip
            </button>
          )}
          <button
            type="button"
            className={cropTool ? "active" : ""}
            title="Crop tool — drag on video"
            onClick={() => (cropTool ? exitCrop() : onCropTool?.(true))}
          >
            <IconCrop />
            <span>Crop</span>
          </button>
          <button
            type="button"
            className={textOverlay ? "active" : ""}
            title="Text styles — pick a style, type your text, then drag it in the monitor"
            onClick={() => setTextPickerOpen(true)}
          >
            <IconType />
            <span>Text</span>
          </button>
          <button
            type="button"
            className={magicTool ? "active" : ""}
            title="Magic Remove — brush over a logo, text or object and erase it"
            onClick={() => onMagicTool?.(!magicTool)}
          >
            <IconMagic />
            <span>Remove</span>
          </button>
          <button
            type="button"
            className={blurTool ? "active" : ""}
            title="Blur Region — drag a blurred area over the monitor (shapes, feather, keyframes, auto-track)"
            onClick={() => onBlurTool?.(!blurTool)}
          >
            <IconBlur />
            <span>Blur</span>
          </button>
          <button
            type="button"
            className={keyTool ? "active" : ""}
            title="Remove Background — chroma key a solid color or select areas to remove"
            onClick={() => onKeyTool?.(keyTool ? null : "chroma")}
          >
            <IconKey />
            <span>BG</span>
          </button>
          <button
            type="button"
            title="Add an image overlay — pick from this project or browse your disk"
            onClick={() => setImagePickerOpen(true)}
          >
            <IconImage />
            <span>Image</span>
          </button>
          <div className="aspect-toggle" role="group" aria-label="Preview aspect">
            <button
              type="button"
              className={!tiktok ? "active" : ""}
              title="Landscape 16:9"
              onClick={() => onAspect("landscape")}
            >
              <IconAspectWide />
              <span>16:9</span>
            </button>
            <button
              type="button"
              className={tiktok ? "active" : ""}
              title="Vertical 9:16"
              onClick={() => onAspect("tiktok")}
            >
              <IconAspectTall />
              <span>9:16</span>
            </button>
          </div>
        </div>
        <div className="monitor-fs">
          <button
            type="button"
            className={`monitor-fs-btn ${fullView ? "active" : ""}`}
            title={fullView ? "Exit full view" : "Full view"}
            aria-label={fullView ? "Exit full view" : "Full view"}
            onClick={() => setFullView((v) => !v)}
          >
            <span className={`fs-icon ${fullView ? "exit" : ""}`} aria-hidden />
          </button>
        </div>
      </div>
      <div className="monitor-stage">
        <div
          ref={(el) => {
            frameRef.current = el;
            onRegisterDropTarget?.(el);
          }}
          className={`monitor-frame ${tiktok ? "phone" : "wide"} ${cropTool ? "crop-mode" : ""} ${magicTool ? "magic-mode" : ""} ${transformActive ? "transform-mode" : ""} ${dropTarget ? "drop-target" : ""}`}
          onPointerDown={(e) => {
            if (eyedropActive) {
              // Color picking has priority over gestures in key mode.
              pickColorAt(e);
              return;
            }
            if (magicTool || blurTool || keyTool === "area") {
              // Region tools own the frame; their overlays handle input.
              return;
            }
            if (cropTool) {
              startCropDrag("new", e);
              return;
            }
            beginTransformDrag(e);
          }}
          onWheel={onFrameWheel}
          onDoubleClick={onFrameDoubleClick}
          title={transformEnabled ? "Drag to move · wheel or corner handles to resize · double-click to reset" : undefined}
        >
          {/* Overlay stack: video-track clips above the base clip (
              PiP). Playback-synced, per-clip effects/fades/transform. */}
          {layers.map((l) => (
            <MonitorLayer
              key={l.clip.id}
              layer={l}
              playing={playing}
              registerEl={registerLayerEl}
              onMediaSize={onLayerMediaSize}
            />
          ))}
          <video
            ref={videoRef}
            className="monitor-video"
            playsInline
            muted
            preload="auto"
            // CORS-mode load: Tauri's asset protocol answers with
            // Access-Control-Allow-Origin, keeping the canvas un-tainted so
            // the BG-key/blur previews can read pixels. Without this,
            // drawImage from the cross-origin asset origin poisons the
            // canvas and getImageData throws — blanking the monitor.
            crossOrigin="anonymous"
            onClick={onVideoClick}
            onLoadedMetadata={(e) => onVisualMetadata(e.currentTarget)}
            style={{
              display: previewMode === "video" && previewSrc && !previewIsImage ? "block" : "none",
              visibility: keyPreviewActive ? "hidden" : undefined,
              cursor: eyedropActive ? "crosshair" : transformEnabled ? "move" : undefined,
              background: layers.length > 0 ? "transparent" : undefined,
            }}
          />
          {/* Text filter overlay (WYSIWYG with drawtext export) */}
          {textOverlay && previewMode === "video" && frameSize.h > 0 && textEditing ? (
            <textarea
              ref={textEditRef}
              className="monitor-text-overlay editing"
              style={{
                ...textStyle,
                width: textBox ? Math.max(180, Math.round(textBox.w + 28)) : 260,
                height: textBox ? Math.max(48, Math.round(textBox.h + 16)) : undefined,
              }}
              value={textDraft}
              rows={2}
              onChange={(e) => setTextDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commitTextEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setTextEditing(false);
                }
              }}
              onBlur={commitTextEdit}
              onPointerDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            />
          ) : textOverlay && previewMode === "video" && frameSize.h > 0 ? (
            <div
              ref={textOverlayRef}
              className={`monitor-text-overlay ${textDraggable ? "interactive" : ""} ${textDragging ? "dragging" : ""}`}
              style={textStyle}
              onPointerDown={beginTextDrag}
              onPointerEnter={() => setTextHoverSticky(true)}
              onPointerLeave={() => setTextHoverSticky(false)}
              onWheel={onTextWheel}
              onDoubleClick={(e) => {
                e.stopPropagation();
                beginTextEdit();
              }}
              title={textDraggable ? "Drag to move · wheel or corner handles to resize · double-click to edit" : undefined}
            >
              {textOverlay.text}
            </div>
          ) : null}
          {/* Text resize handles (hover the text to reveal them). */}
          {textHandlesActive && textBox && (
            <div
              className="text-handles"
              style={{ left: textBox.x, top: textBox.y, width: textBox.w, height: textBox.h }}
            >
              {(
                [
                  ["tl", 0, 0, "nwse-resize"],
                  ["tr", 1, 0, "nesw-resize"],
                  ["bl", 0, 1, "nesw-resize"],
                  ["br", 1, 1, "nwse-resize"],
                ] as const
              ).map(([key, fx, fy, cursor]) => (
                <div
                  key={key}
                  className={`crop-handle text-handle text-handle-${key}`}
                  style={{
                    left: `calc(${fx * 100}% - 6px)`,
                    top: `calc(${fy * 100}% - 6px)`,
                    cursor,
                  }}
                  onPointerEnter={() => setTextHoverSticky(true)}
                  onPointerLeave={() => setTextHoverSticky(false)}
                  onPointerDown={beginTextScaleDrag}
                  title="Drag to resize text"
                />
              ))}
            </div>
          )}
          {/* Still image / GIF clip preview */}
          {imageRef && (
            <img
              ref={imageRef}
              className="monitor-video is-front"
              src={previewIsImage ? (previewSrc ?? undefined) : undefined}
              alt=""
              draggable={false}
              crossOrigin="anonymous"
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth > 0) setMediaSize({ w: img.naturalWidth, h: img.naturalHeight });
              }}
              style={{
                display: previewMode === "video" && previewSrc && previewIsImage ? "block" : "none",
                visibility: keyPreviewActive ? "hidden" : undefined,
                cursor: eyedropActive ? "crosshair" : transformEnabled ? "move" : undefined,
                background: layers.length > 0 ? "transparent" : undefined,
              }}
            />
          )}
          {/* Scale handles: mirror the media transform so the corners stay
              glued to the displayed content at any aspect ratio. */}
          {handlesVisible && (
            <div
              ref={tfFrameRef}
              className="tf-frame"
              style={{ transform: tfTransform }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {/* Selection outline around the manipulable content. */}
              <div
                className="tf-outline"
                style={{
                  left: `${(tfRect.x * 100).toFixed(3)}%`,
                  top: `${(tfRect.y * 100).toFixed(3)}%`,
                  right: `${((1 - tfRect.x - tfRect.w) * 100).toFixed(3)}%`,
                  bottom: `${((1 - tfRect.y - tfRect.h) * 100).toFixed(3)}%`,
                }}
              />
              {(
                [
                  ["tl", tfRect.x, tfRect.y, "nwse-resize"],
                  ["tr", tfRect.x + tfRect.w, tfRect.y, "nesw-resize"],
                  ["bl", tfRect.x, tfRect.y + tfRect.h, "nesw-resize"],
                  ["br", tfRect.x + tfRect.w, tfRect.y + tfRect.h, "nwse-resize"],
                ] as const
              ).map(([key, fx, fy, cursor]) => (
                <div
                  key={key}
                  className={`crop-handle tf-handle tf-handle-${key}`}
                  style={{
                    left: `calc(${(fx * 100).toFixed(3)}% - 7px)`,
                    top: `calc(${(fy * 100).toFixed(3)}% - 7px)`,
                    cursor,
                  }}
                  onPointerDown={beginScaleDrag}
                  title="Drag to resize"
                />
              ))}
            </div>
          )}
          {/* Magic Remove (AI Eraser): brush mask overlay + controls. Keyed
              by clip id — a fresh panel per clip, so strokes/mask draft state
              can never bleed across clips. */}
          {magicTool && magicClip && previewMode === "video" && !previewIsImage && frameSize.w > 2 && (
            <MagicRemoveOverlay
              key={magicClip.id}
              clip={magicClip}
              frameSize={frameSize}
              content={content}
              params={magicParams}
              busy={magicBusy}
              status={magicStatus}
              onCommit={(patch) => onMagicCommit?.(patch)}
              onParamChange={(patch) => onMagicParamChange?.(patch)}
              onTrack={(m) => onMagicTrack?.(m)}
              onRemove={(m) => onMagicRemove?.(m)}
              onCancel={() => onMagicCancel?.()}
              onDone={() => onMagicTool?.(false)}
            />
          )}
          {/* BG Key live preview: keyed/alpha-composited frame replaces the
              base visual (which stays hidden but keeps decoding). */}
          {keyPreviewActive && previewMode === "video" && frameSize.w > 2 && (
            <KeyPreviewCanvas
              isImage={previewIsImage}
              playing={playing}
              frameSize={frameSize}
              content={visibleContent}
              mediaSize={effectiveMediaSize}
              srcRect={srcRect}
              filters={keyFilters ?? { chroma: null, mask: null }}
              getDrawSource={() =>
                previewIsImage
                  ? (imageRef?.current ?? null)
                  : (videoRef.current ?? null)
              }
              getMirrorTransform={baseMirrorTransform}
              elRef={keyCanvasRef}
            />
          )}
          {/* Blur Region overlay: always previews when the filter exists;
              the panel + handles appear while the tool is open. Keyed by
              clip id so gesture state never leaks across clips. */}
          {blurRegion && previewMode === "video" && frameSize.w > 2 && (
            <BlurRegionOverlayMemo
              key={`${blurRegion.clipId}:${blurRegion.filterId}`}
              clip={blurRegion.clip}
              src={previewSrc}
              isImage={previewIsImage}
              frameSize={frameSize}
              content={visibleContent}
              mediaSize={effectiveMediaSize}
              srcRect={srcRect}
              params={blurRegion.params}
              toolOpen={blurTool}
              busy={blurBusy}
              status={blurStatus}
              getSourceEl={() =>
                keyCanvasRef.current ??
                (activeVisualEl() as
                  | HTMLVideoElement
                  | HTMLImageElement
                  | HTMLCanvasElement
                  | null)
              }
              getMirrorTransform={baseMirrorTransform}
              onCommit={(patch) => onBlurCommit?.(patch)}
              onTrack={() => onBlurTrack?.()}
              onCancelTrack={() => onBlurCancelTrack?.()}
              onRemove={() => onBlurRemove?.()}
              onDone={() => onBlurTool?.(false)}
            />
          )}
          {/* BG Key tool panel (+ select-area drawing surface). */}
          {keyTool && previewMode === "video" && (
            <BackgroundKeyPanel
              mode={keyTool}
              onMode={(m) => onKeyTool?.(m)}
              chroma={keyFilters?.chroma ?? null}
              mask={keyFilters?.mask ?? null}
              content={visibleContent}
              frameSize={frameSize}
              onChromaChange={(patch) => onChromaChange?.(patch)}
              onMaskChange={(patch) => onMaskChange?.(patch)}
              onDone={() => onKeyTool?.(null)}
            />
          )}
          {gestureBadge && <div className="tf-badge">{gestureBadge}</div>}
          {handlesVisible && (
            <div
              className="sel-panel"
              onPointerDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <span className="sel-panel-name">
                {manipulableLayer
                  ? baseName(manipulableLayer.clip.media_path)
                  : previewIsImage
                    ? "Image"
                    : "Video"}
              </span>
              <span className="sel-panel-label">Opacity</span>
              <input
                type="range"
                min={0}
                max={100}
                value={opacityPct ?? currentOpacityPct}
                onChange={onOpacityInput}
                aria-label="Overlay opacity"
              />
              <span className="sel-panel-value">{opacityPct ?? currentOpacityPct}%</span>
            </div>
          )}
          {dropTarget && (
            <div className="monitor-drop-hint">
              {fileDropActive
                ? (fileDropLabel ?? "Drop to add at the playhead")
                : "Release to place at the playhead"}
            </div>
          )}
          {cropTool && previewMode === "video" && (
            <div
              className="crop-box"
              style={boxInsets}
            >
              {/* Body for moving the whole box */}
              <div
                className="crop-box-body"
                style={{ cursor: isUncropped ? "crosshair" : "move" }}
                onPointerDown={(e) => startCropDrag("body", e)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  const zero = { left: 0, top: 0, right: 0, bottom: 0 };
                  setActiveCrop(zero);
                  onCropCommit?.(zero);
                }}
                title={isUncropped ? "Drag anywhere on video to crop" : "Drag to move crop area · Double-click to reset"}
              />

              {/* Rule of thirds grid lines */}
              <div className="crop-grid-h1" />
              <div className="crop-grid-h2" />
              <div className="crop-grid-v1" />
              <div className="crop-grid-v2" />

              {/* 4 Corner Resize Handles */}
              <div
                className="crop-handle crop-handle-tl"
                style={{
                  top: isAtTop ? 0 : -6,
                  left: isAtLeft ? 0 : -6,
                }}
                onPointerDown={(e) => startCropDrag("tl", e)}
                title="Resize Top-Left"
              />
              <div
                className="crop-handle crop-handle-tr"
                style={{
                  top: isAtTop ? 0 : -6,
                  right: isAtRight ? 0 : -6,
                }}
                onPointerDown={(e) => startCropDrag("tr", e)}
                title="Resize Top-Right"
              />
              <div
                className="crop-handle crop-handle-bl"
                style={{
                  bottom: isAtBottom ? 0 : -6,
                  left: isAtLeft ? 0 : -6,
                }}
                onPointerDown={(e) => startCropDrag("bl", e)}
                title="Resize Bottom-Left"
              />
              <div
                className="crop-handle crop-handle-br"
                style={{
                  bottom: isAtBottom ? 0 : -6,
                  right: isAtRight ? 0 : -6,
                }}
                onPointerDown={(e) => startCropDrag("br", e)}
                title="Resize Bottom-Right"
              />

              {/* 4 Edge Resize Handles */}
              <div
                className="crop-handle crop-handle-t"
                style={{ top: isAtTop ? 0 : -5 }}
                onPointerDown={(e) => startCropDrag("t", e)}
                title="Resize Top Edge"
              />
              <div
                className="crop-handle crop-handle-b"
                style={{ bottom: isAtBottom ? 0 : -5 }}
                onPointerDown={(e) => startCropDrag("b", e)}
                title="Resize Bottom Edge"
              />
              <div
                className="crop-handle crop-handle-l"
                style={{ left: isAtLeft ? 0 : -5 }}
                onPointerDown={(e) => startCropDrag("l", e)}
                title="Resize Left Edge"
              />
              <div
                className="crop-handle crop-handle-r"
                style={{ right: isAtRight ? 0 : -5 }}
                onPointerDown={(e) => startCropDrag("r", e)}
                title="Resize Right Edge"
              />

              {/* Information badge & Quick Actions */}
              <div
                className={`crop-info-badge ${currentCrop.top < 0.12 ? "flip-inside" : ""}`}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <span className="crop-dim-text">
                  Crop:
                  <span className="crop-dim-val">
                    {Math.round(cropWidth * 100)}% × {Math.round(cropHeight * 100)}%
                  </span>
                  {mediaSize && (
                    <span className="crop-dim-px">
                      {` · ${Math.max(2, Math.round(cropWidth * mediaSize.w))}×${Math.max(2, Math.round(cropHeight * mediaSize.h))} px`}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className="crop-badge-btn"
                  title="Reset crop to full frame"
                  onClick={(e) => {
                    e.stopPropagation();
                    const zero = { left: 0, top: 0, right: 0, bottom: 0 };
                    setActiveCrop(zero);
                    onCropCommit?.(zero);
                  }}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="crop-badge-btn done"
                  title="Done cropping (Enter)"
                  onClick={(e) => {
                    e.stopPropagation();
                    exitCrop();
                  }}
                >
                  Done
                </button>
              </div>
            </div>
          )}
          <audio ref={audioRef} preload="metadata" className="monitor-timeline-audio" />
          <audio ref={audio2Ref} preload="metadata" className="monitor-timeline-audio" />
          <div
            className="monitor-audio-only"
            style={{ display: !hasTimelineClips && previewMode === "audio" && previewSrc ? "grid" : "none" }}
          >
            <div className="audio-orb small">♪</div>
            <h2>Audio preview</h2>
            <p>Playing timeline audio</p>
          </div>
          {previewMode === "empty" && (
            <div className="monitor-empty">
              <p>
                {hasTimelineClips
                  ? "No clip under the playhead — drop media here or scrub the timeline"
                  : tiktok
                    ? "Vertical frame · drop video, images or .txt here to start editing"
                    : "Drop video, images or .txt here — or import media and place clips on the timeline"}
              </p>
            </div>
          )}
        </div>
        {previewError && <div className="preview-error">{previewError}</div>}
      </div>
      <div className="monitor-transport">
        <button type="button" className="play-btn sm" onClick={onTogglePlay} disabled={!canPlay}>
          {playing ? "❚❚" : "▶"}
        </button>
        <MonitorTransportTime duration={duration} canPlay={canPlay} onSeekRatio={onSeekRatio} />
        <span className="timecode muted-tc">{formatTime(duration)}</span>
        <button
          type="button"
          className={`vol-btn sm ${muted || volume === 0 ? "is-muted" : ""}`}
          title={muted || volume === 0 ? "Unmute" : "Mute"}
          aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
          onClick={() => onMuted(!muted)}
        >
          {muted || volume === 0 ? "×" : "♪"}
        </button>
        <input
          className="vol-scrub"
          type="range"
          min={0}
          max={100}
          value={Math.round((muted ? 0 : volume) * 100)}
          title="Volume"
          aria-label="Project monitor volume"
          onChange={(e) => {
            const next = Number(e.target.value) / 100;
            onVolume(next);
            if (next > 0) onMuted(false);
          }}
        />
      </div>
      {textPickerOpen && (
        <TextPresetPicker
          onApply={(preset, text) => {
            setTextPickerOpen(false);
            onAddTextStyled?.({ ...preset.params, text });
          }}
          onClose={() => setTextPickerOpen(false)}
        />
      )}
      {imagePickerOpen && (
        <ImagePicker
          images={mediaImages}
          contextLabel={imagePickerContext}
          onPick={(item) => {
            setImagePickerOpen(false);
            onPickImageItem?.(item);
          }}
          onBrowse={() => {
            setImagePickerOpen(false);
            onBrowseImages?.();
          }}
          onClose={() => setImagePickerOpen(false)}
        />
      )}
      {ctx && (
        <ContextMenuPopup
          x={ctx.x}
          y={ctx.y}
          items={ctxItems}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  );
}

/** Playhead-driven transport bits (timecode + scrub slider). Subscribes to
 * the authoritative playback clock directly so the monitor body never
 * re-renders because playback advanced. */
const MonitorTransportTime = memo(function MonitorTransportTime({
  duration,
  canPlay,
  onSeekRatio,
}: {
  duration: number;
  canPlay: boolean;
  onSeekRatio: (ratio: number) => void;
}) {
  const playhead = usePlayheadTime();
  const safeDur = Math.max(0.001, duration);
  return (
    <>
      <span className="timecode">{formatTime(playhead)}</span>
      <input
        className="scrub"
        type="range"
        min={0}
        max={1000}
        value={Math.round((playhead / safeDur) * 1000)}
        disabled={!canPlay}
        onChange={(e) => onSeekRatio(Number(e.target.value) / 1000)}
      />
    </>
  );
});

/** An overlay clip composited ABOVE the main preview (PiP layer).
 * Video layers play in sync with the main clock (muted — their audio lives
 * on the linked audio track); images are static. Per-clip filters, fades
 * and transform are applied exactly like the export composites them.
 * The playhead arrives via the playback clock subscription: this tiny
 * component updates at the clock's throttled rate while its parent stays
 * stable during playback. Memoized: monitor-only re-renders (drags) skip
 * layer reconciliation. */
const MonitorLayer = memo(function MonitorLayer({
  layer,
  playing,
  registerEl,
  onMediaSize,
}: {
  layer: MonitorLayerClip;
  playing: boolean;
  registerEl: (clipId: string, el: HTMLElement | null) => void;
  onMediaSize: (clipId: string, w: number, h: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playhead = usePlayheadTime();
  const { clip, src, isImage } = layer;

  const style = useMemo(() => {
    const s = previewVideoStyle(
      (clip.filters ?? []) as FilterInstance[],
      clipFadeGain(clip, playhead),
    );
    // Cross-dissolve fade-in for overlay layers — matches the export's
    // alpha fade on the incoming segment.
    const tr = (clip.filters ?? []).find((f) => f.kind === "transition" && f.enabled);
    if (tr) {
      const p = (tr.params ?? {}) as Record<string, unknown>;
      const d = typeof p.duration === "number" && Number.isFinite(p.duration) ? p.duration : 0.5;
      const local = playhead - clip.start;
      if (local < d) s.opacity *= Math.max(0.04, local / d);
    }
    return s;
  }, [clip, playhead]);

  // Seek to the right frame the moment ANY load stage reports readiness —
  // a paused layer video that never seeks paints black instead of content.
  const seekNow = useCallback(() => {
    const v = videoRef.current;
    if (!v || v.readyState < 1) return;
    if (v.videoWidth > 0) onMediaSize(clip.id, v.videoWidth, v.videoHeight);
    const want = mediaTimeForClip(clip, playhead);
    try {
      if (Math.abs(v.currentTime - want) > 0.05) v.currentTime = want;
    } catch {
      /* metadata not ready */
    }
  }, [clip, playhead, onMediaSize]);

  // Layer video sync: load once, resync on drift, follow play/pause.
  useEffect(() => {
    const v = videoRef.current;
    if (isImage || !v) return;
    if (v.dataset.src !== src) {
      v.dataset.src = src;
      v.src = src;
      v.load();
    }
    const want = mediaTimeForClip(clip, playhead);
    if (v.readyState >= 1 && Math.abs(v.currentTime - want) > 0.35) {
      try {
        v.currentTime = want;
      } catch {
        /* metadata not ready */
      }
    }
    if (clip.speed && !clip.reverse) {
      v.playbackRate = Math.min(4, Math.max(0.25, clip.speed));
    }
    if (playing) {
      if (v.paused) void v.play().catch(() => undefined);
    } else if (!v.paused) {
      v.pause();
    }
  }, [isImage, src, clip, playhead, playing]);

  const layerStyle = {
    filter: style.filter,
    transform: style.transform,
    opacity: style.opacity,
    ...(style.objectViewBox ? ({ objectViewBox: style.objectViewBox } as Record<string, string>) : {}),
    objectFit: style.objectFit ?? undefined,
  } as React.CSSProperties;

  if (isImage) {
    return (
      <img
        ref={(el) => {
          registerEl(clip.id, el);
        }}
        className="monitor-layer"
        src={src}
        alt=""
        draggable={false}
        crossOrigin="anonymous"
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0) onMediaSize(clip.id, img.naturalWidth, img.naturalHeight);
        }}
        style={layerStyle}
      />
    );
  }
  return (
    <video
      ref={(el) => {
        videoRef.current = el;
        registerEl(clip.id, el);
      }}
      className="monitor-layer"
      muted
      playsInline
      preload="auto"
      crossOrigin="anonymous"
      onLoadedMetadata={seekNow}
      onLoadedData={seekNow}
      onCanPlay={seekNow}
      style={layerStyle}
    />
  );
});
