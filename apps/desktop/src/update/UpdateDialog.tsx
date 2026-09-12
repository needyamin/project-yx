import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { friendlyUpdateError, runUpdateCheck } from "./checkUpdate";
import "./UpdateDialog.css";

type Phase = "checking" | "none" | "available" | "installing" | "error";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function UpdateDialog({ open, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [currentVersion, setCurrentVersion] = useState("…");
  const [message, setMessage] = useState("Checking for updates…");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase("checking");
    setMessage("Checking for updates…");
    setUpdate(null);
    setProgress(null);

    void (async () => {
      const ver = await getVersion().catch(() => "0.1.0");
      if (!cancelled) setCurrentVersion(ver);

      const result = await runUpdateCheck();
      if (cancelled) return;

      if (result.kind === "available") {
        setUpdate(result.update);
        setPhase("available");
        setMessage(result.message);
        return;
      }
      if (result.kind === "none") {
        setPhase("none");
        setMessage(
          result.message.includes("No newer")
            ? `You're up to date (v${ver}). No newer release is published on GitHub yet.`
            : `You're up to date (v${ver}).`,
        );
        return;
      }
      setPhase("error");
      setMessage(result.message);
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const busy = phase === "checking" || phase === "installing";

  async function install() {
    if (!update) return;
    setPhase("installing");
    setProgress("Downloading…");
    let downloaded = 0;
    let total: number | undefined;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength;
          downloaded = 0;
          setProgress("Downloading…");
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total && total > 0) {
            const pct = Math.min(100, Math.round((downloaded / total) * 100));
            setProgress(`Downloading… ${pct}%`);
          } else {
            setProgress(`Downloading… ${Math.round(downloaded / 1024)} KB`);
          }
        } else if (event.event === "Finished") {
          setProgress("Installing…");
        }
      });
      setProgress("Restarting…");
      await relaunch();
    } catch (e) {
      setPhase("error");
      setMessage(friendlyUpdateError(String(e), true));
      setProgress(null);
    }
  }

  return (
    <div
      className="update-modal-backdrop"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="update-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="update-modal-head">
          <div>
            <h2 id="update-modal-title">Updates</h2>
            <p>Installed version {currentVersion}</p>
          </div>
          <button
            type="button"
            className="update-close"
            disabled={busy}
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="update-modal-body">
          {phase === "checking" && <div className="update-spinner" aria-hidden />}
          <p className="update-title">
            {phase === "checking" && "Checking for updates…"}
            {phase === "none" && "You're up to date"}
            {phase === "available" && "Update available"}
            {phase === "installing" && "Installing update"}
            {phase === "error" && "Update check failed"}
          </p>
          <p className={`update-detail${phase === "error" ? " error" : ""}`}>
            {phase === "installing" ? progress ?? message : message}
            {phase === "available" && update?.body
              ? `\n\n${update.body.trim()}`
              : phase === "available"
                ? "\n\nDownload and install now? The app will restart."
                : null}
          </p>
        </div>

        <footer className="update-modal-foot">
          {phase === "available" ? (
            <>
              <button type="button" className="ghost-btn" onClick={onClose}>
                Later
              </button>
              <button type="button" className="primary-btn" onClick={() => void install()}>
                Install & Restart
              </button>
            </>
          ) : (
            <button type="button" className="ghost-btn" disabled={busy} onClick={onClose}>
              {phase === "installing" ? "Please wait…" : "Close"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
