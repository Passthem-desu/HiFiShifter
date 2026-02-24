use crate::state::{Clip, TimelineState};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone)]
struct ClipPitchKey {
    clip_id: String,
    key: String,
    frame_period_ms: f64,
    sample_rate: u32,
    pre_silence_sec: f64,
}

#[derive(Debug, Clone)]
pub struct CachedClipPitch {
    pub key: String,
    pub midi: Vec<f32>, // timeline frames (frame_period_ms)
}

static GLOBAL_CLIP_PITCH_CACHE: OnceLock<Mutex<HashMap<String, CachedClipPitch>>> = OnceLock::new();
static GLOBAL_CLIP_PITCH_INFLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn global_cache() -> &'static Mutex<HashMap<String, CachedClipPitch>> {
    GLOBAL_CLIP_PITCH_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn global_inflight() -> &'static Mutex<HashSet<String>> {
    GLOBAL_CLIP_PITCH_INFLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

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

fn beat_sec(bpm: f64) -> f64 {
    60.0 / bpm.max(1e-6)
}

fn build_clip_pitch_key(
    tl: &TimelineState,
    clip: &Clip,
    root_track_id: &str,
    frame_period_ms: f64,
) -> Option<ClipPitchKey> {
    let bpm = if tl.bpm.is_finite() && tl.bpm > 0.0 {
        tl.bpm
    } else {
        120.0
    };
    let bs = beat_sec(bpm);

    let source_path = clip.source_path.as_deref()?;

    let _clip_start_sec = (clip.start_beat.max(0.0)) * bs;
    let clip_timeline_len_sec = (clip.length_beats.max(0.0)) * bs;
    if !(clip_timeline_len_sec.is_finite() && clip_timeline_len_sec > 0.0) {
        return None;
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

    let fp = frame_period_ms.max(0.1);

    let mut hasher = blake3::Hasher::new();
    hasher.update(b"clip_pitch_v2_world_midi");
    hasher.update(root_track_id.as_bytes());
    hasher.update(clip.id.as_bytes());
    hasher.update(source_path.as_bytes());
    let (len, mtime) = file_sig(Path::new(source_path));
    hasher.update(&len.to_le_bytes());
    hasher.update(&mtime.to_le_bytes());

    hasher.update(&quantize_u32(bpm, 1000.0).to_le_bytes());
    hasher.update(&quantize_u32(fp, 1000.0).to_le_bytes());

    // Content-affecting params.
    hasher.update(&quantize_u32(clip.start_beat, 1000.0).to_le_bytes());
    hasher.update(&quantize_u32(clip.length_beats, 1000.0).to_le_bytes());
    hasher.update(&quantize_u32(playback_rate, 10000.0).to_le_bytes());
    hasher.update(&quantize_i64(clip.trim_start_beat, 1000.0).to_le_bytes());
    hasher.update(&quantize_u32(clip.trim_end_beat, 1000.0).to_le_bytes());

    // Pre-silence influences alignment.
    hasher.update(&quantize_u32(pre_silence_sec, 1000.0).to_le_bytes());
    hasher.update(&quantize_u32(trim_start_sec, 1000.0).to_le_bytes());
    hasher.update(&quantize_u32(trim_end_sec, 1000.0).to_le_bytes());

    let key = hasher.finalize().to_hex().to_string();

    Some(ClipPitchKey {
        clip_id: clip.id.clone(),
        key,
        frame_period_ms: fp,
        sample_rate: 44100,
        pre_silence_sec,
    })
}

pub fn get_or_compute_clip_pitch_midi_global(
    tl: &TimelineState,
    clip: &Clip,
    root_track_id: &str,
    frame_period_ms: f64,
) -> Option<CachedClipPitch> {
    let ck = build_clip_pitch_key(tl, clip, root_track_id, frame_period_ms)?;

    {
        let cache = global_cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(found) = cache.get(&ck.clip_id) {
            if found.key == ck.key {
                return Some(found.clone());
            }
        }
    }

    let inflight_key = format!("{}|{}", ck.clip_id, ck.key);
    let should_compute = {
        let mut set = global_inflight().lock().unwrap_or_else(|e| e.into_inner());
        if set.contains(&inflight_key) {
            false
        } else {
            set.insert(inflight_key.clone());
            true
        }
    };
    if !should_compute {
        return None;
    }

    let res = compute_clip_pitch_midi(tl, clip, root_track_id, frame_period_ms);

    {
        let mut set = global_inflight().lock().unwrap_or_else(|e| e.into_inner());
        set.remove(&inflight_key);
    }

    let midi = res?;

    let cached = CachedClipPitch {
        key: ck.key.clone(),
        midi,
    };

    {
        let mut cache = global_cache().lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(ck.clip_id.clone(), cached.clone());

        const MAX: usize = 256;
        if cache.len() > MAX {
            let keys: Vec<String> = cache
                .keys()
                .take(cache.len().saturating_sub(MAX))
                .cloned()
                .collect();
            for k in keys {
                cache.remove(&k);
            }
        }
    }

    Some(cached)
}

pub fn compute_clip_pitch_midi(
    tl: &TimelineState,
    clip: &Clip,
    root_track_id: &str,
    frame_period_ms: f64,
) -> Option<Vec<f32>> {
    if !crate::world::is_available() {
        return None;
    }

    let ck = build_clip_pitch_key(tl, clip, root_track_id, frame_period_ms)?;
    let source_path = clip.source_path.as_deref()?;

    let bpm = if tl.bpm.is_finite() && tl.bpm > 0.0 {
        tl.bpm
    } else {
        120.0
    };
    let bs = beat_sec(bpm);

    // Source trimming in beats -> sec.
    let trim_start_beats_src = clip.trim_start_beat.max(0.0);
    let trim_end_beats_src = clip.trim_end_beat.max(0.0);

    let trim_start_sec = trim_start_beats_src * bs;
    let trim_end_sec = trim_end_beats_src * bs;

    // Decode.
    let (in_rate, in_channels, pcm) =
        crate::audio_utils::decode_audio_f32_interleaved(Path::new(source_path)).ok()?;
    let in_channels_usize = (in_channels as usize).max(1);
    let in_frames = pcm.len() / in_channels_usize;
    if in_frames < 2 {
        return None;
    }

    let total_sec = (in_frames as f64) / (in_rate.max(1) as f64);
    if !(total_sec.is_finite() && total_sec > 0.0) {
        return None;
    }

    let src_end_limit_sec = (total_sec - trim_end_sec).max(trim_start_sec);
    if src_end_limit_sec - trim_start_sec <= 1e-9 {
        return None;
    }

    let src_i0 = (trim_start_sec * in_rate as f64).floor().max(0.0) as usize;
    let src_i1 = (src_end_limit_sec * in_rate as f64)
        .ceil()
        .max(src_i0 as f64) as usize;
    let src_i1 = src_i1.min(in_frames);
    if src_i1 <= src_i0 + 1 {
        return None;
    }

    let segment = &pcm[(src_i0 * in_channels_usize)..(src_i1 * in_channels_usize)];
    let segment = crate::mixdown::linear_resample_interleaved(
        segment,
        in_channels_usize,
        in_rate,
        ck.sample_rate,
    );

    let seg_frames = segment.len() / in_channels_usize;
    if seg_frames < 2 {
        return None;
    }

    // mono
    let mut mono_raw: Vec<f64> = Vec::with_capacity(seg_frames);
    for f in 0..seg_frames {
        let base = f * in_channels_usize;
        let mut sum = 0.0f64;
        for c in 0..in_channels_usize {
            sum += segment[base + c] as f64;
        }
        mono_raw.push(sum / in_channels_usize as f64);
    }

    // remove DC + clamp like other WORLD callers
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

    // f0
    let prefer = std::env::var("HIFISHIFTER_WORLD_F0")
        .ok()
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "harvest".to_string());

    let frame_period_tl_ms = ck.frame_period_ms.max(0.1);
    let f0_floor = 40.0;
    let f0_ceil = 1600.0;

    let fs_i32 = ck.sample_rate as i32;
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
        return None;
    }

    let mut midi: Vec<f32> = Vec::with_capacity(f0_hz.len());
    for hz in f0_hz {
        midi.push(hz_to_midi(hz));
    }

    // timeline alignment
    let clip_timeline_len_sec = (clip.length_beats.max(0.0)) * bs;
    let clip_frames = ((clip_timeline_len_sec * 1000.0) / frame_period_tl_ms)
        .round()
        .max(1.0) as usize;
    let mut midi = resample_curve_linear(&midi, clip_frames);

    // Apply pre-silence shift.
    let pre_frames = ((ck.pre_silence_sec * 1000.0) / frame_period_tl_ms)
        .round()
        .max(0.0) as usize;
    if pre_frames > 0 {
        let mut shifted = vec![0.0f32; clip_frames];
        for (i, v) in shifted.iter_mut().enumerate() {
            if let Some(src) = i.checked_sub(pre_frames) {
                if let Some(&m) = midi.get(src) {
                    *v = m;
                }
            }
        }
        midi = shifted;
    }

    // Small gap fill.
    let gap_ms = std::env::var("HIFISHIFTER_WORLD_F0_GAP_MS")
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0)
        .clamp(0.0, 200.0);
    if gap_ms > 0.0 {
        let gap_frames = ((gap_ms / frame_period_tl_ms).round() as isize).max(1) as usize;
        let mut last = 0.0f32;
        let mut zeros = 0usize;
        for v in midi.iter_mut() {
            if *v > 0.0 {
                last = *v;
                zeros = 0;
            } else {
                zeros += 1;
                if zeros <= gap_frames && last > 0.0 {
                    *v = last;
                }
            }
        }
    }

    Some(midi)
}

#[allow(dead_code)]
pub fn get_clips_for_root<'a>(tl: &'a TimelineState, root_track_id: &str) -> Vec<&'a Clip> {
    let mut out: Vec<&Clip> = tl
        .clips
        .iter()
        .filter(|c| tl.resolve_root_track_id(&c.track_id).as_deref() == Some(root_track_id))
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}
