import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus = {
  kind: "idle" | "checking" | "available" | "none" | "error" | "installing";
  message: string;
  version?: string;
};

/** Silent or interactive update check against GitHub Releases latest.json. */
export async function checkForAppUpdate(opts: {
  interactive: boolean;
  onStatus: (s: UpdateStatus) => void;
}): Promise<void> {
  const { interactive, onStatus } = opts;
  onStatus({ kind: "checking", message: "Checking for updates…" });
  try {
    const update = await check();
    if (!update) {
      onStatus({
        kind: "none",
        message: interactive ? "You're up to date" : "Up to date",
      });
      return;
    }
    onStatus({
      kind: "available",
      message: `Update ${update.version} available`,
      version: update.version,
    });
    if (!interactive) return;

    const ok = window.confirm(
      `Project YX ${update.version} is available.\n\nDownload and install now? The app will restart.`,
    );
    if (!ok) return;

    onStatus({
      kind: "installing",
      message: `Downloading ${update.version}…`,
      version: update.version,
    });
    await update.downloadAndInstall();
    onStatus({ kind: "installing", message: "Restarting…" });
    await relaunch();
  } catch (e) {
    const msg = String(e);
    // Dev builds / missing release assets are expected until first publish.
    onStatus({
      kind: "error",
      message: interactive
        ? `Update check failed: ${msg}`
        : "No update feed yet",
    });
  }
}
