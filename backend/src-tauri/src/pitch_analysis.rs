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
    let bpm = if tl.bpm.is_finite() && tl.bpm > 0.0 { tl.bpm } else { 120.0 };

    let mut hasher = blake3::Hasher::new();
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
        PitchAnalysisAlgo::WorldDll | PitchAnalysisAlgo::NsfHifiganOnnx | PitchAnalysisAlgo::Unknown
    ) {
        hasher.update(&[if crate::world::is_available() { 1 } else { 0 }]);
    }

    // Include each clip mapped to this root track.
    // Sort by clip id for stability.
    let mut clips: Vec<&Clip> = tl
        .clips
        .iter()
        .filter(|c| {
            tl.resolve_root_track_id(&c.track_id)
                .as_deref()
                == Some(root_track_id)
        })
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
    for of in 0..out_len {
        let t_in = (of as f64) * scale;
        let i0 = t_in.floor() as usize;
        let i1 = (i0 + 1).min(in_len - 1);
        let frac = (t_in - (i0 as f64)) as f32;
        let a = values[i0];
        let b = values[i1];
        out[of] = a + (b - a) * frac;
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

fn compute_pitch_curve(job: &PitchJob) -> Vec<f32> {
    let debug = std::env::var("HIFISHIFTER_DEBUG_COMMANDS")
        .ok()
        .as_deref()
        == Some("1");

    // If WORLD isn't available, return zeros.
    if matches!(
        job.algo,
        PitchAnalysisAlgo::WorldDll | PitchAnalysisAlgo::NsfHifiganOnnx | PitchAnalysisAlgo::Unknown
    ) && !crate::world::is_available()
    {
        if debug {
            eprintln!(
                "pitch: WORLD unavailable; return zeros (root_track_id={} key={} frames={})",
                job.root_track_id,
                job.key,
                job.target_frames
            );
        }
        return vec![0.0; job.target_frames];
    }

    if debug {
        eprintln!(
            "pitch: start analysis (root_track_id={} key={} clips={} frames={} fp_ms={} algo={:?})",
            job.root_track_id,
            job.key,
            job.timeline.clips.len(),
            job.target_frames,
            job.frame_period_ms,
            job.algo
        );
    }

    let mut out = vec![0.0f32; job.target_frames];

    // Render root-subtree mix (same as the param panel background waveform) and analyze it.
    let project_sec = job.timeline.project_duration_sec();
    if project_sec <= 1e-9 {
        return out;
    }

    let opts = crate::mixdown::MixdownOptions {
        sample_rate: 44100,
        start_sec: 0.0,
        end_sec: Some(project_sec),
        // Match UI waveform background exactly.
        stretch: crate::time_stretch::StretchAlgorithm::RubberBand,
    };

    let (sr, ch, _dur, mix) = match crate::mixdown::render_mixdown_interleaved(&job.timeline, opts)
    {
        Ok(v) => v,
        Err(e) => {
            if debug {
                eprintln!(
                    "pitch: mixdown failed (root_track_id={} key={}) err={}",
                    job.root_track_id, job.key, e
                );
            }
            return out;
        }
    };

    let channels = ch.max(1) as usize;
    let frames = mix.len() / channels.max(1);
    if frames < 2 {
        return out;
    }

    let mut mono_raw: Vec<f64> = Vec::with_capacity(frames);
    for f in 0..frames {
        let base = f * channels;
        let mut sum = 0.0f64;
        for c in 0..channels {
            sum += mix[base + c] as f64;
        }
        mono_raw.push(sum / channels as f64);
    }

    // WORLD pitch trackers are sensitive to clipped / DC-offset inputs.
    // Keep preprocessing minimal (no slew/LPF): remove DC and clamp.
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

    // Match python demo defaults (utils/wav2F0.py): f0_min=40, f0_max=1600.
    let f0_floor = 40.0;
    let f0_ceil = 1600.0;
    let frame_period_tl_ms = job.frame_period_ms.max(0.1);
    let fs_i32 = sr.max(1) as i32;

    let prefer = std::env::var("HIFISHIFTER_WORLD_F0")
        .ok()
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "harvest".to_string());

    let f0_hz: Vec<f64> = match job.algo {
        PitchAnalysisAlgo::WorldDll | PitchAnalysisAlgo::NsfHifiganOnnx | PitchAnalysisAlgo::Unknown => {
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

            match res {
                Ok(v) => v,
                Err(e) => {
                    if debug {
                        eprintln!(
                            "pitch: WORLD failed (root_track_id={} key={} prefer={}) err={}",
                            job.root_track_id, job.key, prefer, e
                        );
                    }
                    vec![]
                }
            }
        }
        PitchAnalysisAlgo::None => vec![],
    };

    let mut midi: Vec<f32> = Vec::with_capacity(f0_hz.len());
    let mut last: f32 = 0.0;
    for hz in f0_hz {
        let v = hz_to_midi(hz);
        if v > 0.0 {
            last = v;
            midi.push(v);
        } else {
            midi.push(last);
        }
    }

    let midi = resample_curve_linear(&midi, job.target_frames);
    out.copy_from_slice(&midi);

    if debug {
        let any_nonzero = out.iter().any(|&v| v.is_finite() && v > 0.0);
        eprintln!(
            "pitch: done analysis (root_track_id={} key={} any_nonzero={})",
            job.root_track_id,
            job.key,
            any_nonzero
        );
    }
    out
}

pub fn maybe_schedule_pitch_orig(state: &AppState, root_track_id: &str) {
    // Build job snapshot under timeline lock, then release lock for heavy work.
    let job = {
        let tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
        build_pitch_job(&tl, root_track_id)
    };

    let Some(job) = job else {
        return;
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
        return;
    }

    let Some(app) = state.app_handle.get().cloned() else {
        // Should not happen in the real Tauri app (setup sets it), but keep safe.
        if let Ok(mut set) = state.pitch_inflight.lock() {
            set.remove(&inflight_key);
        }
        return;
    };

    let job2 = job.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();

        let curve = compute_pitch_curve(&job2);

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
                    let edit_all_zero = entry.pitch_edit.iter().all(|&v| v == 0.0);
                    if edit_all_zero {
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
}
