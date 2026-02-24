use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use arc_swap::ArcSwap;

#[cfg(feature = "onnx")]
use crate::audio_engine::pitch_stream_onnx;

use super::types::EngineSnapshot;
use super::util::clamp11;

fn mix_snapshot_clips_into_scratch(
    _frames: usize,
    snap: &EngineSnapshot,
    pos0: u64,
    pos1: u64,
    scratch: &mut [f32],
) {
    for clip in &snap.clips {
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

        let src_pcm = clip.src.pcm.as_slice();
        let src_frames = clip.src.frames as u64;
        let loop_len = clip.src_end_frame.saturating_sub(clip.src_start_frame) as f64;

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

            let (l, r) = if let Some(stream) = clip.stretch_stream.as_ref() {
                if let Some((sl, sr)) = stream.read_frame(local) {
                    (sl * g, sr * g)
                } else {
                    let src_pos = if clip.repeat {
                        if loop_len <= 1.0 {
                            continue;
                        }
                        let within = (local_adj * clip.playback_rate).rem_euclid(loop_len);
                        (clip.src_start_frame as f64) + within
                    } else {
                        (clip.src_start_frame as f64) + local_adj * clip.playback_rate
                    };

                    if !clip.repeat && src_pos + 1.0 >= clip.src_end_frame as f64 {
                        continue;
                    }

                    let i0 = src_pos.floor().max(0.0) as u64;
                    if i0 >= src_frames {
                        continue;
                    }
                    let mut i1 = i0.saturating_add(1);
                    if clip.repeat {
                        if i1 >= clip.src_end_frame {
                            i1 = clip.src_start_frame;
                        }
                    } else if i1 >= src_frames {
                        continue;
                    }

                    let frac = (src_pos - (i0 as f64)) as f32;

                    let i0u = i0 as usize;
                    let i1u = i1 as usize;

                    let l0 = src_pcm[i0u * 2];
                    let r0 = src_pcm[i0u * 2 + 1];
                    let l1 = src_pcm[i1u * 2];
                    let r1 = src_pcm[i1u * 2 + 1];

                    let l = l0 + (l1 - l0) * frac;
                    let r = r0 + (r1 - r0) * frac;
                    (l * g, r * g)
                }
            } else {
                let src_pos = if clip.repeat {
                    if loop_len <= 1.0 {
                        continue;
                    }
                    let within = (local_adj * clip.playback_rate).rem_euclid(loop_len);
                    (clip.src_start_frame as f64) + within
                } else {
                    (clip.src_start_frame as f64) + local_adj * clip.playback_rate
                };

                if !clip.repeat && src_pos + 1.0 >= clip.src_end_frame as f64 {
                    continue;
                }

                let i0 = src_pos.floor().max(0.0) as u64;
                if i0 >= src_frames {
                    continue;
                }
                let mut i1 = i0.saturating_add(1);
                if clip.repeat {
                    if i1 >= clip.src_end_frame {
                        i1 = clip.src_start_frame;
                    }
                } else if i1 >= src_frames {
                    continue;
                }

                let frac = (src_pos - (i0 as f64)) as f32;

                let i0u = i0 as usize;
                let i1u = i1 as usize;

                let l0 = src_pcm[i0u * 2];
                let r0 = src_pcm[i0u * 2 + 1];
                let l1 = src_pcm[i1u * 2];
                let r1 = src_pcm[i1u * 2 + 1];

                let l = l0 + (l1 - l0) * frac;
                let r = r0 + (r1 - r0) * frac;
                (l * g, r * g)
            };

            let oi = (out_off + f) * 2;
            scratch[oi] += l;
            scratch[oi + 1] += r;
        }
    }
}

fn mix_into_scratch_stereo(
    frames: usize,
    snapshot: &Arc<ArcSwap<EngineSnapshot>>,
    is_playing: &AtomicBool,
    position_frames: &AtomicU64,
    duration_frames: &AtomicU64,
    scratch: &mut Vec<f32>,
) {
    scratch.resize(frames * 2, 0.0);
    scratch.fill(0.0);

    if !is_playing.load(Ordering::Relaxed) {
        return;
    }

    let snap = snapshot.load();
    let pos0 = position_frames.load(Ordering::Relaxed);
    let pos1 = pos0.saturating_add(frames as u64);

    if let Some(stream) = snap.pitch_stream.as_ref() {
        let base = stream.base_frame.load(Ordering::Acquire);
        let write = stream.write_frame.load(Ordering::Acquire);

        // If pitch-stream is enabled, the user expects to hear pitch-edited audio.
        // However, at the very beginning (or right after a seek/reset), the stream
        // might not have rendered any frames yet. Previously we would fall back to
        // original realtime mixing, which sounded like "original -> pitched".
        //
        // IMPORTANT: never block the real-time callback.
        // If we're at the stream base and the requested window is not covered yet,
        // we default to falling back to normal realtime mixing (so playback advances
        // instead of appearing to "freeze").
        //
        // If you prefer the old "hard start" (silence + do not advance until covered),
        // set: HIFISHIFTER_PITCH_STREAM_HARD_START=1
        let hard_start_env = std::env::var("HIFISHIFTER_PITCH_STREAM_HARD_START")
            .ok()
            .as_deref()
            == Some("1");
        let hard_start = hard_start_env || stream.is_hard_start_enabled();
        if hard_start && pos0 == base && pos1 > write {
            return;
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
            // Not fully covered yet: mix normally, then override the frames we do have.
            // This also acts as the fallback path when the stream hasn't warmed up.
            mix_snapshot_clips_into_scratch(frames, &snap, pos0, pos1, scratch.as_mut_slice());
            for f in 0..frames {
                let abs_f = pos0.saturating_add(f as u64);
                if let Some((l, r)) = stream.read_frame(abs_f) {
                    scratch[f * 2] = l;
                    scratch[f * 2 + 1] = r;
                }
            }
        }
    } else {
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
