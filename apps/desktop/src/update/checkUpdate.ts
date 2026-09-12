import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdateStatus = {
  kind: "idle" | "checking" | "available" | "none" | "error" | "installing";
  message: string;
  version?: string;
};

export type UpdateCheckResult =
  | { kind: "available"; update: Update; message: string }
  | { kind: "none"; message: string }
  | { kind: "error"; message: string };

/** Tauri throws this when every endpoint returns non-success / invalid JSON (e.g. GitHub 404). */
function isMissingFeedError(raw: string): boolean {
  const msg = raw.toLowerCase();
  return (
    msg.includes("could not fetch a valid release") ||
    msg.includes("release json") ||
    msg.includes("release not found") ||
    msg.includes("404") ||
    msg.includes("not found") ||
    msg.includes("status code") ||
    (msg.includes("latest.json") && !msg.includes("signature"))
  );
}

function isNetworkError(raw: string): boolean {
  const msg = raw.toLowerCase();
  // Do not treat ReleaseNotFound ("Could not fetch a valid release JSON…") as offline.
  if (isMissingFeedError(raw)) return false;
  return (
    msg.includes("error sending request") ||
    msg.includes("dns") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("connection refused") ||
    msg.includes("connection reset") ||
    msg.includes("network") ||
    msg.includes("name resolution") ||
    msg.includes("failed to lookup")
  );
}

export function friendlyUpdateError(raw: string, interactive: boolean): string {
  if (isMissingFeedError(raw)) {
    return interactive
      ? "No update feed published yet (missing latest.json on GitHub Releases)."
      : "";
  }
  if (isNetworkError(raw)) {
    return interactive
      ? "Could not reach the update server. Check your network and try again."
      : "";
  }
  if (
    raw.toLowerCase().includes("signature") ||
    raw.toLowerCase().includes("public key") ||
    raw.toLowerCase().includes("minisign")
  ) {
    return interactive
      ? "Update signature check failed. The release may be unsigned or the app pubkey does not match."
      : "";
  }
  return interactive ? `Update check failed: ${raw}` : "";
}

/**
 * Run an update check. Missing GitHub feed (404) is treated as up-to-date —
 * there is simply no newer published release yet.
 */
export async function runUpdateCheck(): Promise<UpdateCheckResult> {
  try {
    const update = await check();
    if (!update) {
      return { kind: "none", message: "You're up to date." };
    }
    return {
      kind: "available",
      update,
      message: `Version ${update.version} is available.`,
    };
  } catch (e) {
    const raw = String(e);
    if (isMissingFeedError(raw)) {
      return {
        kind: "none",
        message: "You're up to date. No newer release is published on GitHub yet.",
      };
    }
    const message = friendlyUpdateError(raw, true);
    return { kind: "error", message: message || `Update check failed: ${raw}` };
  }
}

/** Silent or interactive update check against GitHub Releases latest.json. */
export async function checkForAppUpdate(opts: {
  interactive: boolean;
  onStatus: (s: UpdateStatus) => void;
}): Promise<void> {
  const { interactive, onStatus } = opts;
  onStatus({ kind: "checking", message: "Checking for updates…" });
  const result = await runUpdateCheck();
  if (result.kind === "available") {
    onStatus({
      kind: "available",
      message: interactive
        ? result.message
        : `Update ${result.update.version} available`,
      version: result.update.version,
    });
    return;
  }
  if (result.kind === "none") {
    onStatus({
      kind: "none",
      message: interactive ? result.message : "Up to date",
    });
    return;
  }
  if (!interactive) {
    onStatus({ kind: "idle", message: "" });
    return;
  }
  onStatus({ kind: "error", message: result.message });
}
