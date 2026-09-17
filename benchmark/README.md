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
