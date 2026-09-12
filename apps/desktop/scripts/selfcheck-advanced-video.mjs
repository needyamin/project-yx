/**
 * Self-check: Advanced Video wiring + reverse/speed export.
 * Run: node apps/desktop/scripts/selfcheck-advanced-video.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "../..");
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error(`FAIL  ${msg}`);
  } else {
    console.log(`PASS  ${msg}`);
  }
}

const dialog = readFileSync(join(root, "src/video/AdvancedVideoDialog.tsx"), "utf8");
assert(dialog.includes("export function AdvancedVideoDialog"), "AdvancedVideoDialog exported");
assert(dialog.includes("Reverse"), "Reverse control present");
assert(dialog.includes("SPEED_PRESETS"), "Speed presets present");
assert(dialog.includes("onSetSpeed"), "Speed callback wired");
assert(dialog.includes("handleDone"), "Done commits");
assert(dialog.includes("previewVideoStyle"), "live CSS preview");
assert(dialog.includes("requestAnimationFrame"), "rAF playback (supports reverse)");
assert(dialog.includes("playbackRate"), "native forward playbackRate");
assert(dialog.includes("commitLocalUi"), "throttled local time UI");

const app = readFileSync(join(root, "src/App.tsx"), "utf8");
assert(app.includes("openAdvancedVideoForClip"), "App opens Advanced Video");
assert(app.includes("set_clip_reverse"), "App invokes set_clip_reverse");
assert(app.includes("set_clip_speed"), "App invokes set_clip_speed");
assert(app.includes("AdvancedVideoDialog"), "App mounts AdvancedVideoDialog");
assert(app.includes("onAdvancedVideo"), "timeline prop wired");
assert(app.includes("reverseRafRef"), "reverse rAF cancel ref");
assert(app.includes("playingRef.current"), "playingRef gate for reverse stop");
assert(app.includes("onSetSpeed"), "App passes onSetSpeed");

const menu = readFileSync(join(root, "src/timeline/TimelineContextMenu.tsx"), "utf8");
assert(menu.includes("Advanced Video…"), "context menu has Advanced Video");

const types = readFileSync(join(root, "src/timeline/types.ts"), "utf8");
assert(types.includes("reverse?: boolean"), "Clip.reverse in TS types");
assert(types.includes("speed?: number"), "Clip.speed in TS types");
assert(types.includes("clipTimelineDuration"), "clipTimelineDuration helper");

const timelineRs = readFileSync(join(repo, "crates/yx-timeline/src/lib.rs"), "utf8");
assert(timelineRs.includes("pub reverse: bool"), "Clip.reverse in yx-timeline");
assert(timelineRs.includes("pub speed: f64"), "Clip.speed in yx-timeline");
assert(timelineRs.includes("SetClipReverse"), "SetClipReverse command");
assert(timelineRs.includes("SetClipSpeed"), "SetClipSpeed command");
assert(timelineRs.includes("media / self.clamped_speed()"), "duration retimes by speed");

const mediaRs = readFileSync(join(repo, "crates/yx-media/src/lib.rs"), "utf8");
assert(mediaRs.includes("pub reverse: bool"), "ExportSegment.reverse");
assert(mediaRs.includes("pub speed: f64"), "ExportSegment.speed");
assert(mediaRs.includes('parts.push("reverse"'), "FFmpeg reverse in video chain");
assert(mediaRs.includes("setpts=PTS/"), "FFmpeg setpts for speed");
assert(mediaRs.includes("video_effect_chain_includes_reverse"), "reverse unit test");
assert(mediaRs.includes("video_effect_chain_includes_setpts_for_speed"), "speed unit test");
assert(mediaRs.includes("video_effect_chain_speed_then_reverse"), "setpts before reverse test");

const tauri = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");
assert(tauri.includes("fn set_clip_reverse"), "Tauri set_clip_reverse command");
assert(tauri.includes("set_clip_reverse,"), "Tauri reverse handler registered");
assert(tauri.includes("fn set_clip_speed"), "Tauri set_clip_speed command");
assert(tauri.includes("set_clip_speed,"), "Tauri speed handler registered");

console.log("");
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("All Advanced Video self-checks passed");
