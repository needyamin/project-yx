# Benchmark media

Generated test media for the performance harness — **the large files in
`media/` are gitignored**; regenerate them with the bundled FFmpeg before
running benchmarks:

```bash
FF="apps/desktop/src-tauri/bin/ffmpeg.exe"
mkdir -p benchmark/media && cd benchmark/media
"$FF" -y -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=60" -f lavfi -i "sine=frequency=440:duration=60" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest bench_1080p30.mp4
"$FF" -y -f lavfi -i "testsrc2=size=1920x1080:rate=60:duration=30" -f lavfi -i "sine=frequency=660:duration=30" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest bench_1080p60.mp4
"$FF" -y -f lavfi -i "testsrc2=size=3840x2160:rate=30:duration=30" -f lavfi -i "sine=frequency=440:duration=30" -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest bench_4k30.mp4
"$FF" -y -f lavfi -i "testsrc2=size=3840x2160:rate=30:duration=12" -c:v libx265 -preset ultrafast -crf 30 -pix_fmt yuv420p -an bench_4k_hevc.mp4
"$FF" -y -f lavfi -i "sine=frequency=440:duration=120" -c:a pcm_s16le bench_audio.wav
"$FF" -y -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=5" -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -an bench_small.mp4
```

## Frontend harness

```bash
cd apps/desktop && npm install
npx vite            # then open http://localhost:1420/bench.html
```

Mounts the real app against a mock Tauri backend (100/500-clip projects) and
measures: edit/drag latency, scroll & zoom frame pacing, playhead publish
cost, undo round-trips, real-codec playback FPS (presented frames), seek
latency, A/V drift over a 60s session, and JS heap growth. Results render in
the page and land in `window.__BENCH_RESULTS`.

## Engine benchmark

```bash
cargo test -p yx-timeline bench -- --ignored --nocapture
```

Times edit commands, undo snapshots, and IPC serialization at 100/500 clips
with regression budgets that fail the test on order-of-magnitude regressions.

## Recorded baselines (2026-09-25)

Reference numbers so a future run has something to compare against. All are from
the debug profile unless stated; re-measure before drawing conclusions, and do
not run cargo/npm builds in parallel with a benchmark (machine load skews
presented-frame counts — HEVC once read 56 % under load vs 99 % idle).

| Measurement | Value | How it was taken |
|---|---|---|
| Engine edit ops @500 clips | move 0.105 ms, split+undo 0.194 ms, snapshot 0.09 ms | `cargo test -p yx-timeline bench -- --ignored` |
| IPC payload @500 clips | 272 KB, ~10 ms serialize+deserialize (once per edit) | engine bench |
| Per-frame covering-set scan (`updateUnderPlayhead`) | 0.029 ms @100 clips → **0.19 ms @3000 clips** (1.1 % of a 60 fps budget) | real helpers from `timeline/types.ts`, driven from Node |
| `probe_media` | **117.42 ms** per probe (was 231.45 ms), 1 process (was 2) | 20 warm probes |
| Magic Remove mask shift | **4K 9.71 ms/frame** (was 116.23); u8 plane 0.60 ms (was 58.24) | direct call on the real functions |
| Frontend edit → paint @500 clips | 18 ms drag, 17.6 ms undo, 18.3 ms zoom, 16.6 ms scroll | `bench.html` (mock IPC) |
| A/V drift over 60 s | 12.3 ms max | `bench.html` |
| Presented frames | 4K30 99 %, 4K HEVC 99 %, 1080p60 ~78–92 % | `bench.html`, idle machine |

**These are dev-harness numbers, not a hardware acceptance pass.** 4K / high-bitrate /
long-duration behaviour on real target machines is still unverified — see
[docs/QA-MATRIX.md](../docs/QA-MATRIX.md).

## Related suites

The performance work sits alongside correctness suites that also run against real
media; see the root [README.md](../README.md#test-suites) for the full inventory.
The audit write-ups are in [docs/QA-REPORT-2026-09-25.md](../docs/QA-REPORT-2026-09-25.md)
and [docs/QA-REPORT-2026-09-25-SUBSYSTEMS.md](../docs/QA-REPORT-2026-09-25-SUBSYSTEMS.md).
