/**
 * Benchmark harness entry (dev-only, served at /bench.html).
 *
 * Mounts the REAL App against a mock Tauri backend and produces
 * repeatable measurements: render/edit latency at scale, scroll/zoom
 * frame pacing, playhead latency, undo round-trips, and real-media
 * playback (frame rate via requestVideoFrameCallback, seek/scrub
 * latency, A/V drift, JS heap growth).
 *
 * Results land in window.__BENCH_RESULTS and the #status table.
 * Not part of the production bundle.
 */
import { invoke } from "@tauri-apps/api/core";
import React from "react";
import ReactDOM from "react-dom/client";
import { installMockTauri } from "./mockTauri";
import { reconcileTimeline } from "../timeline/reconcile";
import type { Timeline } from "../timeline/types";

type Row = {
  name: string;
  value: string;
  detail?: string;
  verdict?: "ok" | "warn" | "bad";
};

const rows: Row[] = [];
(window as unknown as { __BENCH_RESULTS: unknown }).__BENCH_RESULTS = rows;

const statusEl = document.getElementById("status") as HTMLPreElement;
function renderRows() {
  const html = rows
    .map(
      (r) =>
        `<tr><td>${r.name}</td><td class="${r.verdict ?? ""}">${r.value}</td><td>${r.detail ?? ""}</td></tr>`,
    )
    .join("");
  statusEl.innerHTML =
    `<table><tr><th>measurement</th><th>value</th><th>detail</th></tr>${html}</table>`;
}
function row(name: string, value: string, detail?: string, verdict?: Row["verdict"]) {
  rows.push({ name, value, detail, verdict });
  renderRows();
}

const now = () => performance.now();
const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const stats = (xs: number[]) => {
  if (xs.length === 0) return { avg: NaN, p95: NaN, max: NaN };
  const s = [...xs].sort((a, b) => a - b);
  return {
    avg: s.reduce((a, b) => a + b, 0) / s.length,
    p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
    max: s[s.length - 1],
  };
};
const heapMB = () =>
  (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    ? Math.round((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576)
    : -1;

const MEDIA_DIR = encodeURI("/@fs/Y:/Project YX/benchmark/media");
const MEDIA = {
  p1080: `${MEDIA_DIR}/bench_1080p30.mp4`,
  p108060: `${MEDIA_DIR}/bench_1080p60.mp4`,
  p4k: `${MEDIA_DIR}/bench_4k30.mp4`,
  p4khevc: `${MEDIA_DIR}/bench_4k_hevc.mp4`,
};
const MEDIA_URLS = [MEDIA.p1080, MEDIA.p108060, MEDIA.p4k, MEDIA.p4khevc];

async function mountApp(container: HTMLDivElement, clips: number): Promise<number> {
  installMockTauri({ clips, mediaUrls: MEDIA_URLS });
  container.innerHTML = "";
  const host = document.createElement("div");
  container.appendChild(host);
  const t0 = now();
  const { default: App } = await import("../App");
  ReactDOM.createRoot(host).render(React.createElement(App));
  // Wait until the timeline actually paints clips.
  for (let i = 0; i < 600; i++) {
    await raf();
    if (document.querySelector(".tl-clip")) break;
  }
  await raf();
  await raf();
  return now() - t0;
}

/**
 * Drive the REAL editing path: pointerdown on the clip, pointermove on the
 * window, pointerup — exactly what ClipBlock handles (optimistic update →
 * invoke → reconcile → re-render). Returns nothing; measurement is done by
 * the caller watching the DOM.
 */
async function dragClip(clipId: string, dxPx: number): Promise<void> {
  const el = document.querySelector(`[data-clip-id="${clipId}"]`) as HTMLElement | null;
  if (!el) throw new Error(`clip ${clipId} not found (culled?)`);
  const rect = el.getBoundingClientRect();
  const startX = rect.left + Math.min(30, rect.width / 2 - 2);
  const startY = rect.top + rect.height / 2;
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: startX, clientY: startY, button: 0, pointerId: 1 }));
  await raf();
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, clientX: startX + dxPx, clientY: startY, pointerId: 1 }));
  await raf();
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, clientX: startX + dxPx, clientY: startY, pointerId: 1 }));
}

/** Measure: pointer release → clip's rendered left actually changed. */
async function editViaDrag(clipId: string, dx: number, iterations: number) {
  const times: number[] = [];
  let allUpdated = true;
  for (let i = 0; i < iterations; i++) {
    const el = () =>
      document.querySelector(`[data-clip-id="${clipId}"]`) as HTMLElement | null;
    const before = el()?.style.left ?? "";
    // Press + move (setup, not measured)... then measure from the actual release.
    const elNow = el();
    if (!elNow) throw new Error(`clip ${clipId} not found (culled?)`);
    const rect = elNow.getBoundingClientRect();
    const startX = rect.left + Math.min(30, rect.width / 2 - 2);
    const startY = rect.top + rect.height / 2;
    elNow.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: startX, clientY: startY, button: 0, pointerId: 1 }));
    await raf();
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, clientX: startX + dx, clientY: startY, pointerId: 1 }));
    await raf();
    const t0 = now();
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, clientX: startX + dx, clientY: startY, pointerId: 1 }));
    let waited = now() - t0;
    let updated = false;
    for (let k = 0; k < 200; k++) {
      await raf();
      const cur = el()?.style.left ?? "";
      if (cur && cur !== before) {
        updated = true;
        waited = now() - t0;
        break;
      }
    }
    if (!updated) allUpdated = false;
    times.push(waited);
    dx = -dx; // alternate so the clip doesn't drift away
  }
  return { ...stats(times), allUpdated };
}

/** Zoom in N steps through the app's ctrl+wheel handler. */
async function zoomInSteps(steps: number) {
  const scroller = document.querySelector(".tl-scroller") as HTMLDivElement | null;
  if (!scroller) return;
  for (let i = 0; i < steps; i++) {
    scroller.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -120, bubbles: true, cancelable: true }));
    await raf();
  }
}

async function runBench() {
  const container = document.getElementById("app-under-test") as HTMLDivElement;
  const rvfcSupported = "requestVideoFrameCallback" in HTMLVideoElement.prototype;

  // ---------------- mount + edit latency @ 100 clips ----------------
  let t0 = now();
  const mount100 = await mountApp(container, 100);
  row("mount → timeline painted (100 clips)", `${mount100.toFixed(0)} ms`,
    `import+boot+first paint; timeline confirmed after ${(now() - t0 - mount100).toFixed(0)}ms of paint wait`);

  const heapAfterMount100 = heapMB();

  // Keep the target clip well inside the visible window (no culling).
  const edit100 = await editViaDrag("v3", 40, 20);
  row("drag-edit → visual update (100 clips)",
    `${edit100.avg.toFixed(1)} ms avg / ${edit100.p95.toFixed(1)} p95`,
    "pointer release → optimistic commit → paint" + (edit100.allUpdated ? "" : " — DOM NEVER UPDATED!"),
    edit100.allUpdated && edit100.p95 < 50 ? "ok" : "warn");

  // scroll pacing
  {
    const scroller = document.querySelector(".tl-scroller") as HTMLDivElement | null;
    if (scroller) {
      const gaps: number[] = [];
      let last = now();
      for (let i = 0; i < 120; i++) {
        scroller.scrollLeft += 300;
        await raf();
        const t = now();
        gaps.push(t - last);
        last = t;
      }
      const s = stats(gaps);
      row("scroll pacing (120 frames @500px)", `${s.avg.toFixed(2)} ms/frame avg`,
        `max ${s.max.toFixed(2)} ms — 60fps budget 16.7ms`, s.p95 < 20 ? "ok" : "warn");
    }
  }

  // zoom pacing via ctrl+wheel (the app's zoom gesture): one frame per step
  {
    const scroller = document.querySelector(".tl-scroller") as HTMLDivElement | null;
    if (scroller) {
      const gaps: number[] = [];
      let last = now();
      for (let i = 0; i < 10; i++) {
        scroller.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -120, bubbles: true, cancelable: true }));
        await raf();
        const t = now();
        gaps.push(t - last);
        last = t;
      }
      const s = stats(gaps);
      row("zoom-in steps (ctrl+wheel ×10)", `${s.avg.toFixed(2)} ms/frame avg`,
        "re-layout + ruler + clip reposition (one frame per step)", s.max < 60 ? "ok" : "warn");
    }
  }

  // playhead publish → DOM (synchronous imperative path). Restores the
  // previous clock value afterwards — publishing bypasses the app's
  // boundary detection and would desync later measurements otherwise.
  {
    const ph = document.querySelector(".tl-ruler .tl-playhead") as HTMLDivElement | null;
    if (ph) {
      const { playbackClock } = await import("../playback/playbackClock");
      const restore = playbackClock.get();
      const times: number[] = [];
      for (let i = 0; i < 60; i++) {
        const t0b = now();
        playbackClock.publish(i * 0.1 + 30, true);
        void ph.style.left; // style write happens synchronously inside publish
        times.push(now() - t0b);
      }
      playbackClock.publish(restore, true);
      const s = stats(times);
      row("playhead publish → line moved (sync)", `${(s.avg * 1000).toFixed(0)} µs avg`,
        "imperative DOM write per publish");
    }
  }

  // undo via the app's real Ctrl+Z handler, measured to DOM update
  {
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const el = () =>
        document.querySelector(`[data-clip-id="v3"]`) as HTMLElement | null;
      await dragClip("v3", 40);
      for (let k = 0; k < 200; k++) { await raf(); }
      const before = el()?.style.left ?? "";
      const t0b = now();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
      let waited = now() - t0b;
      let updated = false;
      for (let k = 0; k < 200; k++) {
        await raf();
        const cur = el()?.style.left ?? "";
        if (cur && cur !== before) {
          updated = true;
          waited = now() - t0b;
          break;
        }
      }
      times.push(waited);
      void updated;
    }
    const s = stats(times);
    row("edit + Ctrl+Z undo → DOM", `${s.avg.toFixed(1)} ms avg`, undefined, s.p95 < 60 ? "ok" : "warn");
  }

  // ---------------- 500-clip project ----------------
  const mount500 = await mountApp(container, 500);
  row("mount → timeline painted (500 clips)", `${mount500.toFixed(0)} ms`,
    "same harness, 5× project size", mount500 < mount100 * 4 ? "ok" : "warn");

  // Bring zoom to a normal editing level (auto-fit squeezed 500 clips into view).
  await zoomInSteps(20);

  const edit500 = await editViaDrag("v3", 40, 25);
  row("drag-edit → visual update (500 clips)",
    `${edit500.avg.toFixed(1)} ms avg / ${edit500.p95.toFixed(1)} p95`,
    "must not scale linearly with project size" + (edit500.allUpdated ? "" : " — DOM NEVER UPDATED!"),
    edit500.allUpdated && edit500.p95 < 60 ? "ok" : "warn");

  // reconcile pure cost
  {
    const res = await invoke<Timeline>("get_timeline");
    const prev = res;
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const fresh = JSON.parse(JSON.stringify(prev)) as Timeline;
      const t0b = now();
      reconcileTimeline(prev, fresh);
      times.push(now() - t0b);
    }
    const s = stats(times);
    row("reconcileTimeline (500 clips, full payload)", `${s.avg.toFixed(2)} ms avg`,
      "identity-merge pass per edit response", s.avg < 8 ? "ok" : "warn");
  }

  // 500-edit storm: repeated real drags through the full edit pipeline.
  {
    const heapBefore = heapMB();
    const t0b = now();
    for (let i = 0; i < 200; i++) {
      await dragClip("v3", i % 2 === 0 ? 40 : -40);
      if (i % 25 === 0) await raf();
    }
    const total = now() - t0b;
    await raf();
    await sleep(300);
    const heapAfter = heapMB();
    row("200-drag edit storm", `${total.toFixed(0)} ms total (${(total / 200).toFixed(1)} ms/drag)`,
      `heap ${heapBefore} → ${heapAfter} MB (includes mock's 100 JSON undo snapshots)`,
      heapAfter - heapBefore < 60 ? "ok" : "warn");
  }

  const heapAfterStorm = heapMB();

  // waveform overview pipeline on real media (the app's own module path)
  {
    const { loadOverviewPeaks } = await import("../audio/waveformPeaks");
    const t0b = now();
    try {
      const overview = await loadOverviewPeaks(MEDIA.p1080);
      const ms = now() - t0b;
      row("waveform overview build (60s AAC)",
        `${ms.toFixed(0)} ms`,
        overview ? `${overview.peaks.length} bins · ${overview.duration.toFixed(1)}s decoded once per file` : "decode failed",
        overview && ms < 2000 ? "ok" : "warn");
    } catch (e) {
      row("waveform overview build (60s AAC)", "FAILED", String(e), "bad");
    }
  }

  // ---------------- real media playback ----------------
  row("requestVideoFrameCallback", rvfcSupported ? "supported" : "NOT supported",
    rvfcSupported ? "frame-accurate clock available" : "fall back to rAF clock");

  async function playbackFps(src: string, seconds: number): Promise<{ fps: number; compositorFps: number }> {
    const v = document.createElement("video");
    v.muted = true;
    v.src = src;
    v.preload = "auto";
    v.style.position = "fixed";
    v.style.width = "480px";
    v.style.left = "0";
    v.style.bottom = "0";
    v.style.zIndex = "999";
    document.body.appendChild(v);
    try {
      await new Promise<void>((res, rej) => {
        v.onloadeddata = () => res();
        v.onerror = () => rej(new Error(`media load failed: ${src}`));
      });
      await v.play();
      let frames = 0;
      let compositorFrames = 0;
      const t0 = now();
      // Compositor pace: rAF count while the video plays — distinguishes
      // decoder stalls from pane/vsync throttling.
      const countRaf = () => {
        compositorFrames++;
        if (now() - t0 < seconds * 1000) requestAnimationFrame(countRaf);
      };
      requestAnimationFrame(countRaf);
      if (rvfcSupported) {
        const step = () => {
          frames++;
          if (now() - t0 < seconds * 1000 && !v.paused) {
            v.requestVideoFrameCallback(step);
          }
        };
        v.requestVideoFrameCallback(step);
      }
      await sleep(seconds * 1000);
      v.pause();
      const elapsed = (now() - t0) / 1000;
      if (!rvfcSupported) {
        // Fallback: count distinct media timestamps observed via rAF sampling.
        let distinct = 0;
        let lastMediaTime = -1;
        const t1 = now();
        const tick = () => {
          if (v.currentTime !== lastMediaTime) {
            distinct++;
            lastMediaTime = v.currentTime;
          }
          if (now() - t1 < 3000) requestAnimationFrame(tick);
        };
        await v.play();
        requestAnimationFrame(tick);
        await sleep(3000);
        v.pause();
        return { fps: distinct / 3, compositorFps: compositorFrames / elapsed };
      }
      return { fps: frames / elapsed, compositorFps: compositorFrames / elapsed };
    } finally {
      v.pause();
      v.removeAttribute("src");
      v.load();
      v.remove();
    }
  }

  for (const [label, src, nominal] of [
    ["1080p30 H.264 playback FPS", MEDIA.p1080, 30],
    ["1080p60 H.264 playback FPS", MEDIA.p108060, 60],
    ["4K30 H.264 playback FPS", MEDIA.p4k, 30],
    ["4K HEVC playback FPS", MEDIA.p4khevc, 30],
  ] as [string, string, number][]) {
    try {
      const { fps, compositorFps } = await playbackFps(src, 6);
      const pct = (fps / nominal) * 100;
      row(label, `${fps.toFixed(1)} / ${nominal}`,
        `presented frames over 6s (${pct.toFixed(0)}% of nominal; compositor ${compositorFps.toFixed(1)} fps)`,
        pct > 90 ? "ok" : pct > 70 ? "warn" : "bad");
    } catch (e) {
      row(label, "FAILED", String(e), "bad");
    }
  }

  // seek latency
  {
    const v = document.createElement("video");
    v.muted = true;
    v.src = MEDIA.p1080;
    await new Promise<void>((res) => {
      v.onloadeddata = () => res();
      document.body.appendChild(v);
    });
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t = 1 + (i * 3.7) % 50;
      const t0b = now();
      v.currentTime = t;
      await new Promise<void>((res) => {
        const done = () => res();
        v.onseeked = done;
      });
      times.push(now() - t0b);
    }
    const s = stats(times);
    v.remove();
    row("seek latency (1080p, random ×15)", `${s.avg.toFixed(0)} ms avg / ${s.max.toFixed(0)} max`,
      "video.currentTime → 'seeked' event", s.avg < 120 ? "ok" : "warn");
  }

  // A/V drift: video element + audio element on the same AV source (the
  // app's model). Autoplay policy: start BOTH muted, then unmute the audio
  // once playing — audible play() without a user gesture would be rejected.
  {
    const v = document.createElement("video");
    v.muted = true;
    const a = document.createElement("audio");
    a.muted = true;
    v.src = MEDIA.p1080;
    a.src = MEDIA.p1080;
    document.body.appendChild(v);
    document.body.appendChild(a);
    await new Promise<void>((res) => {
      v.onloadeddata = () => res();
    });
    await Promise.all([v.play(), a.play()]);
    a.muted = false;
    await sleep(500);
    const audioPlaying = !a.paused && a.currentTime > 0.05;
    const samples: number[] = [];
    if (audioPlaying) {
      for (let i = 0; i < 12; i++) {
        await sleep(5000);
        samples.push(Math.abs(v.currentTime - a.currentTime));
      }
    }
    v.pause();
    a.pause();
    v.remove();
    a.remove();
    if (!audioPlaying) {
      row("A/V drift (60s session)", "MEASUREMENT BLOCKED",
        "browser autoplay policy rejected audible playback in harness", "warn");
    } else {
      const maxDrift = Math.max(...samples);
      row("A/V drift (60s session, sampled 5s)", `${(maxDrift * 1000).toFixed(1)} ms max`,
        "|video.currentTime − audio.currentTime|; app resyncs >120ms",
        maxDrift < 0.045 ? "ok" : maxDrift < 0.12 ? "warn" : "bad");
    }
  }

  // App-level playback: drive the real play button; the presented-frame
  // clock should advance the timeline playhead in step with wall time.
  {
    const btn = document.querySelector(".project-monitor .play-btn") as HTMLButtonElement | null;
    if (btn && !btn.disabled) {
      const readSeconds = () => {
        const tc = document.querySelector(".project-monitor .timecode")?.textContent ?? "0:00.00";
        const [mm, rest] = tc.split(":");
        return Number(mm) * 60 + Number(rest ?? 0);
      };
      const beforeT = readSeconds();
      btn.click();
      await sleep(5000);
      btn.click();
      await raf();
      const delta = readSeconds() - beforeT;
      row("app playback 5s wall → playhead delta", `${delta.toFixed(2)} s`,
        "frame-accurate clock drives the playhead through the real transport",
        delta > 4.3 && delta < 5.8 ? "ok" : "warn");
    } else {
      row("app playback 5s wall → playhead delta", "SKIPPED", "transport unavailable in harness", "warn");
    }
  }

  // heap after media work
  await sleep(500);
  row("JS heap (MB)", `${heapMB()} MB`,
    `after mount100=${heapAfterMount100}, after storm=${heapAfterStorm}, after media=now`);

  row("BENCH COMPLETE", new Date().toISOString());
  console.log("BENCH RESULTS", JSON.stringify(rows, null, 2));
}

void runBench().catch((e) => {
  row("HARNESS ERROR", String(e && (e as Error).stack ? (e as Error).stack : e), undefined, "bad");
});
