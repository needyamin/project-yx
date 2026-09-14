import { useEffect, useMemo, useState } from "react";
import type { PerformanceTier } from "../timeline/types";
import "./ExportDialog.css";

export type ExportPresetId =
  | "best"
  | "youtube1080"
  | "tiktok"
  | "instagram"
  | "4k"
  | "draft"
  | "custom";

export type ExportSettings = {
  preset: ExportPresetId;
  matchSource: boolean;
  width: number;
  height: number;
  fps: number | null;
  codec: "h264" | "h265";
  x264Preset: string;
  qualityMode: "crf" | "bitrate";
  crf: number;
  videoBitrate: string;
  audioBitrate: string;
  fit: "contain" | "cover";
  encoder: "auto" | "software" | "nvenc" | "qsv" | "amf";
};

export type ExportSourceInfo = {
  width: number;
  height: number;
  frameRate: number;
  duration: number;
};

type Props = {
  open: boolean;
  busy: boolean;
  progress: number;
  sourceName: string | null;
  sourceInfo: ExportSourceInfo | null;
  tier: PerformanceTier;
  preferHw: boolean;
  previewAspect: "landscape" | "tiktok";
  onClose: () => void;
  onExport: (settings: ExportSettings) => void;
};

const PRESETS: {
  id: ExportPresetId;
  label: string;
  hint: string;
}[] = [
  { id: "best", label: "Best (recommended)", hint: "Same size as source · max quality" },
  { id: "youtube1080", label: "YouTube 1080p", hint: "16:9 · social / web" },
  { id: "tiktok", label: "TikTok / Reels", hint: "9:16 · 1080×1920" },
  { id: "instagram", label: "Instagram feed", hint: "1:1 · 1080×1080" },
  { id: "4k", label: "4K Ultra HD", hint: "16:9 · 3840×2160" },
  { id: "draft", label: "Draft / fast", hint: "720p · quick encode" },
  { id: "custom", label: "Custom", hint: "Full manual control" },
];

function bestDefaults(
  _tier: PerformanceTier,
  source: ExportSourceInfo | null,
): ExportSettings {
  const width = source?.width && source.width > 0 ? source.width : 1920;
  const height = source?.height && source.height > 0 ? source.height : 1080;
  return {
    preset: "best",
    matchSource: true,
    width,
    height,
    fps: null,
    codec: "h264",
    x264Preset: "slow",
    qualityMode: "crf",
    crf: 15,
    videoBitrate: "20M",
    audioBitrate: "320k",
    fit: "contain",
    encoder: "software",
  };
}

function applyPreset(
  id: ExportPresetId,
  tier: PerformanceTier,
  source: ExportSourceInfo | null,
  prev: ExportSettings,
): ExportSettings {
  const base = bestDefaults(tier, source);
  switch (id) {
    case "best":
      return base;
    case "youtube1080":
      return {
        ...base,
        preset: id,
        matchSource: false,
        width: 1920,
        height: 1080,
        crf: 17,
        x264Preset: "medium",
        audioBitrate: "192k",
      };
    case "tiktok":
      return {
        ...base,
        preset: id,
        matchSource: false,
        width: 1080,
        height: 1920,
        fit: "cover",
        crf: 17,
        x264Preset: "medium",
        audioBitrate: "192k",
      };
    case "instagram":
      return {
        ...base,
        preset: id,
        matchSource: false,
        width: 1080,
        height: 1080,
        fit: "cover",
        crf: 17,
        x264Preset: "medium",
        audioBitrate: "192k",
      };
    case "4k":
      return {
        ...base,
        preset: id,
        matchSource: false,
        width: 3840,
        height: 2160,
        crf: 15,
        x264Preset: "slow",
        videoBitrate: "45M",
      };
    case "draft":
      return {
        ...base,
        preset: id,
        matchSource: false,
        width: 1280,
        height: 720,
        x264Preset: "ultrafast",
        qualityMode: "bitrate",
        videoBitrate: "4M",
        crf: 28,
        audioBitrate: "128k",
        encoder: "auto",
      };
    case "custom":
      return { ...prev, preset: "custom" };
  }
}

export function ExportDialog({
  open,
  busy,
  progress,
  sourceName,
  sourceInfo,
  tier,
  preferHw,
  previewAspect,
  onClose,
  onExport,
}: Props) {
  const [settings, setSettings] = useState<ExportSettings>(() =>
    bestDefaults(tier, sourceInfo),
  );

  useEffect(() => {
    if (open) {
      setSettings(bestDefaults(tier, sourceInfo));
    }
  }, [open, tier, sourceInfo]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  const summary = useMemo(() => {
    const size = settings.matchSource
      ? `source ${settings.width}×${settings.height}`
      : `${settings.width}×${settings.height}`;
    const fps = settings.fps ? `${settings.fps} fps` : "source fps";
    const q =
      settings.qualityMode === "crf"
        ? `CRF ${settings.crf}`
        : settings.videoBitrate;
    return `${size} · ${settings.codec.toUpperCase()} · ${q} · ${settings.x264Preset} · ${fps} · AAC ${settings.audioBitrate}`;
  }, [settings]);

  if (!open) return null;

  function patch(partial: Partial<ExportSettings>) {
    setSettings((s) => ({ ...s, ...partial, preset: "custom" }));
  }

  void previewAspect;

  const sourceLabel =
    sourceInfo && sourceInfo.width > 0
      ? `Same as source (${sourceInfo.width}×${sourceInfo.height})`
      : "Same as source";

  return (
    <div className="export-modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div
        className="export-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="export-modal-head">
          <div>
            <h2 id="export-modal-title">Export</h2>
            <p>
              {sourceName ? (
                <>
                  {sourceName.startsWith("Timeline") ? "Export" : "Source"}:{" "}
                  <strong>{sourceName}</strong>
                </>
              ) : (
                "No media selected"
              )}
              {" · "}
              {preferHw ? "HW encode available" : "Software encode"} · {tier} tier
            </p>
          </div>
          <button type="button" className="export-close" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>

        <div className="export-modal-body">
          <section className="export-presets">
            <h3>Preset</h3>
            <div className="export-preset-grid">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`export-preset ${settings.preset === p.id ? "active" : ""}`}
                  disabled={busy}
                  onClick={() =>
                    setSettings((s) => applyPreset(p.id, tier, sourceInfo, s))
                  }
                >
                  <strong>{p.label}</strong>
                  <span>{p.hint}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="export-fields">
            <h3>Customize</h3>
            <div className="export-grid">
              <label>
                Resolution
                <select
                  value={
                    settings.matchSource
                      ? "source"
                      : `${settings.width}x${settings.height}`
                  }
                  disabled={busy}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "source") {
                      patch({
                        matchSource: true,
                        width: sourceInfo?.width || settings.width,
                        height: sourceInfo?.height || settings.height,
                      });
                      return;
                    }
                    const [w, h] = v.split("x").map(Number);
                    patch({ matchSource: false, width: w, height: h });
                  }}
                >
                  <option value="source">{sourceLabel}</option>
                  <option value="1920x1080">1920×1080 (16:9)</option>
                  <option value="1280x720">1280×720 (16:9)</option>
                  <option value="3840x2160">3840×2160 (4K)</option>
                  <option value="1080x1920">1080×1920 (9:16)</option>
                  <option value="1080x1350">1080×1350 (4:5)</option>
                  <option value="1080x1080">1080×1080 (1:1)</option>
                  <option value="720x1280">720×1280 (9:16)</option>
                </select>
              </label>

              <label>
                Frame rate
                <select
                  value={settings.fps ?? "source"}
                  disabled={busy}
                  onChange={(e) => {
                    const v = e.target.value;
                    patch({ fps: v === "source" ? null : Number(v) });
                  }}
                >
                  <option value="source">Same as source</option>
                  <option value="24">24</option>
                  <option value="25">25</option>
                  <option value="30">30</option>
                  <option value="60">60</option>
                </select>
              </label>

              <label>
                Video codec
                <select
                  value={settings.codec}
                  disabled={busy}
                  onChange={(e) =>
                    patch({ codec: e.target.value as ExportSettings["codec"] })
                  }
                >
                  <option value="h264">H.264 (best compatibility)</option>
                  <option value="h265">H.265 / HEVC (smaller files)</option>
                </select>
              </label>

              <label>
                Encoder
                <select
                  value={settings.encoder}
                  disabled={busy}
                  onChange={(e) =>
                    patch({ encoder: e.target.value as ExportSettings["encoder"] })
                  }
                >
                  <option value="software">Software (best quality)</option>
                  <option value="auto">Auto (faster / HW if available)</option>
                  <option value="nvenc">NVIDIA NVENC</option>
                  <option value="qsv">Intel Quick Sync</option>
                  <option value="amf">AMD AMF</option>
                </select>
              </label>

              <label>
                Encode speed
                <select
                  value={settings.x264Preset}
                  disabled={busy}
                  onChange={(e) => patch({ x264Preset: e.target.value })}
                >
                  <option value="ultrafast">Ultrafast</option>
                  <option value="veryfast">Very fast</option>
                  <option value="faster">Faster</option>
                  <option value="medium">Medium (balanced)</option>
                  <option value="slow">Slow (higher quality)</option>
                  <option value="slower">Slower (best quality)</option>
                </select>
              </label>

              <label>
                Fit mode
                <select
                  value={settings.fit}
                  disabled={busy}
                  onChange={(e) =>
                    patch({ fit: e.target.value as ExportSettings["fit"] })
                  }
                >
                  <option value="contain">Fit (letterbox)</option>
                  <option value="cover">Fill (crop)</option>
                </select>
              </label>

              <label>
                Quality mode
                <select
                  value={settings.qualityMode}
                  disabled={busy}
                  onChange={(e) =>
                    patch({
                      qualityMode: e.target.value as ExportSettings["qualityMode"],
                    })
                  }
                >
                  <option value="crf">Quality (CRF)</option>
                  <option value="bitrate">Bitrate</option>
                </select>
              </label>

              {settings.qualityMode === "crf" ? (
                <label>
                  CRF ({settings.crf}) — lower = better
                  <input
                    type="range"
                    min={12}
                    max={28}
                    value={settings.crf}
                    disabled={busy}
                    onChange={(e) => patch({ crf: Number(e.target.value) })}
                  />
                </label>
              ) : (
                <label>
                  Video bitrate
                  <select
                    value={settings.videoBitrate}
                    disabled={busy}
                    onChange={(e) => patch({ videoBitrate: e.target.value })}
                  >
                    <option value="4M">4 Mbps</option>
                    <option value="8M">8 Mbps</option>
                    <option value="10M">10 Mbps</option>
                    <option value="16M">16 Mbps</option>
                    <option value="25M">25 Mbps</option>
                    <option value="45M">45 Mbps</option>
                  </select>
                </label>
              )}

              <label>
                Audio bitrate
                <select
                  value={settings.audioBitrate}
                  disabled={busy}
                  onChange={(e) => patch({ audioBitrate: e.target.value })}
                >
                  <option value="128k">128 kbps</option>
                  <option value="192k">192 kbps (recommended)</option>
                  <option value="256k">256 kbps</option>
                  <option value="320k">320 kbps</option>
                </select>
              </label>
            </div>
          </section>
        </div>

        <footer className="export-modal-foot">
          {busy ? (
            <div className="export-progress">
              <div className="export-progress-meta">
                <span>Encoding…</span>
                <span>{Math.round(progress * 100)}%</span>
              </div>
              <div className="export-progress-track" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} role="progressbar">
                <div
                  className="export-progress-fill"
                  style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
                />
              </div>
              <p className="export-progress-hint">Rendering in the background — UI stays responsive</p>
            </div>
          ) : (
            <p className="export-summary">{summary}</p>
          )}
          <div className="export-actions">
            <button type="button" className="ghost-btn" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-btn"
              disabled={busy || !sourceName}
              onClick={() => onExport(settings)}
            >
              {busy ? "Exporting…" : "Export MP4"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
