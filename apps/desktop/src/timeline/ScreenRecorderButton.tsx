import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./ScreenRecorderButton.css";

type Props = {
  /** Called with the saved recording file path — placed on the timeline. */
  onSaved: (path: string) => void;
  onStatus: (message: string) => void;
};

const MAX_SECONDS = 2 * 60 * 60; // 2h safety cap

type Prefs = { mic: boolean; camera: boolean };
const PREFS_KEY = "yx-screen-rec-prefs";

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { mic: true, camera: false, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { mic: true, camera: false };
}

/**
 * Smart screen recorder for tutorials:
 * - Options panel before start: microphone on/off, camera bubble
 * - OS-native picker (screen / window / tab)
 * - System audio + microphone mixed into one track (Web Audio graph)
 * - Mic can be toggled (or added) LIVE while recording
 * - Auto-save when the user presses the browser "Stop sharing" bar
 * - Lands on the timeline as a normal video+audio clip
 */
export function ScreenRecorderButton({ onSaved, onStatus }: Props) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Mic is currently audible in the recording. */
  const [micLive, setMicLive] = useState(false);
  /** System audio (PC playback) is being recorded - from the picker checkbox. */
  const [systemAudio, setSystemAudio] = useState(false);
  /** A mic stream exists (muting ≠ removed). */
  const micStreamRef = useRef<MediaStream | null>(null);
  const micGainRef = useRef<GainNode | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamsRef = useRef<MediaStream[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const drawTimerRef = useRef(0);
  const timerRef = useRef(0);
  const cancelledRef = useRef(false);

  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }, [prefs]);

  useEffect(() => {
    return () => {
      window.clearInterval(timerRef.current);
      window.clearInterval(drawTimerRef.current);
      streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      void audioCtxRef.current?.close().catch(() => undefined);
    };
  }, []);

  function cleanupStreams() {
    window.clearInterval(timerRef.current);
    window.clearInterval(drawTimerRef.current);
    streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streamsRef.current = [];
    micStreamRef.current = null;
    micGainRef.current = null;
    destRef.current = null;
    if (canvasRef.current) {
      canvasRef.current.remove();
      canvasRef.current = null;
    }
    if (previewHostRef.current) previewHostRef.current.innerHTML = "";
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    window.setTimeout(() => void ctx?.close().catch(() => undefined), 300);
  }

  /** Connect a microphone into the live recording graph (start or mid-take). */
  async function attachMic(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      micStreamRef.current = stream;
      streamsRef.current.push(stream);
      if (!audioCtxRef.current || !destRef.current) {
        // This take has no audio graph (mixing failed at start) - a track
        // cannot join a running MediaRecorder after the fact.
        onStatus("Audio mixing unavailable for this take - mic cannot join");
        return false;
      }
      const src = audioCtxRef.current.createMediaStreamSource(stream);
      const gain = audioCtxRef.current.createGain();
      gain.gain.value = 1.35;
      src.connect(gain).connect(destRef.current);
      micGainRef.current = gain;
      setMicLive(true);
      return true;
    } catch {
      onStatus("Microphone unavailable");
      return false;
    }
  }

  function toggleMicLive() {
    if (micGainRef.current) {
      // Mute / unmute the live mic.
      const nowOn = micGainRef.current.gain.value <= 0.01;
      micGainRef.current.gain.value = nowOn ? 1.35 : 0;
      setMicLive(nowOn);
      onStatus(nowOn ? "Microphone live" : "Microphone muted");
    } else {
      // Mic wasn't part of the recording — attach it from this moment.
      void attachMic().then((ok) => {
        if (ok) onStatus("Microphone added to the recording");
      });
    }
  }

  async function start() {
    setError(null);
    cancelledRef.current = false;
    let screen: MediaStream;
    try {
      screen = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: 30,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as MediaTrackConstraints,
      });
    } catch (e) {
      if (String(e).includes("Permission denied") || String(e).includes("NotAllowed")) {
        onStatus("Screen capture was cancelled or blocked");
      } else {
        onStatus(`Screen capture failed: ${String(e)}`);
        setError("Screen capture unavailable in this environment");
      }
      return;
    }
    streamsRef.current.push(screen);

    let mic: MediaStream | null = null;
    if (prefs.mic) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        micStreamRef.current = mic;
        streamsRef.current.push(mic);
      } catch {
        onStatus("Microphone unavailable — toggle the mic during recording to retry");
      }
    }

    let camera: MediaStream | null = null;
    if (prefs.camera) {
      try {
        camera = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 480 }, height: { ideal: 270 } },
        });
        streamsRef.current.push(camera);
      } catch {
        onStatus("Camera unavailable — recording without camera bubble");
      }
    }

    // --- Compositing: direct screen track, or canvas when camera bubble is on
    const screenTrack = screen.getVideoTracks()[0];
    let videoTrack: MediaStreamTrack;
    let canvas: HTMLCanvasElement | null = null;
    let camVideo: HTMLVideoElement | null = null;
    let screenVideo: HTMLVideoElement | null = null;

    if (camera) {
      // Canvas compositing: screen full-frame + camera bubble bottom-right.
      // The app window must stay visible for the compositor to tick, so pin
      // it above other windows for the duration of the recording.
      try {
        await getCurrentWindow().setAlwaysOnTop(true);
      } catch {
        /* ignore */
      }
      screenVideo = document.createElement("video");
      screenVideo.srcObject = new MediaStream([screenTrack]);
      screenVideo.muted = true;
      camVideo = document.createElement("video");
      camVideo.srcObject = new MediaStream([camera.getVideoTracks()[0]]);
      camVideo.muted = true;
      await Promise.all([
        screenVideo.play().catch(() => undefined),
        camVideo.play().catch(() => undefined),
      ]);
      const w = screenVideo.videoWidth || 1920;
      const h = screenVideo.videoHeight || 1080;
      canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvasRef.current = canvas;
      const ctx = canvas.getContext("2d");
      const bubbleW = Math.round(w * 0.18);
      const bubbleH = Math.round(
        bubbleW * (camVideo.videoHeight ? camVideo.videoHeight / camVideo.videoWidth : 0.5625),
      );
      const margin = Math.round(w * 0.02);
      const drawFrame = () => {
        if (!ctx || !screenVideo) return;
        ctx.drawImage(screenVideo, 0, 0, w, h);
        if (camVideo && camVideo.videoWidth > 0) {
          const bx = w - bubbleW - margin;
          const by = h - bubbleH - margin;
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(bx, by, bubbleW, bubbleH, 12);
          ctx.clip();
          ctx.drawImage(camVideo, bx, by, bubbleW, bubbleH);
          ctx.restore();
          ctx.strokeStyle = "rgba(255,255,255,0.9)";
          ctx.lineWidth = Math.max(2, w / 640);
          ctx.strokeRect(bx, by, bubbleW, bubbleH);
        }
      };
      drawFrame();
      drawTimerRef.current = window.setInterval(drawFrame, 33);
      if (previewHostRef.current) {
        canvas.style.width = "100%";
        canvas.style.display = "block";
        previewHostRef.current.appendChild(canvas);
      }
      videoTrack = canvas.captureStream(30).getVideoTracks()[0];
    } else {
      // Direct screen track — records perfectly even when the app is hidden.
      videoTrack = screenTrack;
    }

    // --- Audio: mix system audio + mic into ONE track via Web Audio
    // NOTE: the native picker's "share system audio" checkbox captures PC
    // playback sound - it is NOT the microphone (that is getUserMedia).
    const mixed = new MediaStream([videoTrack]);
    const displayAudio = screen.getAudioTracks()[0] ?? null;
    setSystemAudio(!!displayAudio);
    // ALWAYS create the audio graph, even when silent: MediaRecorder cannot
    // add audio tracks after start, and this reserved track is what lets the
    // Mic button attach the microphone mid-recording.
    {
      // Reserved audio track: see note above — lets the Mic button join live.
      try {
        const actx = new AudioContext();
        audioCtxRef.current = actx;
        // The async picker breaks the user-gesture chain, so the context can
        // be born SUSPENDED -> everything recorded would be silent. Resume it.
        await actx.resume().catch(() => undefined);
        const dest = actx.createMediaStreamDestination();
        destRef.current = dest;
        if (displayAudio) {
          actx
            .createMediaStreamSource(new MediaStream([displayAudio]))
            .connect(dest);
        }
        if (mic) {
          const micSrc = actx.createMediaStreamSource(mic);
          const micGain = actx.createGain();
          micGain.gain.value = 1.35;
          micSrc.connect(micGain).connect(dest);
          micGainRef.current = micGain;
        }
        const aTrack = dest.stream.getAudioTracks()[0];
        if (aTrack) mixed.addTrack(aTrack);
      } catch {
        onStatus("Audio mixing failed — recording without sound");
      }
    }

    // --- Record
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
        ? "video/webm;codecs=vp8,opus"
        : "video/webm";
    const recorder = new MediaRecorder(mixed, {
      mimeType: mime,
      videoBitsPerSecond: 8_000_000,
    });
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => void finish();
    screenTrack.addEventListener("ended", () => stop(false), { once: true });
    recorderRef.current = recorder;
    recorder.start(1000);
    setSeconds(0);
    setMicLive(!!mic);
    timerRef.current = window.setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_SECONDS) {
          window.setTimeout(() => stop(false), 0);
          return s;
        }
        return s + 1;
      });
    }, 1000);
    setRecording(true);
    onStatus(
      `Screen recording started — mic ${mic || micStreamRef.current ? "on" : "off"} (toggle live in the toolbar)`,
    );
  }

  function stop(cancel: boolean) {
    cancelledRef.current = cancel;
    setRecording(false);
    setSaving(!cancel);
    window.clearInterval(timerRef.current);
    window.clearInterval(drawTimerRef.current);
    recorderRef.current?.stop();
    streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    void getCurrentWindow().setAlwaysOnTop(false).catch(() => undefined);
  }

  async function finish() {
    cleanupStreams();
    setMicLive(false);
    setSystemAudio(false);
    const blob = new Blob(chunksRef.current, { type: "video/webm" });
    chunksRef.current = [];
    recorderRef.current = null;
    if (cancelledRef.current || blob.size === 0) {
      setSaving(false);
      onStatus(cancelledRef.current ? "Screen recording discarded" : "Screen recording was empty");
      return;
    }
    try {
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      const path = await invoke<string>("save_screen_recording", {
        bytes,
        ext: "webm",
      });
      onSaved(path);
    } catch (e) {
      onStatus(String(e));
    } finally {
      setSaving(false);
    }
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  if (saving) {
    return (
      <button type="button" className="vo-btn" disabled title={error ?? undefined}>
        Saving recording…
      </button>
    );
  }

  if (recording) {
    return (
      <div className="sr-recording" role="status">
        <span className="vo-dot" aria-hidden />
        <span className="vo-timer sr-timer">
          REC {mm}:{ss}
        </span>
        {systemAudio && (
          <span
            className="sr-audio-badge"
            title="Recording PC/system audio (the 'Share system audio' checkbox in the picker = PC sound, not the microphone)"
          >
            PC audio
          </span>
        )}
        <button
          type="button"
          className={`sr-mic-btn ${micLive ? "on" : "off"}`}
          title={
            micLive
              ? "Microphone is live - click to mute"
              : "Microphone off - click to add your voice from this moment"
          }
          onClick={toggleMicLive}
        >
          {micLive ? "🎙 Mic on" : "🎙 Mic off"}
        </button>
        {prefs.camera && <div ref={previewHostRef} className="sr-preview" />}
        <button type="button" className="vo-btn stop" title="Stop and add to timeline" onClick={() => stop(false)}>
          ■
        </button>
        <button type="button" className="vo-btn cancel" title="Discard recording" onClick={() => stop(true)}>
          ×
        </button>
      </div>
    );
  }

  function toggleCameraPref() {
    setPrefs((p) => {
      const next = { ...p, camera: !p.camera };
      onStatus(next.camera ? "Camera bubble on for next recording" : "Camera bubble off");
      return next;
    });
  }

  return (
    <div className="sr-wrap">
      <button
        type="button"
        className="vo-btn"
        title={
          "Record the screen - the system picker opens. Its 'Share system audio' checkbox is PC sound (not the mic); the Mic button toggles your voice live. Right-click for camera bubble."
        }
        onClick={() => void start()}
        onContextMenu={(e) => {
          e.preventDefault();
          toggleCameraPref();
        }}
      >
        ◉ Screen
      </button>
    </div>
  );
}
