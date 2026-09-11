//! Hardware capability probe and performance tiers.
//!
//! Old CPUs stay usable by never editing full 4K sources in the timeline.
//! Export can still target 4K; preview/proxies adapt to the machine.

use serde::{Deserialize, Serialize};

/// How aggressively the editor should protect the host machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PerformanceTier {
    /// Dual-core / no discrete GPU: 540p proxy, 1/8 preview, cheap filters only.
    Potato,
    /// Typical laptop: 720p proxy, 1/4 preview.
    Low,
    /// Decent desktop / modern laptop: 720p or 1080p proxy, 1/2 preview.
    Medium,
    /// Strong CPU + GPU + hardware encode: full or 1/2 preview.
    High,
}

impl PerformanceTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Potato => "potato",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

/// Preview resolution scale relative to the timeline output size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewScale {
    Full,
    Half,
    Quarter,
    Eighth,
}

impl PreviewScale {
    pub fn divisor(self) -> u32 {
        match self {
            Self::Full => 1,
            Self::Half => 2,
            Self::Quarter => 4,
            Self::Eighth => 8,
        }
    }
}

/// Proxy height used while editing (export still reads originals).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProxyPreset {
    pub height: u32,
    pub video_bitrate_kbps: u32,
}

/// Detected hardware capabilities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareProfile {
    pub logical_cpus: usize,
    pub physical_cpus: usize,
    pub total_memory_mb: u64,
    pub has_discrete_gpu: bool,
    pub hw_decode: Vec<String>,
    pub hw_encode: Vec<String>,
    pub ffmpeg_available: bool,
}

/// Runtime policy derived from [`HardwareProfile`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformancePolicy {
    pub tier: PerformanceTier,
    pub preview_scale: PreviewScale,
    pub proxy: ProxyPreset,
    /// Soft cap so export does not freeze the UI on old CPUs.
    pub encode_threads: usize,
    /// In preview, only allow cheap filters on potato/low tiers.
    pub preview_allows_heavy_filters: bool,
    pub prefer_hw_decode: bool,
    pub prefer_hw_encode: bool,
}

impl PerformancePolicy {
    pub fn from_profile(profile: &HardwareProfile) -> Self {
        let tier = classify_tier(profile);
        let encode_threads = encode_thread_cap(profile.physical_cpus.max(1));

        let (preview_scale, proxy, preview_allows_heavy_filters) = match tier {
            PerformanceTier::Potato => (
                PreviewScale::Eighth,
                ProxyPreset {
                    height: 540,
                    video_bitrate_kbps: 2500,
                },
                false,
            ),
            PerformanceTier::Low => (
                PreviewScale::Quarter,
                ProxyPreset {
                    height: 720,
                    video_bitrate_kbps: 4000,
                },
                false,
            ),
            PerformanceTier::Medium => (
                PreviewScale::Half,
                ProxyPreset {
                    height: 720,
                    video_bitrate_kbps: 6000,
                },
                true,
            ),
            PerformanceTier::High => (
                PreviewScale::Half,
                ProxyPreset {
                    height: 1080,
                    video_bitrate_kbps: 10000,
                },
                true,
            ),
        };

        Self {
            tier,
            preview_scale,
            proxy,
            encode_threads,
            preview_allows_heavy_filters,
            prefer_hw_decode: !profile.hw_decode.is_empty(),
            prefer_hw_encode: !profile.hw_encode.is_empty(),
        }
    }
}

/// Probe the local machine. Safe to call at app startup.
pub fn probe() -> HardwareProfile {
    let logical = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    // Without a platform-specific physical-core API yet, estimate conservatively.
    let physical = (logical / 2).max(1);

    let total_memory_mb = detect_total_memory_mb();
    let ffmpeg_available = which_ffmpeg().is_some();
    let (hw_decode, hw_encode) = if ffmpeg_available {
        probe_ffmpeg_hwaccels()
    } else {
        (Vec::new(), Vec::new())
    };

    HardwareProfile {
        logical_cpus: logical,
        physical_cpus: physical,
        total_memory_mb,
        has_discrete_gpu: !hw_encode.is_empty() || !hw_decode.is_empty(),
        hw_decode,
        hw_encode,
        ffmpeg_available,
    }
}

pub fn probe_and_policy() -> (HardwareProfile, PerformancePolicy) {
    let profile = probe();
    let policy = PerformancePolicy::from_profile(&profile);
    (profile, policy)
}

fn classify_tier(profile: &HardwareProfile) -> PerformanceTier {
    let weak_cpu = profile.physical_cpus <= 2;
    let low_ram = profile.total_memory_mb > 0 && profile.total_memory_mb < 6000;
    let strong_cpu = profile.physical_cpus >= 8;
    let has_hw = !profile.hw_encode.is_empty() || !profile.hw_decode.is_empty();

    if weak_cpu || low_ram {
        PerformanceTier::Potato
    } else if profile.physical_cpus <= 4 && !has_hw {
        PerformanceTier::Low
    } else if strong_cpu && has_hw {
        PerformanceTier::High
    } else {
        PerformanceTier::Medium
    }
}

/// Leave one physical core free for the UI / OS.
pub fn encode_thread_cap(physical_cpus: usize) -> usize {
    physical_cpus.saturating_sub(1).max(1)
}

fn which_ffmpeg() -> Option<std::path::PathBuf> {
    which_bin("ffmpeg")
}

fn which_bin(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let with_exe = dir.join(format!("{name}.exe"));
            if with_exe.is_file() {
                return Some(with_exe);
            }
        }
    }
    None
}

fn detect_total_memory_mb() -> u64 {
    #[cfg(windows)]
    {
        use std::mem::MaybeUninit;
        #[repr(C)]
        struct MemoryStatusEx {
            dw_length: u32,
            dw_memory_load: u32,
            ull_total_phys: u64,
            ull_avail_phys: u64,
            ull_total_page_file: u64,
            ull_avail_page_file: u64,
            ull_total_virtual: u64,
            ull_avail_virtual: u64,
            ull_avail_extended_virtual: u64,
        }

        #[link(name = "kernel32")]
        extern "system" {
            fn GlobalMemoryStatusEx(lpBuffer: *mut MemoryStatusEx) -> i32;
        }

        unsafe {
            let mut status = MaybeUninit::<MemoryStatusEx>::zeroed();
            (*status.as_mut_ptr()).dw_length = std::mem::size_of::<MemoryStatusEx>() as u32;
            if GlobalMemoryStatusEx(status.as_mut_ptr()) != 0 {
                return status.assume_init().ull_total_phys / (1024 * 1024);
            }
        }
    }
    0
}

fn probe_ffmpeg_hwaccels() -> (Vec<String>, Vec<String>) {
    let mut decode = Vec::new();
    let mut encode = Vec::new();

    if let Ok(output) = std::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-hwaccels"])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines().skip(1) {
            let name = line.trim().to_ascii_lowercase();
            if name.is_empty() {
                continue;
            }
            // Common hardware decode backends reported by FFmpeg.
            if matches!(
                name.as_str(),
                "cuda" | "qsv" | "d3d11va" | "dxva2" | "vaapi" | "videotoolbox" | "vulkan"
            ) {
                decode.push(name);
            }
        }
    }

    if let Ok(output) = std::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let lower = line.to_ascii_lowercase();
            for name in [
                "h264_nvenc",
                "hevc_nvenc",
                "h264_qsv",
                "hevc_qsv",
                "h264_amf",
                "hevc_amf",
                "h264_videotoolbox",
                "hevc_videotoolbox",
            ] {
                if lower.contains(name) && !encode.iter().any(|e| e == name) {
                    encode.push(name.to_string());
                }
            }
        }
    }

    (decode, encode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn potato_policy_uses_small_proxy() {
        let profile = HardwareProfile {
            logical_cpus: 4,
            physical_cpus: 2,
            total_memory_mb: 4096,
            has_discrete_gpu: false,
            hw_decode: vec![],
            hw_encode: vec![],
            ffmpeg_available: true,
        };
        let policy = PerformancePolicy::from_profile(&profile);
        assert_eq!(policy.tier, PerformanceTier::Potato);
        assert_eq!(policy.proxy.height, 540);
        assert_eq!(policy.preview_scale, PreviewScale::Eighth);
        assert!(!policy.preview_allows_heavy_filters);
        assert_eq!(policy.encode_threads, 1);
    }

    #[test]
    fn encode_cap_leaves_one_core() {
        assert_eq!(encode_thread_cap(8), 7);
        assert_eq!(encode_thread_cap(1), 1);
    }
}
