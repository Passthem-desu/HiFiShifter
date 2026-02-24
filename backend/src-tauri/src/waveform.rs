use crate::audio_utils;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone)]
pub struct CachedPeaks {
    pub sample_rate: u32,
    pub hop: usize,
    pub min: Vec<f32>,
    pub max: Vec<f32>,
    pub total_frames: u64,
}

impl CachedPeaks {
    pub fn compute(path: &Path, hop: usize) -> Result<Self, String> {
        audio_utils::compute_minmax_peaks(path, hop)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct WaveformPeaksSegmentPayload {
    pub ok: bool,
    pub min: Vec<f32>,
    pub max: Vec<f32>,
    pub sample_rate: u32,
    pub hop: u32,
}

pub fn segment_from_cached(
    peaks: &CachedPeaks,
    start_sec: f64,
    duration_sec: f64,
    columns: usize,
) -> WaveformPeaksSegmentPayload {
    if columns == 0 || !start_sec.is_finite() || !duration_sec.is_finite() {
        return WaveformPeaksSegmentPayload {
            ok: false,
            min: vec![],
            max: vec![],
            sample_rate: peaks.sample_rate,
            hop: peaks.hop as u32,
        };
    }

    let sr = peaks.sample_rate.max(1) as f64;
    let start_frame = (start_sec.max(0.0) * sr).floor() as i64;
    let frames = (duration_sec.max(0.0) * sr).ceil() as i64;
    if frames <= 0 {
        return WaveformPeaksSegmentPayload {
            ok: true,
            min: vec![0.0; columns],
            max: vec![0.0; columns],
            sample_rate: peaks.sample_rate,
            hop: peaks.hop as u32,
        };
    }

    let hop = peaks.hop.max(1) as i64;
    let start_peak = (start_frame.div_euclid(hop)).max(0);
    let end_peak = ((start_frame + frames + hop - 1).div_euclid(hop)).max(start_peak + 1);

    let len = peaks.min.len().min(peaks.max.len()) as i64;
    let i0 = start_peak.min(len);
    let i1 = end_peak.min(len);
    if i1 <= i0 {
        return WaveformPeaksSegmentPayload {
            ok: true,
            min: vec![0.0; columns],
            max: vec![0.0; columns],
            sample_rate: peaks.sample_rate,
            hop: peaks.hop as u32,
        };
    }

    let span = (i1 - i0).max(1) as f64;
    let mut out_min = vec![f32::INFINITY; columns];
    let mut out_max = vec![f32::NEG_INFINITY; columns];

    for idx in i0..i1 {
        let rel = (idx - i0) as f64;
        let x = ((rel * columns as f64) / span).floor() as isize;
        if x < 0 {
            continue;
        }
        let x = x as usize;
        if x >= columns {
            continue;
        }
        let mi = peaks.min[idx as usize];
        let ma = peaks.max[idx as usize];
        if mi < out_min[x] {
            out_min[x] = mi;
        }
        if ma > out_max[x] {
            out_max[x] = ma;
        }
    }

    for i in 0..columns {
        if !out_min[i].is_finite() {
            out_min[i] = 0.0;
        }
        if !out_max[i].is_finite() {
            out_max[i] = 0.0;
        }
    }

    WaveformPeaksSegmentPayload {
        ok: true,
        min: out_min,
        max: out_max,
        sample_rate: peaks.sample_rate,
        hop: peaks.hop as u32,
    }
}
