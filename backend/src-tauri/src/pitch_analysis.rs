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

pub(crate) fn build_root_pitch_key(tl: &TimelineState, root_track_id: &str) -> String {
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
        hasher.update(&quantize_u32(c.start_sec, 1000.0).to_le_bytes());
        hasher.update(&quantize_u32(c.length_sec, 1000.0).to_le_bytes());
        hasher.update(&quantize_u32(c.playback_rate as f64, 10000.0).to_le_bytes());
        hasher.update(&quantize_i64(c.source_start_sec, 1000.0).to_le_bytes());
        hasher.update(&quantize_u32(c.source_end_sec, 1000.0).to_le_bytes());
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
    /// 当前正在分析�?clip 名称（None 表示未知或已完成�?
    pub current_clip_name: Option<String>,
    /// 已完成的 clip 数量
    pub completed_clips: u32,
    /// 需要分析的 clip 总数
    pub total_clips: u32,
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

/// Build a timeline snapshot for incremental refresh detection
///
/// Generates a snapshot of the current timeline state, capturing:
/// - Cache keys for all clips (to detect parameter changes)
/// - BPM and frame period (to detect global parameter changes)
///
/// This snapshot can be compared with previous snapshots to determine
/// which clips need re-analysis.
fn build_timeline_snapshot(
    clips: &[Clip],
    bpm: f64,
    frame_period_ms: f64,
    f0_floor: f64,
    f0_ceil: f64,
    algo: &PitchAnalysisAlgo,
) -> crate::state::TimelineSnapshot {
    use std::collections::HashMap;
    
    let mut clip_keys = HashMap::new();
    
    for clip in clips {
        if let Some(source_path) = &clip.source_path {
            let (file_size, file_mtime) = crate::clip_pitch_cache::get_file_signature(
                std::path::Path::new(source_path)
            );
            
            let key_data = crate::clip_pitch_cache::ClipCacheKey {
                source_path: source_path.clone(),
                file_size,
                file_mtime,
                algo: match algo {
                    PitchAnalysisAlgo::WorldDll => "world_dll",
                    PitchAnalysisAlgo::NsfHifiganOnnx => "nsf_hifigan_onnx",
                    PitchAnalysisAlgo::None => "none",
                    PitchAnalysisAlgo::Unknown => "unknown",
                }.to_string(),
                f0_floor: crate::clip_pitch_cache::quantize_f64(f0_floor, 10.0),
                f0_ceil: crate::clip_pitch_cache::quantize_f64(f0_ceil, 10.0),
                version: crate::clip_pitch_cache::CACHE_FORMAT_VERSION,
            };
            
            let cache_key = crate::clip_pitch_cache::generate_clip_cache_key(&key_data);
            clip_keys.insert(clip.id.clone(), cache_key);
        }
    }
    
    crate::state::TimelineSnapshot {
        clips: clip_keys,
        bpm,
        frame_period_ms,
    }
}

/// Detected change types for incremental refresh
#[derive(Debug, Clone, PartialEq, Eq)]
enum ClipChangeType {
    Added,      // New clip in timeline
    Modified,   // Existing clip with changed parameters
    Deleted,    // Clip removed from timeline
    Unchanged,  // Clip exists with same cache key
}

/// Result of comparing two timeline snapshots
#[derive(Debug)]
struct SnapshotComparison {
    added_clip_ids: Vec<String>,
    modified_clip_ids: Vec<String>,
    deleted_clip_ids: Vec<String>,
    unchanged_clip_ids: Vec<String>,
}

/// Compare two timeline snapshots to detect changes
///
/// Returns a comparison result indicating which clips were added, modified,
/// deleted, or unchanged. This enables incremental refresh by only re-analyzing
/// clips that have actually changed.
///
/// # Change Detection Rules
/// - **Added**: Clip ID exists in new snapshot but not in old
/// - **Modified**: Clip ID exists in both, but cache key differs
/// - **Deleted**: Clip ID exists in old snapshot but not in new
/// - **Unchanged**: Clip ID and cache key are identical in both snapshots
///
/// Note: Position-only changes (start_sec) do NOT affect the cache key,
/// so moving a clip without changing its content will not trigger re-analysis.
fn compare_snapshots(
    old_snapshot: Option<&crate::state::TimelineSnapshot>,
    new_snapshot: &crate::state::TimelineSnapshot,
) -> SnapshotComparison {
    use std::collections::HashSet;
    
    // If no old snapshot exists, all clips are "added" (first analysis)
    let Some(old) = old_snapshot else {
        return SnapshotComparison {
            added_clip_ids: new_snapshot.clips.keys().cloned().collect(),
            modified_clip_ids: Vec::new(),
            deleted_clip_ids: Vec::new(),
            unchanged_clip_ids: Vec::new(),
        };
    };
    
    // Check for global parameter changes (BPM or frame period)
    let global_params_changed = (old.bpm - new_snapshot.bpm).abs() > 1e-6
        || (old.frame_period_ms - new_snapshot.frame_period_ms).abs() > 1e-6;
    
    let old_ids: HashSet<&String> = old.clips.keys().collect();
    let new_ids: HashSet<&String> = new_snapshot.clips.keys().collect();
    
    let mut added = Vec::new();
    let mut modified = Vec::new();
    let mut deleted = Vec::new();
    let mut unchanged = Vec::new();
    
    // Detect added and modified clips
    for (clip_id, new_key) in &new_snapshot.clips {
        if let Some(old_key) = old.clips.get(clip_id) {
            // Clip exists in both snapshots
            if old_key != new_key || global_params_changed {
                modified.push(clip_id.clone());
            } else {
                unchanged.push(clip_id.clone());
            }
        } else {
            // Clip is new
            added.push(clip_id.clone());
        }
    }
    
    // Detect deleted clips
    for clip_id in &old_ids {
        if !new_ids.contains(clip_id) {
            deleted.push((*clip_id).clone());
        }
    }
    
    SnapshotComparison {
        added_clip_ids: added,
        modified_clip_ids: modified,
        deleted_clip_ids: deleted,
        unchanged_clip_ids: unchanged,
    }
}

/// Determine which clips need analysis based on incremental refresh
///
/// This function implements incremental refresh by comparing the current timeline
/// with the last snapshot. Only clips that have been added or modified need re-analysis.
///
/// # Parameters
/// - `clips`: All clips in the current timeline
/// - `old_snapshot`: Previous timeline snapshot (if any)
/// - `new_snapshot`: Current timeline snapshot
///
/// # Returns
/// A tuple of (clips_to_analyze, unchanged_clip_ids):
/// - `clips_to_analyze`: Clips that need analysis (added + modified)
/// - `unchanged_clip_ids`: Clips that can be loaded from cache
fn determine_clips_to_analyze<'a>(
    clips: &'a [Clip],
    old_snapshot: Option<&crate::state::TimelineSnapshot>,
    new_snapshot: &crate::state::TimelineSnapshot,
) -> (Vec<&'a Clip>, Vec<String>) {
    let comparison = compare_snapshots(old_snapshot, new_snapshot);
    
    // Clips needing analysis: added + modified
    let mut need_analysis_ids: std::collections::HashSet<String> = comparison
        .added_clip_ids
        .into_iter()
        .chain(comparison.modified_clip_ids.into_iter())
        .collect();
    
    // Filter clips that need analysis
    let clips_to_analyze: Vec<&Clip> = clips
        .iter()
        .filter(|clip| need_analysis_ids.contains(&clip.id))
        .collect();
    
    (clips_to_analyze, comparison.unchanged_clip_ids)
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

/// Analyze a single clip's pitch curve with caching support
///
/// This function checks the cache first, and only performs expensive F0 analysis
/// if the result is not cached. Results are stored in the cache for future use.
///
/// # Returns
/// - `Ok(Arc<Vec<f32>>)`: MIDI pitch curve (unvoiced frames = 0.0)
/// - `Err(String)`: Error message if analysis fails
#[allow(clippy::too_many_arguments)]
fn analyze_clip_with_cache(
    clip: &Clip,
    bpm: f64,
    frame_period_ms: f64,
    f0_floor: f64,
    f0_ceil: f64,
    algo: &PitchAnalysisAlgo,
    cache: &std::sync::Arc<std::sync::Mutex<crate::clip_pitch_cache::ClipPitchCache>>,
    debug: bool,
) -> Result<std::sync::Arc<Vec<f32>>, String> {
    let Some(source_path) = clip.source_path.as_ref() else {
        return Err("No source path".to_string());
    };

    eprintln!(
        "[pitch:analyze] clip_id={} source={} duration_sec={:?} fp={:.1}ms algo={:?}",
        clip.id,
        source_path,
        clip.duration_sec,
        frame_period_ms,
        algo,
    );

    // Generate cache key
    let (file_size, file_mtime) = crate::clip_pitch_cache::get_file_signature(Path::new(source_path));
    
    let algo_str = match algo {
        PitchAnalysisAlgo::WorldDll => "world_dll",
        PitchAnalysisAlgo::NsfHifiganOnnx => "nsf_hifigan_onnx",
        PitchAnalysisAlgo::None => "none",
        PitchAnalysisAlgo::Unknown => "unknown",
    };
    
    let key_data = crate::clip_pitch_cache::ClipCacheKey {
        source_path: source_path.clone(),
        file_size,
        file_mtime,
        algo: algo_str.to_string(),
        f0_floor: crate::clip_pitch_cache::quantize_f64(f0_floor, 10.0),
        f0_ceil: crate::clip_pitch_cache::quantize_f64(f0_ceil, 10.0),
        version: crate::clip_pitch_cache::CACHE_FORMAT_VERSION,
    };
    
    let cache_key = crate::clip_pitch_cache::generate_clip_cache_key(&key_data);
    
    // Query cache
    {
        let mut cache_guard = cache.lock().map_err(|e| format!("Cache lock error: {}", e))?;
        if let Some(cached) = cache_guard.get(&cache_key) {
            if debug {
                eprintln!("clip_pitch_cache: HIT for clip_id={} key={}", clip.id, &cache_key[..16]);
            }
            return Ok(cached);
        }
        if debug {
            eprintln!("clip_pitch_cache: MISS for clip_id={} key={}", clip.id, &cache_key[..16]);
        }
    }
    
    // Cache miss - perform analysis
    let bs = 60.0 / bpm.max(1e-6);
    
    // Decode audio
    let (in_rate, in_channels, pcm) =
        crate::audio_utils::decode_audio_f32_interleaved(Path::new(source_path))
            .map_err(|e| format!("Failed to decode audio: {}", e))?;
    
    let in_channels_usize = (in_channels as usize).max(1);
    let in_frames = pcm.len() / in_channels_usize;
    if in_frames < 2 {
        return Err("Audio too short".to_string());
    }
    
    // 全量分析策略：分析完整源音频，trim/rate 在组装阶段处理
    // Resample 全量 PCM 到 44100 Hz
    let segment = crate::mixdown::linear_resample_interleaved(&pcm, in_channels_usize, in_rate, 44100);
    let seg_frames = segment.len() / in_channels_usize;
    if seg_frames < 2 {
        return Err("Resampled audio too short".to_string());
    }
    
    // Convert to mono
    let mut mono_raw: Vec<f64> = Vec::with_capacity(seg_frames);
    for f in 0..seg_frames {
        let base = f * in_channels_usize;
        let mut sum = 0.0f64;
        for c in 0..in_channels_usize {
            sum += segment[base + c] as f64;
        }
        mono_raw.push(sum / in_channels_usize as f64);
    }
    
    // Preprocess: remove DC and normalize
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
    
    // Compute F0 using WORLD
    let fs_i32 = 44100i32;
    let prefer = std::env::var("HIFISHIFTER_WORLD_F0")
        .ok()
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "harvest".to_string());
    
    let f0_hz: Vec<f64> = {
        let try_harvest = || {
            crate::world::compute_f0_hz_harvest(
                &mono,
                fs_i32,
                frame_period_ms,
                f0_floor,
                f0_ceil,
            )
        };
        let try_dio = || {
            crate::world::compute_f0_hz_dio_stonemask(
                &mono,
                fs_i32,
                frame_period_ms,
                f0_floor,
                f0_ceil,
            )
        };
        
        let res = if prefer == "dio" {
            try_dio().or_else(|_| try_harvest())
        } else {
            try_harvest().or_else(|_| try_dio())
        };
        
        res.map_err(|e| format!("F0 analysis failed: {}", e))?
    };
    
    if f0_hz.len() < 2 {
        return Err("F0 analysis returned too few frames".to_string());
    }
    
    // Convert Hz to MIDI
    let mut midi: Vec<f32> = Vec::with_capacity(f0_hz.len());
    for hz in f0_hz {
        midi.push(hz_to_midi(hz));
    }
    
    if debug {
        eprintln!(
            "clip_pitch_cache: ANALYZED clip_id={} midi_len={} key={}",
            clip.id,
            midi.len(),
            &cache_key[..16]
        );
    }
    
    // Store in cache
    let result = std::sync::Arc::new(midi);
    {
        let mut cache_guard = cache.lock().map_err(|e| format!("Cache lock error: {}", e))?;
        cache_guard.put(cache_key, std::sync::Arc::clone(&result));
    }
    
    Ok(result)
}

/// Parallel analysis result for a single clip
#[derive(Debug, Clone)]
struct ClipAnalysisResult {
    clip_id: String,
    clip_start_sec: f64,
    clip_end_sec: f64,
    pre_silence_sec: f64,
    clip_total_frames: usize,
    midi: std::sync::Arc<Vec<f32>>,
    track_gain_value: f32,
    was_cache_hit: bool,
}

/// Helper function to process a single clip with cache and progress tracking
///
/// This is extracted from compute_pitch_curve_parallel to allow both
/// parallel (ONNX) and serial (WORLD) processing with the same logic.
#[allow(clippy::too_many_arguments)]
fn process_single_clip(
    clip: &Clip,
    tracks_gain: &std::collections::HashMap<String, f32>,
    bpm: f64,
    frame_period_ms: f64,
    f0_floor: f64,
    f0_ceil: f64,
    algo: &PitchAnalysisAlgo,
    cache: &std::sync::Arc<std::sync::Mutex<crate::clip_pitch_cache::ClipPitchCache>>,
    tracker: Option<&std::sync::Arc<crate::pitch_progress::ProgressTracker>>,
    debug: bool,
    duration_sec: f64,
    _bs: f64, // Beat duration in seconds (kept for signature compatibility)
) -> Result<ClipAnalysisResult, String> {
    let clip_start_sec = clip.start_sec.max(0.0);
    let clip_timeline_len_sec = clip.length_sec.max(0.0);
    let clip_end_sec = clip_start_sec + clip_timeline_len_sec;
    
    let track_gain_value = tracks_gain.get(&clip.track_id).copied().unwrap_or(1.0);

    eprintln!(
        "[pitch:process] clip_id={} start={:.3}s len={:.3}s src_start={:.3}s src_end={:.3}s pr={:.2} track_gain={:.2}",
        clip.id, clip_start_sec, clip_timeline_len_sec,
        clip.source_start_sec, clip.source_end_sec,
        clip.playback_rate, track_gain_value,
    );
    
    // Check if clip has valid source
    let Some(_source_path) = clip.source_path.as_ref() else {
        if debug {
            eprintln!("  clip {} skipped: no source path", clip.id);
        }
        return Err(format!("Clip {} has no source path", clip.id));
    };
    
    // Check cache before analysis
    let was_cache_hit = {
        let (file_size, file_mtime) = crate::clip_pitch_cache::get_file_signature(
            std::path::Path::new(_source_path)
        );
        let key_data = crate::clip_pitch_cache::ClipCacheKey {
            source_path: _source_path.clone(),
            file_size,
            file_mtime,
            algo: match algo {
                PitchAnalysisAlgo::WorldDll => "world_dll",
                PitchAnalysisAlgo::NsfHifiganOnnx => "nsf_hifigan_onnx",
                PitchAnalysisAlgo::None => "none",
                PitchAnalysisAlgo::Unknown => "unknown",
            }.to_string(),
            f0_floor: crate::clip_pitch_cache::quantize_f64(f0_floor, 10.0),
            f0_ceil: crate::clip_pitch_cache::quantize_f64(f0_ceil, 10.0),
            version: crate::clip_pitch_cache::CACHE_FORMAT_VERSION,
        };
        let cache_key = crate::clip_pitch_cache::generate_clip_cache_key(&key_data);
        
        if let Ok(mut guard) = cache.lock() {
            guard.get(&cache_key).is_some()
        } else {
            false
        }
    };
    
    // Analyze clip (with caching)
    // 在分析开始前，通知 tracker 当前正在处理�?clip
    if let Some(tracker) = tracker {
        tracker.set_current_clip(Some(clip.name.clone()));
    }

    let midi_result = analyze_clip_with_cache(
        clip,
        bpm,
        frame_period_ms,
        f0_floor,
        f0_ceil,
        algo,
        cache,
        debug,
    );
    
    // Update progress
    if let Some(tracker) = tracker {
        let progress = tracker.report_clip_completed(duration_sec, was_cache_hit);
        // 分析完成后清除当�?clip 名称
        tracker.set_current_clip(None);
        if debug {
            eprintln!(
                "  clip {} completed (cache_hit={}), overall progress={:.1}%",
                clip.id,
                was_cache_hit,
                progress * 100.0
            );
        }
    }
    
    // Handle result
    match midi_result {
        Ok(full_midi) => {
            // 全量分析策略：缓存中是全量源音频曲线，
            // 需要做 trim+resample 转换为 timeline 对齐的曲线
            let playback_rate = if clip.playback_rate.is_finite() && clip.playback_rate > 0.0 {
                clip.playback_rate as f64
            } else {
                1.0
            };
            
            let midi = std::sync::Arc::new(crate::pitch_clip::trim_and_resample_midi(
                &full_midi,
                frame_period_ms,
                clip.source_start_sec,
                clip.source_end_sec,
                playback_rate,
                clip_timeline_len_sec,
            ));
            
            // Calculate pre_silence_sec for clip placement
            let pre_silence_sec_src = (-clip.source_start_sec).max(0.0);
            let pre_silence_sec = pre_silence_sec_src / playback_rate.max(1e-6);
            
            // Estimate clip_total_frames (from original audio)
            let clip_total_frames = if let Some(dur) = clip.duration_sec {
                let in_rate = 44100.0; // Assuming standard rate
                (dur * in_rate).round().max(0.0) as usize
            } else {
                // Fallback: use midi length as approximation
                midi.len() * (frame_period_ms / 1000.0 * 44100.0) as usize
            };
            
            Ok(ClipAnalysisResult {
                clip_id: clip.id.clone(),
                clip_start_sec,
                clip_end_sec,
                pre_silence_sec,
                clip_total_frames,
                midi,
                track_gain_value,
                was_cache_hit,
            })
        }
        Err(e) => {
            if debug {
                eprintln!("  clip {} failed: {}", clip.id, e);
            }
            Err(format!("Clip {}: {}", clip.id, e))
        }
    }
}

/// Parallel pitch analysis for multiple clips
///
/// This function analyzes multiple clips in parallel using rayon, with caching support
/// and progress tracking. It returns results for all successfully analyzed clips,
/// even if some clips fail.
///
/// # Parameters
/// - `clips`: List of clips to analyze
/// - `bpm`: Project BPM
/// - `frame_period_ms`: Analysis frame period in milliseconds
/// - `f0_floor`: F0 floor frequency (Hz)
/// - `f0_ceil`: F0 ceiling frequency (Hz)
/// - `algo`: Analysis algorithm
/// - `cache`: Clip pitch cache
/// - `tracker`: Progress tracker (optional for progress updates)
/// - `debug`: Enable debug logging
///
/// # Returns
/// - `Ok(Vec<ClipAnalysisResult>)`: Successfully analyzed clips (may be partial)
/// - `Err(String)`: Critical failure (>50% clips failed)
#[allow(clippy::too_many_arguments)]
fn compute_pitch_curve_parallel(
    clips: &[Clip],
    tracks_gain: &std::collections::HashMap<String, f32>,
    bpm: f64,
    frame_period_ms: f64,
    f0_floor: f64,
    f0_ceil: f64,
    algo: &PitchAnalysisAlgo,
    cache: &std::sync::Arc<std::sync::Mutex<crate::clip_pitch_cache::ClipPitchCache>>,
    tracker: Option<&std::sync::Arc<crate::pitch_progress::ProgressTracker>>,
    debug: bool,
) -> Result<Vec<ClipAnalysisResult>, String> {
    use rayon::prelude::*;
    
    if clips.is_empty() {
        return Ok(Vec::new());
    }
    
    let bs = 60.0 / bpm.max(1e-6);
    
    // Separate clips by algorithm: WORLD requires serial processing due to world_dll_mutex
    let (world_clips, onnx_clips): (Vec<&Clip>, Vec<&Clip>) = clips
        .iter()
        .partition(|_clip| matches!(algo, PitchAnalysisAlgo::WorldDll));
    
    if debug {
        eprintln!(
            "compute_pitch_curve_parallel: {} total clips ({} WORLD, {} ONNX/other)",
            clips.len(),
            world_clips.len(),
            onnx_clips.len()
        );
    }
    
    let mut all_results: Vec<Result<ClipAnalysisResult, String>> = Vec::new();
    
    // Process ONNX clips in parallel (no locking constraints)
    if !onnx_clips.is_empty() {
        if debug {
            eprintln!("  Processing {} ONNX clips in parallel...", onnx_clips.len());
        }
        
        // Sort by workload descending for better load balancing
        let mut onnx_sorted: Vec<(&Clip, f64)> = onnx_clips
            .iter()
            .map(|clip| {
                let duration_sec = clip.length_sec.max(0.0);
                (*clip, duration_sec)
            })
            .collect();
        
        onnx_sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        
        let onnx_results: Vec<Result<ClipAnalysisResult, String>> = onnx_sorted
            .par_iter()
            .map(|(clip, duration_sec)| {
                process_single_clip(
                    clip,
                    tracks_gain,
                    bpm,
                    frame_period_ms,
                    f0_floor,
                    f0_ceil,
                    algo,
                    cache,
                    tracker,
                    debug,
                    *duration_sec,
                    bs,
                )
            })
            .collect();
        
        all_results.extend(onnx_results);
    }
    
    // Process WORLD clips serially (due to world_dll_mutex)
    if !world_clips.is_empty() {
        if debug {
            eprintln!("  Processing {} WORLD clips serially...", world_clips.len());
        }
        
        // Sort by workload descending (not as critical for serial, but consistent)
        let mut world_sorted: Vec<(&Clip, f64)> = world_clips
            .iter()
            .map(|clip| {
                let duration_sec = clip.length_sec.max(0.0);
                (*clip, duration_sec)
            })
            .collect();        
        world_sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        
        for (clip, duration_sec) in world_sorted {
            let result = process_single_clip(
                &clip,
                tracks_gain,
                bpm,
                frame_period_ms,
                f0_floor,
                f0_ceil,
                algo,
                cache,
                tracker,
                debug,
                duration_sec,
                bs,
            );
            all_results.push(result);
        }
    }
    
    // Separate successes and failures
    let mut successes = Vec::new();
    let mut failures = Vec::new();
    
    for result in all_results {
        match result {
            Ok(clip_result) => successes.push(clip_result),
            Err(e) => failures.push(e),
        }
    }
    
    if debug {
        eprintln!(
            "compute_pitch_curve_parallel: {} successes, {} failures",
            successes.len(),
            failures.len()
        );
    }
    
    // Check failure rate
    let total = successes.len() + failures.len();
    if total > 0 {
        let failure_rate = failures.len() as f64 / total as f64;
        if failure_rate > 0.5 {
            return Err(format!(
                "Critical failure: {}/{} clips failed (>{:.0}%). Errors: {}",
                failures.len(),
                total,
                failure_rate * 100.0,
                failures.join("; ")
            ));
        }
    }
    
    // Return partial results (even if some clips failed, as long as <50% failed)
    if !failures.is_empty() && debug {
        eprintln!(
            "  Warning: {} clips failed but continuing with {} successes",
            failures.len(),
            successes.len()
        );
    }
    
    Ok(successes)
}

/// Incremental pitch analysis with caching and parallel processing
///
/// This function implements the full incremental refresh workflow:
/// 1. Query previous snapshot from state
/// 2. Generate current snapshot
/// 3. Compare snapshots to identify changed clips
/// 4. Analyze only changed clips in parallel
/// 5. Load unchanged clips from cache
/// 6. Merge results
/// 7. Update snapshot in state
///
/// # Parameters
/// - `state`: AppState containing cache and snapshot storage
/// - `root_track_id`: Root track being analyzed
/// - `clips`: All clips in the timeline
/// - `tracks_gain`: Track gain values
/// - `bpm`: Project BPM
/// - `frame_period_ms`: Analysis frame period
/// - `f0_floor`: F0 floor frequency
/// - `f0_ceil`: F0 ceiling frequency
/// - `algo`: Analysis algorithm
/// - `debug`: Enable debug logging
///
/// # Returns
/// - `Ok((results, new_snapshot))`: Analysis results and updated snapshot
/// - `Err(String)`: Critical failure
#[allow(clippy::too_many_arguments)]
fn compute_pitch_curve_with_incremental_refresh(
    state: &AppState,
    root_track_id: &str,
    clips: &[Clip],
    tracks_gain: &std::collections::HashMap<String, f32>,
    bpm: f64,
    frame_period_ms: f64,
    f0_floor: f64,
    f0_ceil: f64,
    algo: &PitchAnalysisAlgo,
    debug: bool,
) -> Result<(Vec<ClipAnalysisResult>, crate::state::TimelineSnapshot), String> {
    let cache = &state.clip_pitch_cache;
    
    // Task 9.1: Query previous snapshot
    let old_snapshot = if let Ok(snapshot_map) = state.pitch_timeline_snapshot.lock() {
        snapshot_map.get(root_track_id).cloned()
    } else {
        None
    };
    
    // Task 9.2: Generate current snapshot
    let new_snapshot = build_timeline_snapshot(
        clips,
        bpm,
        frame_period_ms,
        f0_floor,
        f0_ceil,
        algo,
    );
    
    // Task 9.3: Compare snapshots to identify changes
    let (clips_to_analyze, unchanged_clip_ids) = determine_clips_to_analyze(
        clips,
        old_snapshot.as_ref(),
        &new_snapshot,
    );
    
    if debug {
        eprintln!(
            "Incremental refresh: {} clips need analysis, {} unchanged (cached)",
            clips_to_analyze.len(),
            unchanged_clip_ids.len()
        );
    }
    
    let mut all_results = Vec::new();
    
    // Task 9.4: Analyze only changed clips in parallel
    if !clips_to_analyze.is_empty() {
        // Create progress tracker for changed clips only
        let tracker = std::sync::Arc::new(crate::pitch_progress::ProgressTracker::new(
            &clips_to_analyze.iter().map(|c| (*c).clone()).collect::<Vec<_>>(),
            bpm,
            cache,
        ));
        
        let analyzed_results = compute_pitch_curve_parallel(
            &clips_to_analyze.iter().map(|c| (*c).clone()).collect::<Vec<_>>(),
            tracks_gain,
            bpm,
            frame_period_ms,
            f0_floor,
            f0_ceil,
            algo,
            cache,
            Some(&tracker),
            debug,
        )?;
        
        all_results.extend(analyzed_results);
    }
    
    // Task 9.5: Load unchanged clips from cache
    let bs = 60.0 / bpm.max(1e-6);
    for clip_id in &unchanged_clip_ids {
        let Some(clip) = clips.iter().find(|c| &c.id == clip_id) else {
            continue;
        };
        
        // Try to load from cache
        let cache_result = analyze_clip_with_cache(
            clip,
            bpm,
            frame_period_ms,
            f0_floor,
            f0_ceil,
            algo,
            cache,
            debug,
        );
        
        if let Ok(full_midi) = cache_result {
    let clip_start_sec = clip.start_sec.max(0.0);
    let clip_timeline_len_sec = clip.length_sec.max(0.0);
            let clip_end_sec = clip_start_sec + clip_timeline_len_sec;
            
            let track_gain_value = tracks_gain.get(&clip.track_id).copied().unwrap_or(1.0);
            
            let pre_silence_sec_src = (-clip.source_start_sec).max(0.0);
            let playback_rate = if clip.playback_rate.is_finite() && clip.playback_rate > 0.0 {
                clip.playback_rate as f64
            } else {
                1.0
            };
            let pre_silence_sec = pre_silence_sec_src / playback_rate.max(1e-6);
            
            // 全量分析策略：缓存中是全量源音频曲线，做 trim+resample
            let midi = std::sync::Arc::new(crate::pitch_clip::trim_and_resample_midi(
                &full_midi,
                frame_period_ms,
                clip.source_start_sec,
                clip.source_end_sec,
                playback_rate,
                clip_timeline_len_sec,
            ));
            
            let clip_total_frames = if let Some(dur) = clip.duration_sec {
                let in_rate = 44100.0;
                (dur * in_rate).round().max(0.0) as usize
            } else {
                midi.len() * (frame_period_ms / 1000.0 * 44100.0) as usize
            };
            
            all_results.push(ClipAnalysisResult {
                clip_id: clip.id.clone(),
                clip_start_sec,
                clip_end_sec,
                pre_silence_sec,
                clip_total_frames,
                midi,
                track_gain_value,
                was_cache_hit: true,
            });
        }
    }
    
    // Task 9.6: Results are already merged in all_results
    if debug {
        eprintln!(
            "Incremental refresh complete: {} total results ({} analyzed, {} cached)",
            all_results.len(),
            clips_to_analyze.len(),
            unchanged_clip_ids.len()
        );
    }
    
    // Task 9.7: Update snapshot (will be done in caller)
    Ok((all_results, new_snapshot))
}

// Helper functions for pitch analysis business logic

fn beat_sec(bpm: f64) -> f64 {
    60.0 / bpm.max(1e-6)
}

fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

/// Calculate clip weight at a given frame, accounting for fades and gain
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


    let fade_in_frames = (clip.fade_in_sec.max(0.0) * sample_rate as f64)
        .round()
        .max(0.0) as usize;
    let fade_out_frames = (clip.fade_out_sec.max(0.0) * sample_rate as f64)
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

/// Optimized pitch curve fusion with coverage table
///
/// This function fuses multiple clip pitch curves into a single root curve using
/// a coverage table for O(1) frame lookups. Implements winner-take-most algorithm
/// with hysteresis to avoid rapid switching.
///
/// # Optimizations
/// - Pre-builds coverage table (O(N×M)) to identify active clips per frame
/// - Fast-path for empty frames (no clips): write 0.0 directly
/// - Fast-path for single-clip frames: skip weight calculation
/// - Only computes weights for multi-clip overlaps
/// - Maintains hysteresis for smooth transitions
///
/// # Parameters
/// - `clip_results`: Analysis results from parallel/incremental processing
/// - `clips`: Original clip data (for weight calculation)
/// - `target_frames`: Output curve length
/// - `frame_period_ms`: Frame period in milliseconds  
/// - `bpm`: Project BPM
/// - `debug`: Enable debug logging
///
/// # Returns
/// Fused MIDI pitch curve (0.0 for unvoiced frames)
#[allow(clippy::too_many_arguments)]
fn fuse_clip_pitches_optimized(
    clip_results: &[ClipAnalysisResult],
    clips: &[Clip],
    target_frames: usize,
    frame_period_ms: f64,
    bpm: f64,
    debug: bool,
) -> Vec<f32> {
    if clip_results.is_empty() {
        return vec![0.0; target_frames];
    }
    
    let mut out = vec![0.0f32; target_frames];
    
    // Task 10.1-10.2: Build coverage table
    let mut coverage: Vec<Option<Vec<usize>>> = vec![None; target_frames];
    
    for (clip_idx, result) in clip_results.iter().enumerate() {
        let start_frame = ((result.clip_start_sec * 1000.0) / frame_period_ms).round().max(0.0) as usize;
        let end_frame = ((result.clip_end_sec * 1000.0) / frame_period_ms).round().max(0.0) as usize;

        let nonzero = result.midi.iter().filter(|&&v| v.is_finite() && v > 0.0).count();
        eprintln!(
            "[pitch:fuse] clip[{}] id={} start={:.3}s end={:.3}s pre_silence={:.3}s midi_len={} nonzero={} start_frame={} end_frame={}",
            clip_idx, result.clip_id,
            result.clip_start_sec, result.clip_end_sec,
            result.pre_silence_sec,
            result.midi.len(), nonzero,
            start_frame, end_frame,
        );
        
        for frame in start_frame..end_frame.min(target_frames) {
            coverage[frame].get_or_insert_with(Vec::new).push(clip_idx);
        }
    }
    
    {
        let covered_frames = coverage.iter().filter(|c| c.is_some()).count();
        eprintln!(
            "[pitch:fuse] summary: {} clips, target_frames={}, fp={:.1}ms, covered={} ({:.1}%)",
            clip_results.len(),
            target_frames,
            frame_period_ms,
            covered_frames,
            (covered_frames as f64 / target_frames.max(1) as f64) * 100.0
        );
    }
    
    // Task 10.3-10.7: Optimized fusion loop with coverage table
    let mut last_winner: Option<String> = None;
    let hysteresis_ratio: f32 = 1.10;
    
    for (frame_idx, out_v) in out.iter_mut().enumerate() {
        let abs_time_sec = (frame_idx as f64) * frame_period_ms / 1000.0;
        
        // Task 10.4: Fast-path for empty frames
        let Some(active_clips) = &coverage[frame_idx] else {
            *out_v = 0.0;
            continue;
        };
        
        // Task 10.5: Fast-path for single-clip frames
        if active_clips.len() == 1 {
            let result = &clip_results[active_clips[0]];
            let local_sec = abs_time_sec - result.clip_start_sec;
            let local_frame = ((local_sec * 1000.0) / frame_period_ms).round().max(0.0) as usize;
            
            if let Some(&pitch) = result.midi.get(local_frame) {
                if pitch.is_finite() && pitch > 0.0 {
                    *out_v = pitch;
                    last_winner = Some(result.clip_id.clone());
                    continue;
                }
            }
            
            *out_v = 0.0;
            continue;
        }
        
        // Task 10.6: Multi-clip overlap - full winner-take-most
        let mut best_id: Option<&str> = None;
        let mut best_weight: f32 = 0.0;
        let mut best_pitch: f32 = 0.0;
        
        for &clip_idx in active_clips {
            let result = &clip_results[clip_idx];
            
            // Get pitch value
            let local_sec = abs_time_sec - result.clip_start_sec;
            let local_frame = ((local_sec * 1000.0) / frame_period_ms).round().max(0.0) as usize;
            let p = result.midi.get(local_frame).copied().unwrap_or(0.0);
            
            if !(p.is_finite() && p > 0.0) {
                continue;
            }
            
            // Find matching clip for weight calculation
            let Some(clip) = clips.iter().find(|c| c.id == result.clip_id) else {
                continue;
            };
            
            // Calculate weight with fade semantics
            let local_in_clip_frames = ((local_sec * 44100.0).round().max(0.0)) as usize;
            
            let w = clip_weight_at_frame(
                clip,
                bpm,
                44100,
                result.clip_start_sec,
                result.pre_silence_sec,
                result.clip_total_frames,
                local_in_clip_frames,
                result.track_gain_value,
            );
            
            if w <= 0.0 {
                continue;
            }
            
            if w > best_weight {
                best_weight = w;
                best_id = Some(result.clip_id.as_str());
                best_pitch = p;
            }
        }
        
        // Task 10.7: Apply hysteresis
        if let Some(prev_id) = last_winner.as_deref() {
            if let Some(best_id_now) = best_id {
                if prev_id != best_id_now {
                    // Recompute previous winner's weight
                    if let Some(result) = clip_results.iter().find(|r| r.clip_id == prev_id) {
                        if abs_time_sec >= result.clip_start_sec && abs_time_sec < result.clip_end_sec {
                            let local_sec = abs_time_sec - result.clip_start_sec;
                            let local_frame = ((local_sec * 1000.0) / frame_period_ms).round().max(0.0) as usize;
                            let prev_pitch = result.midi.get(local_frame).copied().unwrap_or(0.0);
                            
                            if prev_pitch > 0.0 {
                                if let Some(clip) = clips.iter().find(|c| c.id == prev_id) {
                                    let local_in_clip_frames = ((local_sec * 44100.0).round().max(0.0)) as usize;
                                    let prev_weight = clip_weight_at_frame(
                                        clip,
                                        bpm,
                                        44100,
                                        result.clip_start_sec,
                                        result.pre_silence_sec,
                                        result.clip_total_frames,
                                        local_in_clip_frames,
                                        result.track_gain_value,
                                    );
                                    
                                    // Stick with previous if new winner isn't significantly better
                                    if prev_weight > 0.0 && best_weight < prev_weight * hysteresis_ratio {
                                        *out_v = prev_pitch;
                                        continue;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // Commit winner
        if best_weight > 0.0 {
            *out_v = best_pitch;
            last_winner = best_id.map(|s| s.to_string());
        } else {
            *out_v = 0.0;
        }
    }

    {
        let nonzero = out.iter().filter(|&&v| v.is_finite() && v > 0.0).count();
        eprintln!(
            "[pitch:fuse] result: {}/{} frames ({:.1}%) have pitch",
            nonzero, out.len(),
            (nonzero as f64 / out.len().max(1) as f64) * 100.0
        );
    }
    
    out
}

fn compute_pitch_curve(job: &PitchJob, mut on_progress: impl FnMut(f32)) -> Vec<f32> {
    use std::sync::Arc;
    
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
    let clip_start_sec = clip.start_sec.max(0.0);
    let clip_timeline_len_sec = clip.length_sec.max(0.0);
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

        // Source range (already in sec).
        let source_start_sec = clip.source_start_sec.max(0.0);
        let source_end_sec = clip.source_end_sec;
        let pre_silence_sec = (-clip.source_start_sec).max(0.0) / playback_rate.max(1e-6);

        let total_sec = (in_frames as f64) / (in_rate.max(1) as f64);
        if !(total_sec.is_finite() && total_sec > 0.0) {
            continue;
        }

        let src_end_limit_sec = source_end_sec.min(total_sec).max(source_start_sec);
        if src_end_limit_sec - source_start_sec <= 1e-9 {
            continue;
        }

        let src_i0 = (source_start_sec * in_rate as f64).floor().max(0.0) as usize;
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
        
        // DEBUG: Check for time alignment issues that cause pitch curve speed mismatch
        let actual_audio_sec = seg_frames as f64 / 44100.0;
        let clip_frames_from_timeline = ((clip_timeline_len_sec * 1000.0) / frame_period_tl_ms)
            .round()
            .max(1.0) as usize;
        let clip_frames_from_audio = ((actual_audio_sec * 1000.0) / frame_period_tl_ms)
            .round()
            .max(1.0) as usize;
        let ratio = actual_audio_sec / clip_timeline_len_sec.max(1e-9);
        
        // �?playback_rate != 1 时，actual_audio_sec �?clip_timeline_len_sec 不同是正常的
        // （actual_audio_sec �?clip_timeline_len_sec × playback_rate），不应被当作错�?
        if debug {
            eprintln!(
                "pitch: [ALIGNMENT] clip_id={} clip_timeline_len_sec={:.3} actual_audio_sec={:.3} ratio={:.3} playback_rate={:.2}",
                clip.id,
                clip_timeline_len_sec,
                actual_audio_sec,
                ratio,
                playback_rate
            );
            eprintln!(
                "  frames_from_timeline={} frames_from_audio={} midi_len={}",
                clip_frames_from_timeline,
                clip_frames_from_audio,
                midi.len(),
            );
        }
        
        // 始终使用 timeline 帧数：源时域�?F0 曲线需�?resample �?timeline 时域
        // 这样 pitch_orig 中每帧对应的就是 timeline 上的 frame_period 步进
        let clip_frames = clip_frames_from_timeline;
        
        let midi = resample_curve_linear(&midi, clip_frames);

        let tg = track_gain.get(&clip.track_id).copied().unwrap_or(1.0);

        // 始终使用 clip_end_sec（timeline 域），确保融合后曲线长度�?clip 显示范围一�?
        let adjusted_end_sec = clip_end_sec;

        clip_pitches.push(ClipPitch {
            clip_id: clip.id.clone(),
            start_sec: clip_start_sec,
            end_sec: adjusted_end_sec,
            pre_silence_sec,
            clip_total_frames: ((actual_audio_sec * 44100.0).round().max(1.0)) as usize,
            midi,
            track_gain_value: tg,
        });
    }

    on_progress(0.85);

    // Task 10: Convert ClipPitch to ClipAnalysisResult for fusion optimization
    let clip_results: Vec<ClipAnalysisResult> = clip_pitches
        .into_iter()
        .map(|cp| ClipAnalysisResult {
            clip_id: cp.clip_id,
            clip_start_sec: cp.start_sec,
            clip_end_sec: cp.end_sec,
            pre_silence_sec: cp.pre_silence_sec,
            clip_total_frames: cp.clip_total_frames,
            midi: Arc::new(cp.midi), // Wrap in Arc for ClipAnalysisResult
            track_gain_value: cp.track_gain_value,
            was_cache_hit: false,
        })
        .collect();

    // Task 10.1-10.8: Use optimized fusion algorithm with coverage table
    out = fuse_clip_pitches_optimized(
        &clip_results,
        &job.timeline.clips,
        job.target_frames,
        frame_period_tl_ms,
        bpm,
        debug,
    );

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

/// �?per-clip 缓存（GLOBAL_CLIP_PITCH_CACHE）直接组装整体音高线�?
///
/// 策略：按 `tl.clips` 的顺序（�?z-order，越靠后�?clip �?上方"）�?clip 写入�?
/// 后面�?clip 直接覆盖前面的（非零值覆盖，零值不覆盖）�?
///
/// # 返回�?
/// - `Some((Vec<f32>, true))`：所�?clip 缓存均命中，组装成功
/// - `Some((Vec<f32>, false))`：部�?clip 缓存未命中，返回已有部分的曲线（渐进更新�?
/// - `None`：内部错误（实际上不会发生）
fn assemble_pitch_orig_from_cache(
    tl: &crate::state::TimelineState,
    root_track_id: &str,
) -> Option<(Vec<f32>, bool)> {
    let fp = tl.frame_period_ms();
    let target_frames = tl.target_param_frames(fp);
    let bpm = if tl.bpm.is_finite() && tl.bpm > 0.0 { tl.bpm } else { 120.0 };
    let bs = 60.0 / bpm;

    // 收集属于�?root track 的所�?clip（保�?tl.clips 原始顺序 = z-order�?
    let clips: Vec<&crate::state::Clip> = tl
        .clips
        .iter()
        .filter(|c| {
            tl.resolve_root_track_id(&c.track_id).as_deref() == Some(root_track_id)
                && !c.muted
                && c.source_path.is_some()
        })
        .collect();

    if clips.is_empty() {
        // 没有 clip，直接返回全零曲线（视为全部命中�?
        return Some((vec![0.0f32; target_frames], true));
    }

    let cache = crate::pitch_clip::global_cache().lock().unwrap_or_else(|e| e.into_inner());

    let mut out = vec![0.0f32; target_frames];
    let mut all_cache_hit = true;

    // �?z-order 从低到高（tl.clips 顺序）写入，后面�?clip 覆盖前面�?
    for clip in &clips {
        // 查缓�?
        let cached = match cache.get(&clip.id) {
            Some(c) => c,
            None => {
                // 缓存未命中，跳过�?clip 继续组装（渐进更新）
                all_cache_hit = false;
                continue;
            }
        };

        // 验证 key 是否仍然有效（clip 参数未变�?
        let expected_key = {
            // 用与 pitch_clip.rs 相同�?key 构建逻辑验证
            // 简化：只要 cached.midi 非空就认为有效（key 校验�?schedule_clip_pitch_jobs 负责�?
            // 实际�?pitch_clip.rs �?get_or_compute_clip_pitch_midi_global 已经做了 key 校验
            // 这里我们直接信任缓存（因�?schedule_clip_pitch_jobs 会在 key 变化时重新分析）
            let _ = &cached.key; // 使用 key 字段避免 unused 警告
            true
        };
        if !expected_key {
            return None;
        }

        // 计算 clip �?timeline 中的起始�?
        let clip_start_sec = clip.start_sec.max(0.0);
        let clip_start_frame = ((clip_start_sec * 1000.0) / fp).round().max(0.0) as usize;

        // 判断是否为全量源音频缓存（playback_rate == 1�?
        let pr = clip.playback_rate as f64;
        let is_full_source = pr.is_finite() && pr > 0.0 && (pr - 1.0).abs() <= 1e-6;

        // 缓存中始终是全量源音频的 MIDI 曲线�?
        // is_full_source (rate==1)：从 source_start_sec 处偏移截取，直接写入 out
        // !is_full_source (rate!=1)：从全量曲线中截�?source range 区间 �?resample �?clip timeline 长度 �?写入 out
        let clip_len_sec = clip.length_sec.max(0.0);
        let clip_len_frames = ((clip_len_sec * 1000.0) / fp).round().max(0.0) as usize;

        if is_full_source {
            // rate==1：从 source_start_sec 处偏移截取，直接写入
            let src_offset = {
                let source_start_sec = clip.source_start_sec.max(0.0);
                ((source_start_sec * 1000.0) / fp).round().max(0.0) as usize
            };
            for local_i in 0..clip_len_frames {
                let src_i = src_offset + local_i;
                let global_i = clip_start_frame + local_i;
                if global_i >= target_frames {
                    break;
                }
                let pitch = cached.midi.get(src_i).copied().unwrap_or(0.0);
                if pitch.is_finite() && pitch > 0.0 {
                    out[global_i] = pitch;
                } else {
                    out[global_i] = 0.0;
                }
            }
        } else {
            // rate!=1：从全量曲线中截�?source range 区间 �?resample �?clip timeline 长度
            let pr_valid = if pr.is_finite() && pr > 0.0 { pr } else { 1.0 };
            let resampled = crate::pitch_clip::trim_and_resample_midi(
                &cached.midi,
                fp,
                clip.source_start_sec,
                clip.source_end_sec,
                pr_valid,
                clip_len_sec,
            );
            for local_i in 0..clip_len_frames {
                let global_i = clip_start_frame + local_i;
                if global_i >= target_frames {
                    break;
                }
                let pitch = resampled.get(local_i).copied().unwrap_or(0.0);
                if pitch.is_finite() && pitch > 0.0 {
                    out[global_i] = pitch;
                } else {
                    out[global_i] = 0.0;
                }
            }
        }
    }

    Some((out, all_cache_hit))
}

/// Returns whether pitch analysis is currently pending (scheduled or already inflight).
pub fn maybe_schedule_pitch_orig(state: &AppState, root_track_id: &str) -> bool {
    // 单次 lock 保证 build_pitch_job �?assemble �?写入 的原子性，
    // 避免多次 lock 之间 state.timeline 被前端命令修改导�?key 不一致�?
    let mut should_emit = false;
    let mut emit_root_track_id = String::new();
    {
        let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());

        // 检查是否需要更新（compose_enabled、algo 等前置条件）
        let job = match build_pitch_job(&tl, root_track_id) {
            Some(j) => j,
            None => return false,
        };

        // 直接�?per-clip 缓存同步组装整体音高线（不再重新分析音频�?
        let (curve, all_cache_hit) = match assemble_pitch_orig_from_cache(&tl, root_track_id) {
            Some(v) => v,
            None => {
                // assemble_pitch_orig_from_cache 目前永远返回 Some，此分支保留作为安全兜底
                return true;
            }
        };

        // 将组装好的曲线写�?state
        tl.ensure_params_for_root(&job.root_track_id);
        let current_key = build_root_pitch_key(&tl, &job.root_track_id);
        if current_key == job.key {
            if let Some(entry) = tl.params_by_root_track.get_mut(&job.root_track_id) {
                entry.pitch_orig = curve;
                // 只有所�?clip 缓存均命中时才标�?key 为已完成
                // 否则保持 pitch_orig_key �?None，确保后�?clip 完成时仍会触发推�?
                if all_cache_hit {
                    entry.pitch_orig_key = Some(job.key.clone());
                } else {
                    entry.pitch_orig_key = None;
                }

                // 如果用户尚未手动编辑，保�?edit �?orig 同步
                if !entry.pitch_edit_user_modified {
                    entry.pitch_edit = entry.pitch_orig.clone();
                }
                should_emit = true;
                emit_root_track_id = job.root_track_id.clone();
            }
        }
    }
    // lock 释放后再 emit，避免持锁时发事�?
    if should_emit {
        if let Some(app) = state.app_handle.get() {
            let _ = app.emit(
                "pitch_orig_updated",
                PitchOrigUpdatedEvent {
                    root_track_id: emit_root_track_id,
                },
            );
        }
    }

    false // 同步完成，不�?pending
}

// Task 3.6: PitchProgressPayload for frontend API
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchProgressPayload {
    pub root_track_id: String,
    pub progress: f32,
    pub eta_seconds: Option<f64>,
    /// 当前正在分析�?clip 名称
    pub current_clip_name: Option<String>,
    /// 已完成的 clip 数量
    pub completed_clips: u32,
    /// 需要分析的 clip 总数
    pub total_clips: u32,
}

impl From<&PitchOrigAnalysisProgressEvent> for PitchProgressPayload {
    fn from(event: &PitchOrigAnalysisProgressEvent) -> Self {
        Self {
            root_track_id: event.root_track_id.clone(),
            progress: event.progress,
            eta_seconds: None,
            current_clip_name: event.current_clip_name.clone(),
            completed_clips: event.completed_clips,
            total_clips: event.total_clips,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::clip_pitch_cache::ClipPitchCache;
    use std::sync::{Arc, Mutex};

    #[test]
    fn test_analyze_clip_with_cache_missing_source() {
        let clip = Clip {
            id: "test_clip".to_string(),
            track_id: "test_track".to_string(),
            name: "Test Clip".to_string(),
            start_sec: 0.0,
            length_sec: 4.0,
            color: "#ff0000".to_string(),
            source_path: None,
            duration_sec: None,
            waveform_preview: None,
            pitch_range: None,
            gain: 1.0,
            muted: false,
            source_start_sec: 0.0,
            source_end_sec: 4.0,
            playback_rate: 1.0,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
        };

        let cache = Arc::new(Mutex::new(ClipPitchCache::new(10)));
        let result = analyze_clip_with_cache(
            &clip,
            120.0,
            5.0,
            40.0,
            1600.0,
            &PitchAnalysisAlgo::WorldDll,
            &cache,
            false,
        );

        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "No source path");
    }

    #[test]
    fn test_analyze_clip_with_cache_nonexistent_file() {
        let clip = Clip {
            id: "test_clip".to_string(),
            track_id: "test_track".to_string(),
            name: "Test Clip".to_string(),
            start_sec: 0.0,
            length_sec: 4.0,
            color: "#ff0000".to_string(),
            source_path: Some("/nonexistent/path/to/audio.wav".to_string()),
            duration_sec: Some(2.0),
            waveform_preview: None,
            pitch_range: None,
            gain: 1.0,
            muted: false,
            source_start_sec: 0.0,
            source_end_sec: 2.0,
            playback_rate: 1.0,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,        };

        let cache = Arc::new(Mutex::new(ClipPitchCache::new(10)));
        let result = analyze_clip_with_cache(
            &clip,
            120.0,
            5.0,
            40.0,
            1600.0,
            &PitchAnalysisAlgo::WorldDll,
            &cache,
            false,
        );

        // Should fail with decode error
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to decode audio"));
    }

    #[test]
    fn test_compute_pitch_curve_parallel_empty_clips() {
        let clips: Vec<Clip> = vec![];
        let tracks_gain = std::collections::HashMap::new();
        let cache = Arc::new(Mutex::new(ClipPitchCache::new(10)));
        
        let result = compute_pitch_curve_parallel(
            &clips,
            &tracks_gain,
            120.0,
            5.0,
            40.0,
            1600.0,
            &PitchAnalysisAlgo::WorldDll,
            &cache,
            None,
            false,
        );
        
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }
    
    #[test]
    fn test_compute_pitch_curve_parallel_all_invalid() {
        let clips = vec![
            Clip {
                id: "clip1".to_string(),
                track_id: "track1".to_string(),
                name: "Invalid 1".to_string(),
            start_sec: 0.0,
            length_sec: 4.0,
            color: "#ff0000".to_string(),
            source_path: None,
            duration_sec: None,
            waveform_preview: None,
            pitch_range: None,
            gain: 1.0,
            muted: false,
            source_start_sec: 0.0,
            source_end_sec: 4.0,
            playback_rate: 1.0,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            },
            Clip {
                id: "clip2".to_string(),
                track_id: "track1".to_string(),
                name: "Invalid 2".to_string(),
                start_sec: 4.0,
                length_sec: 4.0,
                color: "#00ff00".to_string(),
                source_path: None,
                duration_sec: None,
                waveform_preview: None,
                pitch_range: None,
                gain: 1.0,
                muted: false,
                source_start_sec: 0.0,
                source_end_sec: 4.0,
                playback_rate: 1.0,
                fade_in_sec: 0.0,
                fade_out_sec: 0.0,
            },
        ];
        
        let mut tracks_gain = std::collections::HashMap::new();
        tracks_gain.insert("track1".to_string(), 1.0);
        
        let cache = Arc::new(Mutex::new(ClipPitchCache::new(10)));
        
        let result = compute_pitch_curve_parallel(
            &clips,
            &tracks_gain,
            120.0,
            5.0,
            40.0,
            1600.0,
            &PitchAnalysisAlgo::WorldDll,
            &cache,
            None,
            false,
        );
        
        // Should fail with critical failure (>50% failed)
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Critical failure"));
    }
    
    #[test]
    fn test_compute_pitch_curve_parallel_with_tracker() {
        // Test that progress tracker integration doesn't cause crashes
        let clips = vec![
            Clip {
                id: "clip1".to_string(),
                track_id: "track1".to_string(),
                name: "Test Clip".to_string(),
            start_sec: 0.0,
            length_sec: 4.0,
                color: "#ff0000".to_string(),
                source_path: Some("/nonexistent.wav".to_string()),
                duration_sec: Some(2.0),
                waveform_preview: None,
                pitch_range: None,
                gain: 1.0,
                muted: false,
            source_start_sec: 0.0,
            source_end_sec: 2.0,
            playback_rate: 1.0,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            },
        ];
        
        let mut tracks_gain = std::collections::HashMap::new();
        tracks_gain.insert("track1".to_string(), 1.0);
        
        let cache = Arc::new(Mutex::new(ClipPitchCache::new(10)));
        let tracker = Arc::new(crate::pitch_progress::ProgressTracker::new(
            &clips,
            120.0,
            &cache,
        ));
        
        let result = compute_pitch_curve_parallel(
            &clips,
            &tracks_gain,
            120.0,
            5.0,
            40.0,
            1600.0,
            &PitchAnalysisAlgo::WorldDll,
            &cache,
            Some(&tracker),
            false,
        );
        
        // Should fail (nonexistent file) but not crash
        assert!(result.is_err());
        
        // Progress should be updated (100% since clip completed, even with failure)
        let progress = tracker.get_current_progress();
        assert!(progress >= 0.0 && progress <= 1.0);
    }
    
    #[test]
    fn test_compute_pitch_curve_parallel_mixed_algorithms() {
        // This test verifies that the WORLD/ONNX separation logic works correctly.
        // In a real scenario, WORLD clips would be processed serially and ONNX clips in parallel.
        // Here we just verify the function handles clips with different algorithms without crashing.
        
        // Note: Since we're passing WorldDll as `algo` parameter, all clips will be treated as WORLD clips.
        // In the actual implementation, each clip would have its own algorithm field.
        // For now, this test verifies the separation logic doesn't break the flow.
        
        let clips = vec![
            Clip {
                id: "world1".to_string(),
                track_id: "track1".to_string(),
                name: "WORLD Clip 1".to_string(),
            start_sec: 0.0,
            length_sec: 4.0,
                color: "#ff0000".to_string(),
                source_path: Some("/nonexistent_world.wav".to_string()),
                duration_sec: Some(2.0),
                waveform_preview: None,
                pitch_range: None,
                gain: 1.0,
                muted: false,
            source_start_sec: 0.0,
            source_end_sec: 2.0,
            playback_rate: 1.0,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            },
            Clip {
                id: "world2".to_string(),
                track_id: "track1".to_string(),
                name: "WORLD Clip 2".to_string(),
            start_sec: 4.0,
            length_sec: 4.0,
                color: "#00ff00".to_string(),
                source_path: Some("/nonexistent_world2.wav".to_string()),
                duration_sec: Some(2.0),
                waveform_preview: None,
                pitch_range: None,
                gain: 1.0,
                muted: false,
            source_start_sec: 0.0,
            source_end_sec: 2.0,
            playback_rate: 1.0,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            },
        ];
        
        let mut tracks_gain = std::collections::HashMap::new();
        tracks_gain.insert("track1".to_string(), 1.0);
        
        let cache = Arc::new(Mutex::new(ClipPitchCache::new(10)));
        
        // Test with WORLD algorithm (all clips will be processed serially)
        let result = compute_pitch_curve_parallel(
            &clips,
            &tracks_gain,
            120.0,
            5.0,
            40.0,
            1600.0,
            &PitchAnalysisAlgo::WorldDll,
            &cache,
            None,
            false,
        );
        
        // Should fail (all clips will fail due to nonexistent files, 100% > 50%)
        assert!(result.is_err());
        
        // Test with ONNX algorithm (all clips will be processed in parallel)
        let result_onnx = compute_pitch_curve_parallel(
            &clips,
            &tracks_gain,
            120.0,
            5.0,
            40.0,
            1600.0,
            &PitchAnalysisAlgo::NsfHifiganOnnx,
            &cache,
            None,
            false,
        );
        
        // Should also fail (all clips will fail, 100% > 50%)
        assert!(result_onnx.is_err());
    }
    
    #[test]
    fn test_compare_snapshots_no_old_snapshot() {
        use std::collections::HashMap;
        
        let mut new_clips = HashMap::new();
        new_clips.insert("clip1".to_string(), "key1".to_string());
        new_clips.insert("clip2".to_string(), "key2".to_string());
        
        let new_snapshot = crate::state::TimelineSnapshot {
            clips: new_clips,
            bpm: 120.0,
            frame_period_ms: 5.0,
        };
        
        let comparison = compare_snapshots(None, &new_snapshot);
        
        assert_eq!(comparison.added_clip_ids.len(), 2);
        assert!(comparison.added_clip_ids.contains(&"clip1".to_string()));
        assert!(comparison.added_clip_ids.contains(&"clip2".to_string()));
        assert_eq!(comparison.modified_clip_ids.len(), 0);
        assert_eq!(comparison.deleted_clip_ids.len(), 0);
        assert_eq!(comparison.unchanged_clip_ids.len(), 0);
    }
    
    #[test]
    fn test_compare_snapshots_added_clips() {
        use std::collections::HashMap;
        
        let mut old_clips = HashMap::new();
        old_clips.insert("clip1".to_string(), "key1".to_string());
        
        let old_snapshot = crate::state::TimelineSnapshot {
            clips: old_clips,
            bpm: 120.0,
            frame_period_ms: 5.0,
        };
        
        let mut new_clips = HashMap::new();
        new_clips.insert("clip1".to_string(), "key1".to_string());
        new_clips.insert("clip2".to_string(), "key2".to_string());
        
        let new_snapshot = crate::state::TimelineSnapshot {
            clips: new_clips,
            bpm: 120.0,
            frame_period_ms: 5.0,
        };
        
        let comparison = compare_snapshots(Some(&old_snapshot), &new_snapshot);
        
        assert_eq!(comparison.added_clip_ids, vec!["clip2".to_string()]);
        assert_eq!(comparison.modified_clip_ids.len(), 0);
        assert_eq!(comparison.deleted_clip_ids.len(), 0);
        assert_eq!(comparison.unchanged_clip_ids, vec!["clip1".to_string()]);
    }
    
    #[test]
    fn test_compare_snapshots_modified_clips() {
        use std::collections::HashMap;
        
        let mut old_clips = HashMap::new();
        old_clips.insert("clip1".to_string(), "key1".to_string());
        old_clips.insert("clip2".to_string(), "key2".to_string());
        
        let old_snapshot = crate::state::TimelineSnapshot {
            clips: old_clips,
            bpm: 120.0,
            frame_period_ms: 5.0,
        };
        
        let mut new_clips = HashMap::new();
        new_clips.insert("clip1".to_string(), "key1".to_string());
        new_clips.insert("clip2".to_string(), "key2_modified".to_string());
        
        let new_snapshot = crate::state::TimelineSnapshot {
            clips: new_clips,
            bpm: 120.0,
            frame_period_ms: 5.0,
        };
        
        let comparison = compare_snapshots(Some(&old_snapshot), &new_snapshot);
        
        assert_eq!(comparison.added_clip_ids.len(), 0);
        assert_eq!(comparison.modified_clip_ids, vec!["clip2".to_string()]);
        assert_eq!(comparison.deleted_clip_ids.len(), 0);
        assert_eq!(comparison.unchanged_clip_ids, vec!["clip1".to_string()]);
    }
    
    #[test]
    fn test_compare_snapshots_deleted_clips() {
        use std::collections::HashMap;
        
        let mut old_clips = HashMap::new();
        old_clips.insert("clip1".to_string(), "key1".to_string());
        old_clips.insert("clip2".to_string(), "key2".to_string());
        
        let old_snapshot = crate::state::TimelineSnapshot {
            clips: old_clips,
            bpm: 120.0,
            frame_period_ms: 5.0,
        };
        
        let mut new_clips = HashMap::new();
        new_clips.insert("clip1".to_string(), "key1".to_string());
        
        let new_snapshot = crate::state::TimelineSnapshot {
            clips: new_clips,
            bpm: 120.0,
            frame_period_ms: 5.0,
        };
        
        let comparison = compare_snapshots(Some(&old_snapshot), &new_snapshot);
        
        assert_eq!(comparison.added_clip_ids.len(), 0);
        assert_eq!(comparison.modified_clip_ids.len(), 0);
        assert_eq!(comparison.deleted_clip_ids, vec!["clip2".to_string()]);
        assert_eq!(comparison.unchanged_clip_ids, vec!["clip1".to_string()]);
    }
    
    #[test]
    fn test_compare_snapshots_global_param_change() {
        use std::collections::HashMap;
        
        let mut old_clips = HashMap::new();
        old_clips.insert("clip1".to_string(), "key1".to_string());
        
        let old_snapshot = crate::state::TimelineSnapshot {
            clips: old_clips,
            bpm: 120.0,
            frame_period_ms: 5.0,
        };
        
        let mut new_clips = HashMap::new();
        new_clips.insert("clip1".to_string(), "key1".to_string());
        
        let new_snapshot = crate::state::TimelineSnapshot {
            clips: new_clips,
            bpm: 140.0,  // BPM changed
            frame_period_ms: 5.0,
        };
        
        let comparison = compare_snapshots(Some(&old_snapshot), &new_snapshot);
        
        // Clip should be marked as modified due to BPM change
        assert_eq!(comparison.added_clip_ids.len(), 0);
        assert_eq!(comparison.modified_clip_ids, vec!["clip1".to_string()]);
        assert_eq!(comparison.deleted_clip_ids.len(), 0);
        assert_eq!(comparison.unchanged_clip_ids.len(), 0);
    }
    
    #[test]
    fn test_compare_snapshots_mixed_changes() {
        use std::collections::HashMap;
        
        let mut old_clips = HashMap::new();
        old_clips.insert("clip1".to_string(), "key1".to_string());
        old_clips.insert("clip2".to_string(), "key2".to_string());
        old_clips.insert("clip3".to_string(), "key3".to_string());
        
        let old_snapshot = crate::state::TimelineSnapshot {
            clips: old_clips,
            bpm: 120.0,
            frame_period_ms: 5.0,
        };
        
        let mut new_clips = HashMap::new();
        new_clips.insert("clip1".to_string(), "key1".to_string());  // unchanged
        new_clips.insert("clip2".to_string(), "key2_modified".to_string());  // modified
        new_clips.insert("clip4".to_string(), "key4".to_string());  // added
        // clip3 deleted
        
        let new_snapshot = crate::state::TimelineSnapshot {
            clips: new_clips,
            bpm: 120.0,
            frame_period_ms: 5.0,
        };
        
        let comparison = compare_snapshots(Some(&old_snapshot), &new_snapshot);
        
        assert_eq!(comparison.added_clip_ids, vec!["clip4".to_string()]);
        assert_eq!(comparison.modified_clip_ids, vec!["clip2".to_string()]);
        assert_eq!(comparison.deleted_clip_ids, vec!["clip3".to_string()]);
        assert_eq!(comparison.unchanged_clip_ids, vec!["clip1".to_string()]);
    }

    // Note: Full integration tests with actual audio files and cache hit/miss
    // scenarios would require test audio files and more complex setup.
    // These tests verify the basic error handling paths.
}