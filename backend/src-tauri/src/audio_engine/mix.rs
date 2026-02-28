use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use arc_swap::ArcSwap;

#[cfg(feature = "onnx")]
use crate::audio_engine::pitch_stream_onnx;
use crate::state::TimelineState;

use super::types::EngineSnapshot;
use super::util::clamp11;
use super::realtime_stats::RealtimeRenderStats;
use super::types::EngineClip;

/// 采样 clip 在 local 帧处的原始 PCM（不含 gain/fade）。
/// 返回 None 表示该帧应静音（越界、leading silence 等）。
#[inline]
fn sample_clip_pcm(clip: &EngineClip, local: u64, local_adj: f64) -> Option<(f32, f32)> {
    let src_pcm = clip.src.pcm.as_slice();
    let src_frames = clip.src.frames as u64;
    let loop_len = clip.src_end_frame.saturating_sub(clip.src_start_frame) as f64;

    // Fast path: stretch_stream ring 已覆盖该帧
    if let Some(stream) = clip.stretch_stream.as_ref() {
        if let Some((sl, sr)) = stream.read_frame(local) {
            return Some((sl, sr));
        }
    }

    // Fallback: 线性插值采样
    let src_pos = if clip.repeat {
        if loop_len <= 1.0 {
            return None;
        }
        let within = (local_adj * clip.playback_rate).rem_euclid(loop_len);
        (clip.src_start_frame as f64) + within
    } else {
        (clip.src_start_frame as f64) + local_adj * clip.playback_rate
    };

    if !clip.repeat && src_pos + 1.0 >= clip.src_end_frame as f64 {
        return None;
    }

    let i0 = src_pos.floor().max(0.0) as u64;
    if i0 >= src_frames {
        return None;
    }
    let mut i1 = i0.saturating_add(1);
    if clip.repeat {
        if i1 >= clip.src_end_frame {
            i1 = clip.src_start_frame;
        }
    } else if i1 >= src_frames {
        return None;
    }

    let frac = (src_pos - i0 as f64) as f32;
    let i0u = i0 as usize;
    let i1u = i1 as usize;
    let l = src_pcm[i0u * 2] + (src_pcm[i1u * 2] - src_pcm[i0u * 2]) * frac;
    let r = src_pcm[i0u * 2 + 1] + (src_pcm[i1u * 2 + 1] - src_pcm[i0u * 2 + 1]) * frac;
    Some((l, r))
}

pub(crate) fn mix_snapshot_clips_into_scratch(
    _frames: usize,
    snap: &EngineSnapshot,
    pos0: u64,
    pos1: u64,
    scratch: &mut [f32],
) {
    for clip in snap.clips.iter() {
        let clip_start = clip.start_frame;
        let clip_end = clip.start_frame.saturating_add(clip.length_frames);
        if clip_end <= pos0 || clip_start >= pos1 {
            continue;
        }

        let overlap_start = clip_start.max(pos0);
        let overlap_end = clip_end.min(pos1);
        if overlap_end <= overlap_start {
            continue;
        }

        let out_off = (overlap_start - pos0) as usize;
        let clip_off = overlap_start - clip_start;
        let mix_frames = (overlap_end - overlap_start) as usize;

        for f in 0..mix_frames {
            let local = clip_off + f as u64;

            let local_i64 = if local > i64::MAX as u64 {
                continue;
            } else {
                local as i64
            };
            let local_adj_i64 = local_i64.saturating_add(clip.local_src_offset_frames);
            if local_adj_i64 < 0 {
                continue;
            }
            let local_adj = local_adj_i64 as f64;

            let mut g = clip.gain;
            if clip.fade_in_frames > 0 && local < clip.fade_in_frames {
                g *= (local as f32 / clip.fade_in_frames as f32).clamp(0.0, 1.0);
            }
            if clip.fade_out_frames > 0 && local + clip.fade_out_frames > clip.length_frames {
                let remain = clip.length_frames.saturating_sub(local);
                g *= (remain as f32 / clip.fade_out_frames as f32).clamp(0.0, 1.0);
            }
            if g <= 0.0 {
                continue;
            }

            let Some((l, r)) = sample_clip_pcm(clip, local, local_adj) else {
                continue;
            };

            let oi = (out_off + f) * 2;
            scratch[oi] += l * g;
            scratch[oi + 1] += r * g;
        }
    }
}

pub(crate) fn mix_snapshot_clips_pitch_edited_into_scratch(
    _frames: usize,
    timeline: &TimelineState,
    snap: &EngineSnapshot,
    pos0: u64,
    pos1: u64,
    scratch: &mut [f32],
) {
    if scratch.is_empty() {
        return;
    }
    scratch.fill(0.0);

    let sr = snap.sample_rate.max(1) as f64;

    // Temporary per-clip render buffer.
    let mut seg: Vec<f32> = vec![];

    for clip in snap.clips.iter() {
        let clip_start = clip.start_frame;
        let clip_end = clip.start_frame.saturating_add(clip.length_frames);
        if clip_end <= pos0 || clip_start >= pos1 {
            continue;
        }

        let overlap_start = clip_start.max(pos0);
        let overlap_end = clip_end.min(pos1);
        if overlap_end <= overlap_start {
            continue;
        }

        let out_off = (overlap_start - pos0) as usize;
        let clip_off = overlap_start - clip_start;
        let mix_frames = (overlap_end - overlap_start) as usize;

        if mix_frames == 0 {
            continue;
        }

        // Render this clip segment (pre-gain, pre-fade).
        seg.resize(mix_frames * 2, 0.0);
        seg.fill(0.0);

        for f in 0..mix_frames {
            let local = clip_off + f as u64;

            let local_i64 = if local > i64::MAX as u64 {
                continue;
            } else {
                local as i64
            };
            let local_adj_i64 = local_i64.saturating_add(clip.local_src_offset_frames);
            if local_adj_i64 < 0 {
                continue;
            }
            let local_adj = local_adj_i64 as f64;

            let Some((l, r)) = sample_clip_pcm(clip, local, local_adj) else {
                continue;
            };

            seg[f * 2] = l;
            seg[f * 2 + 1] = r;
        }

        // Apply v2 pitch edit for this clip segment (best-effort).
        if let Some(src_clip) = timeline.clips.iter().find(|c| c.id == clip.clip_id) {
            let clip_start_sec = (clip.start_frame as f64) / sr;
            let seg_start_sec = (overlap_start as f64) / sr;
            let _ = crate::pitch_editing::maybe_apply_pitch_edit_to_clip_segment(
                timeline,
                src_clip,
                clip_start_sec,
                seg_start_sec,
                snap.sample_rate,
                seg.as_mut_slice(),
            );
        }

        // Mix into output with gain and fades.
        for f in 0..mix_frames {
            let local = clip_off + f as u64;

            let mut g = clip.gain;
            if clip.fade_in_frames > 0 && local < clip.fade_in_frames {
                g *= (local as f32 / clip.fade_in_frames as f32).clamp(0.0, 1.0);
            }
            if clip.fade_out_frames > 0 && local + clip.fade_out_frames > clip.length_frames {
                let remain = clip.length_frames.saturating_sub(local);
                g *= (remain as f32 / clip.fade_out_frames as f32).clamp(0.0, 1.0);
            }
            if g <= 0.0 {
                continue;
            }

            let oi = (out_off + f) * 2;
            scratch[oi] += seg[f * 2] * g;
            scratch[oi + 1] += seg[f * 2 + 1] * g;
        }
    }
}

fn mix_into_scratch_stereo(
    frames: usize,
    snapshot: &Arc<ArcSwap<EngineSnapshot>>,
    is_playing: &AtomicBool,
    position_frames: &AtomicU64,
    duration_frames: &AtomicU64,
    stats: &RealtimeRenderStats,
    scratch: &mut Vec<f32>,
) {
    scratch.resize(frames * 2, 0.0);
    scratch.fill(0.0);

    stats.callbacks_total.fetch_add(1, Ordering::Relaxed);

    if !is_playing.load(Ordering::Relaxed) {
        stats
            .callbacks_silenced_not_playing
            .fetch_add(1, Ordering::Relaxed);
        return;
    }

    let snap = snapshot.load();
    let pos0 = position_frames.load(Ordering::Relaxed);
    let pos1 = pos0.saturating_add(frames as u64);

    if let Some(stream) = snap.pitch_stream.as_ref() {
        stats.pitch_callbacks_total.fetch_add(1, Ordering::Relaxed);
        let base = stream.base_frame.load(Ordering::Acquire);
        let write = stream.write_frame.load(Ordering::Acquire);

        // If pitch-stream is enabled, the user expects to hear pitch-edited audio.
        // We intentionally avoid doing expensive fallback mixing in the real-time callback,
        // because it can cause CPU spikes (underruns) and an audible "original -> pitched"
        // transition.
        //
        // When hard-start is enabled, we output silence and DO NOT advance playback until
        // the requested window is covered by [base_frame, write_frame).
        let hard_start = stream.is_hard_start_enabled();
        if hard_start {
            // Optional: require a small prebuffer before starting, so we don't oscillate
            // between covered/not-covered right after starting.
            let prime_sec: f64 = std::env::var("HIFISHIFTER_PITCH_STREAM_PRIME_SEC")
                .ok()
                .and_then(|s| s.trim().parse::<f64>().ok())
                .filter(|v| v.is_finite() && *v > 0.0)
                .unwrap_or(0.25);
            let sr = snap.sample_rate.max(1) as f64;
            let prime_frames = (prime_sec * sr).round().max(1.0) as u64;

            if pos0 == base {
                let need = base.saturating_add(prime_frames);
                if write < need {
                    stats
                        .pitch_callbacks_prime_waiting
                        .fetch_add(1, Ordering::Relaxed);
                    return;
                }
            }

            if pos0 < base || pos1 > write {
                stats
                    .pitch_callbacks_silenced_waiting
                    .fetch_add(1, Ordering::Relaxed);
                return;
            }
        }

        // Fully covered: stream-only fast path.
        if pos0 >= base && pos1 <= write {
            for f in 0..frames {
                let abs_f = pos0.saturating_add(f as u64);
                if let Some((l, r)) = stream.read_frame(abs_f) {
                    scratch[f * 2] = l;
                    scratch[f * 2 + 1] = r;
                }
            }
        } else {
            // Best-effort fallback (debug): keep legacy behavior when hard-start is disabled.
            stats
                .pitch_callbacks_fallback_mixed
                .fetch_add(1, Ordering::Relaxed);
            mix_snapshot_clips_into_scratch(frames, &snap, pos0, pos1, scratch.as_mut_slice());
            for f in 0..frames {
                let abs_f = pos0.saturating_add(f as u64);
                if let Some((l, r)) = stream.read_frame(abs_f) {
                    scratch[f * 2] = l;
                    scratch[f * 2 + 1] = r;
                }
            }
        }
    } else if let Some(base) = snap.base_stream.as_ref() {
        stats.base_callbacks_total.fetch_add(1, Ordering::Relaxed);
        let base0 = base.base_frame.load(Ordering::Acquire);
        let write = base.write_frame.load(Ordering::Acquire);
        if pos0 >= base0 && pos1 <= write {
            stats.base_callbacks_covered.fetch_add(1, Ordering::Relaxed);
            for f in 0..frames {
                let abs_f = pos0.saturating_add(f as u64);
                if let Some((l, r)) = base.read_frame(abs_f) {
                    scratch[f * 2] = l;
                    scratch[f * 2 + 1] = r;
                }
            }
        } else {
            stats
                .base_callbacks_fallback_mixed
                .fetch_add(1, Ordering::Relaxed);
            mix_snapshot_clips_into_scratch(frames, &snap, pos0, pos1, scratch.as_mut_slice());
        }
    } else {
        stats.legacy_callbacks_mixed.fetch_add(1, Ordering::Relaxed);
        mix_snapshot_clips_into_scratch(frames, &snap, pos0, pos1, scratch.as_mut_slice());
    }

    let new_pos = pos0.saturating_add(frames as u64);
    position_frames.store(new_pos, Ordering::Relaxed);

    let dur = duration_frames.load(Ordering::Relaxed);
    if dur > 0 && new_pos >= dur {
        is_playing.store(false, Ordering::Relaxed);
    }
}

pub(crate) fn render_callback_f32(
    data: &mut [f32],
    out_channels: usize,
    snapshot: &Arc<ArcSwap<EngineSnapshot>>,
    is_playing: &AtomicBool,
    position_frames: &AtomicU64,
    duration_frames: &AtomicU64,
    stats: &RealtimeRenderStats,
    scratch: &mut Vec<f32>,
) {
    let frames = if out_channels == 0 {
        0
    } else {
        data.len() / out_channels
    };
    if frames == 0 {
        return;
    }

    let was_playing = is_playing.load(Ordering::Relaxed);
    if !was_playing {
        data.fill(0.0);
        return;
    }

    mix_into_scratch_stereo(
        frames,
        snapshot,
        is_playing,
        position_frames,
        duration_frames,
        stats,
        scratch,
    );

    for f in 0..frames {
        let l = clamp11(scratch[f * 2]);
        let r = clamp11(scratch[f * 2 + 1]);
        if out_channels == 1 {
            data[f] = (l + r) * 0.5;
        } else {
            let base = f * out_channels;
            data[base] = l;
            data[base + 1] = r;
            for ch in 2..out_channels {
                data[base + ch] = 0.0;
            }
        }
    }
}

pub(crate) fn render_callback_i16(
    data: &mut [i16],
    out_channels: usize,
    snapshot: &Arc<ArcSwap<EngineSnapshot>>,
    is_playing: &AtomicBool,
    position_frames: &AtomicU64,
    duration_frames: &AtomicU64,
    stats: &RealtimeRenderStats,
    scratch: &mut Vec<f32>,
) {
    let frames = if out_channels == 0 {
        0
    } else {
        data.len() / out_channels
    };
    if frames == 0 {
        return;
    }

    if !is_playing.load(Ordering::Relaxed) {
        data.fill(0);
        return;
    }

    mix_into_scratch_stereo(
        frames,
        snapshot,
        is_playing,
        position_frames,
        duration_frames,
        stats,
        scratch,
    );

    for f in 0..frames {
        let l = clamp11(scratch[f * 2]);
        let r = clamp11(scratch[f * 2 + 1]);
        if out_channels == 1 {
            let v = clamp11((l + r) * 0.5);
            data[f] = (v * i16::MAX as f32) as i16;
        } else {
            let base = f * out_channels;
            data[base] = (l * i16::MAX as f32) as i16;
            data[base + 1] = (r * i16::MAX as f32) as i16;
            for ch in 2..out_channels {
                data[base + ch] = 0;
            }
        }
    }
}

pub(crate) fn render_callback_u16(
    data: &mut [u16],
    out_channels: usize,
    snapshot: &Arc<ArcSwap<EngineSnapshot>>,
    is_playing: &AtomicBool,
    position_frames: &AtomicU64,
    duration_frames: &AtomicU64,
    stats: &RealtimeRenderStats,
    scratch: &mut Vec<f32>,
) {
    let frames = if out_channels == 0 {
        0
    } else {
        data.len() / out_channels
    };
    if frames == 0 {
        return;
    }

    if !is_playing.load(Ordering::Relaxed) {
        data.fill(u16::MAX / 2);
        return;
    }

    mix_into_scratch_stereo(
        frames,
        snapshot,
        is_playing,
        position_frames,
        duration_frames,
        stats,
        scratch,
    );

    for f in 0..frames {
        let l = clamp11(scratch[f * 2]);
        let r = clamp11(scratch[f * 2 + 1]);
        if out_channels == 1 {
            let v = clamp11((l + r) * 0.5);
            let s = ((v * 0.5 + 0.5) * u16::MAX as f32).round();
            data[f] = s.clamp(0.0, u16::MAX as f32) as u16;
        } else {
            let base = f * out_channels;
            let sl = ((l * 0.5 + 0.5) * u16::MAX as f32).round();
            let sr = ((r * 0.5 + 0.5) * u16::MAX as f32).round();
            data[base] = sl.clamp(0.0, u16::MAX as f32) as u16;
            data[base + 1] = sr.clamp(0.0, u16::MAX as f32) as u16;
            for ch in 2..out_channels {
                data[base + ch] = u16::MAX / 2;
            }
        }
    }
}
