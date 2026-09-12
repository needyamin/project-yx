/**
 * Self-check: monitor pitch preview + Done/voice wiring (no GUI).
 * Run: node apps/desktop/scripts/selfcheck-audio-preview.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error(`FAIL  ${msg}`);
  } else {
    console.log(`PASS  ${msg}`);
  }
}

function n(params, key, d) {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/** Mirror of effects.ts previewPitchRate */
function previewPitchRate(filters) {
  for (const f of filters) {
    if (!f.enabled || f.kind !== "pitch") continue;
    const st = n(f.params ?? {}, "semitones", 0);
    if (Math.abs(st) < 0.05) return 1;
    return Math.pow(2, Math.max(-12, Math.min(12, st)) / 12);
  }
  return 1;
}

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

// —— Unit: pitch rate math (Male -4 / Female +4 / Child +7) ——
assert(previewPitchRate([]) === 1, "empty filters → rate 1");
assert(
  previewPitchRate([{ kind: "pitch", enabled: false, params: { semitones: 4 } }]) === 1,
  "disabled pitch → rate 1",
);
assert(
  approx(previewPitchRate([{ kind: "pitch", enabled: true, params: { semitones: -4 } }]), Math.pow(2, -4 / 12)),
  "Male −4 st ≈ 0.7937",
);
assert(
  approx(previewPitchRate([{ kind: "pitch", enabled: true, params: { semitones: 4 } }]), Math.pow(2, 4 / 12)),
  "Female +4 st ≈ 1.2599",
);
assert(
  approx(previewPitchRate([{ kind: "pitch", enabled: true, params: { semitones: 7 } }]), Math.pow(2, 7 / 12)),
  "Child +7 st ≈ 1.4983",
);
assert(
  previewPitchRate([{ kind: "pitch", enabled: true, params: { semitones: 0 } }]) === 1,
  "near-zero semitones → rate 1",
);

const clamped = Math.max(
  0.5,
  Math.min(2, previewPitchRate([{ kind: "pitch", enabled: true, params: { semitones: 12 } }])),
);
assert(approx(clamped, 2), "monitor clamp keeps +12st within 0.5–2");

// —— Wiring: source must apply rate on monitor audio ——
const appSrc = readFileSync(join(root, "src/App.tsx"), "utf8");
assert(appSrc.includes("previewPitchRate"), "App imports/uses previewPitchRate");
assert(appSrc.includes("audio.playbackRate"), "App sets audio.playbackRate for monitor");
assert(
  appSrc.includes("Skip hard resync when pitch") || appSrc.includes("pitchRate"),
  "App skips hard A/V resync when pitched",
);

// —— Lag fix: throttle + stable under-playhead + pitch once ——
assert(appSrc.includes("stableUnderPlayhead"), "stable under-playhead helper present");
assert(appSrc.includes("commitPlayhead"), "throttled commitPlayhead present");
assert(appSrc.includes("PLAYHEAD_UI_MS"), "playhead UI throttle constant present");
assert(appSrc.includes("monitorPitchKey"), "pitch applied via clip/params key effect");
assert(appSrc.includes("lastVideoStyle"), "cached video style DOM writes");
assert(appSrc.includes("lastAudioVolume"), "cached audio volume DOM writes");

// Pitch must not be written inside applyPreviewFades body (only volume/styles there).
const fadesFn = appSrc.match(/function applyPreviewFades\([\s\S]*?\n  \}/);
assert(!!fadesFn, "applyPreviewFades function found");
assert(
  fadesFn && !fadesFn[0].includes("playbackRate"),
  "applyPreviewFades does not set playbackRate (pitch is one-shot)",
);

const effectsSrc = readFileSync(join(root, "src/effects/effects.ts"), "utf8");
assert(effectsSrc.includes("export function previewPitchRate"), "effects.ts exports previewPitchRate");

const dialogSrc = readFileSync(join(root, "src/audio/AdvancedAudioDialog.tsx"), "utf8");
assert(dialogSrc.includes("async function handleDone"), "Done handler exists");
assert(
  dialogSrc.includes("shouldApplyVoice") && dialogSrc.includes('onApplyEffect("pitch"'),
  "Done commits pitch when voice dirty",
);
assert(dialogSrc.includes("onSetFades") && dialogSrc.includes("onSetVolume"), "Done flushes fades/volume");

const inspectorSrc = readFileSync(join(root, "src/effects/EffectInspector.tsx"), "utf8");
assert(
  !inspectorSrc.match(/EXPORT_ONLY = new Set\(\[[^\]]*"[^"]*pitch"/s),
  "pitch not marked export-only (monitor preview enabled)",
);
assert(inspectorSrc.includes("Reset to default"), "Reset to default control present");

console.log("");
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("All self-checks passed");
