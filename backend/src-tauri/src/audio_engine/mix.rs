use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use arc_swap::ArcSwap;

use super::types::EngineSnapshot;
use super::util::clamp11;
use super::types::EngineClip;

fn sample_automation_curve(
    curve: Option<&Vec<f32>>,
    abs_frame: u64,
    sample_rate: u32,
    frame_period_ms: f64,
    default_value: f32,
) -> f32 {
    let Some(curve) = curve else {
        return default_value;
    };
    if curve.is_empty() {
        return default_value;
    }

    let fp = frame_period_ms.max(0.1);
    let abs_sec = abs_frame as f64 / sample_rate.max(1) as f64;
    let idx_f = (abs_sec * 1000.0) / fp;
    if !idx_f.is_finite() {
        return default_value;
    }
    let i0 = idx_f.floor().max(0.0) as usize;
    let i1 = (i0 + 1).min(curve.len().saturating_sub(1));
    let frac = (idx_f - i0 as f64).clamp(0.0, 1.0) as f32;
    let a = curve.get(i0).copied().unwrap_or(default_value);
    let b = curve.get(i1).copied().unwrap_or(a);
    a + (b - a) * frac
}

/// 采样 clip 在 local 帧处的原始 PCM（不含 gain/fade）。
/// 返回 None 表示该帧应静音（越界、leading silence 等）。
#[inline]
fn sample_clip_pcm(clip: &EngineClip, local: u64, local_adj: f64) -> Option<(f32, f32)> {
    // 最高优先级：预渲染 PCM（有 pitch edit 时由后台线程渲染）
    if let Some(ref rendered) = clip.rendered_pcm {
        let idx = (local as usize) * 2;
        if idx + 1 < rendered.len() {
            let mut left = rendered[idx];
            let mut right = rendered[idx + 1];
            if let Some(ref breath_noise) = clip.breath_noise_pcm {
                if idx + 1 < breath_noise.len() {
                    let gain = sample_automation_curve(
                        clip.breath_curve.as_deref(),
                        clip.start_frame.saturating_add(local),
                        clip.src.sample_rate,
                        clip.breath_curve_frame_period_ms,
                        1.0,
                    );
                    left += breath_noise[idx] * gain;
                    right += breath_noise[idx + 1] * gain;
                }
            }
            return Some((left, right));
        }
        // rendered_pcm 存在但越界时返回静音
        return None;
    }

    // 若该 clip 需要合成（pitch edit）但尚未渲染完成，静音等待
    if clip.needs_synthesis {
        return None;
    }

    // 无需合成：直接回退到源 PCM（支持 playback_rate 采样）
    let src_frame_f = local_adj * clip.playback_rate;
    let src_frame = src_frame_f.round() as u64;
    let src_abs = src_frame.saturating_add(clip.src_start_frame);
    if src_abs >= clip.src_end_frame {
        if clip.repeat {
            let range = clip.src_end_frame.saturating_sub(clip.src_start_frame);
            if range == 0 {
                return None;
            }
            let looped = clip.src_start_frame + ((src_abs - clip.src_start_frame) % range);
            let idx = (looped as usize) * 2;
            if idx + 1 < clip.src.pcm.len() {
                return Some((clip.src.pcm[idx], clip.src.pcm[idx + 1]));
            }
        }
        return None;
    }
    let idx = (src_abs as usize) * 2;
    if idx + 1 < clip.src.pcm.len() {
        Some((clip.src.pcm[idx], clip.src.pcm[idx + 1]))
    } else {
        None
    }
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

    // 检查当前播放窗口内是否有需要合成但尚未渲染完成的 clip，
    // 如果有则 cursor 暂停（不推进 position），输出静音等待渲染完成。
    let has_pending_clip = snap.clips.iter().any(|clip| {
        if !clip.needs_synthesis || clip.rendered_pcm.is_some() {
            return false; // 不需要合成 或 已经渲染好
        }
        // 该 clip 需要合成但还没好，检查是否与当前播放窗口重叠
        let clip_end = clip.start_frame.saturating_add(clip.length_frames);
        clip.start_frame < pos1 && clip_end > pos0
    });

    if has_pending_clip {
        // cursor 暂停，不推进 position，输出静音等待
        // 调试：每隔约 1s 打印一次（避免刷屏）
        if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
            static LAST_LOG: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let now = pos0 / 44100; // rough seconds
            let last = LAST_LOG.load(Ordering::Relaxed);
            if now != last {
                LAST_LOG.store(now, Ordering::Relaxed);
                for clip in snap.clips.iter() {
                    if clip.needs_synthesis && clip.rendered_pcm.is_none() {
                        let clip_end = clip.start_frame.saturating_add(clip.length_frames);
                        if clip.start_frame < pos1 && clip_end > pos0 {
                            eprintln!(
                                "[mix] PENDING clip_id={} needs_synthesis=true rendered_pcm=None pos={}",
                                clip.clip_id, pos0
                            );
                        }
                    }
                }
            }
        }
        return;
    }

    // Legacy mixing: 直接在 audio callback 中混合所有 clip
    mix_snapshot_clips_into_scratch(frames, &snap, pos0, pos1, scratch.as_mut_slice());

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
