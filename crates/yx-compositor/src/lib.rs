//! Frame composition and filter budget.
//!
//! Full wgpu surface integration lands with the Tauri preview window.
//! This crate already encodes the filter policy used by that path.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use yx_detect::{PerformancePolicy, PreviewScale};

#[derive(Debug, Error)]
pub enum CompositorError {
    #[error("filter '{0}' is disabled for this performance tier in preview")]
    FilterBlockedInPreview(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterKind {
    Exposure,
    Contrast,
    Lut,
    Crop,
    Fade,
    Text,
    Blur,
    Denoise,
}

impl FilterKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exposure => "exposure",
            Self::Contrast => "contrast",
            Self::Lut => "lut",
            Self::Crop => "crop",
            Self::Fade => "fade",
            Self::Text => "text",
            Self::Blur => "blur",
            Self::Denoise => "denoise",
        }
    }

    pub fn is_heavy(self) -> bool {
        matches!(self, Self::Blur | Self::Denoise | Self::Lut)
    }

    /// Cheap filters that always run, even on potato-tier preview.
    pub fn is_preview_safe(self) -> bool {
        !self.is_heavy()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterOp {
    pub kind: FilterKind,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComposePlan {
    pub preview_scale: PreviewScale,
    pub output_width: u32,
    pub output_height: u32,
    pub preview_width: u32,
    pub preview_height: u32,
    pub filters: Vec<FilterOp>,
    pub dropped_heavy_filters: Vec<String>,
}

/// Decide which filters run in preview for the current machine.
pub fn plan_preview(
    timeline_width: u32,
    timeline_height: u32,
    filters: &[FilterOp],
    policy: &PerformancePolicy,
) -> ComposePlan {
    let div = policy.preview_scale.divisor();
    let preview_width = (timeline_width / div).max(2);
    let preview_height = (timeline_height / div).max(2);

    let mut kept = Vec::new();
    let mut dropped = Vec::new();

    for filter in filters {
        if !filter.enabled {
            continue;
        }
        if filter.kind.is_heavy() && !policy.preview_allows_heavy_filters {
            dropped.push(filter.kind.as_str().to_string());
            continue;
        }
        kept.push(filter.clone());
    }

    ComposePlan {
        preview_scale: policy.preview_scale,
        output_width: timeline_width,
        output_height: timeline_height,
        preview_width,
        preview_height,
        filters: kept,
        dropped_heavy_filters: dropped,
    }
}

/// Apply a simple CPU exposure/contrast pass on packed RGBA8 (preview fallback).
pub fn apply_cpu_color_rgba8(
    pixels: &mut [u8],
    exposure: f32,
    contrast: f32,
) -> Result<(), CompositorError> {
    let exposure_mul = 2f32.powf(exposure);
    let contrast = contrast.max(0.0);
    for chunk in pixels.chunks_exact_mut(4) {
        for c in &mut chunk[0..3] {
            let mut v = (*c as f32 / 255.0) * exposure_mul;
            v = (v - 0.5) * contrast + 0.5;
            *c = (v.clamp(0.0, 1.0) * 255.0) as u8;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use yx_detect::{HardwareProfile, PerformancePolicy, PerformanceTier, PreviewScale, ProxyPreset};

    fn potato_policy() -> PerformancePolicy {
        PerformancePolicy {
            tier: PerformanceTier::Potato,
            preview_scale: PreviewScale::Eighth,
            proxy: ProxyPreset {
                height: 540,
                video_bitrate_kbps: 2500,
            },
            encode_threads: 1,
            preview_allows_heavy_filters: false,
            prefer_hw_decode: false,
            prefer_hw_encode: false,
        }
    }

    #[test]
    fn potato_drops_blur_in_preview() {
        let plan = plan_preview(
            3840,
            2160,
            &[
                FilterOp {
                    kind: FilterKind::Exposure,
                    enabled: true,
                },
                FilterOp {
                    kind: FilterKind::Blur,
                    enabled: true,
                },
            ],
            &potato_policy(),
        );
        assert_eq!(plan.preview_width, 480);
        assert_eq!(plan.preview_height, 270);
        assert_eq!(plan.filters.len(), 1);
        assert_eq!(plan.dropped_heavy_filters, vec!["blur".to_string()]);
    }

    #[test]
    fn from_real_probe_compiles_policy() {
        let profile = HardwareProfile {
            logical_cpus: 8,
            physical_cpus: 4,
            total_memory_mb: 16000,
            has_discrete_gpu: true,
            hw_decode: vec!["cuda".into()],
            hw_encode: vec!["h264_nvenc".into()],
            ffmpeg_available: true,
        };
        let _ = PerformancePolicy::from_profile(&profile);
    }
}
