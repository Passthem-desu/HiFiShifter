use crate::state::{AppState, Clip, PitchAnalysisAlgo, TimelineState};
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use tauri::{Emitter, Manager};

fn hz_to_midi(hz: f64) -> f32 {
    if !(hz.is_finite() && hz > 1e-6) {
        return 0.0;
    }
    let midi = 69.0 + 12.0 * (hz / 440.0).log2();
    if midi.is_finite() {
        midi as f32
    } else {
        0.0
    }
}

fn quantize_i64(x: f64, scale: f64) -> i64 {
    if !x.is_finite() {
        return 0;
    }
    (x * scale).round() as i64
}

fn quantize_u32(x: f64, scale: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    let v = (x * scale).round();
    if v <= 0.0 {
        0
    } else if v > (u32::MAX as f64) {
        u32::MAX
    } else {
        v as u32
    }
}

fn file_sig(path: &Path) -> (u64, u64) {
    // (len_bytes, modified_ms_since_epoch)
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return (0, 0),
    };
    let len = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    (len, mtime_ms)
}

fn build_root_pitch_key(tl: &TimelineState, root_track_id: &str) -> String {
    let bpm = if tl.bpm.is_finite() && tl.bpm > 0.0 {
        tl.bpm
    } else {
        120.0
    };

    let mut hasher = blake3::Hasher::new();
    hasher.update(b"pitch_orig_v2_clip_fuse");
    hasher.update(root_track_id.as_bytes());
    hasher.update(&quantize_u32(bpm, 1000.0).to_le_bytes());
    hasher.update(&quantize_u32(tl.frame_period_ms(), 1000.0).to_le_bytes());

    // Include track-level analysis config.
    let (compose, algo) = tl
        .tracks
        .iter()
        .find(|t| t.id == root_track_id)
        .map(|t| (t.compose_enabled, t.pitch_analysis_algo.clone()))
        .unwrap_or((false, PitchAnalysisAlgo::Unknown));
    hasher.update(&[if compose { 1 } else { 0 }]);
    hasher.update(match algo {
        PitchAnalysisAlgo::WorldDll => b"world_dll",
        PitchAnalysisAlgo::NsfHifiganOnnx => b"nsf_hifigan_onnx",
        PitchAnalysisAlgo::None => b"none",
        PitchAnalysisAlgo::Unknown => b"unknown",
    });

    // If WORLD is selected, include its availability so we can cache the
    // unavailable state but still recompute when the DLL becomes available.
    if matches!(
        algo,
        PitchAnalysisAlgo::WorldDll
            | PitchAnalysisAlgo::NsfHifiganOnnx
            | PitchAnalysisAlgo::Unknown
    ) {
        hasher.update(&[if crate::world::is_available() { 1 } else { 0 }]);
    }

    // Include each clip mapped to this root track.
    // Sort by clip id for stability.
    let mut clips: Vec<&Clip> = tl
        .clips
        .iter()
        .filter(|c| tl.resolve_root_track_id(&c.track_id).as_deref() == Some(root_track_id))
        .collect();
    clips.sort_by(|a, b| a.id.cmp(&b.id));

    for c in clips {
        hasher.update(c.id.as_bytes());
        hasher.update(&quantize_u32(c.start_beat, 1000.0).to_le_bytes());
        hasher.update(&quantize_u32(c.length_beats, 1000.0).to_le_bytes());
        hasher.update(&quantize_u32(c.playback_rate as f64, 10000.0).to_le_bytes());
        hasher.update(&quantize_i64(c.trim_start_beat, 1000.0).to_le_bytes());
        hasher.update(&quantize_u32(c.trim_end_beat, 1000.0).to_le_bytes());
        if let Some(sp) = c.source_path.as_deref() {
            hasher.update(sp.as_bytes());
            let p = Path::new(sp);
            let (len, mtime) = file_sig(p);
            hasher.update(&len.to_le_bytes());
            hasher.update(&mtime.to_le_bytes());
        } else {
            hasher.update(b"(no_source)");
        }
    }

    hasher.finalize().to_hex().to_string()
}

#[derive(Debug, Clone)]
struct PitchJob {
    root_track_id: String,
    key: String,
    frame_period_ms: f64,
    target_frames: usize,
    algo: PitchAnalysisAlgo,

    /// Root-subtree timeline snapshot used for root-mix analysis.
    /// This matches what the parameter panel background waveform shows.
    timeline: TimelineState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchOrigUpdatedEvent {
    pub root_track_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchOrigAnalysisStartedEvent {
    pub root_track_id: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchOrigAnalysisProgressEvent {
    pub root_track_id: String,
    pub progress: f32,
}

fn resample_curve_linear(values: &[f32], out_len: usize) -> Vec<f32> {
    if out_len == 0 {
        return vec![];
    }
    if values.is_empty() {
        return vec![0.0; out_len];
    }
    if values.len() == out_len {
        return values.to_vec();
    }
    if values.len() == 1 {
        return vec![values[0]; out_len];
    }
    if out_len == 1 {
        return vec![values[0]];
    }

    let in_len = values.len();
    let scale = (in_len - 1) as f64 / (out_len - 1) as f64;
    let mut out = vec![0.0f32; out_len];
    for (of, out_v) in out.iter_mut().enumerate() {
        let t_in = (of as f64) * scale;
        let i0 = t_in.floor() as usize;
        let i1 = (i0 + 1).min(in_len - 1);
        let frac = (t_in - (i0 as f64)) as f32;
        let a = values[i0];
        let b = values[i1];
        *out_v = a + (b - a) * frac;
    }
    out
}

fn build_root_mix_timeline(tl: &TimelineState, root_track_id: &str) -> TimelineState {
    // Collect root + descendants.
    let mut included: HashSet<String> = HashSet::new();
    included.insert(root_track_id.to_string());
    let mut idx = 0usize;
    let mut frontier = vec![root_track_id.to_string()];
    while idx < frontier.len() {
        let cur = frontier[idx].clone();
        for child in tl
            .tracks
            .iter()
            .filter(|t| t.parent_id.as_deref() == Some(cur.as_str()))
            .map(|t| t.id.clone())
            .collect::<Vec<_>>()
        {
            if included.insert(child.clone()) {
                frontier.push(child);
            }
        }
        idx += 1;
        if idx > 4096 {
            break;
        }
    }

    let mut out = tl.clone();
    out.tracks.retain(|t| included.contains(&t.id));
    out.clips.retain(|c| included.contains(&c.track_id));

    // Background waveform ignores mute/solo; pitch analysis should match that.
    for t in &mut out.tracks {
        t.muted = false;
        t.solo = false;
    }
    for c in &mut out.clips {
        c.muted = false;
    }

    // Avoid cloning large curve buffers into the job.
    out.params_by_root_track.clear();
    out
}

fn build_pitch_job(tl: &TimelineState, root_track_id: &str) -> Option<PitchJob> {
    let fp = tl.frame_period_ms();
    let target = tl.target_param_frames(fp);

    let (compose_enabled, algo) = tl
        .tracks
        .iter()
        .find(|t| t.id == root_track_id)
        .map(|t| (t.compose_enabled, t.pitch_analysis_algo.clone()))
        .unwrap_or((false, PitchAnalysisAlgo::Unknown));
    if !compose_enabled {
        return None;
    }
    if matches!(algo, PitchAnalysisAlgo::None) {
        return None;
    }

    let key = build_root_pitch_key(tl, root_track_id);

    // If already up-to-date, do nothing.
    let is_up_to_date = tl
        .params_by_root_track
        .get(root_track_id)
        .map(|e| e.pitch_orig_key.as_deref() == Some(&key) && e.pitch_orig.len() == target)
        .unwrap_or(false);
    if is_up_to_date {
        return None;
    }

    let mix_timeline = build_root_mix_timeline(tl, root_track_id);

    Some(PitchJob {
        root_track_id: root_track_id.to_string(),
        key,
        frame_period_ms: fp,
        target_frames: target,
        algo,
        timeline: mix_timeline,
    })
}

fn compute_pitch_curve(job: &PitchJob, mut on_progress: impl FnMut(f32)) -> Vec<f32> {
    let debug = std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1");

    on_progress(0.02);

    // If WORLD isn't available, return zeros.
    if matches!(
        job.algo,
        PitchAnalysisAlgo::WorldDll
            | PitchAnalysisAlgo::NsfHifiganOnnx
            | PitchAnalysisAlgo::Unknown
    ) && !crate::world::is_available()
    {
        if debug {
            eprintln!(
                "pitch: WORLD unavailable; return zeros (root_track_id={} key={} frames={})",
                job.root_track_id, job.key, job.target_frames
            );
        }
        return vec![0.0; job.target_frames];
    }

    let mut out = vec![0.0f32; job.target_frames];

    let project_sec = job.timeline.project_duration_sec();
    if project_sec <= 1e-9 {
        return out;
    }

    if debug {
        eprintln!(
            "pitch: start analysis v2 (root_track_id={} key={} clips={} frames={} fp_ms={} algo={:?})",
            job.root_track_id,
            job.key,
            job.timeline.clips.len(),
            job.target_frames,
            job.frame_period_ms,
            job.algo
        );
    }

    // Strategy (v2): analyze per-clip pitch in timeline time, then fuse to a single
    // root curve by choosing the dominant (highest-weight) voiced clip each frame.
    // This avoids WORLD instability on overlap regions.

    // Match python demo defaults (utils/wav2F0.py): f0_min=40, f0_max=1600.
    let f0_floor = 40.0;
    let f0_ceil = 1600.0;
    let frame_period_tl_ms = job.frame_period_ms.max(0.1);

    let prefer = std::env::var("HIFISHIFTER_WORLD_F0")
        .ok()
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "harvest".to_string());

    fn beat_sec(bpm: f64) -> f64 {
        60.0 / bpm.max(1e-6)
    }

    fn clamp01(x: f32) -> f32 {
        x.clamp(0.0, 1.0)
    }

    #[allow(clippy::too_many_arguments)]
    fn clip_weight_at_frame(
        clip: &Clip,
        bpm: f64,
        sample_rate: u32,
        _clip_start_sec: f64,
        pre_silence_sec: f64,
        clip_total_frames: usize,
        local_in_clip_frames: usize,
        track_gain_value: f32,
    ) -> f32 {
        let bs = beat_sec(bpm);
        let gain = (clip.gain.max(0.0) * track_gain_value).clamp(0.0, 4.0);
        if gain <= 0.0 {
            return 0.0;
        }

        let fade_in_frames = ((clip.fade_in_beats.max(0.0) * bs) * sample_rate as f64)
            .round()
            .max(0.0) as usize;
        let fade_out_frames = ((clip.fade_out_beats.max(0.0) * bs) * sample_rate as f64)
            .round()
            .max(0.0) as usize;

        let pre_silence_frames = (pre_silence_sec * sample_rate as f64).round().max(0.0) as usize;
        let local_in_clip = pre_silence_frames.saturating_add(local_in_clip_frames);
        if local_in_clip >= clip_total_frames {
            return 0.0;
        }

        let mut g = gain;
        if fade_in_frames > 0 && local_in_clip < fade_in_frames {
            g *= (local_in_clip as f32 / fade_in_frames as f32).clamp(0.0, 1.0);
        }
        if fade_out_frames > 0 && local_in_clip + fade_out_frames > clip_total_frames {
            let remain = clip_total_frames.saturating_sub(local_in_clip);
            g *= (remain as f32 / fade_out_frames as f32).clamp(0.0, 1.0);
        }

        // Also drop weight before the audible segment start (pre_silence).
        if local_in_clip < pre_silence_frames {
            g = 0.0;
        }

        // Prevent pathological values.
        g.clamp(0.0, 4.0)
    }

    // Track gains (mute/solo already cleared in build_root_mix_timeline).
    let mut track_gain: std::collections::HashMap<String, f32> = std::collections::HashMap::new();
    for t in &job.timeline.tracks {
        track_gain.insert(t.id.clone(), clamp01(t.volume));
    }

    let bpm = job.timeline.bpm;
    if !(bpm.is_finite() && bpm > 0.0) {
        return out;
    }
    let bs = beat_sec(bpm);

    // Winner-take-most fusion with hysteresis to avoid rapid switching.
    let mut last_winner: Option<String> = None;
    let mut _last_winner_weight: f32 = 0.0;

    // We need per-frame candidate pitches + weights.
    // Do per-clip analysis first; keep in memory as MIDI curve in timeline frames.
    struct ClipPitch {
        clip_id: String,
        start_sec: f64,
        end_sec: f64,
        pre_silence_sec: f64,
        clip_total_frames: usize,
        midi: Vec<f32>,
        track_gain_value: f32,
    }

    let mut clip_pitches: Vec<ClipPitch> = Vec::new();

    for clip in &job.timeline.clips {
        let Some(source_path) = clip.source_path.as_ref() else {
            continue;
        };

        // Timeline placement.
        let clip_start_sec = (clip.start_beat.max(0.0)) * bs;
        let clip_timeline_len_sec = (clip.length_beats.max(0.0)) * bs;
        if !(clip_timeline_len_sec.is_finite() && clip_timeline_len_sec > 0.0) {
            continue;
        }
        let clip_end_sec = clip_start_sec + clip_timeline_len_sec;

        // Decode audio.
        let (in_rate, in_channels, pcm) =
            match crate::audio_utils::decode_audio_f32_interleaved(Path::new(source_path)) {
                Ok(v) => v,
                Err(_) => continue,
            };
        let in_channels_usize = (in_channels as usize).max(1);
        let in_frames = pcm.len() / in_channels_usize;
        if in_frames < 2 {
            continue;
        }

        let playback_rate = clip.playback_rate as f64;
        let playback_rate = if playback_rate.is_finite() && playback_rate > 0.0 {
            playback_rate
        } else {
            1.0
        };

        // Source trimming in beats -> sec.
        let trim_start_beats_src = clip.trim_start_beat.max(0.0);
        let trim_end_beats_src = clip.trim_end_beat.max(0.0);
        let pre_silence_beats_src = (-clip.trim_start_beat).max(0.0);

        let trim_start_sec = trim_start_beats_src * bs;
        let trim_end_sec = trim_end_beats_src * bs;
        let pre_silence_sec = (pre_silence_beats_src * bs) / playback_rate.max(1e-6);

        let total_sec = (in_frames as f64) / (in_rate.max(1) as f64);
        if !(total_sec.is_finite() && total_sec > 0.0) {
            continue;
        }

        let src_end_limit_sec = (total_sec - trim_end_sec).max(trim_start_sec);
        if src_end_limit_sec - trim_start_sec <= 1e-9 {
            continue;
        }

        let src_i0 = (trim_start_sec * in_rate as f64).floor().max(0.0) as usize;
        let src_i1 = (src_end_limit_sec * in_rate as f64)
            .ceil()
            .max(src_i0 as f64) as usize;
        let src_i1 = src_i1.min(in_frames);
        if src_i1 <= src_i0 + 1 {
            continue;
        }

        let segment = &pcm[(src_i0 * in_channels_usize)..(src_i1 * in_channels_usize)];

        // Resample to analysis rate (44100) and convert to mono.
        let segment =
            crate::mixdown::linear_resample_interleaved(segment, in_channels_usize, in_rate, 44100);

        let seg_frames = segment.len() / in_channels_usize;
        if seg_frames < 2 {
            continue;
        }

        let mut mono_raw: Vec<f64> = Vec::with_capacity(seg_frames);
        for f in 0..seg_frames {
            let base = f * in_channels_usize;
            let mut sum = 0.0f64;
            for c in 0..in_channels_usize {
                sum += segment[base + c] as f64;
            }
            mono_raw.push(sum / in_channels_usize as f64);
        }

        // Preprocess: remove DC and clamp.
        let mut mean = 0.0f64;
        for &v in &mono_raw {
            mean += v;
        }
        mean /= mono_raw.len().max(1) as f64;

        let mut max_abs = 0.0f64;
        for &v in &mono_raw {
            let vv = v - mean;
            let a = vv.abs();
            if a.is_finite() && a > max_abs {
                max_abs = a;
            }
        }
        let scale = if max_abs.is_finite() && max_abs > 1.0 {
            (1.0 / max_abs).clamp(0.0, 1.0)
        } else {
            1.0
        };

        let mut mono: Vec<f64> = Vec::with_capacity(mono_raw.len());
        for &v in &mono_raw {
            let vv = (v - mean) * scale;
            mono.push(vv.clamp(-1.0, 1.0));
        }

        // Compute f0.
        let fs_i32 = 44100i32;
        let f0_hz: Vec<f64> = {
            let try_harvest = || {
                crate::world::compute_f0_hz_harvest(
                    &mono,
                    fs_i32,
                    frame_period_tl_ms,
                    f0_floor,
                    f0_ceil,
                )
            };
            let try_dio = || {
                crate::world::compute_f0_hz_dio_stonemask(
                    &mono,
                    fs_i32,
                    frame_period_tl_ms,
                    f0_floor,
                    f0_ceil,
                )
            };

            let res = if prefer == "dio" {
                try_dio().or_else(|_| try_harvest())
            } else {
                try_harvest().or_else(|_| try_dio())
            };

            res.unwrap_or_default()
        };

        if f0_hz.len() < 2 {
            continue;
        }

        // Convert to MIDI, keep unvoiced as 0.
        let mut midi: Vec<f32> = Vec::with_capacity(f0_hz.len());
        for hz in f0_hz {
            midi.push(hz_to_midi(hz));
        }

        // Time-align: analysis output is on the segment timeline. We need it in clip timeline time.
        // For now, resample to the clip's timeline length in frames.
        let clip_frames = ((clip_timeline_len_sec * 1000.0) / frame_period_tl_ms)
            .round()
            .max(1.0) as usize;
        let midi = resample_curve_linear(&midi, clip_frames);

        let tg = track_gain.get(&clip.track_id).copied().unwrap_or(1.0);

        clip_pitches.push(ClipPitch {
            clip_id: clip.id.clone(),
            start_sec: clip_start_sec,
            end_sec: clip_end_sec,
            pre_silence_sec,
            clip_total_frames: ((clip_timeline_len_sec * 44100.0).round().max(1.0)) as usize,
            midi,
            track_gain_value: tg,
        });
    }

    on_progress(0.85);

    // Fuse to root curve.
    for (frame_idx, out_v) in out.iter_mut().enumerate() {
        if frame_idx >= job.target_frames {
            break;
        }
        let abs_time_sec = (frame_idx as f64) * frame_period_tl_ms / 1000.0;

        let mut best_id: Option<&str> = None;
        let mut best_weight: f32 = 0.0;
        let mut best_pitch: f32 = 0.0;

        for cp in &clip_pitches {
            if abs_time_sec < cp.start_sec || abs_time_sec >= cp.end_sec {
                continue;
            }

            // Local time inside the clip in seconds.
            let local_sec = abs_time_sec - cp.start_sec;
            let local_frame = ((local_sec * 1000.0) / frame_period_tl_ms).round().max(0.0) as usize;
            let p = cp.midi.get(local_frame).copied().unwrap_or(0.0);
            if !(p.is_finite() && p > 0.0) {
                continue;
            }

            // Weight with fade semantics.
            // We approximate local-in-segment frames with 44.1kHz timeline frames for fades.
            let local_in_clip_frames = ((local_sec * 44100.0).round().max(0.0)) as usize;

            // Need clip struct; use a lookup.
            let Some(clip) = job.timeline.clips.iter().find(|c| c.id == cp.clip_id) else {
                continue;
            };

            let w = clip_weight_at_frame(
                clip,
                bpm,
                44100,
                cp.start_sec,
                cp.pre_silence_sec,
                cp.clip_total_frames,
                local_in_clip_frames,
                cp.track_gain_value,
            );
            if w <= 0.0 {
                continue;
            }

            if w > best_weight {
                best_weight = w;
                best_id = Some(cp.clip_id.as_str());
                best_pitch = p;
            }
        }

        // Hysteresis: prefer sticking with the previous winner unless clearly beaten.
        let hysteresis_ratio: f32 = 1.10;
        if let Some(prev_id) = last_winner.as_deref() {
            if let Some(best_id_now) = best_id {
                if prev_id != best_id_now {
                    // Recompute prev weight quickly.
                    let mut prev_weight = 0.0f32;
                    let mut prev_pitch = 0.0f32;
                    if let Some(cp) = clip_pitches.iter().find(|c| c.clip_id == prev_id) {
                        if abs_time_sec >= cp.start_sec && abs_time_sec < cp.end_sec {
                            let local_sec = abs_time_sec - cp.start_sec;
                            let local_frame = ((local_sec * 1000.0) / frame_period_tl_ms)
                                .round()
                                .max(0.0) as usize;
                            prev_pitch = cp.midi.get(local_frame).copied().unwrap_or(0.0);
                            if prev_pitch > 0.0 {
                                let local_in_clip_frames =
                                    ((local_sec * 44100.0).round().max(0.0)) as usize;
                                if let Some(clip) =
                                    job.timeline.clips.iter().find(|c| c.id == cp.clip_id)
                                {
                                    prev_weight = clip_weight_at_frame(
                                        clip,
                                        bpm,
                                        44100,
                                        cp.start_sec,
                                        cp.pre_silence_sec,
                                        cp.clip_total_frames,
                                        local_in_clip_frames,
                                        cp.track_gain_value,
                                    );
                                }
                            }
                        }
                    }

                    if prev_weight.is_finite()
                        && prev_weight > 0.0
                        && best_weight < prev_weight * hysteresis_ratio
                    {
                        *out_v = prev_pitch;
                        _last_winner_weight = prev_weight;
                        continue;
                    }
                }
            }
        }

        if let Some(id) = best_id {
            *out_v = best_pitch;
            last_winner = Some(id.to_string());
            _last_winner_weight = best_weight;
        } else {
            *out_v = 0.0;
            last_winner = None;
            _last_winner_weight = 0.0;
        }
    }

    on_progress(1.0);

    if debug {
        let any_nonzero = out.iter().any(|&v| v.is_finite() && v > 0.0);
        eprintln!(
            "pitch: done analysis v2 (root_track_id={} key={} any_nonzero={})",
            job.root_track_id, job.key, any_nonzero
        );
    }

    out
}

/// Returns whether pitch analysis is currently pending (scheduled or already inflight).
pub fn maybe_schedule_pitch_orig(state: &AppState, root_track_id: &str) -> bool {
    // Build job snapshot under timeline lock, then release lock for heavy work.
    let job = {
        let tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
        build_pitch_job(&tl, root_track_id)
    };

    let Some(job) = job else {
        return false;
    };

    // De-dup inflight.
    let inflight_key = format!("{}|{}", job.root_track_id, job.key);
    let should_spawn = if let Ok(mut set) = state.pitch_inflight.lock() {
        if set.contains(&inflight_key) {
            false
        } else {
            set.insert(inflight_key.clone());
            true
        }
    } else {
        false
    };
    if !should_spawn {
        return true;
    }

    let Some(app) = state.app_handle.get().cloned() else {
        // Should not happen in the real Tauri app (setup sets it), but keep safe.
        if let Ok(mut set) = state.pitch_inflight.lock() {
            set.remove(&inflight_key);
        }
        return false;
    };

    // Notify UI that analysis has started for this root track.
    let _ = app.emit(
        "pitch_orig_analysis_started",
        PitchOrigAnalysisStartedEvent {
            root_track_id: job.root_track_id.clone(),
            key: job.key.clone(),
        },
    );

    let job2 = job.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();

        let curve = compute_pitch_curve(&job2, |p| {
            let pp = p.clamp(0.0, 1.0);
            let _ = app.emit(
                "pitch_orig_analysis_progress",
                PitchOrigAnalysisProgressEvent {
                    root_track_id: job2.root_track_id.clone(),
                    progress: pp,
                },
            );
        });

        // Apply if still current.
        let mut should_emit = false;
        {
            let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
            tl.ensure_params_for_root(&job2.root_track_id);
            let current_key = build_root_pitch_key(&tl, &job2.root_track_id);
            if current_key == job2.key {
                if let Some(entry) = tl.params_by_root_track.get_mut(&job2.root_track_id) {
                    entry.pitch_orig = curve;
                    entry.pitch_orig_key = Some(job2.key.clone());

                    // If user hasn't edited yet, keep edit in sync with orig so
                    // the main (solid) curve shows the recognized pitch.
                    if !entry.pitch_edit_user_modified {
                        entry.pitch_edit = entry.pitch_orig.clone();
                    }
                    should_emit = true;
                }
            }
        }

        if let Ok(mut set) = state.pitch_inflight.lock() {
            set.remove(&inflight_key);
        }

        if should_emit {
            let _ = app.emit(
                "pitch_orig_updated",
                PitchOrigUpdatedEvent {
                    root_track_id: job2.root_track_id.clone(),
                },
            );
        }
    });

    true
}
