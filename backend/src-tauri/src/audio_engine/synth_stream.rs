use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::thread;

use crate::state::{Clip, TimelineState};

use super::ring::StreamRingStereo;
use super::types::EngineSnapshot;

/// 启动 per-clip 音高合成后台 worker。
///
/// Worker 按块调用 `maybe_apply_pitch_edit_to_clip_segment`，将合成后的 PCM
/// 写入 `ring`，供音频回调低延迟读取（优先于原始 PCM）。
///
/// # 参数
/// - `ring`: 写入目标 ring buffer（绝对帧地址）
/// - `snap`: 当前 engine snapshot（含 clip 的 src PCM）
/// - `src_clip`: 对应的 timeline clip（含 pitch edit 曲线）
/// - `timeline`: 当前 timeline 状态（含 pitch_edit 曲线）
/// - `clip_start_frame`: clip 在 timeline 上的起始帧（绝对）
/// - `clip_length_frames`: clip 在 timeline 上的总帧数
/// - `sample_rate`: 引擎输出采样率
/// - `position_frames`: 当前播放头（绝对帧）
/// - `is_playing`: 播放状态
/// - `epoch`: per-clip synth epoch，用于 cancel 检测
/// - `my_epoch`: 本 worker 启动时的 epoch 值
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_synth_stream(
    ring: Arc<StreamRingStereo>,
    snap: EngineSnapshot,
    src_clip: Clip,
    timeline: TimelineState,
    clip_start_frame: u64,
    clip_length_frames: u64,
    sample_rate: u32,
    position_frames: Arc<AtomicU64>,
    is_playing: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
    my_epoch: u64,
) {
    thread::spawn(move || {
        let sr = sample_rate.max(1) as f64;
        // 每块约 0.5s，平衡延迟与 CPU 开销
        let block_frames: u64 = (sr * 0.5).round().max(256.0) as u64;
        // 保持约 1.5s 的前瞻缓冲
        let lookahead_frames: u64 = (sr * 1.5).round().max(block_frames as f64) as u64;

        // 从播放头附近开始，减少感知延迟
        let now = position_frames.load(Ordering::Relaxed);
        let local0 = now.saturating_sub(clip_start_frame).min(clip_length_frames);
        ring.reset(local0);
        let mut out_cursor: u64 = local0;

        let mut seg_buf: Vec<f32> = Vec::new();

        loop {
            // epoch 变化 → 本 worker 已过期，退出
            if epoch.load(Ordering::Relaxed) != my_epoch {
                break;
            }

            if !is_playing.load(Ordering::Relaxed) {
                thread::sleep(std::time::Duration::from_millis(8));
                continue;
            }

            let now_abs = position_frames.load(Ordering::Relaxed);
            // clip 已结束
            if now_abs >= clip_start_frame.saturating_add(clip_length_frames) {
                thread::sleep(std::time::Duration::from_millis(8));
                continue;
            }

            let local_now = now_abs.saturating_sub(clip_start_frame);

            // 检测 seek（播放头跳跃）
            let base = ring.base_frame.load(Ordering::Acquire);
            let write = ring.write_frame.load(Ordering::Acquire);
            if local_now < base || local_now > write.saturating_add(block_frames * 4) {
                ring.reset(local_now);
                out_cursor = local_now;
            }

            // 不落后于播放头
            if out_cursor < local_now {
                out_cursor = local_now;
            }

            // 已有足够前瞻，等待
            let write_now = ring.write_frame.load(Ordering::Acquire);
            if write_now >= local_now.saturating_add(lookahead_frames) {
                thread::sleep(std::time::Duration::from_millis(3));
                continue;
            }

            // 超出 clip 范围，停止写入
            if out_cursor >= clip_length_frames {
                thread::sleep(std::time::Duration::from_millis(8));
                continue;
            }

            let frames = block_frames
                .min(clip_length_frames.saturating_sub(out_cursor)) as usize;
            if frames == 0 {
                thread::sleep(std::time::Duration::from_millis(8));
                continue;
            }

            // 从 snapshot 中采样该 clip 的原始 PCM（不含 pitch edit）
            seg_buf.resize(frames * 2, 0.0);
            seg_buf.fill(0.0);

            // 找到对应的 EngineClip
            let engine_clip = snap.clips.iter().find(|c| c.clip_id == src_clip.id);
            if let Some(ec) = engine_clip {
                let clip_off = out_cursor;
                for f in 0..frames {
                    let local = clip_off + f as u64;
                    let local_i64 = local as i64;
                    let local_adj_i64 = local_i64.saturating_add(ec.local_src_offset_frames);
                    if local_adj_i64 < 0 {
                        continue;
                    }
                    let local_adj = local_adj_i64 as f64;

                    // 直接从 src PCM 采样（不走 synth_ring，避免递归）
                    let src_pcm = ec.src.pcm.as_slice();
                    let src_frames = ec.src.frames as u64;
                    let src_pos = (ec.src_start_frame as f64) + local_adj * ec.playback_rate;

                    if src_pos + 1.0 >= ec.src_end_frame as f64 {
                        continue;
                    }
                    let i0 = src_pos.floor().max(0.0) as u64;
                    if i0 >= src_frames {
                        continue;
                    }
                    let i1 = (i0 + 1).min(src_frames - 1);
                    let frac = (src_pos - i0 as f64) as f32;
                    let i0u = i0 as usize;
                    let i1u = i1 as usize;
                    let l = src_pcm[i0u * 2]
                        + (src_pcm[i1u * 2] - src_pcm[i0u * 2]) * frac;
                    let r = src_pcm[i0u * 2 + 1]
                        + (src_pcm[i1u * 2 + 1] - src_pcm[i0u * 2 + 1]) * frac;
                    seg_buf[f * 2] = l;
                    seg_buf[f * 2 + 1] = r;
                }
            }

            // 应用 pitch edit（in-place）
            let abs_start = clip_start_frame.saturating_add(out_cursor);
            let clip_start_sec = (clip_start_frame as f64) / sr;
            let seg_start_sec = (abs_start as f64) / sr;

            let _ = crate::pitch_editing::maybe_apply_pitch_edit_to_clip_segment(
                &timeline,
                &src_clip,
                clip_start_sec,
                seg_start_sec,
                sample_rate,
                seg_buf.as_mut_slice(),
            );

            // 写入 ring（local 帧地址）
            ring.write_interleaved(out_cursor, seg_buf.as_slice());
            out_cursor = out_cursor.saturating_add(frames as u64);
        }
    });
}
