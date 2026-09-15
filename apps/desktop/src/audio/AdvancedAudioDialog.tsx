import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { formatTime } from "../timeline/types";
import {
  pitchRatio,
  presetFromSemitones,
  VOICE_PRESETS,
  type VoicePreset,
} from "./agentLog";
import { getCachedPeaks, loadWaveformPeaks } from "./waveformPeaks";
import "./AdvancedAudioDialog.css";

export type AdvancedAudioTarget = {
  mediaPath: string;
  name: string;
  duration: number;
  inPoint: number;
  outPoint: number;
  clipId: string | null;
  fadeIn: number;
  fadeOut: number;
  volumeGain: number;
  sourceMode: boolean;
  /** Filter kinds already on the clip (e.g. denoise, pitch). */
  appliedKinds?: string[];
  /** The clip's full audio filter list — powers Voice Clean sliders and the
   * processed-sound preview. */
  audioFilters?: import("../effects/effects").FilterInstance[];
  /** Existing pitch on the clip (for Done / UI restore). */
  initialSemitones?: number;
  initialVoicePreset?: VoicePreset;
  initialTab?: "overview" | "waveform" | "effects";
};

type Props = {
  target: AdvancedAudioTarget;
  onClose: () => void;
  onSetFades: (fadeIn: number, fadeOut: number) => void;
  onSetVolume: (gain: number) => void;
  onApplyEffect: (kind: string, params?: Record<string, unknown>) => void | Promise<void>;
  onRemoveEffect?: (kind: string) => void | Promise<void>;
  onCutSelection: (selStart: number, selEnd: number) => void;
  onStatus: (s: string) => void;
};

const WRITE_DEBOUNCE_MS = 160;

function clipLocalGain(
  t: number,
  dur: number,
  fadeIn: number,
  fadeOut: number,
  gain: number,
): number {
  let g = Math.max(0, gain);
  if (fadeIn > 1e-4 && t < fadeIn) g *= Math.max(0, t / fadeIn);
  if (fadeOut > 1e-4 && t > dur - fadeOut) {
    g *= Math.max(0, (dur - t) / fadeOut);
  }
  return g;
}

export function AdvancedAudioDialog({
  target,
  onClose,
  onSetFades,
  onSetVolume,
  onApplyEffect,
  onRemoveEffect,
  onCutSelection,
  onStatus,
}: Props) {
  const inPoint = Math.max(0, target.inPoint);
  const outPoint = Math.max(inPoint + 0.05, target.outPoint);
  const dur = Math.max(0.05, outPoint - inPoint);
  const [appliedKinds, setAppliedKinds] = useState<string[]>(
    target.appliedKinds ?? [],
  );

  useEffect(() => {
    setAppliedKinds(target.appliedKinds ?? []);
  }, [target.appliedKinds, target.clipId]);

  useEffect(() => {
    const st = target.initialSemitones ?? 0;
    initialSemitonesRef.current = st;
    setSemitones(st);
    setVoicePreset(target.initialVoicePreset ?? presetFromSemitones(st));
    voiceTouchedRef.current = false;
    voiceAppliedRef.current = false;
  }, [target.clipId, target.initialSemitones, target.initialVoicePreset]);

  const hasDenoise = appliedKinds.includes("denoise");
  const hasPitch = appliedKinds.includes("pitch");

  const cached = getCachedPeaks(target.mediaPath, inPoint, outPoint);
  const [peaks, setPeaks] = useState<Float32Array | null>(cached?.peaks ?? null);
  const [peakAbs, setPeakAbs] = useState(cached?.peakAbs ?? 1);
  const [buffer, setBuffer] = useState<AudioBuffer | null>(cached?.buffer ?? null);
  const [loading, setLoading] = useState(!cached?.buffer);
  const [playing, setPlaying] = useState(false);
  const [fadeIn, setFadeIn] = useState(target.fadeIn);
  const [fadeOut, setFadeOut] = useState(target.fadeOut);
  const [gain, setGain] = useState(target.volumeGain);
  const [prevGain, setPrevGain] = useState(target.volumeGain || 1);
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const [localTime, setLocalTime] = useState(0);
  const [semitones, setSemitones] = useState(target.initialSemitones ?? 0);
  const [voicePreset, setVoicePreset] = useState<VoicePreset>(
    target.initialVoicePreset ?? presetFromSemitones(target.initialSemitones ?? 0),
  );
  const voiceAppliedRef = useRef(false);
  const voiceTouchedRef = useRef(false);
  const initialSemitonesRef = useRef(target.initialSemitones ?? 0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const dragSel = useRef(false);
  const selRaf = useRef(0);
  const pendingSel = useRef<{ a: number; b: number } | null>(null);
  const fadeTimer = useRef(0);
  const gainTimer = useRef(0);
  const canvasSize = useRef({ w: 0, h: 0, dpr: 1 });

  const ctxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playOriginRef = useRef(0);
  const playOffsetRef = useRef(0);
  const playingRef = useRef(false);
  const startFromRef = useRef<(offset: number) => Promise<void>>(async () => undefined);
  const rateRef = useRef(1);

  const fadeInRef = useRef(fadeIn);
  const fadeOutRef = useRef(fadeOut);
  const gainRef = useRef(gain);
  const durRef = useRef(dur);
  const selRef = useRef(sel);
  fadeInRef.current = fadeIn;
  fadeOutRef.current = fadeOut;
  gainRef.current = gain;
  durRef.current = dur;
  selRef.current = sel;
  rateRef.current = pitchRatio(semitones);

  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onSetFadesRef = useRef(onSetFades);
  onSetFadesRef.current = onSetFades;
  const onSetVolumeRef = useRef(onSetVolume);
  onSetVolumeRef.current = onSetVolume;

  const src = useMemo(() => {
    try {
      return convertFileSrc(target.mediaPath);
    } catch {
      return null;
    }
  }, [target.mediaPath]);

  const selLo = sel ? Math.min(sel.a, sel.b) : 0;
  const selHi = sel ? Math.max(sel.a, sel.b) : dur;
  const hasSel = sel != null && selHi - selLo > 0.02;
  const canEdit = Boolean(target.clipId) && !target.sourceMode;

  /* ---- Voice Clean & Boost ---- */
  const [processed, setProcessed] = useState<{ path: string; url: string } | null>(null);
  const [processingPreview, setProcessingPreview] = useState(false);
  const processedAudioRef = useRef<HTMLAudioElement | null>(null);
  const vcTimer = useRef(0);

  const AUDIO_CHAIN_KINDS = new Set([
    "volume",
    "equalizer",
    "compressor",
    "highpass",
    "lowpass",
    "gate",
    "denoise",
    "limiter",
    "reverb",
    "pitch",
    "normalize",
    "deesser",
  ]);

  const audioFilters = target.audioFilters ?? [];
  const filterParam = (kind: string, key: string, d: number): number => {
    const f = audioFilters.find((x) => x.kind === kind && x.enabled);
    const v = (f?.params ?? {})[key];
    return typeof v === "number" && Number.isFinite(v) ? v : d;
  };
  const hasFilter = (kind: string) => appliedKinds.includes(kind);

  const filterSignature = JSON.stringify(
    audioFilters.filter((f) => f.enabled && AUDIO_CHAIN_KINDS.has(f.kind)),
  );
  useEffect(() => {
    setProcessed(null);
  }, [filterSignature]);

  const VC_CHAINS = {
    clean: [
      ["highpass", { freq: 100 }],
      ["denoise", { nf: -30, nr: 20 }],
      ["equalizer", { bass: -1, mid: 0, treble: 3 }],
      ["compressor", { threshold: -24, ratio: 3, attack: 15, release: 200 }],
    ],
    strong: [
      ["highpass", { freq: 120 }],
      ["gate", { threshold: -45, ratio: 12, attack: 5, release: 150 }],
      ["denoise", { nf: -34, nr: 35 }],
      ["equalizer", { bass: -1.5, mid: 0.5, treble: 4 }],
      ["compressor", { threshold: -26, ratio: 4, attack: 10, release: 180 }],
    ],
    podcast: [
      ["highpass", { freq: 85 }],
      ["gate", { threshold: -40, ratio: 10, attack: 10, release: 150 }],
      ["denoise", { nf: -30, nr: 25 }],
      ["equalizer", { bass: 1, mid: 1, treble: 2.5 }],
      ["compressor", { threshold: -22, ratio: 4, attack: 12, release: 200 }],
      ["deesser", { amount: 0.6 }],
    ],
  } as const;

  async function applyVoiceChain(preset: keyof typeof VC_CHAINS) {
    if (!canEdit) {
      onStatus("Add this audio to the timeline to apply voice cleanup");
      return;
    }
    onStatus("Applying voice cleanup…");
    for (const [kind, params] of VC_CHAINS[preset]) {
      await Promise.resolve(onApplyEffect(kind, params as Record<string, unknown>));
    }
    onStatus(
      "Voice cleanup applied — press ▶ Hear processed result to hear the export sound",
    );
  }

  async function clearVoiceCleanup() {
    if (!canEdit) return;
    for (const kind of ["gate", "denoise", "highpass", "equalizer", "compressor", "deesser", "normalize"]) {
      if (hasFilter(kind)) {
        await Promise.resolve(onRemoveEffect?.(kind));
      }
    }
    setAppliedKinds((k) =>
      k.filter(
        (x) =>
          !["gate", "denoise", "highpass", "equalizer", "compressor", "deesser", "normalize"].includes(x),
      ),
    );
    onStatus("Voice cleanup cleared");
  }

  function scheduleVoiceParam(kind: string, params: Record<string, unknown>) {
    if (!canEdit) {
      onStatus("Add this audio to the timeline to edit cleanup");
      return;
    }
    window.clearTimeout(vcTimer.current);
    vcTimer.current = window.setTimeout(() => {
      void Promise.resolve(onApplyEffect(kind, params));
    }, 260);
  }

  async function hearProcessed() {
    const filters = audioFilters
      .filter((f) => f.enabled && AUDIO_CHAIN_KINDS.has(f.kind))
      .map((f) => ({ kind: f.kind, enabled: true, params: f.params ?? {} }));
    if (filters.length === 0) {
      onStatus("Apply a cleanup preset first, then hear the processed result");
      return;
    }
    stopSource();
    playingRef.current = false;
    setPlaying(false);
    processedAudioRef.current?.pause();
    setProcessingPreview(true);
    try {
      const path = await invoke<string>("render_audio_preview", {
        source: target.mediaPath,
        inPoint,
        duration: dur,
        filters,
      });
      const url = convertFileSrc(path);
      setProcessed({ path, url });
      window.setTimeout(() => {
        void processedAudioRef.current?.play().catch(() => undefined);
      }, 120);
      onStatus("Playing the exact export sound of this clip");
    } catch (e) {
      onStatus(String(e));
    } finally {
      setProcessingPreview(false);
    }
  }

  function ensureGraph(): { ctx: AudioContext; gain: GainNode } | null {
    let ctx = ctxRef.current;
    if (!ctx || ctx.state === "closed") {
      ctx = new AudioContext();
      ctxRef.current = ctx;
      const g = ctx.createGain();
      g.connect(ctx.destination);
      gainNodeRef.current = g;
    }
    const g = gainNodeRef.current;
    if (!g) return null;
    return { ctx, gain: g };
  }

  function stopSource() {
    const srcNode = sourceRef.current;
    sourceRef.current = null;
    if (srcNode) {
      try {
        srcNode.onended = null;
        srcNode.stop();
      } catch {
        /* already stopped */
      }
      try {
        srcNode.disconnect();
      } catch {
        /* */
      }
    }
  }

  function currentClipTime(): number {
    if (!playingRef.current || !ctxRef.current) return playOffsetRef.current;
    const elapsed =
      (ctxRef.current.currentTime - playOriginRef.current) * rateRef.current;
    return Math.max(0, Math.min(durRef.current, playOffsetRef.current + elapsed));
  }

  // —— Peak + buffer load ——
  useEffect(() => {
    if (!src) {
      setLoading(false);
      return;
    }
    const hit = getCachedPeaks(target.mediaPath, inPoint, outPoint);
    if (hit?.buffer) {
      setPeaks(hit.peaks);
      setPeakAbs(hit.peakAbs);
      setBuffer(hit.buffer);
      setLoading(false);
      return;
    }

    const ac = new AbortController();
    setLoading(true);
    void loadWaveformPeaks(src, target.mediaPath, {
      inPoint,
      outPoint,
      signal: ac.signal,
      onProgress: (partial, done) => {
        if (ac.signal.aborted) return;
        setPeaks(partial.peaks);
        setPeakAbs(partial.peakAbs);
        if (partial.buffer) setBuffer(partial.buffer);
        if (done) setLoading(false);
      },
    }).then((result) => {
      if (ac.signal.aborted) return;
      if (!result) {
        setPeaks(null);
        setBuffer(null);
        setLoading(false);
        onStatusRef.current("Could not decode waveform preview");
      } else {
        setPeaks(result.peaks);
        setPeakAbs(result.peakAbs);
        setBuffer(result.buffer);
        setLoading(false);
      }
    });

    return () => ac.abort();
  }, [src, target.mediaPath, inPoint, outPoint]);

  useEffect(() => {
    return () => {
      playingRef.current = false;
      stopSource();
      void ctxRef.current?.close().catch(() => undefined);
      ctxRef.current = null;
      gainNodeRef.current = null;
      window.clearTimeout(fadeTimer.current);
      window.clearTimeout(gainTimer.current);
      cancelAnimationFrame(selRaf.current);
    };
  }, []);

  // —— Static waveform ——
  const drawStatic = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks || peaks.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w < 2 || h < 2) return;

    const sizeChanged =
      canvasSize.current.w !== w ||
      canvasSize.current.h !== h ||
      canvasSize.current.dpr !== dpr;
    if (sizeChanged) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvasSize.current = { w, h, dpr };
    }

    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#1a1c22";
    g.fillRect(0, 0, w, h);

    if (hasSel) {
      g.fillStyle = "rgba(61, 174, 233, 0.22)";
      g.fillRect((selLo / dur) * w, 0, ((selHi - selLo) / dur) * w, h);
    }

    if (fadeIn > 0.001) {
      const fw = Math.min(1, fadeIn / dur) * w;
      g.fillStyle = "rgba(240, 163, 94, 0.18)";
      g.beginPath();
      g.moveTo(0, h);
      g.lineTo(0, 0);
      g.lineTo(fw, h);
      g.closePath();
      g.fill();
    }
    if (fadeOut > 0.001) {
      const fw = Math.min(1, fadeOut / dur) * w;
      g.fillStyle = "rgba(240, 163, 94, 0.18)";
      g.beginPath();
      g.moveTo(w, h);
      g.lineTo(w, 0);
      g.lineTo(w - fw, h);
      g.closePath();
      g.fill();
    }

    const mid = h / 2;
    const abs = Math.max(peakAbs, 1e-6);
    g.strokeStyle = "#3daee9";
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * w;
      const amp = (peaks[i] / abs) * (mid - 4);
      g.moveTo(x, mid - amp);
      g.lineTo(x, mid + amp);
    }
    g.stroke();
  }, [peaks, peakAbs, hasSel, selLo, selHi, dur, fadeIn, fadeOut]);

  useEffect(() => {
    drawStatic();
  }, [drawStatic]);

  // —— Playhead + gain automation ——
  useEffect(() => {
    let raf = 0;
    let active = true;
    function tick() {
      if (!active) return;
      const ph = playheadRef.current;
      const t = currentClipTime();
      if (ph) ph.style.left = `${(t / durRef.current) * 100}%`;

      const gNode = gainNodeRef.current;
      if (gNode) {
        gNode.gain.value = clipLocalGain(
          t,
          durRef.current,
          fadeInRef.current,
          fadeOutRef.current,
          gainRef.current,
        );
      }

      if (playingRef.current) {
        const s = selRef.current;
        const lo = s ? Math.min(s.a, s.b) : 0;
        const hi = s ? Math.max(s.a, s.b) : durRef.current;
        const loop = s != null && hi - lo > 0.02;
        const endAt = loop ? hi : durRef.current;
        if (t >= endAt - 0.01) {
          stopSource();
          if (loop) {
            playOffsetRef.current = lo;
            void startFromRef.current(lo);
          } else {
            playingRef.current = false;
            playOffsetRef.current = 0;
            setPlaying(false);
            setLocalTime(0);
          }
        } else {
          setLocalTime((prev) => (Math.abs(prev - t) > 0.12 ? t : prev));
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      active = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  async function startFrom(offset: number) {
    if (!buffer) {
      onStatus("Waveform still loading…");
      return;
    }
    const graph = ensureGraph();
    if (!graph) return;
    await graph.ctx.resume();
    stopSource();

    const start = Math.max(0, Math.min(buffer.duration - 0.01, offset));
    const rate = rateRef.current;
    const node = graph.ctx.createBufferSource();
    node.buffer = buffer;
    node.playbackRate.value = rate;
    node.connect(graph.gain);
    graph.gain.gain.value = clipLocalGain(
      start,
      dur,
      fadeInRef.current,
      fadeOutRef.current,
      gainRef.current,
    );
    sourceRef.current = node;
    playOffsetRef.current = start;
    playOriginRef.current = graph.ctx.currentTime;
    playingRef.current = true;
    setPlaying(true);
    node.start(0, start);
  }
  startFromRef.current = startFrom;

  function togglePlay() {
    if (playingRef.current) {
      const t = currentClipTime();
      stopSource();
      playingRef.current = false;
      playOffsetRef.current = t;
      setPlaying(false);
      setLocalTime(t);
      return;
    }
    let start = playOffsetRef.current;
    if (hasSel) {
      if (start < selLo || start >= selHi) start = selLo;
    } else if (start >= dur - 0.02) {
      start = 0;
    }
    void startFrom(start);
  }

  function xToTime(clientX: number) {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const r = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    return x * dur;
  }

  function onCanvasDown(e: React.PointerEvent) {
    e.preventDefault();
    const t0 = xToTime(e.clientX);
    dragSel.current = true;
    setSel({ a: t0, b: t0 });
    // Click seeks playhead when not dragging far
    playOffsetRef.current = t0;
    setLocalTime(t0);
    if (playingRef.current) void startFrom(t0);

    const onMove = (ev: PointerEvent) => {
      if (!dragSel.current) return;
      pendingSel.current = { a: t0, b: xToTime(ev.clientX) };
      if (selRaf.current) return;
      selRaf.current = requestAnimationFrame(() => {
        selRaf.current = 0;
        if (pendingSel.current) setSel(pendingSel.current);
      });
    };
    const onUp = () => {
      dragSel.current = false;
      if (pendingSel.current) setSel(pendingSel.current);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function scheduleFades(nextIn: number, nextOut: number) {
    if (!canEdit) {
      onStatus("Add this audio to the timeline to edit fades");
      return;
    }
    window.clearTimeout(fadeTimer.current);
    fadeTimer.current = window.setTimeout(() => {
      onSetFadesRef.current(Math.max(0, nextIn), Math.max(0, nextOut));
    }, WRITE_DEBOUNCE_MS);
  }

  function scheduleGain(next: number) {
    const g = Math.max(0, Math.min(2, next));
    setGain(g);
    if (!canEdit) {
      onStatus("Add this audio to the timeline to save volume");
      return;
    }
    window.clearTimeout(gainTimer.current);
    gainTimer.current = window.setTimeout(() => {
      onSetVolumeRef.current(g);
    }, WRITE_DEBOUNCE_MS);
  }

  function applyGainImmediate(next: number) {
    const g = Math.max(0, Math.min(2, next));
    setGain(g);
    window.clearTimeout(gainTimer.current);
    if (!canEdit) {
      onStatus("Add this audio to the timeline to save volume");
      return;
    }
    onSetVolume(g);
  }

  function toggleMute() {
    if (gain <= 0.001) {
      applyGainImmediate(prevGain > 0.001 ? prevGain : 1);
    } else {
      setPrevGain(gain);
      applyGainImmediate(0);
    }
  }

  function selectVoicePreset(id: VoicePreset) {
    voiceTouchedRef.current = true;
    setVoicePreset(id);
    if (id === "custom") {
      onStatus("Custom voice — drag the pitch slider, then Play to preview");
      return;
    }
    const st = VOICE_PRESETS.find((p) => p.id === id)?.semitones ?? 0;
    setSemitones(st);
    rateRef.current = pitchRatio(st);
    onStatus(
      `${id[0]!.toUpperCase()}${id.slice(1)} voice (${st > 0 ? "+" : ""}${st} st) — press Play to hear preview`,
    );
    if (playingRef.current) void startFromRef.current(currentClipTime());
  }

  async function applyNoiseRemove() {
    if (!canEdit) {
      onStatus("Add to timeline to apply noise remove");
      return;
    }
    await Promise.resolve(onApplyEffect("denoise"));
    setAppliedKinds((k) => (k.includes("denoise") ? k : [...k, "denoise"]));
    onStatus("Noise remove on this audio clip — Applied tab (heard on export)");
  }

  async function applyChangeVoice() {
    if (!canEdit) {
      onStatus("Add to timeline to change voice");
      return;
    }
    if (Math.abs(semitones) < 0.05) {
      onStatus("Pick Male / Female / Child, or move Custom pitch, then Apply");
      return;
    }
    const preset = voicePreset === "custom" ? presetFromSemitones(semitones) : voicePreset;
    await Promise.resolve(onApplyEffect("pitch", { semitones, preset }));
    setAppliedKinds((k) => (k.includes("pitch") ? k : [...k, "pitch"]));
    voiceAppliedRef.current = true;
    onStatus("Voice on this audio clip — hear it in Project Monitor (approx)");
  }

  async function handleDone() {
    const voiceDirty =
      voiceTouchedRef.current &&
      Math.abs(semitones - initialSemitonesRef.current) >= 0.05;
    const shouldApplyVoice =
      canEdit &&
      Math.abs(semitones) >= 0.05 &&
      (voiceDirty || (voiceTouchedRef.current && !voiceAppliedRef.current));

    if (canEdit) {
      window.clearTimeout(fadeTimer.current);
      fadeTimer.current = 0;
      window.clearTimeout(gainTimer.current);
      gainTimer.current = 0;
      onSetFades(Math.max(0, fadeIn), Math.max(0, fadeOut));
      onSetVolume(Math.max(0, Math.min(2, gain)));
      if (shouldApplyVoice) {
        const preset = voicePreset === "custom" ? presetFromSemitones(semitones) : voicePreset;
        await Promise.resolve(onApplyEffect("pitch", { semitones, preset }));
        setAppliedKinds((k) => (k.includes("pitch") ? k : [...k, "pitch"]));
        voiceAppliedRef.current = true;
        onStatus("Saved to audio clip — Voice plays in Project Monitor (approx); full quality on export");
      } else if (voiceTouchedRef.current && Math.abs(semitones) < 0.05 && hasPitch) {
        await Promise.resolve(onRemoveEffect?.("pitch"));
        setAppliedKinds((k) => k.filter((x) => x !== "pitch"));
        onStatus("Voice cleared from clip");
      } else {
        onStatus("Advanced Audio Tools closed — fades/volume saved");
      }
    }
    onClose();
  }

  async function resetDefaults() {
    setFadeIn(0);
    setFadeOut(0);
    setGain(1);
    setPrevGain(1);
    setSemitones(0);
    setVoicePreset("custom");
    rateRef.current = 1;
    if (playingRef.current) {
      stopSource();
      playingRef.current = false;
      setPlaying(false);
    }
    if (!canEdit) {
      onStatus("Preview reset — add to timeline to clear saved effects");
      return;
    }
    onSetFades(0, 0);
    onSetVolume(1);
    if (hasDenoise) await Promise.resolve(onRemoveEffect?.("denoise"));
    if (hasPitch) await Promise.resolve(onRemoveEffect?.("pitch"));
    setAppliedKinds((k) => k.filter((x) => x !== "denoise" && x !== "pitch"));
    onStatus("Reset to defaults — fades, volume, noise remove, and voice cleared");
  }

  return (
    <div className="aad-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="aad-modal"
        role="dialog"
        aria-label="Advanced Audio Tools"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="aad-head">
          <div>
            <strong>Advanced Audio Tools</strong>
            <p>
              {target.name} · {formatTime(dur)}
              {target.sourceMode ? " · source preview" : ""}
            </p>
          </div>
          <button type="button" className="aad-close" onClick={onClose} title="Close">
            ×
          </button>
        </header>

        <div className="aad-wave-wrap">
          {loading && <p className="aad-hint aad-loading">Loading waveform…</p>}
          <canvas
            ref={canvasRef}
            className="aad-canvas"
            onPointerDown={onCanvasDown}
            title="Click to seek · drag to select loop region"
          />
          <div ref={playheadRef} className="aad-playhead" aria-hidden />
        </div>

        <div className="aad-transport">
          <button type="button" onClick={togglePlay} disabled={!buffer}>
            {playing ? "Pause" : "Play"}
          </button>
          <span className="aad-tc">
            {formatTime(localTime)} / {formatTime(dur)}
          </span>
          {hasSel && (
            <span className="aad-sel">
              Loop {formatTime(selLo)}–{formatTime(selHi)}
            </span>
          )}
          <button type="button" className="ghost" onClick={() => setSel(null)} disabled={!sel}>
            Clear selection
          </button>
          {hasSel && canEdit && (
            <button
              type="button"
              className="primary"
              title="Remove the selected range from the clip (ripple)"
              onClick={() => {
                stopSource();
                playingRef.current = false;
                setPlaying(false);
                onCutSelection(selLo, selHi);
              }}
            >
              Cut selection
            </button>
          )}
        </div>

        <div className="aad-body">
          <div className="aad-voiceclean">
            <div className="aad-vc-head">
              <span className="aad-vc-title">Voice Clean &amp; Boost</span>
              <span className="aad-vc-sub">
                Remove noise · cut background · boost clarity · even out level
              </span>
            </div>
            <div className="aad-actions wrap">
              <button
                type="button"
                className="primary"
                disabled={!canEdit}
                onClick={() => void applyVoiceChain("clean")}
              >
                Clean &amp; Optimize Voice
              </button>
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => void applyVoiceChain("strong")}
              >
                Strong noise removal
              </button>
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => void applyVoiceChain("podcast")}
              >
                Podcast voice
              </button>
              <button
                type="button"
                className="ghost"
                disabled={!canEdit}
                onClick={() => void clearVoiceCleanup()}
              >
                Clear cleanup
              </button>
            </div>

            <div className="aad-vc-sliders">
              {hasFilter("denoise") && (
                <label className="aad-slider">
                  <span>
                    Noise removal <em>{filterParam("denoise", "nr", 20).toFixed(0)}</em>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={60}
                    step={1}
                    value={filterParam("denoise", "nr", 20)}
                    onChange={(e) =>
                      scheduleVoiceParam("denoise", {
                        nf: filterParam("denoise", "nf", -30),
                        nr: Number(e.target.value),
                      })
                    }
                  />
                </label>
              )}
              {hasFilter("gate") && (
                <label className="aad-slider">
                  <span>
                    Background cut (gate) <em>{filterParam("gate", "threshold", -40).toFixed(0)} dB</em>
                  </span>
                  <input
                    type="range"
                    min={-60}
                    max={-20}
                    step={1}
                    value={filterParam("gate", "threshold", -40)}
                    onChange={(e) =>
                      scheduleVoiceParam("gate", {
                        threshold: Number(e.target.value),
                        ratio: filterParam("gate", "ratio", 10),
                        attack: filterParam("gate", "attack", 10),
                        release: filterParam("gate", "release", 150),
                      })
                    }
                  />
                </label>
              )}
              {hasFilter("equalizer") && (
                <label className="aad-slider">
                  <span>
                    Voice clarity <em>+{filterParam("equalizer", "treble", 0).toFixed(1)} dB</em>
                  </span>
                  <input
                    type="range"
                    min={-6}
                    max={8}
                    step={0.5}
                    value={filterParam("equalizer", "treble", 0)}
                    onChange={(e) =>
                      scheduleVoiceParam("equalizer", {
                        bass: filterParam("equalizer", "bass", 0),
                        mid: filterParam("equalizer", "mid", 0),
                        treble: Number(e.target.value),
                      })
                    }
                  />
                </label>
              )}
              {hasFilter("compressor") && (
                <label className="aad-slider">
                  <span>
                    Even out level <em>ratio {filterParam("compressor", "ratio", 3).toFixed(1)}:1</em>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={8}
                    step={0.5}
                    value={filterParam("compressor", "ratio", 3)}
                    onChange={(e) =>
                      scheduleVoiceParam("compressor", {
                        threshold: filterParam("compressor", "threshold", -22),
                        ratio: Number(e.target.value),
                        attack: filterParam("compressor", "attack", 15),
                        release: filterParam("compressor", "release", 200),
                      })
                    }
                  />
                </label>
              )}
              {hasFilter("deesser") && (
                <label className="aad-slider">
                  <span>
                    De-esser (harsh S) <em>{filterParam("deesser", "amount", 0.5).toFixed(2)}</em>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={filterParam("deesser", "amount", 0.5)}
                    onChange={(e) => scheduleVoiceParam("deesser", { amount: Number(e.target.value) })}
                  />
                </label>
              )}
            </div>

            <div className="aad-vc-preview">
              <button
                type="button"
                className="primary"
                disabled={!canEdit || processingPreview}
                onClick={() => void hearProcessed()}
              >
                {processingPreview
                  ? "Rendering processed sound…"
                  : "▶ Hear processed result (export sound)"}
              </button>
              {processed && !processingPreview && (
                <span className="aad-hint">
                  Playing the exact sound the exported file will have.
                </span>
              )}
              <audio ref={processedAudioRef} src={processed?.url ?? undefined} preload="auto" />
            </div>
          </div>

          {(hasDenoise || hasPitch) && (
            <div className="aad-on-clip">
              <span className="aad-on-label">On this audio clip</span>
              {hasDenoise && <span className="aad-chip">Noise remove</span>}
              {hasPitch && <span className="aad-chip">Voice</span>}
            </div>
          )}
          {hasDenoise && (
            <p className="aad-confirm">
              Noise remove is on this audio clip. Timeline Play stays dry — heard on export. Check
              Applied for Noise floor / Reduction.
            </p>
          )}
          <label className="aad-slider">
            <span>
              Fade in <em>{fadeIn.toFixed(2)}s</em>
            </span>
            <input
              type="range"
              min={0}
              max={Math.min(10, dur / 2)}
              step={0.01}
              value={fadeIn}
              disabled={!canEdit}
              onChange={(e) => {
                const v = Number(e.target.value);
                setFadeIn(v);
                scheduleFades(v, fadeOut);
              }}
            />
          </label>
          <label className="aad-slider">
            <span>
              Fade out <em>{fadeOut.toFixed(2)}s</em>
            </span>
            <input
              type="range"
              min={0}
              max={Math.min(10, dur / 2)}
              step={0.01}
              value={fadeOut}
              disabled={!canEdit}
              onChange={(e) => {
                const v = Number(e.target.value);
                setFadeOut(v);
                scheduleFades(fadeIn, v);
              }}
            />
          </label>
          <label className="aad-slider">
            <span>
              Volume boost <em>{(gain * 100).toFixed(0)}%</em>
            </span>
            <input
              type="range"
              min={0}
              max={200}
              step={1}
              value={Math.round(gain * 100)}
              disabled={!canEdit}
              onChange={(e) => scheduleGain(Number(e.target.value) / 100)}
            />
          </label>

          <div className="aad-actions">
            <button type="button" disabled={!canEdit} onClick={toggleMute}>
              {gain <= 0.001 ? "Unmute" : "Mute"}
            </button>
            <button
              type="button"
              className={hasDenoise ? "primary" : ""}
              disabled={!canEdit}
              onClick={() => void applyNoiseRemove()}
              title={
                hasDenoise
                  ? "Noise remove is on — opens Applied to tweak (export only)"
                  : "Add Noise remove to this clip"
              }
            >
              {hasDenoise ? "Noise remove · On" : "Noise remove"}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!canEdit && fadeIn === 0 && fadeOut === 0 && gain === 1 && !hasDenoise && !hasPitch}
              onClick={() => void resetDefaults()}
            >
              Reset defaults
            </button>
          </div>

          <div className="aad-actions wrap">
            {VOICE_PRESETS.filter((p) => p.id !== "custom").map((p) => (
              <button
                key={p.id}
                type="button"
                className={voicePreset === p.id ? "primary" : ""}
                onClick={() => selectVoicePreset(p.id)}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              className={voicePreset === "custom" ? "primary" : ""}
              onClick={() => selectVoicePreset("custom")}
            >
              Custom
            </button>
          </div>
          <label className="aad-slider">
            <span>
              Voice pitch <em>{semitones > 0 ? "+" : ""}
              {semitones.toFixed(1)} st</em>
              {Math.abs(semitones) > 0.05 ? " · Play to preview" : ""}
            </span>
            <input
              type="range"
              min={-8}
              max={8}
              step={0.5}
              value={semitones}
              onChange={(e) => {
                const v = Number(e.target.value);
                voiceTouchedRef.current = true;
                setSemitones(v);
                setVoicePreset(presetFromSemitones(v));
                if (playingRef.current) void startFromRef.current(currentClipTime());
              }}
            />
          </label>
          <div className="aad-actions">
            <button
              type="button"
              disabled={!canEdit || Math.abs(semitones) < 0.05}
              onClick={() => void applyChangeVoice()}
            >
              Apply voice to clip
            </button>
          </div>

          <p className="aad-hint">
            Play previews fade, volume, and voice here. <strong>Done</strong> saves fades, volume,
            and the current voice to the audio clip. Project Monitor plays an approximate voice
            preview; Noise remove is export-only.
          </p>
          {target.sourceMode && (
            <p className="aad-hint">
              Source preview only — add the clip to the timeline to save edits.
            </p>
          )}
        </div>

        <footer className="aad-foot">
          <button type="button" className="primary" onClick={() => void handleDone()}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
