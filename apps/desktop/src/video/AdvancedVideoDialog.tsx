import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  defaultParams,
  effectLabel,
  previewVideoStyle,
  type FilterInstance,
} from "../effects/effects";
import { formatTime } from "../timeline/types";
import "./AdvancedVideoDialog.css";

const WRITE_DEBOUNCE_MS = 160;
const UI_TIME_MS = 80;
const SPEED_PRESETS = [0.5, 1, 1.5, 2] as const;
const VIDEO_KINDS = [
  "flip",
  "exposure",
  "contrast",
  "saturation",
  "blur",
  "transform",
  "crop",
  "chromakey",
] as const;

export type AdvancedVideoTarget = {
  mediaPath: string;
  name: string;
  duration: number;
  inPoint: number;
  outPoint: number;
  clipId: string | null;
  fadeIn: number;
  fadeOut: number;
  reverse: boolean;
  speed?: number;
  sourceMode: boolean;
  appliedKinds?: string[];
  filters?: FilterInstance[];
};

type Props = {
  target: AdvancedVideoTarget;
  onClose: () => void;
  onSetFades: (fadeIn: number, fadeOut: number) => void;
  onSetReverse: (reverse: boolean) => void | Promise<void>;
  onSetSpeed: (speed: number) => void | Promise<void>;
  onApplyEffect: (kind: string, params?: Record<string, unknown>) => void | Promise<void>;
  onRemoveEffect?: (kind: string) => void | Promise<void>;
  onOpenApplied?: () => void;
  onStatus: (s: string) => void;
};

function clipLocalGain(t: number, dur: number, fadeIn: number, fadeOut: number): number {
  let g = 1;
  if (fadeIn > 1e-4 && t < fadeIn) g *= Math.max(0, t / fadeIn);
  if (fadeOut > 1e-4 && t > dur - fadeOut) g *= Math.max(0, (dur - t) / fadeOut);
  return g;
}

function clampSpeed(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(4, Math.max(0.25, v));
}

export function AdvancedVideoDialog({
  target,
  onClose,
  onSetFades,
  onSetReverse,
  onSetSpeed,
  onApplyEffect,
  onRemoveEffect,
  onOpenApplied,
  onStatus,
}: Props) {
  const inPoint = Math.max(0, target.inPoint);
  const outPoint = Math.max(inPoint + 0.05, target.outPoint);
  const dur = Math.max(0.05, outPoint - inPoint);
  const canEdit = !!target.clipId && !target.sourceMode;

  const [fadeIn, setFadeIn] = useState(target.fadeIn);
  const [fadeOut, setFadeOut] = useState(target.fadeOut);
  const [reverse, setReverse] = useState(!!target.reverse);
  const [speed, setSpeed] = useState(clampSpeed(target.speed ?? 1));
  const [filters, setFilters] = useState<FilterInstance[]>(target.filters ?? []);
  const [appliedKinds, setAppliedKinds] = useState<string[]>(target.appliedKinds ?? []);
  const [localTime, setLocalTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [exposure, setExposure] = useState(0);
  const [contrast, setContrast] = useState(1);
  const [saturation, setSaturation] = useState(1);
  const [blur, setBlur] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fadeTimer = useRef(0);
  const filterTimer = useRef(0);
  const speedTimer = useRef(0);
  const rafRef = useRef(0);
  const playingRef = useRef(false);
  const reverseRef = useRef(reverse);
  const speedRef = useRef(speed);
  const localTimeRef = useRef(0);
  const wallOriginRef = useRef(0);
  const localOriginRef = useRef(0);
  const uiTimeTimer = useRef(0);
  const nativePlayRef = useRef(false);
  const draftFiltersRef = useRef(false);

  const src = useMemo(() => {
    try {
      return convertFileSrc(target.mediaPath);
    } catch {
      return null;
    }
  }, [target.mediaPath]);

  // Full hydrate when clip identity changes.
  useEffect(() => {
    setFadeIn(target.fadeIn);
    setFadeOut(target.fadeOut);
    setReverse(!!target.reverse);
    setSpeed(clampSpeed(target.speed ?? 1));
    setFilters(target.filters ?? []);
    setAppliedKinds(target.appliedKinds ?? []);
    draftFiltersRef.current = false;
    const fl = (target.filters ?? []).find((f) => f.kind === "flip" && f.enabled);
    setFlipH(!!fl?.params?.horizontal);
    setFlipV(!!fl?.params?.vertical);
    const ex = (target.filters ?? []).find((f) => f.kind === "exposure" && f.enabled);
    setExposure(typeof ex?.params?.amount === "number" ? (ex.params.amount as number) : 0);
    const ct = (target.filters ?? []).find((f) => f.kind === "contrast" && f.enabled);
    setContrast(typeof ct?.params?.amount === "number" ? (ct.params.amount as number) : 1);
    const sat = (target.filters ?? []).find((f) => f.kind === "saturation" && f.enabled);
    setSaturation(typeof sat?.params?.amount === "number" ? (sat.params.amount as number) : 1);
    const bl = (target.filters ?? []).find((f) => f.kind === "blur" && f.enabled);
    setBlur(typeof bl?.params?.radius === "number" ? (bl.params.radius as number) : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity-only hydrate
  }, [target.clipId]);

  // Light sync: chips / reverse / speed / fades from parent without clobbering live sliders.
  useEffect(() => {
    setReverse(!!target.reverse);
    setSpeed(clampSpeed(target.speed ?? 1));
    setFadeIn(target.fadeIn);
    setFadeOut(target.fadeOut);
    setAppliedKinds(target.appliedKinds ?? []);
    if (!draftFiltersRef.current) {
      setFilters(target.filters ?? []);
    }
  }, [target.reverse, target.speed, target.fadeIn, target.fadeOut, target.appliedKinds, target.filters]);

  reverseRef.current = reverse;
  speedRef.current = speed;
  localTimeRef.current = localTime;

  const previewFilters = useMemo((): FilterInstance[] => {
    const base = filters.filter(
      (f) => !["flip", "exposure", "contrast", "saturation", "blur"].includes(f.kind),
    );
    const live: FilterInstance[] = [
      ...base,
      {
        id: "live-flip",
        kind: "flip",
        enabled: flipH || flipV,
        params: { horizontal: flipH, vertical: flipV },
      },
      { id: "live-ex", kind: "exposure", enabled: Math.abs(exposure) > 0.01, params: { amount: exposure } },
      {
        id: "live-ct",
        kind: "contrast",
        enabled: Math.abs(contrast - 1) > 0.01,
        params: { amount: contrast },
      },
      {
        id: "live-sat",
        kind: "saturation",
        enabled: Math.abs(saturation - 1) > 0.01,
        params: { amount: saturation },
      },
      { id: "live-blur", kind: "blur", enabled: blur > 0.05, params: { radius: blur } },
    ];
    return live;
  }, [filters, flipH, flipV, exposure, contrast, saturation, blur]);

  const applyPreviewCss = useCallback(
    (tLocal: number) => {
      const video = videoRef.current;
      if (!video) return;
      const fade = clipLocalGain(tLocal, dur, fadeIn, fadeOut);
      const style = previewVideoStyle(previewFilters, fade);
      video.style.filter = style.filter;
      video.style.transform = style.transform;
      video.style.opacity = String(style.opacity);
      video.style.clipPath = style.clipPath ?? "";
    },
    [dur, fadeIn, fadeOut, previewFilters],
  );

  const mediaTimeFromLocal = useCallback(
    (tLocal: number) => {
      const t = Math.max(0, Math.min(dur, tLocal));
      return reverseRef.current ? outPoint - t : inPoint + t;
    },
    [dur, inPoint, outPoint],
  );

  const commitLocalUi = useCallback((t: number, immediate = false) => {
    localTimeRef.current = t;
    if (immediate) {
      window.clearTimeout(uiTimeTimer.current);
      uiTimeTimer.current = 0;
      setLocalTime(t);
      return;
    }
    if (uiTimeTimer.current) return;
    uiTimeTimer.current = window.setTimeout(() => {
      uiTimeTimer.current = 0;
      setLocalTime(localTimeRef.current);
    }, UI_TIME_MS);
  }, []);

  const seekLocal = useCallback(
    (tLocal: number, immediateUi = true) => {
      const t = Math.max(0, Math.min(dur, tLocal));
      commitLocalUi(t, immediateUi);
      const video = videoRef.current;
      if (video && Number.isFinite(mediaTimeFromLocal(t))) {
        video.currentTime = mediaTimeFromLocal(t);
      }
      applyPreviewCss(t);
    },
    [dur, mediaTimeFromLocal, applyPreviewCss, commitLocalUi],
  );

  useEffect(() => {
    applyPreviewCss(localTimeRef.current);
  }, [applyPreviewCss]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    video.src = src;
    video.load();
    const onMeta = () => seekLocal(0, true);
    video.addEventListener("loadedmetadata", onMeta);
    return () => video.removeEventListener("loadedmetadata", onMeta);
  }, [src, seekLocal]);

  const stopRaf = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  const stopPlayback = useCallback(() => {
    const video = videoRef.current;
    playingRef.current = false;
    nativePlayRef.current = false;
    setPlaying(false);
    stopRaf();
    video?.pause();
    commitLocalUi(localTimeRef.current, true);
  }, [stopRaf, commitLocalUi]);

  const needsSteppedPlay = reverse;

  const tick = useCallback(() => {
    if (!playingRef.current) return;
    const elapsed = (performance.now() - wallOriginRef.current) / 1000;
    const rate = speedRef.current;
    let t = localOriginRef.current + elapsed * rate;
    if (t >= dur) {
      t = dur;
      seekLocal(t, true);
      stopPlayback();
      return;
    }
    seekLocal(t, false);
    applyPreviewCss(t);
    rafRef.current = requestAnimationFrame(tick);
  }, [dur, seekLocal, stopPlayback, applyPreviewCss]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      if (!nativePlayRef.current || !playingRef.current) return;
      const media = video.currentTime;
      const t = reverseRef.current
        ? Math.max(0, outPoint - media)
        : Math.max(0, media - inPoint);
      const clamped = Math.max(0, Math.min(dur, t));
      commitLocalUi(clamped, false);
      applyPreviewCss(clamped);
      if (clamped >= dur - 0.02 || media >= outPoint - 0.02) {
        stopPlayback();
        seekLocal(dur, true);
      }
    };
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("ended", stopPlayback);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("ended", stopPlayback);
    };
  }, [dur, inPoint, outPoint, commitLocalUi, applyPreviewCss, stopPlayback, seekLocal]);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (playingRef.current) {
      stopPlayback();
      return;
    }
    if (localTimeRef.current >= dur - 0.02) seekLocal(0, true);

    if (!needsSteppedPlay) {
      try {
        video.playbackRate = speedRef.current;
      } catch {
        /* ignore */
      }
      video.currentTime = mediaTimeFromLocal(localTimeRef.current);
      playingRef.current = true;
      nativePlayRef.current = true;
      setPlaying(true);
      void video.play().catch(() => {
        stopPlayback();
      });
      return;
    }

    wallOriginRef.current = performance.now();
    localOriginRef.current = localTimeRef.current;
    playingRef.current = true;
    nativePlayRef.current = false;
    setPlaying(true);
    video.pause();
    try {
      video.playbackRate = 1;
    } catch {
      /* ignore */
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  useEffect(() => {
    return () => {
      stopRaf();
      window.clearTimeout(fadeTimer.current);
      window.clearTimeout(filterTimer.current);
      window.clearTimeout(speedTimer.current);
      window.clearTimeout(uiTimeTimer.current);
    };
  }, [stopRaf]);

  function scheduleFades(fi: number, fo: number) {
    if (!canEdit) {
      onStatus("Add this video to the timeline to edit fades");
      return;
    }
    window.clearTimeout(fadeTimer.current);
    fadeTimer.current = window.setTimeout(() => {
      onSetFades(Math.max(0, fi), Math.max(0, fo));
    }, WRITE_DEBOUNCE_MS);
  }

  function scheduleFilter(kind: string, params: Record<string, unknown>) {
    if (!canEdit) {
      onStatus("Add this video to the timeline to save effects");
      return;
    }
    draftFiltersRef.current = true;
    window.clearTimeout(filterTimer.current);
    filterTimer.current = window.setTimeout(() => {
      void Promise.resolve(onApplyEffect(kind, params)).then(() => {
        setAppliedKinds((k) => (k.includes(kind) ? k : [...k, kind]));
        draftFiltersRef.current = false;
      });
    }, WRITE_DEBOUNCE_MS);
  }

  function scheduleSpeed(next: number) {
    const v = clampSpeed(next);
    setSpeed(v);
    speedRef.current = v;
    if (!canEdit) {
      onStatus("Preview speed — add to timeline to save");
      return;
    }
    window.clearTimeout(speedTimer.current);
    speedTimer.current = window.setTimeout(() => {
      void Promise.resolve(onSetSpeed(v)).then(() => {
        onStatus(
          v < 1
            ? `Speed ${v.toFixed(2)}× (slow) — clip longer on timeline`
            : v > 1
              ? `Speed ${v.toFixed(2)}× (fast) — clip shorter on timeline`
              : "Speed 1×",
        );
      });
    }, WRITE_DEBOUNCE_MS);
  }

  async function toggleReverse() {
    if (playingRef.current) stopPlayback();
    const next = !reverse;
    setReverse(next);
    reverseRef.current = next;
    seekLocal(localTimeRef.current, true);
    if (!canEdit) {
      onStatus("Preview reverse — add to timeline to save");
      return;
    }
    await Promise.resolve(onSetReverse(next));
    onStatus(
      next
        ? "Reverse on — picture plays backward (export uses FFmpeg reverse; linked audio stays forward)"
        : "Reverse off",
    );
  }

  async function resetDefaults() {
    setFadeIn(0);
    setFadeOut(0);
    setExposure(0);
    setContrast(1);
    setSaturation(1);
    setBlur(0);
    setFlipH(false);
    setFlipV(false);
    setReverse(false);
    reverseRef.current = false;
    setSpeed(1);
    speedRef.current = 1;
    if (playingRef.current) stopPlayback();
    seekLocal(0, true);
    if (!canEdit) {
      onStatus("Preview reset — add to timeline to clear saved effects");
      return;
    }
    onSetFades(0, 0);
    await Promise.resolve(onSetReverse(false));
    await Promise.resolve(onSetSpeed(1));
    for (const kind of VIDEO_KINDS) {
      if (appliedKinds.includes(kind)) {
        await Promise.resolve(onRemoveEffect?.(kind));
      }
    }
    setAppliedKinds([]);
    setFilters([]);
    onStatus("Reset to defaults — fades, reverse, speed, and video effects cleared");
  }

  async function handleDone() {
    if (canEdit) {
      window.clearTimeout(fadeTimer.current);
      window.clearTimeout(filterTimer.current);
      window.clearTimeout(speedTimer.current);
      onSetFades(Math.max(0, fadeIn), Math.max(0, fadeOut));
      await Promise.resolve(onSetReverse(reverse));
      await Promise.resolve(onSetSpeed(clampSpeed(speed)));
      if (flipH || flipV) {
        await Promise.resolve(onApplyEffect("flip", { horizontal: flipH, vertical: flipV }));
      } else if (appliedKinds.includes("flip")) {
        await Promise.resolve(onRemoveEffect?.("flip"));
      }
      if (Math.abs(exposure) > 0.01) {
        await Promise.resolve(onApplyEffect("exposure", { amount: exposure }));
      } else if (appliedKinds.includes("exposure")) {
        await Promise.resolve(onRemoveEffect?.("exposure"));
      }
      if (Math.abs(contrast - 1) > 0.01) {
        await Promise.resolve(onApplyEffect("contrast", { amount: contrast }));
      } else if (appliedKinds.includes("contrast")) {
        await Promise.resolve(onRemoveEffect?.("contrast"));
      }
      if (Math.abs(saturation - 1) > 0.01) {
        await Promise.resolve(onApplyEffect("saturation", { amount: saturation }));
      } else if (appliedKinds.includes("saturation")) {
        await Promise.resolve(onRemoveEffect?.("saturation"));
      }
      if (blur > 0.05) {
        await Promise.resolve(onApplyEffect("blur", { amount: blur, radius: blur }));
      } else if (appliedKinds.includes("blur")) {
        await Promise.resolve(onRemoveEffect?.("blur"));
      }
      onStatus("Advanced Video saved to clip");
      onOpenApplied?.();
    }
    onClose();
  }

  const chips = [
    ...appliedKinds.filter((k) => VIDEO_KINDS.includes(k as (typeof VIDEO_KINDS)[number])),
    ...(reverse ? ["reverse"] : []),
    ...(Math.abs(speed - 1) > 0.02 ? [`speed:${speed}`] : []),
  ];

  const timelineDur = dur / clampSpeed(speed);

  return (
    <div className="avd-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="avd-modal"
        role="dialog"
        aria-label="Advanced Video"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="avd-head">
          <div>
            <strong>Advanced Video</strong>
            <p>
              {target.name} · source {formatTime(dur)}
              {Math.abs(speed - 1) > 0.02 ? ` · timeline ${formatTime(timelineDur)}` : ""}
              {target.sourceMode ? " · source preview" : ""}
            </p>
          </div>
          <button type="button" className="avd-close" onClick={onClose} title="Close">
            ×
          </button>
        </header>

        <div className="avd-preview-wrap">
          {src ? (
            <video ref={videoRef} className="avd-video" playsInline muted preload="auto" />
          ) : (
            <p className="avd-hint">Could not load preview.</p>
          )}
        </div>

        <div className="avd-transport">
          <button type="button" onClick={togglePlay} disabled={!src}>
            {playing ? "Pause" : "Play"}
          </button>
          <span className="avd-tc">
            {formatTime(localTime)} / {formatTime(dur)}
          </span>
          <input
            className="avd-scrub"
            type="range"
            min={0}
            max={dur}
            step={0.01}
            value={localTime}
            onChange={(e) => {
              if (playingRef.current) stopPlayback();
              seekLocal(Number(e.target.value), true);
            }}
          />
        </div>

        <div className="avd-body">
          {chips.length > 0 && (
            <div className="avd-on-clip">
              <span className="avd-on-label">On this clip</span>
              {chips.map((k) => (
                <span key={k} className="avd-chip">
                  {k === "reverse"
                    ? "Reversed"
                    : k.startsWith("speed:")
                      ? `Speed ${clampSpeed(Number(k.slice(6))).toFixed(2)}×`
                      : effectLabel(k)}
                </span>
              ))}
            </div>
          )}

          <label className="avd-slider">
            <span>
              Fade in <em>{fadeIn.toFixed(2)}s</em>
            </span>
            <input
              type="range"
              min={0}
              max={Math.min(10, timelineDur / 2)}
              step={0.01}
              value={fadeIn}
              disabled={!canEdit}
              onChange={(e) => {
                const v = Number(e.target.value);
                setFadeIn(v);
                scheduleFades(v, fadeOut);
                applyPreviewCss(localTimeRef.current);
              }}
            />
          </label>
          <label className="avd-slider">
            <span>
              Fade out <em>{fadeOut.toFixed(2)}s</em>
            </span>
            <input
              type="range"
              min={0}
              max={Math.min(10, timelineDur / 2)}
              step={0.01}
              value={fadeOut}
              disabled={!canEdit}
              onChange={(e) => {
                const v = Number(e.target.value);
                setFadeOut(v);
                scheduleFades(fadeIn, v);
                applyPreviewCss(localTimeRef.current);
              }}
            />
          </label>

          <div className="avd-speed">
            <div className="avd-speed-head">
              <span>
                Speed <em>{speed.toFixed(2)}×</em>
                {speed < 0.999 ? " · Slow" : speed > 1.001 ? " · Fast" : ""}
              </span>
              <div className="avd-speed-presets">
                {SPEED_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={Math.abs(speed - p) < 0.02 ? "primary" : ""}
                    disabled={!canEdit && !src}
                    onClick={() => {
                      if (playingRef.current) stopPlayback();
                      scheduleSpeed(p);
                    }}
                  >
                    {p}×
                  </button>
                ))}
              </div>
            </div>
            <label className="avd-slider">
              <span>Slow ← → Fast</span>
              <input
                type="range"
                min={0.25}
                max={4}
                step={0.05}
                value={speed}
                disabled={!canEdit && !src}
                onChange={(e) => {
                  if (playingRef.current) stopPlayback();
                  scheduleSpeed(Number(e.target.value));
                }}
              />
            </label>
          </div>

          <div className="avd-actions wrap">
            <button
              type="button"
              className={flipH ? "primary" : ""}
              disabled={!canEdit}
              onClick={() => {
                const next = !flipH;
                setFlipH(next);
                scheduleFilter("flip", { horizontal: next, vertical: flipV });
              }}
            >
              Flip H
            </button>
            <button
              type="button"
              className={flipV ? "primary" : ""}
              disabled={!canEdit}
              onClick={() => {
                const next = !flipV;
                setFlipV(next);
                scheduleFilter("flip", { horizontal: flipH, vertical: next });
              }}
            >
              Flip V
            </button>
            <button
              type="button"
              className={reverse ? "primary" : ""}
              disabled={!canEdit && !src}
              onClick={() => void toggleReverse()}
              title="Reverse picture (export). Linked audio stays forward."
            >
              {reverse ? "Reverse · On" : "Reverse"}
            </button>
            <button type="button" className="ghost" disabled={!canEdit} onClick={() => void resetDefaults()}>
              Reset defaults
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!canEdit}
              onClick={() => {
                onOpenApplied?.();
                onStatus("See Applied for full effect controls");
              }}
            >
              Open Applied
            </button>
          </div>

          <label className="avd-slider">
            <span>
              Exposure <em>{exposure.toFixed(2)}</em>
            </span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.01}
              value={exposure}
              disabled={!canEdit}
              onChange={(e) => {
                const v = Number(e.target.value);
                setExposure(v);
                scheduleFilter("exposure", { amount: v });
              }}
            />
          </label>
          <label className="avd-slider">
            <span>
              Contrast <em>{contrast.toFixed(2)}</em>
            </span>
            <input
              type="range"
              min={0}
              max={3}
              step={0.01}
              value={contrast}
              disabled={!canEdit}
              onChange={(e) => {
                const v = Number(e.target.value);
                setContrast(v);
                scheduleFilter("contrast", { amount: v });
              }}
            />
          </label>
          <label className="avd-slider">
            <span>
              Saturation <em>{saturation.toFixed(2)}</em>
            </span>
            <input
              type="range"
              min={0}
              max={3}
              step={0.01}
              value={saturation}
              disabled={!canEdit}
              onChange={(e) => {
                const v = Number(e.target.value);
                setSaturation(v);
                scheduleFilter("saturation", { amount: v });
              }}
            />
          </label>
          <label className="avd-slider">
            <span>
              Blur <em>{blur.toFixed(1)}px</em>
            </span>
            <input
              type="range"
              min={0}
              max={40}
              step={0.5}
              value={blur}
              disabled={!canEdit}
              onChange={(e) => {
                const v = Number(e.target.value);
                setBlur(v);
                scheduleFilter("blur", { ...defaultParams("blur"), radius: v });
              }}
            />
          </label>

          <p className="avd-hint">
            Play previews fades, color, flip, reverse, and speed here. <strong>Done</strong> saves to
            the video clip (Applied tab). Speed retimes timeline length; reverse affects picture on
            export; linked audio stays forward unless edited separately.
          </p>
          {target.sourceMode && (
            <p className="avd-hint">Source preview only — add the clip to the timeline to save edits.</p>
          )}
        </div>

        <footer className="avd-foot">
          <button type="button" className="primary" onClick={() => void handleDone()}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
