use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread;

use crate::state::{Clip, TimelineState, Track};

use super::io::{get_resampled_stereo_cached, is_audio_path};
use super::base_stream;
use super::ring::StreamRingStereo;
use super::types::{EngineClip, EngineSnapshot, ResampledStereo, StretchJob, StretchKey};
use super::util::{clamp01, quantize_i64, quantize_u32};

pub(crate) fn compute_track_gains(tracks: &[Track]) -> HashMap<String, (f32, bool, bool)> {
    fn build_parent_map(tracks: &[Track]) -> HashMap<String, Option<String>> {
        let mut map = HashMap::new();
        for t in tracks {
            map.insert(t.id.clone(), t.parent_id.clone());
        }
        map
    }

    fn track_lineage(track_id: &str, parent_map: &HashMap<String, Option<String>>) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = Some(track_id.to_string());
        let mut safety = 0;
        while let Some(id) = cur {
            out.push(id.clone());
            cur = parent_map.get(&id).and_then(|p| p.clone());
            safety += 1;
            if safety > 2048 {
                break;
            }
        }
        out
    }

    let parent_map = build_parent_map(tracks);
    let by_id: HashMap<String, Track> = tracks.iter().cloned().map(|t| (t.id.clone(), t)).collect();

    let any_solo = tracks.iter().any(|t| t.solo);
    let mut out = HashMap::new();

    for t in tracks {
        let lineage = track_lineage(&t.id, &parent_map);

        let mut gain = 1.0f32;
        let mut muted = false;
        let mut soloed = false;
        for id in &lineage {
            if let Some(node) = by_id.get(id) {
                gain *= clamp01(node.volume);
                muted |= node.muted;
                soloed |= node.solo;
            }
        }

        if any_solo {
            out.insert(t.id.clone(), (gain, muted, soloed));
        } else {
            out.insert(t.id.clone(), (gain, muted, true));
        }
    }

    out
}

pub(crate) fn source_bounds_frames(
    trim_start_beat: f64,
    trim_end_beat: f64,
    bpm: f64,
    src_total_frames: usize,
    sr: u32,
) -> (u64, u64) {
    let bs = 60.0 / bpm.max(1e-6);
    let trim_start_sec = trim_start_beat.max(0.0) * bs;
    let trim_end_sec = trim_end_beat.max(0.0) * bs;

    let total_sec = (src_total_frames as f64) / sr.max(1) as f64;
    let start = (trim_start_sec * sr as f64).round().max(0.0);
    let end_limit_sec = (total_sec - trim_end_sec).max(trim_start_sec);
    let end = (end_limit_sec * sr as f64).round().max(start);

    // Keep within source length.
    let max_start = src_total_frames.saturating_sub(1) as u64;
    let mut start_u = (start as u64).min(max_start);
    let mut end_u = (end as u64).min(src_total_frames as u64);
    if end_u <= start_u {
        end_u = (start_u + 1).min(src_total_frames as u64);
    }
    // Ensure exclusive end.
    if end_u > src_total_frames as u64 {
        end_u = src_total_frames as u64;
    }
    if start_u >= end_u {
        start_u = end_u.saturating_sub(1);
    }
    (start_u, end_u)
}

fn clip_source_bounds_frames(
    clip: &Clip,
    bpm: f64,
    src_total_frames: usize,
    sr: u32,
) -> (u64, u64) {
    source_bounds_frames(
        clip.trim_start_beat.max(0.0),
        clip.trim_end_beat,
        bpm,
        src_total_frames,
        sr,
    )
}

fn make_stretch_key(
    path: &Path,
    out_rate: u32,
    bpm: f64,
    trim_start: f64,
    trim_end: f64,
    playback_rate: f64,
) -> StretchKey {
    StretchKey {
        path: path.to_path_buf(),
        out_rate,
        bpm_q: quantize_u32(bpm, 100.0),
        trim_start_q: quantize_i64(trim_start, 1000.0),
        trim_end_q: quantize_i64(trim_end, 1000.0),
        playback_rate_q: quantize_u32(playback_rate, 10000.0),
    }
}

pub(crate) fn schedule_stretch_jobs(
    timeline: &TimelineState,
    out_rate: u32,
    stretch_tx: &mpsc::Sender<StretchJob>,
    inflight: &Mutex<HashSet<StretchKey>>,
    stretch_cache: &Arc<Mutex<HashMap<StretchKey, ResampledStereo>>>,
) {
    let bpm = if timeline.bpm.is_finite() && timeline.bpm > 0.0 {
        timeline.bpm
    } else {
        120.0
    };

    let track_gain = compute_track_gains(&timeline.tracks);
    let mut audible_tracks: HashSet<String> = HashSet::new();
    for (tid, (_gain, muted, solo_ok)) in &track_gain {
        if !*muted && *solo_ok {
            audible_tracks.insert(tid.clone());
        }
    }

    for clip in &timeline.clips {
        if clip.muted {
            continue;
        }
        if !audible_tracks.contains(&clip.track_id) {
            continue;
        }
        let Some(source_path) = clip.source_path.as_ref() else {
            continue;
        };
        let playback_rate = clip.playback_rate as f64;
        let playback_rate = if playback_rate.is_finite() && playback_rate > 0.0 {
            playback_rate
        } else {
            1.0
        };
        if (playback_rate - 1.0).abs() <= 1e-6 {
            continue;
        }
        let path = Path::new(source_path);
        if !is_audio_path(path) {
            continue;
        }

        let key = make_stretch_key(
            path,
            out_rate,
            bpm,
            clip.trim_start_beat.max(0.0),
            clip.trim_end_beat,
            playback_rate,
        );

        if let Ok(m) = stretch_cache.lock() {
            if m.contains_key(&key) {
                continue;
            }
        }

        let should_enqueue = if let Ok(mut s) = inflight.lock() {
            if s.contains(&key) {
                false
            } else {
                s.insert(key.clone());
                true
            }
        } else {
            false
        };
        if !should_enqueue {
            continue;
        }

        let _ = stretch_tx.send(StretchJob {
            key,
            bpm,
            trim_start_beat: clip.trim_start_beat.max(0.0),
            trim_end_beat: clip.trim_end_beat,
            playback_rate,
        });
    }
}

pub(crate) fn build_snapshot(
    timeline: &TimelineState,
    out_rate: u32,
    cache: &Arc<Mutex<HashMap<(PathBuf, u32), ResampledStereo>>>,
    stretch_cache: &Arc<Mutex<HashMap<StretchKey, ResampledStereo>>>,
    position_frames: &Arc<AtomicU64>,
    is_playing: &Arc<AtomicBool>,
    stretch_stream_epoch: &Arc<AtomicU64>,
) -> EngineSnapshot {
    let debug = std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1");
    let bpm = if timeline.bpm.is_finite() && timeline.bpm > 0.0 {
        timeline.bpm
    } else {
        120.0
    };
    let bs = 60.0 / bpm;

    let duration_frames = ((timeline.project_beats.max(0.0) * bs) * out_rate as f64)
        .round()
        .max(0.0) as u64;

    let track_gain = compute_track_gains(&timeline.tracks);
    let mut audible_tracks: HashSet<String> = HashSet::new();
    for (tid, (_gain, muted, solo_ok)) in &track_gain {
        if !*muted && *solo_ok {
            audible_tracks.insert(tid.clone());
        }
    }

    let mut clips_out: Vec<EngineClip> = Vec::new();

    for clip in &timeline.clips {
        if clip.muted {
            continue;
        }
        if !audible_tracks.contains(&clip.track_id) {
            continue;
        }
        let Some(source_path) = clip.source_path.as_ref() else {
            continue;
        };
        let path = Path::new(source_path);
        if !is_audio_path(path) {
            continue;
        }

        let (track_gain_value, _tmuted, _solo_ok) = track_gain
            .get(&clip.track_id)
            .cloned()
            .unwrap_or((1.0, false, true));

        let gain = (clip.gain.max(0.0) * track_gain_value).clamp(0.0, 4.0);
        if gain <= 0.0 {
            continue;
        }

        let timeline_len_sec = (clip.length_beats.max(0.0) * bs).max(0.0);
        if !(timeline_len_sec.is_finite() && timeline_len_sec > 1e-6) {
            continue;
        }
        let length_frames = (timeline_len_sec * out_rate as f64).round().max(1.0) as u64;

        let start_sec = (clip.start_beat.max(0.0)) * bs;
        let start_frame = (start_sec * out_rate as f64).round().max(0.0) as u64;

        let playback_rate = clip.playback_rate as f64;
        let playback_rate = if playback_rate.is_finite() && playback_rate > 0.0 {
            playback_rate
        } else {
            1.0
        };

        let src = match get_resampled_stereo_cached(path, out_rate, cache) {
            Some(v) => v,
            None => continue,
        };

        let (mut src_start, mut src_end) =
            clip_source_bounds_frames(clip, bpm, src.frames, out_rate);
        if src_end.saturating_sub(src_start) <= 1 {
            continue;
        }

        // Timeline clips never loop/repeat; out-of-range source time is treated as silence.
        let mut repeat = false;
        let mut stretch_stream: Option<Arc<StreamRingStereo>> = None;

        // Negative trimStart means the clip starts before the source: render leading silence.
        // trim_* are expressed in SOURCE beats (i.e. they already incorporate playbackRate in UI).
        // Therefore leading silence in timeline time scales by 1 / playback_rate.
        let local_src_offset_frames: i64 =
            if clip.trim_start_beat.is_finite() && clip.trim_start_beat < 0.0 {
                let pr = playback_rate.max(1e-6);
                let pre_silence_sec = (-clip.trim_start_beat) * bs / pr;
                let frames = (pre_silence_sec * out_rate as f64).round().max(0.0) as i64;
                -frames
            } else {
                0
            };

        // If playback_rate != 1, prefer an asynchronously precomputed, pitch-preserving buffer.
        // Never block snapshot building here.
        let mut src_render = src;
        let mut playback_rate_render = playback_rate;
        if (playback_rate - 1.0).abs() > 1e-6 {
            let key = make_stretch_key(
                path,
                out_rate,
                bpm,
                clip.trim_start_beat.max(0.0),
                clip.trim_end_beat,
                playback_rate,
            );
            if let Ok(m) = stretch_cache.lock() {
                if let Some(stretched) = m.get(&key) {
                    src_render = stretched.clone();
                    src_start = 0;
                    src_end = src_render.frames as u64;
                    playback_rate_render = 1.0;
                    repeat = false;
                }
            }

            // Streaming stage (low-latency): if cache is missing, start a realtime stretcher
            // that incrementally fills a small ring buffer for the audio callback.
            if (playback_rate_render - 1.0).abs() > 1e-6 && crate::rubberband::is_available() {
                let cap_frames = (out_rate as u64).saturating_mul(2); // ~2s buffer
                let ring = Arc::new(StreamRingStereo::new(cap_frames));
                let ring_for_thread = ring.clone();

                // Start close to current playhead to reduce perceived delay.
                let now = position_frames.load(Ordering::Relaxed);
                let local0 = now.saturating_sub(start_frame);
                ring.reset(local0);

                let my_epoch = stretch_stream_epoch.load(Ordering::Relaxed);
                let epoch = stretch_stream_epoch.clone();
                let playing = is_playing.clone();
                let pos = position_frames.clone();

                let src_for_thread = src_render.clone();
                let src_start_u = src_start;
                let src_end_u = src_end;
                let pr = playback_rate_render;
                let clip_len = length_frames;
                let repeat_clip = repeat;
                let silence_frames: u64 = if local_src_offset_frames < 0 {
                    (-local_src_offset_frames) as u64
                } else {
                    0
                };

                thread::spawn(move || {
                    let time_ratio = 1.0 / pr.max(1e-6);
                    let mut rb = match crate::rubberband::RubberBandRealtimeStretcher::new(
                        out_rate, 2, time_ratio,
                    ) {
                        Ok(v) => v,
                        Err(_) => return,
                    };

                    let src_pcm = src_for_thread.pcm.as_slice();
                    let src_total = src_for_thread.frames as u64;

                    let mut out_cursor: u64 = local0;
                    let mut in_cursor: u64 = src_start_u;

                    let mut in_block: Vec<f32> = vec![0.0; 1024 * 2];
                    let mut out_block: Vec<f32> = Vec::with_capacity(2048 * 2);

                    loop {
                        if epoch.load(Ordering::Relaxed) != my_epoch {
                            break;
                        }
                        if !playing.load(Ordering::Relaxed) {
                            std::thread::sleep(std::time::Duration::from_millis(8));
                            continue;
                        }

                        let now_abs = pos.load(Ordering::Relaxed);
                        let local = now_abs.saturating_sub(start_frame);
                        if local >= clip_len {
                            std::thread::sleep(std::time::Duration::from_millis(8));
                            continue;
                        }

                        // Leading silence region (slip-edit past the source start).
                        if local < silence_frames {
                            std::thread::sleep(std::time::Duration::from_millis(4));
                            continue;
                        }

                        let local_audio = local.saturating_sub(silence_frames);

                        // Reset on large jumps (seek).
                        let base = ring_for_thread.base_frame.load(Ordering::Acquire);
                        let write = ring_for_thread.write_frame.load(Ordering::Acquire);
                        if local < base || local > write.saturating_add(4096) {
                            let _ = rb.reset(time_ratio);
                            ring_for_thread.reset(local);
                            out_cursor = local;

                            let start_in = (local_audio as f64 * pr).floor().max(0.0) as u64;
                            if repeat_clip {
                                let loop_len = src_end_u.saturating_sub(src_start_u).max(1);
                                in_cursor = src_start_u + (start_in % loop_len);
                            } else {
                                in_cursor = (src_start_u + start_in).min(src_end_u);
                            }
                        }

                        // Maintain some lookahead.
                        let ahead = write.saturating_sub(local);
                        if ahead >= 4096 {
                            std::thread::sleep(std::time::Duration::from_millis(2));
                            continue;
                        }

                        // Fill an input block from the source window.
                        let mut want_in = 1024usize;
                        if !repeat_clip {
                            if in_cursor >= src_end_u {
                                std::thread::sleep(std::time::Duration::from_millis(4));
                                continue;
                            }
                            let remain = src_end_u.saturating_sub(in_cursor) as usize;
                            want_in = want_in.min(remain.max(1));
                        }

                        for i in 0..want_in {
                            let src_f = if repeat_clip {
                                let loop_len = src_end_u.saturating_sub(src_start_u).max(1);
                                let within =
                                    (in_cursor.saturating_sub(src_start_u) + i as u64) % loop_len;
                                (src_start_u + within).min(src_total.saturating_sub(1))
                            } else {
                                (in_cursor + i as u64).min(src_total.saturating_sub(1))
                            };
                            let si = (src_f as usize) * 2;
                            in_block[i * 2] = src_pcm.get(si).copied().unwrap_or(0.0);
                            in_block[i * 2 + 1] = src_pcm.get(si + 1).copied().unwrap_or(0.0);
                        }

                        let _ = rb.process_interleaved(&in_block[..want_in * 2], false);
                        in_cursor = in_cursor.saturating_add(want_in as u64);
                        if repeat_clip {
                            let loop_len = src_end_u.saturating_sub(src_start_u).max(1);
                            if in_cursor >= src_end_u {
                                in_cursor = src_start_u + ((in_cursor - src_start_u) % loop_len);
                            }
                        }

                        out_block.clear();
                        for _ in 0..4 {
                            let got = rb
                                .retrieve_interleaved_into(&mut out_block, 1024)
                                .unwrap_or_default();
                            if got == 0 {
                                break;
                            }
                        }

                        if !out_block.is_empty() {
                            ring_for_thread.write_interleaved(out_cursor, out_block.as_slice());
                            out_cursor = out_cursor.saturating_add((out_block.len() / 2) as u64);
                        }
                    }
                });

                stretch_stream = Some(ring);
            }
        }

        let fade_in_frames = ((clip.fade_in_beats.max(0.0) * bs) * out_rate as f64)
            .round()
            .max(0.0) as u64;
        let fade_out_frames = ((clip.fade_out_beats.max(0.0) * bs) * out_rate as f64)
            .round()
            .max(0.0) as u64;

        clips_out.push(EngineClip {
            clip_id: clip.id.clone(),
            track_id: clip.track_id.clone(),
            start_frame,
            length_frames,
            src: src_render,
            src_start_frame: src_start,
            src_end_frame: src_end,
            playback_rate: playback_rate_render,
            stretch_stream,
            local_src_offset_frames,
            repeat,
            fade_in_frames,
            fade_out_frames,
            gain,
        });
    }

    clips_out.sort_by_key(|c| c.start_frame);

    // Decide pitch-stream intent early because pitch streaming depends on a stable PCM source.
    let pitch_stream_enabled = std::env::var("HIFISHIFTER_REALTIME_PITCH_STREAM")
        .ok()
        .as_deref()
        != Some("0");
    let pitch_active = crate::pitch_editing::is_pitch_edit_active(timeline);
    let pitch_backend_ok = crate::pitch_editing::is_pitch_edit_backend_available(timeline);
    let want_pitch_stream = pitch_stream_enabled && pitch_active && pitch_backend_ok;
    if debug {
        eprintln!(
            "AudioEngine: pitch_stream_enabled={} pitch_active={} pitch_backend_ok={} want_pitch_stream={}",
            pitch_stream_enabled, pitch_active, pitch_backend_ok, want_pitch_stream
        );
    }

    // Optional: base mix streamer. This offloads per-clip mixing from the audio callback.
    // The callback can read from this ring lock-free; when not covered it falls back to legacy mixing.
    // NOTE: when pitch streaming is requested, we force-enable base_stream because pitch workers read from it.
    let mut base_stream: Option<Arc<StreamRingStereo>> = None;
    let base_stream_enabled = std::env::var("HIFISHIFTER_REALTIME_BASE_STREAM")
        .ok()
        .as_deref()
        != Some("0")
        || want_pitch_stream;
    if base_stream_enabled {
        let cap_frames = (out_rate as u64).saturating_mul(8); // keep a few seconds window
        let ring = Arc::new(StreamRingStereo::new(cap_frames));

        // Start close to current playhead to reduce perceived delay.
        let now = position_frames.load(Ordering::Relaxed);
        ring.reset(now);

        let my_epoch = stretch_stream_epoch.load(Ordering::Relaxed);
        let epoch = stretch_stream_epoch.clone();
        let playing = is_playing.clone();
        let pos = position_frames.clone();
        let sr = out_rate;
        let dur_frames = duration_frames;
        let snap_for_thread = EngineSnapshot {
            bpm,
            sample_rate: sr,
            duration_frames: dur_frames,
            clips: clips_out.clone(),
            base_stream: None,
            pitch_stream: None,
            pitch_stream_algo: None,
        };

        base_stream::spawn_base_stream(
            ring.clone(),
            snap_for_thread,
            pos,
            playing,
            epoch,
            my_epoch,
            debug,
        );

        base_stream = Some(ring);
    }

    // Optional: pitch-edit bus streamer (low latency). It pre-renders forward windows using
    // mixdown (which applies pitch edits) and lets the audio callback read lock-free.
    // This is best-effort; if the selected pitch-edit backend isn't available, we keep normal realtime mixing.
    let mut pitch_stream: Option<Arc<StreamRingStereo>> = None;
    let mut pitch_stream_algo: Option<crate::pitch_editing::PitchEditAlgorithm> = None;
    if want_pitch_stream {
        let algo = crate::pitch_editing::selected_pitch_edit_algorithm(timeline);
        pitch_stream_algo = Some(algo);

        // Buffer sizing tradeoff:
        // - WORLD is usually fast enough; keeping a few seconds ahead reduces glitches.
        // - ONNX (NSF-HiFiGAN) can be significantly slower; keeping a huge lookahead just burns CPU
        //   and increases perceived latency. Keep it short and allow fallback mixing when needed.
        let cap_frames = match algo {
            crate::pitch_editing::PitchEditAlgorithm::NsfHifiganOnnx => {
                (out_rate as u64).saturating_mul(2)
            }
            _ => (out_rate as u64).saturating_mul(8),
        };
        let ring = Arc::new(StreamRingStereo::new(cap_frames));

        // Default: enable hard-start for all pitch-stream algorithms.
        // Can be disabled for debugging via: HIFISHIFTER_PITCH_STREAM_HARD_START=0
        let hard_start = std::env::var("HIFISHIFTER_PITCH_STREAM_HARD_START")
            .ok()
            .as_deref()
            != Some("0");
        if hard_start {
            ring.set_hard_start_enabled(true);
        }

        // A-mode: for slow ONNX inference, prefer a short prebuffer before advancing.
        // This avoids the audible "original -> pitched" transition at the very beginning.
        // Can be disabled for debugging via: HIFISHIFTER_ONNX_PITCH_STREAM_HARD_START=0
        let onnx_hard_start = std::env::var("HIFISHIFTER_ONNX_PITCH_STREAM_HARD_START")
            .ok()
            .as_deref()
            != Some("0");
        if matches!(
            algo,
            crate::pitch_editing::PitchEditAlgorithm::NsfHifiganOnnx
        ) && onnx_hard_start
        {
            ring.set_hard_start_enabled(true);
        }
        let ring_for_thread = ring.clone();

        // Start close to current playhead to reduce perceived delay.
        let now = position_frames.load(Ordering::Relaxed);
        ring.reset(now);

        let my_epoch = stretch_stream_epoch.load(Ordering::Relaxed);
        let epoch = stretch_stream_epoch.clone();
        let playing = is_playing.clone();
        let pos = position_frames.clone();

        let tl_for_thread = timeline.clone();
        let sr = out_rate;

        match algo {
            crate::pitch_editing::PitchEditAlgorithm::NsfHifiganOnnx => {
                let curves = crate::pitch_editing::selected_pitch_curves_snapshot(&tl_for_thread);
                if let Some(curves) = curves {
                    #[cfg(feature = "onnx")]
                    {
                        // Pitch workers read from base_stream.
                        let Some(base_ring) = base_stream.clone() else {
                            if debug {
                                eprintln!("AudioEngine: pitch_stream ONNX not started (missing base_stream)");
                            }
                            return EngineSnapshot {
                                bpm,
                                sample_rate: out_rate,
                                duration_frames,
                                clips: clips_out,
                                base_stream,
                                pitch_stream: None,
                                pitch_stream_algo,
                            };
                        };
                        super::pitch_stream_onnx::spawn_pitch_stream_onnx(
                            tl_for_thread,
                            sr,
                            base_ring,
                            ring_for_thread,
                            pos,
                            playing,
                            epoch,
                            my_epoch,
                            curves,
                            debug,
                        );
                    }
                    #[cfg(not(feature = "onnx"))]
                    {
                        let _ = curves;
                        if debug {
                            eprintln!("AudioEngine: pitch_stream ONNX not started (onnx feature disabled)");
                        }
                    }
                } else if debug {
                    eprintln!("AudioEngine: pitch_stream ONNX not started (missing pitch curves)");
                }
            }
            _ => {
                let snap_for_pitch = EngineSnapshot {
                    bpm,
                    sample_rate: sr,
                    duration_frames,
                    clips: clips_out.clone(),
                    base_stream: None,
                    pitch_stream: None,
                    pitch_stream_algo: None,
                };

                thread::spawn(move || {
                    // Default: prioritize smoothness.
                    let warmup_block_frames = ((sr as u64) / 2).max(256); // ~0.5s
                    let warmup_ahead_frames = ((sr as u64) / 2).max(256); // keep at least ~0.5s initially
                    let block_frames_normal = (sr as u64).saturating_mul(2); // 2s blocks
                    let lookahead_frames_normal = (sr as u64).saturating_mul(3); // keep ~3s ahead

                    let mut out_cursor: u64 = pos.load(Ordering::Relaxed);
                    let mut pcm: Vec<f32> = vec![];

                    loop {
                        if epoch.load(Ordering::Relaxed) != my_epoch {
                            break;
                        }
                        if !playing.load(Ordering::Relaxed) {
                            std::thread::sleep(std::time::Duration::from_millis(8));
                            continue;
                        }

                        let now_abs = pos.load(Ordering::Relaxed);
                        let base = ring_for_thread.base_frame.load(Ordering::Acquire);
                        let write = ring_for_thread.write_frame.load(Ordering::Acquire);

                        // Reset on large jumps (seek / transport changes).
                        if now_abs < base || now_abs > write.saturating_add(sr as u64) {
                            out_cursor = now_abs;
                            ring_for_thread.reset(now_abs);
                            std::thread::sleep(std::time::Duration::from_millis(2));
                            continue;
                        }

                        // Don't render behind the playhead.
                        if out_cursor < now_abs {
                            out_cursor = now_abs;
                        }

                        // Warm up quickly so playback can start without falling back.
                        let need_until = if write <= now_abs.saturating_add(warmup_ahead_frames) {
                            now_abs.saturating_add(warmup_ahead_frames)
                        } else {
                            now_abs.saturating_add(lookahead_frames_normal)
                        };
                        if write >= need_until {
                            std::thread::sleep(std::time::Duration::from_millis(3));
                            continue;
                        }

                        let block_frames = if write <= now_abs.saturating_add(warmup_ahead_frames) {
                            warmup_block_frames
                        } else {
                            block_frames_normal
                        };

                        let frames_u = block_frames.max(1);
                        let frames = frames_u as usize;
                        pcm.resize(frames * 2, 0.0);
                        pcm.fill(0.0);

                        // v2 realtime pitch edit for WORLD: per-clip render + per-clip pitch edit.
                        let pos0 = out_cursor;
                        let pos1 = out_cursor.saturating_add(frames_u);
                        crate::audio_engine::mix::mix_snapshot_clips_pitch_edited_into_scratch(
                            frames,
                            &tl_for_thread,
                            &snap_for_pitch,
                            pos0,
                            pos1,
                            pcm.as_mut_slice(),
                        );

                        ring_for_thread.write_interleaved(out_cursor, pcm.as_slice());
                        out_cursor = out_cursor.saturating_add(frames_u);
                    }
                });
            }
        }

        pitch_stream = Some(ring);
    } else if debug {
        eprintln!(
            "AudioEngine: pitch_stream not started (enabled={}, active={}, pitch_backend_ok={})",
            pitch_stream_enabled, pitch_active, pitch_backend_ok
        );
    }

    if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
        eprintln!(
            "AudioEngine: snapshot built: tracks={} clips_in_timeline={} clips_audible={} duration_frames={} sr={}",
            timeline.tracks.len(),
            timeline.clips.len(),
            clips_out.len(),
            duration_frames,
            out_rate
        );
        if let Some(c0) = clips_out.first() {
            eprintln!(
                "AudioEngine: first clip: start_frame={} len_frames={} src_start={:.1} src_end={:.1} gain={:.3} rate={:.3}",
                c0.start_frame,
                c0.length_frames,
                c0.src_start_frame,
                c0.src_end_frame,
                c0.gain,
                c0.playback_rate
            );
        }
    }

    EngineSnapshot {
        bpm,
        sample_rate: out_rate,
        duration_frames,
        clips: clips_out,
        base_stream,
        pitch_stream,
        pitch_stream_algo,
    }
}

pub(crate) fn build_snapshot_for_file(
    path: &Path,
    out_rate: u32,
    offset_sec: f64,
    cache: &Arc<Mutex<HashMap<(PathBuf, u32), ResampledStereo>>>,
) -> EngineSnapshot {
    let src = match get_resampled_stereo_cached(path, out_rate, cache) {
        Some(v) => v,
        None => return EngineSnapshot::empty(out_rate),
    };

    let offset_frames = (offset_sec.max(0.0) * out_rate as f64).round().max(0.0) as u64;
    let offset_frames = offset_frames.min(src.frames.saturating_sub(1) as u64);
    let available_frames = src.frames.saturating_sub(offset_frames as usize);
    let length_frames = available_frames.max(1) as u64;
    let src_end_frame = offset_frames
        .saturating_add(length_frames)
        .min(src.frames as u64);

    EngineSnapshot {
        bpm: 120.0,
        sample_rate: out_rate,
        duration_frames: length_frames,
        clips: vec![EngineClip {
            clip_id: "__file_preview__".to_string(),
            track_id: "__file_preview__".to_string(),
            start_frame: 0,
            length_frames,
            src,
            src_start_frame: offset_frames,
            src_end_frame,
            playback_rate: 1.0,
            stretch_stream: None,
            local_src_offset_frames: 0,
            repeat: false,
            fade_in_frames: 0,
            fade_out_frames: 0,
            gain: 1.0,
        }],
        base_stream: None,
        pitch_stream: None,
        pitch_stream_algo: None,
    }
}
