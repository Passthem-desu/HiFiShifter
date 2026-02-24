use crate::state::{PitchAnalysisAlgo, TimelineState};

fn pitch_edit_algo_from_env() -> Option<String> {
    std::env::var("HIFISHIFTER_PITCH_EDIT_ALGO")
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
}

fn pitch_edit_apply_mode_from_env() -> Option<String> {
    // Primary switch:
    // - HIFISHIFTER_PER_CLIP_PITCH_EDIT=1  => v2 per-clip
    // - HIFISHIFTER_PER_CLIP_PITCH_EDIT=0  => v1 mixdown
    // Secondary switch:
    // - HIFISHIFTER_PITCH_EDIT_APPLY=v1|v2
    if let Ok(v) = std::env::var("HIFISHIFTER_PER_CLIP_PITCH_EDIT") {
        let v = v.trim();
        if v == "1" {
            return Some("v2".to_string());
        }
        if v == "0" {
            return Some("v1".to_string());
        }
    }

    std::env::var("HIFISHIFTER_PITCH_EDIT_APPLY")
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PitchEditApplyMode {
    MixdownV1,
    PerClipV2,
}

impl PitchEditApplyMode {
    fn current() -> Self {
        let v = pitch_edit_apply_mode_from_env();
        match v.as_deref() {
            Some("v1") | Some("mixdown") | Some("mixdown_v1") => PitchEditApplyMode::MixdownV1,
            Some("v2") | Some("per_clip") | Some("perclip") | Some("clip") => {
                PitchEditApplyMode::PerClipV2
            }
            _ => PitchEditApplyMode::PerClipV2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PitchEditAlgorithm {
    WorldVocoder,
    NsfHifiganOnnx,
    Bypass,
}

#[derive(Debug, Clone)]
pub(crate) struct PitchCurvesSnapshot {
    pub frame_period_ms: f64,
    pub pitch_orig: Vec<f32>,
    pub pitch_edit: Vec<f32>,
}

impl PitchCurvesSnapshot {
    #[allow(dead_code)]
    pub fn midi_at_time(&self, abs_time_sec: f64) -> f64 {
        if !(abs_time_sec.is_finite() && abs_time_sec >= 0.0) {
            return 0.0;
        }

        let fp = self.frame_period_ms.max(0.1);
        let idx_f = (abs_time_sec * 1000.0) / fp;
        if !(idx_f.is_finite() && idx_f >= 0.0) {
            return 0.0;
        }
        let i0 = idx_f.floor() as isize;
        if i0 < 0 {
            return 0.0;
        }
        let i0 = i0 as usize;
        let len = self.pitch_orig.len().min(self.pitch_edit.len().max(1));
        if i0 >= len {
            return 0.0;
        }
        let i1 = (i0 + 1).min(len.saturating_sub(1));
        let frac = (idx_f - (i0 as f64)).clamp(0.0, 1.0);

        let orig0 = self.pitch_orig.get(i0).copied().unwrap_or(0.0) as f64;
        let orig1 = self.pitch_orig.get(i1).copied().unwrap_or(0.0) as f64;
        let edit0 = self.pitch_edit.get(i0).copied().unwrap_or(0.0) as f64;
        let edit1 = self.pitch_edit.get(i1).copied().unwrap_or(0.0) as f64;

        // For ONNX, `pitch_edit` is treated as an absolute target MIDI curve.
        // Allow it to work even when `pitch_orig` is missing (all zeros).
        let mut base0 = if edit0.is_finite() && edit0 > 0.0 {
            edit0
        } else {
            orig0
        };
        let mut base1 = if edit1.is_finite() && edit1 > 0.0 {
            edit1
        } else {
            orig1
        };

        if !(base0.is_finite() && base0 > 0.0) && (base1.is_finite() && base1 > 0.0) {
            base0 = base1;
        }
        if !(base1.is_finite() && base1 > 0.0) && (base0.is_finite() && base0 > 0.0) {
            base1 = base0;
        }
        if !(base0.is_finite() && base0 > 0.0 && base1.is_finite() && base1 > 0.0) {
            return 0.0;
        }

        let v = base0 + (base1 - base0) * frac;
        if v.is_finite() {
            v
        } else {
            0.0
        }
    }

    #[allow(dead_code)]
    pub fn is_voiced_at_time(&self, abs_time_sec: f64) -> bool {
        let fp = self.frame_period_ms.max(0.1);
        let idx = ((abs_time_sec.max(0.0) * 1000.0) / fp).round().max(0.0) as usize;
        let orig = self.pitch_orig.get(idx).copied().unwrap_or(0.0);
        let edit = self.pitch_edit.get(idx).copied().unwrap_or(0.0);
        (orig.is_finite() && orig > 0.0) || (edit.is_finite() && edit > 0.0)
    }
}

pub(crate) fn selected_pitch_curves_snapshot(
    timeline: &TimelineState,
) -> Option<PitchCurvesSnapshot> {
    let selected = timeline
        .selected_track_id
        .clone()
        .or_else(|| timeline.tracks.first().map(|t| t.id.clone()))
        .unwrap_or_default();
    let root = timeline.resolve_root_track_id(&selected)?;

    let entry = timeline.params_by_root_track.get(&root)?;
    Some(PitchCurvesSnapshot {
        frame_period_ms: entry.frame_period_ms.max(0.1),
        pitch_orig: entry.pitch_orig.clone(),
        pitch_edit: entry.pitch_edit.clone(),
    })
}

impl PitchEditAlgorithm {
    pub fn from_track_algo(algo: &PitchAnalysisAlgo) -> Self {
        if let Some(v) = pitch_edit_algo_from_env() {
            if matches!(v.as_str(), "nsf_hifigan" | "nsf_hifigan_onnx" | "onnx") {
                return Self::NsfHifiganOnnx;
            }
            if matches!(v.as_str(), "world" | "world_vocoder") {
                // fall through to track algo below
            }
        }
        match algo {
            PitchAnalysisAlgo::WorldDll | PitchAnalysisAlgo::Unknown => Self::WorldVocoder,
            PitchAnalysisAlgo::NsfHifiganOnnx => Self::NsfHifiganOnnx,
            PitchAnalysisAlgo::None => Self::Bypass,
        }
    }
}

pub fn selected_pitch_edit_algorithm(timeline: &TimelineState) -> PitchEditAlgorithm {
    let selected = timeline
        .selected_track_id
        .clone()
        .or_else(|| timeline.tracks.first().map(|t| t.id.clone()))
        .unwrap_or_default();
    let Some(root) = timeline.resolve_root_track_id(&selected) else {
        return PitchEditAlgorithm::Bypass;
    };

    let track = timeline.tracks.iter().find(|t| t.id == root);
    let Some(track) = track else {
        return PitchEditAlgorithm::Bypass;
    };

    PitchEditAlgorithm::from_track_algo(&track.pitch_analysis_algo)
}

fn semitone_ratio(semitones: f64) -> f64 {
    (2.0f64).powf(semitones / 12.0)
}

fn edit_midi_at_time_or_none(
    frame_period_ms: f64,
    pitch_edit: &[f32],
    abs_time_sec: f64,
) -> Option<f64> {
    if !(abs_time_sec.is_finite() && abs_time_sec >= 0.0) {
        return None;
    }

    let fp = frame_period_ms.max(0.1);
    let idx_f = (abs_time_sec * 1000.0) / fp;
    if !(idx_f.is_finite() && idx_f >= 0.0) {
        return None;
    }
    let i0 = idx_f.floor() as isize;
    if i0 < 0 {
        return None;
    }
    let i0 = i0 as usize;
    if i0 >= pitch_edit.len() {
        return None;
    }
    let i1 = (i0 + 1).min(pitch_edit.len().saturating_sub(1));
    let frac = (idx_f - (i0 as f64)).clamp(0.0, 1.0);

    let e0 = pitch_edit.get(i0).copied().unwrap_or(0.0) as f64;
    let e1 = pitch_edit.get(i1).copied().unwrap_or(0.0) as f64;

    let e0 = if e0.is_finite() && e0 > 0.0 {
        Some(e0)
    } else {
        None
    };
    let e1 = if e1.is_finite() && e1 > 0.0 {
        Some(e1)
    } else {
        None
    };

    match (e0, e1) {
        (None, None) => None,
        (Some(v), None) => Some(v),
        (None, Some(v)) => Some(v),
        (Some(a), Some(b)) => {
            let v = a + (b - a) * frac;
            if v.is_finite() && v > 0.0 {
                Some(v)
            } else {
                None
            }
        }
    }
}

fn clip_midi_at_time(
    frame_period_ms: f64,
    clip_start_sec: f64,
    clip_midi: &[f32],
    abs_time_sec: f64,
) -> f64 {
    if !(abs_time_sec.is_finite() && abs_time_sec >= clip_start_sec) {
        return 0.0;
    }

    let local_sec = abs_time_sec - clip_start_sec;
    let fp = frame_period_ms.max(0.1);
    let idx_f = (local_sec * 1000.0) / fp;
    if !(idx_f.is_finite() && idx_f >= 0.0) {
        return 0.0;
    }
    let i0 = idx_f.floor() as isize;
    if i0 < 0 {
        return 0.0;
    }
    let i0 = i0 as usize;
    if i0 >= clip_midi.len() {
        return 0.0;
    }
    let i1 = (i0 + 1).min(clip_midi.len().saturating_sub(1));
    let frac = (idx_f - (i0 as f64)).clamp(0.0, 1.0);

    let a = clip_midi.get(i0).copied().unwrap_or(0.0) as f64;
    let b = clip_midi.get(i1).copied().unwrap_or(0.0) as f64;

    let mut a = if a.is_finite() && a > 0.0 { a } else { 0.0 };
    let mut b = if b.is_finite() && b > 0.0 { b } else { 0.0 };
    if a <= 0.0 && b > 0.0 {
        a = b;
    }
    if b <= 0.0 && a > 0.0 {
        b = a;
    }
    if a <= 0.0 || b <= 0.0 {
        return 0.0;
    }

    let v = a + (b - a) * frac;
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

fn any_user_edit_in_range(
    frame_period_ms: f64,
    pitch_edit: &[f32],
    start_sec: f64,
    end_sec: f64,
) -> bool {
    let fp = frame_period_ms.max(0.1);
    let start_f = ((start_sec.max(0.0) * 1000.0) / fp).floor().max(0.0) as usize;
    let end_f = ((end_sec.max(start_sec) * 1000.0) / fp).ceil().max(0.0) as usize;
    let end_f = end_f.min(pitch_edit.len());
    if start_f >= end_f {
        return false;
    }

    let stride = ((100.0 / fp).round() as usize).max(1); // ~100ms
    let mut i = start_f;
    while i < end_f {
        let v = pitch_edit.get(i).copied().unwrap_or(0.0);
        if v.is_finite() && v > 0.0 {
            return true;
        }
        i += stride;
    }
    false
}

/// v2: Apply pitch edit to a single clip's stereo segment in-place.
///
/// Semantics:
/// - `pitch_edit[t] > 0`: target is absolute MIDI (user-set)
/// - `pitch_edit[t] == 0`: target is the clip's own original MIDI at that time (no change)
///
/// Returns whether processing was applied.
pub fn maybe_apply_pitch_edit_to_clip_segment(
    timeline: &TimelineState,
    clip: &crate::state::Clip,
    clip_start_sec: f64,
    seg_start_sec: f64,
    sample_rate: u32,
    pcm_stereo: &mut [f32],
) -> Result<bool, String> {
    if !matches!(PitchEditApplyMode::current(), PitchEditApplyMode::PerClipV2) {
        return Ok(false);
    }
    if pcm_stereo.len() < 32 {
        return Ok(false);
    }

    let selected = timeline
        .selected_track_id
        .clone()
        .or_else(|| timeline.tracks.first().map(|t| t.id.clone()))
        .unwrap_or_default();
    let Some(root) = timeline.resolve_root_track_id(&selected) else {
        return Ok(false);
    };

    let Some(clip_root) = timeline.resolve_root_track_id(&clip.track_id) else {
        return Ok(false);
    };
    if clip_root != root {
        return Ok(false);
    }

    let track = timeline.tracks.iter().find(|t| t.id == root);
    let Some(track) = track else {
        return Ok(false);
    };
    if !track.compose_enabled {
        return Ok(false);
    }

    let algo = PitchEditAlgorithm::from_track_algo(&track.pitch_analysis_algo);
    if matches!(algo, PitchEditAlgorithm::Bypass) {
        return Ok(false);
    }

    let entry = timeline.params_by_root_track.get(&root);
    let Some(entry) = entry else {
        return Ok(false);
    };

    let frame_period_ms = entry.frame_period_ms.max(0.1);
    let pitch_edit = entry.pitch_edit.as_slice();

    // Quick skip when user never set a target in this segment window.
    let seg_frames = pcm_stereo.len() / 2;
    let seg_end_sec = seg_start_sec + (seg_frames as f64) / (sample_rate.max(1) as f64);
    if !any_user_edit_in_range(frame_period_ms, pitch_edit, seg_start_sec, seg_end_sec) {
        return Ok(false);
    }

    // Get per-clip original MIDI curve (timeline-aligned, includes pre-silence shift).
    let clip_pitch = crate::pitch_clip::get_or_compute_clip_pitch_midi_global(
        timeline,
        clip,
        &root,
        frame_period_ms,
    );
    let Some(clip_pitch) = clip_pitch else {
        return Ok(false);
    };

    // stereo -> mono
    let frames = seg_frames;
    let mut mono: Vec<f32> = Vec::with_capacity(frames);
    for f in 0..frames {
        mono.push((pcm_stereo[f * 2] + pcm_stereo[f * 2 + 1]) * 0.5);
    }

    let processed = match algo {
        PitchEditAlgorithm::WorldVocoder => {
            if !crate::world_vocoder::is_available() {
                return Ok(false);
            }
            let f0_floor = 40.0;
            let f0_ceil = 1600.0;
            crate::world_vocoder::vocode_pitch_shift_chunked(
                &mono,
                sample_rate,
                seg_start_sec,
                frame_period_ms,
                f0_floor,
                f0_ceil,
                |abs_time_sec| {
                    let orig = clip_midi_at_time(
                        frame_period_ms,
                        clip_start_sec,
                        &clip_pitch.midi,
                        abs_time_sec,
                    );
                    if !(orig.is_finite() && orig > 0.0) {
                        return 0.0;
                    }
                    let target = match edit_midi_at_time_or_none(
                        frame_period_ms,
                        pitch_edit,
                        abs_time_sec,
                    ) {
                        Some(v) => v,
                        None => orig,
                    };
                    let shift = (target - orig).clamp(-24.0, 24.0);
                    if shift.is_finite() {
                        shift
                    } else {
                        0.0
                    }
                },
            )?
        }
        PitchEditAlgorithm::NsfHifiganOnnx => {
            if !crate::nsf_hifigan_onnx::is_available() {
                return Ok(false);
            }
            crate::nsf_hifigan_onnx::infer_pitch_edit_mono(
                &mono,
                sample_rate,
                seg_start_sec,
                |abs_time_sec| {
                    let orig = clip_midi_at_time(
                        frame_period_ms,
                        clip_start_sec,
                        &clip_pitch.midi,
                        abs_time_sec,
                    );
                    if !(orig.is_finite() && orig > 0.0) {
                        return 0.0;
                    }
                    let target = match edit_midi_at_time_or_none(
                        frame_period_ms,
                        pitch_edit,
                        abs_time_sec,
                    ) {
                        Some(v) => v,
                        None => orig,
                    };
                    if target.is_finite() && target > 0.0 {
                        target
                    } else {
                        0.0
                    }
                },
            )?
        }
        PitchEditAlgorithm::Bypass => return Ok(false),
    };

    if processed.len() != mono.len() {
        return Err("pitch_edit: output length mismatch".to_string());
    }

    for f in 0..frames {
        let v = processed[f];
        pcm_stereo[f * 2] = v;
        pcm_stereo[f * 2 + 1] = v;
    }

    Ok(true)
}

#[derive(Clone)]
struct PitchCurvesView<'a> {
    frame_period_ms: f64,
    pitch_orig: &'a [f32],
    pitch_edit: &'a [f32],
}

impl<'a> PitchCurvesView<'a> {
    fn midi_at_time(&self, abs_time_sec: f64) -> f64 {
        if !(abs_time_sec.is_finite() && abs_time_sec >= 0.0) {
            return 0.0;
        }

        let fp = self.frame_period_ms.max(0.1);
        let idx_f = (abs_time_sec * 1000.0) / fp;
        if !(idx_f.is_finite() && idx_f >= 0.0) {
            return 0.0;
        }
        let i0 = idx_f.floor() as isize;
        if i0 < 0 {
            return 0.0;
        }
        let i0 = i0 as usize;
        if i0 >= self.pitch_orig.len() {
            return 0.0;
        }
        let i1 = (i0 + 1).min(self.pitch_orig.len().saturating_sub(1));
        let frac = (idx_f - (i0 as f64)).clamp(0.0, 1.0);

        let orig0 = self.pitch_orig[i0] as f64;
        let orig1 = self.pitch_orig[i1] as f64;
        let edit0 = self.pitch_edit.get(i0).copied().unwrap_or(0.0) as f64;
        let edit1 = self.pitch_edit.get(i1).copied().unwrap_or(0.0) as f64;

        // For ONNX, `pitch_edit` is treated as an absolute target MIDI curve.
        // Allow it to work even when `pitch_orig` is missing (all zeros).
        let mut base0 = if edit0.is_finite() && edit0 > 0.0 {
            edit0
        } else {
            orig0
        };
        let mut base1 = if edit1.is_finite() && edit1 > 0.0 {
            edit1
        } else {
            orig1
        };

        if !(base0.is_finite() && base0 > 0.0) && (base1.is_finite() && base1 > 0.0) {
            base0 = base1;
        }
        if !(base1.is_finite() && base1 > 0.0) && (base0.is_finite() && base0 > 0.0) {
            base1 = base0;
        }
        if !(base0.is_finite() && base0 > 0.0 && base1.is_finite() && base1 > 0.0) {
            return 0.0;
        }

        let v = base0 + (base1 - base0) * frac;
        if v.is_finite() {
            v
        } else {
            0.0
        }
    }

    fn semitone_shift_at_time(&self, abs_time_sec: f64) -> f64 {
        if !(abs_time_sec.is_finite() && abs_time_sec >= 0.0) {
            return 0.0;
        }

        let fp = self.frame_period_ms.max(0.1);
        // NOTE: Use linear interpolation between adjacent frames to reduce
        // audible "zipper" noise when pitch_edit changes over time.
        let idx_f = (abs_time_sec * 1000.0) / fp;
        if !(idx_f.is_finite() && idx_f >= 0.0) {
            return 0.0;
        }
        let i0 = idx_f.floor() as isize;
        if i0 < 0 {
            return 0.0;
        }
        let i0 = i0 as usize;
        if i0 >= self.pitch_orig.len() {
            return 0.0;
        }
        let i1 = (i0 + 1).min(self.pitch_orig.len().saturating_sub(1));
        let frac = (idx_f - (i0 as f64)).clamp(0.0, 1.0);

        let orig0 = self.pitch_orig[i0] as f64;
        let orig1 = self.pitch_orig[i1] as f64;
        if !(orig0.is_finite() && orig1.is_finite() && orig0 > 0.0 && orig1 > 0.0) {
            return 0.0;
        }

        let mut edit0 = self.pitch_edit.get(i0).copied().unwrap_or(0.0) as f64;
        let mut edit1 = self.pitch_edit.get(i1).copied().unwrap_or(0.0) as f64;
        // Treat 0 as "unset" (UI never intentionally sets 0 MIDI).
        if edit0 == 0.0 {
            edit0 = orig0;
        }
        if edit1 == 0.0 {
            edit1 = orig1;
        }

        let shift0 = edit0 - orig0;
        let shift1 = edit1 - orig1;
        let shift = shift0 + (shift1 - shift0) * frac;
        if shift.is_finite() {
            shift.clamp(-24.0, 24.0)
        } else {
            0.0
        }
    }

    fn any_nonzero_shift_in_range(&self, start_sec: f64, end_sec: f64) -> bool {
        let fp = self.frame_period_ms.max(0.1);
        let start_f = ((start_sec.max(0.0) * 1000.0) / fp).floor().max(0.0) as usize;
        let end_f = ((end_sec.max(start_sec) * 1000.0) / fp).ceil().max(0.0) as usize;
        let end_f = end_f.min(self.pitch_orig.len());
        if start_f >= end_f {
            return false;
        }

        // Stride to keep this cheap.
        let stride = ((100.0 / fp).round() as usize).max(1); // ~100ms
        let mut i = start_f;
        while i < end_f {
            if self.semitone_shift_at_time((i as f64) * fp / 1000.0).abs() > 1e-3 {
                return true;
            }
            i += stride;
        }
        false
    }

    fn any_nonzero_onnx_target_in_range(&self, start_sec: f64, end_sec: f64) -> bool {
        let fp = self.frame_period_ms.max(0.1);
        let start_f = ((start_sec.max(0.0) * 1000.0) / fp).floor().max(0.0) as usize;
        let end_f = ((end_sec.max(start_sec) * 1000.0) / fp).ceil().max(0.0) as usize;

        let len = self.pitch_orig.len().min(self.pitch_edit.len().max(1));
        let end_f = end_f.min(len);
        if start_f >= end_f {
            return false;
        }

        let stride = ((100.0 / fp).round() as usize).max(1); // ~100ms
        let mut i = start_f;
        while i < end_f {
            let orig = self.pitch_orig.get(i).copied().unwrap_or(0.0) as f64;
            let edit = self.pitch_edit.get(i).copied().unwrap_or(0.0) as f64;
            let target = if edit.is_finite() && edit > 0.0 {
                edit
            } else {
                orig
            };

            if target.is_finite() && target > 0.0 {
                if !(orig.is_finite() && orig > 0.0) {
                    // No orig curve available but user has a target.
                    if edit.is_finite() && edit > 0.0 {
                        return true;
                    }
                } else if edit.is_finite() && edit > 0.0 && (edit - orig).abs() > 1e-3 {
                    return true;
                }
            }

            i += stride;
        }
        false
    }
}

/// Applies pitch edit curve to an interleaved mixdown buffer in-place.
///
/// Current behavior (v1):
/// - Uses selected track's root `pitch_orig/pitch_edit` curves.
/// - Only runs when `compose_enabled` is true.
/// - WORLD-vocoder based (CheapTrick+D4C+Synthesis).
/// - Processes the *mixdown* as mono and writes back to all channels.
pub fn apply_pitch_edit_to_mixdown(
    timeline: &TimelineState,
    start_sec: f64,
    sample_rate: u32,
    channels: usize,
    pcm_interleaved: &mut [f32],
) -> Result<bool, String> {
    if channels == 0 {
        return Ok(false);
    }

    let frames = pcm_interleaved.len() / channels;
    if frames < 16 {
        return Ok(false);
    }

    let selected = timeline
        .selected_track_id
        .clone()
        .or_else(|| timeline.tracks.first().map(|t| t.id.clone()))
        .unwrap_or_default();
    let Some(root) = timeline.resolve_root_track_id(&selected) else {
        return Ok(false);
    };

    let track = timeline.tracks.iter().find(|t| t.id == root);
    let Some(track) = track else {
        return Ok(false);
    };
    if !track.compose_enabled {
        return Ok(false);
    }

    let algo = PitchEditAlgorithm::from_track_algo(&track.pitch_analysis_algo);
    if matches!(algo, PitchEditAlgorithm::Bypass) {
        return Ok(false);
    }

    let entry = timeline.params_by_root_track.get(&root);
    let Some(entry) = entry else {
        return Ok(false);
    };

    let curves = PitchCurvesView {
        frame_period_ms: entry.frame_period_ms.max(0.1),
        pitch_orig: &entry.pitch_orig,
        pitch_edit: &entry.pitch_edit,
    };

    let duration_sec = frames as f64 / (sample_rate.max(1) as f64);
    let end_sec = start_sec.max(0.0) + duration_sec;

    match algo {
        PitchEditAlgorithm::WorldVocoder => {
            if !curves.any_nonzero_shift_in_range(start_sec, end_sec) {
                return Ok(false);
            }
        }
        PitchEditAlgorithm::NsfHifiganOnnx => {
            if !curves.any_nonzero_onnx_target_in_range(start_sec, end_sec) {
                return Ok(false);
            }
        }
        PitchEditAlgorithm::Bypass => return Ok(false),
    }

    // Interleaved -> mono.
    let mut mono = Vec::with_capacity(frames);
    for f in 0..frames {
        let base = f * channels;
        let mut sum = 0.0f64;
        for ch in 0..channels {
            sum += pcm_interleaved[base + ch] as f64;
        }
        mono.push((sum / channels as f64) as f32);
    }

    let fp_ms = curves.frame_period_ms;
    let processed = match algo {
        PitchEditAlgorithm::WorldVocoder => {
            // Match python demo defaults (utils/wav2F0.py): f0_min=40, f0_max=1600.
            let f0_floor = 40.0;
            let f0_ceil = 1600.0;
            crate::world_vocoder::vocode_pitch_shift_chunked(
                &mono,
                sample_rate,
                start_sec,
                fp_ms,
                f0_floor,
                f0_ceil,
                |abs_time_sec| curves.semitone_shift_at_time(abs_time_sec),
            )?
        }
        PitchEditAlgorithm::NsfHifiganOnnx => crate::nsf_hifigan_onnx::infer_pitch_edit_mono(
            &mono,
            sample_rate,
            start_sec,
            |abs_time_sec| curves.midi_at_time(abs_time_sec),
        )?,
        PitchEditAlgorithm::Bypass => return Ok(false),
    };

    if processed.len() != mono.len() {
        return Err("pitch_edit: WORLD output length mismatch".to_string());
    }

    // mono -> interleaved (write to all channels).
    for (f, frame) in pcm_interleaved
        .chunks_exact_mut(channels)
        .enumerate()
        .take(frames)
    {
        let v = processed[f];
        frame.fill(v);
    }

    Ok(true)
}

pub fn is_pitch_edit_active(timeline: &TimelineState) -> bool {
    let selected = timeline
        .selected_track_id
        .clone()
        .or_else(|| timeline.tracks.first().map(|t| t.id.clone()))
        .unwrap_or_default();
    let Some(root) = timeline.resolve_root_track_id(&selected) else {
        return false;
    };

    let track = timeline.tracks.iter().find(|t| t.id == root);
    let Some(track) = track else {
        return false;
    };
    if !track.compose_enabled {
        return false;
    }

    let algo = PitchEditAlgorithm::from_track_algo(&track.pitch_analysis_algo);
    if matches!(algo, PitchEditAlgorithm::Bypass) {
        return false;
    }

    let entry = timeline.params_by_root_track.get(&root);
    let Some(entry) = entry else {
        return false;
    };

    let curves = PitchCurvesView {
        frame_period_ms: entry.frame_period_ms.max(0.1),
        pitch_orig: &entry.pitch_orig,
        pitch_edit: &entry.pitch_edit,
    };

    // Cheap global check: scan with ~100ms stride.
    match algo {
        PitchEditAlgorithm::WorldVocoder => {
            curves.any_nonzero_shift_in_range(0.0, timeline.project_duration_sec())
        }
        PitchEditAlgorithm::NsfHifiganOnnx => {
            curves.any_nonzero_onnx_target_in_range(0.0, timeline.project_duration_sec())
        }
        PitchEditAlgorithm::Bypass => false,
    }
}

pub fn is_pitch_edit_backend_available(timeline: &TimelineState) -> bool {
    let selected = timeline
        .selected_track_id
        .clone()
        .or_else(|| timeline.tracks.first().map(|t| t.id.clone()))
        .unwrap_or_default();
    let Some(root) = timeline.resolve_root_track_id(&selected) else {
        return false;
    };

    let track = timeline.tracks.iter().find(|t| t.id == root);
    let Some(track) = track else {
        return false;
    };

    let algo = PitchEditAlgorithm::from_track_algo(&track.pitch_analysis_algo);
    match algo {
        PitchEditAlgorithm::WorldVocoder => crate::world_vocoder::is_available(),
        PitchEditAlgorithm::NsfHifiganOnnx => crate::nsf_hifigan_onnx::is_available(),
        PitchEditAlgorithm::Bypass => true,
    }
}

pub fn semitone_to_ratio(semitones: f64) -> f64 {
    semitone_ratio(semitones)
}

pub fn is_pitch_edit_mixdown_v1() -> bool {
    matches!(PitchEditApplyMode::current(), PitchEditApplyMode::MixdownV1)
}
