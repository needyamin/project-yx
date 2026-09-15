import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./VoiceoverButton.css";

type Props = {
  /** Called with the saved recording's file path so it can be placed on the timeline. */
  onSaved: (path: string) => void;
  onStatus: (message: string) => void;
  /** Notifies the timeline so it can show the live recording region. */
  onRecordingChange?: (recording: boolean) => void;
};

/**
 * One-click voiceover: records from the default microphone, saves the take
 * next to the app cache, then hands the file path to the timeline.
 */
export function VoiceoverButton({ onSaved, onStatus, onRecordingChange }: Props) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef(0);
  const cancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      window.clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function start() {
    setError(null);
    cancelledRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => void finish();
      recorderRef.current = recorder;
      recorder.start(250);
      setSeconds(0);
      timerRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
      setRecording(true);
      onRecordingChange?.(true);
    } catch (e) {
      setError("Microphone unavailable — check browser/OS permission.");
      onRecordingChange?.(false);
      onStatus(String(e));
    }
  }

  function stop(cancel: boolean) {
    cancelledRef.current = cancel;
    window.clearInterval(timerRef.current);
    setRecording(false);
    onRecordingChange?.(false);
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function finish() {
    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    chunksRef.current = [];
    if (cancelledRef.current || blob.size === 0) {
      onStatus(cancelledRef.current ? "Voiceover discarded" : "Voiceover was empty");
      return;
    }
    try {
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      const path = await invoke<string>("save_voiceover", { bytes, ext: "webm" });
      onSaved(path);
    } catch (e) {
      setError(String(e));
      onStatus(String(e));
    }
  }

  if (recording) {
    return (
      <div className="vo-recording" role="status">
        <span className="vo-dot" aria-hidden />
        <span className="vo-timer">
          REC {String(Math.floor(seconds / 60)).padStart(2, "0")}:
          {String(seconds % 60).padStart(2, "0")}
        </span>
        <button type="button" className="vo-btn stop" title="Stop and add to timeline" onClick={() => stop(false)}>
          ■
        </button>
        <button type="button" className="vo-btn cancel" title="Discard recording" onClick={() => stop(true)}>
          ×
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="vo-btn start"
      title="Record voiceover from microphone (added at playhead)"
      onClick={() => void start()}
    >
      🎙 Voiceover
      {error && <span className="vo-error" title={error}>!</span>}
    </button>
  );
}
