use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use super::ring::StreamRingStereo;
use crate::pitch_editing::PitchCurvesSnapshot;
use crate::state::TimelineState;

// ─── 环境变量读取 ──────────────────────────────────────────────────────────────

fn env_f64(name: &str) -> Option<f64> {
    std::env::var(name)
        .ok()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite())
}

fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

// ─── PCM 工具函数 ──────────────────────────────────────────────────────────────

fn read_base_stereo_from_ring(
    base_ring: &StreamRingStereo,
    sr: u32,
    start_sec: f64,
    end_sec: f64,
    out: &mut Vec<f32>,
) -> Option<(u64, u64)> {
    let start_frame = (start_sec.max(0.0) * sr as f64).round().max(0.0) as u64;
    let end_frame = (end_sec.max(start_sec) * sr as f64).round().max(start_frame as f64) as u64;
    let frames = end_frame.saturating_sub(start_frame);
    if frames == 0 {
        out.clear();
        return Some((start_frame, end_frame));
    }
    let samples = (frames as usize).saturating_mul(2);
    out.resize(samples, 0.0);
    if !base_ring.read_interleaved_into(start_frame, out.as_mut_slice()) {
        return None;
    }
    Some((start_frame, end_frame))
}

fn take_tail(pcm: &[f32], tail_frames: u64) -> Vec<f32> {
    let frames = (pcm.len() / 2) as u64;
    if frames == 0 {
        return vec![];
    }
    let t = tail_frames.min(frames) as usize;
    let start = (frames as usize - t) * 2;
    pcm[start..].to_vec()
}

fn fit_stereo_to_frames(pcm: &mut Vec<f32>, expected_frames: u64) {
    let expected_samples = (expected_frames as usize).saturating_mul(2);
    if pcm.len() > expected_samples {
        pcm.truncate(expected_samples);
    } else if pcm.len() < expected_samples {
        pcm.resize(expected_samples, 0.0);
    }
}

// ─── Crossfade ─────────────────────────────────────────────────────────────────

/// 在 clip 边界处将 prev_tail 与 curr_head 做等功率 crossfade，
/// 并将混合结果写入 ring buffer 的 [boundary_frame - actual_frames, boundary_frame) 区间。
fn crossfade_into_ring(
    ring: &StreamRingStereo,
    boundary_frame: u64,
    prev_tail: &[f32],
    curr_head: &[f32],
    xfade_frames: u64,
) {
    if xfade_frames == 0 {
        return;
    }

    let prev_avail = prev_tail.len() / 2;
    let curr_avail = curr_head.len() / 2;
    let actual_frames = (xfade_frames as usize)
        .min(prev_avail)
        .min(curr_avail);
    if actual_frames == 0 {
        return;
    }
    if boundary_frame < actual_frames as u64 {
        return;
    }

    let prev_start = (prev_avail - actual_frames) * 2;
    let prev_slice = &prev_tail[prev_start..];
    let curr_slice = &curr_head[..actual_frames * 2];

    let mut blended = vec![0.0f32; actual_frames * 2];
    for f in 0..actual_frames {
        let t = if actual_frames <= 1 {
            1.0f32
        } else {
            f as f32 / (actual_frames as f32 - 1.0)
        };
        let t = clamp01(t);
        let angle = t * std::f32::consts::FRAC_PI_2;
        let w_prev = angle.cos();
        let w_curr = angle.sin();
        let i = f * 2;
        blended[i]     = prev_slice[i]     * w_prev + curr_slice[i]     * w_curr;
        blended[i + 1] = prev_slice[i + 1] * w_prev + curr_slice[i + 1] * w_curr;
    }

    ring.write_interleaved(boundary_frame - actual_frames as u64, &blended);
}

// ─── 流式写入状态 ──────────────────────────────────────────────────────────────

/// 已完成合成的 clip 数据，等待分批流式写入 ring。
struct PendingClip {
    /// 在全局 ring 中的写入起始帧
    #[allow(dead_code)]
    start_frame: u64,
    /// 在全局 ring 中的写入结束帧（exclusive）
    end_frame: u64,
    /// 合成结果（stereo interleaved）
    buf: Arc<Vec<f32>>,
    /// buf 中有效主体数据的样本范围 [main_start, main_end)
    main_start: usize,
    main_end: usize,
    /// 期望写入的总帧数（= end_frame - start_frame）
    expected_frames: u64,
    /// buf 中实际可用的主体帧数
    available_frames: u64,
    /// 已写入的帧数偏移
    write_offset: u64,
    /// 用于下一次 crossfade 的尾部数据
    tail: Vec<f32>,
}

// ─── Clip 描述 ─────────────────────────────────────────────────────────────────

/// 从 timeline 提取的 clip 时间线信息（按 start_frame 排序）。
#[derive(Clone)]
struct ClipInfo {
    clip_id: String,
    /// clip 在 timeline 上的起始帧（绝对）
    start_frame: u64,
    /// clip 在 timeline 上的结束帧（exclusive）
    end_frame: u64,
}

/// 计算 clip 的参数哈希，用于 [`crate::synth_clip_cache::SynthClipCacheKey`]。
fn compute_clip_param_hash(clip: &ClipInfo, sr: u32, curves: &PitchCurvesSnapshot) -> u64 {
    crate::synth_clip_cache::compute_param_hash(
        &clip.clip_id,
        clip.start_frame,
        clip.end_frame,
        sr,
        curves,
    )
}

/// 从 TimelineState 提取所有有效 clip 的时间线信息，按 start_frame 升序排列。
fn collect_clip_infos(timeline: &TimelineState, sr: u32) -> Vec<ClipInfo> {
    let mut infos: Vec<ClipInfo> = timeline
        .clips
        .iter()
        .filter(|c| !c.muted && c.source_path.is_some())
        .filter_map(|c| {
            let start_sec = c.start_sec.max(0.0);
            let len_sec = c.length_sec.max(0.0);
            if !(len_sec.is_finite() && len_sec > 1e-6) {
                return None;
            }
            let start_frame = (start_sec * sr as f64).round().max(0.0) as u64;
            let end_frame = ((start_sec + len_sec) * sr as f64).round().max(start_frame as f64 + 1.0) as u64;
            Some(ClipInfo {
                clip_id: c.id.clone(),
                start_frame,
                end_frame,
            })
        })
        .collect();

    infos.sort_by_key(|c| c.start_frame);
    infos
}

// ─── 主入口 ────────────────────────────────────────────────────────────────────

/// 启动 WORLD pitch_stream 后台 worker。
///
/// 与 `pitch_stream_onnx` 架构对称：
/// - 全局遍历所有 clip，按 clip 级别查/写 `synth_clip_cache`
/// - clip 内：缓存命中直接复用，未命中时调用 `maybe_apply_pitch_edit_to_clip_segment` 合成
/// - clip 间隙：passthrough from base_ring
/// - 等功率 crossfade 拼接边界
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_pitch_stream_world(
    timeline: TimelineState,
    sr: u32,
    base_ring: Arc<StreamRingStereo>,
    ring: Arc<StreamRingStereo>,
    position_frames: Arc<AtomicU64>,
    is_playing: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
    my_epoch: u64,
    curves: PitchCurvesSnapshot,
    debug: bool,
) {
    thread::spawn(move || {
        // ── 参数读取 ──────────────────────────────────────────────────────────
        let xfade_ms = env_f64("HIFISHIFTER_WORLD_VAD_XFADE_MS")
            .unwrap_or(80.0)
            .max(0.0);
        let xfade_frames = ((xfade_ms / 1000.0) * (sr as f64)).round().max(0.0) as u64;

        let warmup_ahead_frames = {
            let ms = env_f64("HIFISHIFTER_WORLD_WARMUP_MS")
                .unwrap_or(500.0)
                .max(0.0);
            ((ms / 1000.0) * sr as f64).round().max(256.0) as u64
        };
        let lookahead_frames_normal = {
            let sec = env_f64("HIFISHIFTER_WORLD_LOOKAHEAD_SEC")
                .unwrap_or(3.0)
                .max(0.0);
            ((sec * sr as f64).round().max(256.0) as u64).max(warmup_ahead_frames)
        };

        // ── Clip 列表 ─────────────────────────────────────────────────────────
        let clips = collect_clip_infos(&timeline, sr);
        let project_sec = timeline.project_duration_sec();
        let project_frames = (project_sec * sr as f64).round().max(0.0) as u64;

        // ── 状态 ──────────────────────────────────────────────────────────────
        let mut out_cursor: u64 = position_frames.load(Ordering::Relaxed);
        let mut clip_idx: usize = 0;
        let mut prev_tail: Vec<f32> = vec![];
        let mut pending: Option<PendingClip> = None;

        loop {
            if epoch.load(Ordering::Relaxed) != my_epoch {
                break;
            }
            if !is_playing.load(Ordering::Relaxed) {
                thread::sleep(std::time::Duration::from_millis(8));
                continue;
            }

            let now_abs = position_frames.load(Ordering::Relaxed);
            let base = ring.base_frame.load(Ordering::Acquire);
            let write = ring.write_frame.load(Ordering::Acquire);

            // ── Seek 检测 ─────────────────────────────────────────────────────
            if now_abs < base || now_abs > write.saturating_add(sr as u64) {
                out_cursor = now_abs;
                ring.reset(now_abs);
                pending = None;
                prev_tail.clear();
                clip_idx = clips
                    .iter()
                    .position(|c| c.end_frame > now_abs)
                    .unwrap_or(clips.len());
                thread::sleep(std::time::Duration::from_millis(2));
                continue;
            }

            if out_cursor < now_abs {
                out_cursor = now_abs;
            }

            // ── 前瞻控制 ──────────────────────────────────────────────────────
            let need_until = if write <= now_abs.saturating_add(warmup_ahead_frames) {
                now_abs.saturating_add(warmup_ahead_frames)
            } else {
                now_abs.saturating_add(lookahead_frames_normal)
            };
            if write >= need_until {
                thread::sleep(std::time::Duration::from_millis(3));
                continue;
            }

            // ── 流式写入 pending clip ─────────────────────────────────────────
            if let Some(p) = pending.as_mut() {
                let total_frames = p.expected_frames;
                if p.write_offset >= total_frames {
                    prev_tail = p.tail.clone();
                    out_cursor = p.end_frame;
                    pending = None;
                    continue;
                }

                let remaining = total_frames.saturating_sub(p.write_offset);
                let target_extra = need_until.saturating_sub(write);
                let chunk_frames = remaining
                    .min(target_extra.max(256))
                    .min((sr as u64) / 2 + 256);

                let mut wrote_frames: u64 = 0;

                // 写入合成结果
                if p.write_offset < p.available_frames {
                    let can = (p.available_frames - p.write_offset).min(chunk_frames);
                    let start = p.main_start + (p.write_offset as usize) * 2;
                    let end = start + (can as usize) * 2;
                    if end <= p.main_end && end <= p.buf.len() {
                        ring.write_interleaved(out_cursor, &p.buf[start..end]);
                        out_cursor = out_cursor.saturating_add(can);
                        p.write_offset = p.write_offset.saturating_add(can);
                        wrote_frames += can;
                    } else {
                        pending = None;
                        continue;
                    }
                }

                // 合成帧不足时补零
                let remain_in_chunk = chunk_frames.saturating_sub(wrote_frames);
                if remain_in_chunk > 0 {
                    let zeros = vec![0.0f32; (remain_in_chunk as usize) * 2];
                    ring.write_interleaved(out_cursor, &zeros);
                    out_cursor = out_cursor.saturating_add(remain_in_chunk);
                    p.write_offset = p.write_offset.saturating_add(remain_in_chunk);
                }

                continue;
            }

            // ── 工程结束 ──────────────────────────────────────────────────────
            if out_cursor >= project_frames && project_frames > 0 {
                thread::sleep(std::time::Duration::from_millis(8));
                continue;
            }

            // ── 推进 clip_idx ─────────────────────────────────────────────────
            while clip_idx < clips.len() && clips[clip_idx].end_frame <= out_cursor {
                clip_idx += 1;
            }

            // ── 判断当前位置属于 clip 内还是 clip 间隙 ───────────────────────
            let in_clip = clip_idx < clips.len()
                && clips[clip_idx].start_frame <= out_cursor
                && out_cursor < clips[clip_idx].end_frame;

            if in_clip {
                // ── 处理当前 clip ─────────────────────────────────────────────
                let clip = &clips[clip_idx];
                let clip_start_sec = (clip.start_frame as f64) / (sr as f64);
                let clip_end_sec = (clip.end_frame as f64) / (sr as f64);
                let expected_frames = clip.end_frame.saturating_sub(out_cursor);

                if debug {
                    eprintln!(
                        "pitch_stream_world: clip={} t0={:.3} t1={:.3} expected_frames={}",
                        clip.clip_id, clip_start_sec, clip_end_sec, expected_frames
                    );
                }

                // ── 查询 per-clip 缓存 ────────────────────────────────────────
                let param_hash = compute_clip_param_hash(clip, sr, &curves);
                let cache_key = crate::synth_clip_cache::SynthClipCacheKey {
                    clip_id: clip.clip_id.clone(),
                    param_hash,
                };

                let cached_pcm: Option<std::sync::Arc<Vec<f32>>> = {
                    let mut cache = crate::synth_clip_cache::global_synth_clip_cache()
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    cache.get(&cache_key).map(|e| e.pcm_stereo.clone())
                };

                let synth_stereo: std::sync::Arc<Vec<f32>> = if let Some(pcm) = cached_pcm {
                    // 缓存命中：直接复用，跳过合成
                    if debug {
                        eprintln!(
                            "pitch_stream_world: cache hit for clip={} hash={:#x}",
                            clip.clip_id, param_hash
                        );
                    }
                    pcm
                } else {
                    // 缓存未命中：读取 PCM 并调用 WORLD 合成
                    let mut pcm_stereo: Vec<f32> = vec![];
                    let ok = read_base_stereo_from_ring(
                        base_ring.as_ref(),
                        sr,
                        clip_start_sec,
                        clip_end_sec,
                        &mut pcm_stereo,
                    );
                    if ok.is_none() {
                        thread::sleep(std::time::Duration::from_millis(6));
                        continue;
                    }

                    // 查找 timeline 中对应的 Clip 对象
                    let tl_clip = timeline.clips.iter().find(|c| c.id == clip.clip_id);
                    let Some(tl_clip) = tl_clip else {
                        if debug {
                            eprintln!("pitch_stream_world: clip {} not found in timeline", clip.clip_id);
                        }
                        thread::sleep(std::time::Duration::from_millis(30));
                        continue;
                    };

                    // 调用 maybe_apply_pitch_edit_to_clip_segment 进行 WORLD 合成
                    let result = crate::pitch_editing::maybe_apply_pitch_edit_to_clip_segment(
                        &timeline,
                        tl_clip,
                        clip_start_sec,
                        clip_start_sec,
                        sr,
                        pcm_stereo.as_mut_slice(),
                    );

                    match result {
                        Ok(true) => {
                            // 合成成功，pcm_stereo 已被 in-place 修改
                        }
                        Ok(false) => {
                            // 跳过合成（无有效编辑），pcm_stereo 保持原始 PCM
                            if debug {
                                eprintln!(
                                    "pitch_stream_world: no effective edit for clip={}",
                                    clip.clip_id
                                );
                            }
                        }
                        Err(e) => {
                            if debug {
                                eprintln!(
                                    "pitch_stream_world: synth error for clip {}: {}",
                                    clip.clip_id, e
                                );
                            }
                            thread::sleep(std::time::Duration::from_millis(30));
                            continue;
                        }
                    }

                    let stereo = std::sync::Arc::new(pcm_stereo);

                    // 写入缓存
                    {
                        let mut cache = crate::synth_clip_cache::global_synth_clip_cache()
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        cache.insert(
                            cache_key,
                            crate::synth_clip_cache::SynthClipCacheEntry {
                                pcm_stereo: stereo.clone(),
                                frames: (stereo.len() / 2) as u64,
                                sample_rate: sr,
                            },
                        );
                    }

                    stereo
                };

                // 计算当前 out_cursor 在 clip 内的偏移
                let cursor_off_in_clip = out_cursor.saturating_sub(clip.start_frame) as usize;
                let main_start = cursor_off_in_clip * 2;
                let mut main_end = synth_stereo.len();

                // 截断到 expected_frames
                let max_end = main_start + (expected_frames as usize) * 2;
                if main_end > max_end {
                    main_end = max_end;
                }

                let available_frames = ((main_end.saturating_sub(main_start)) / 2) as u64;
                let available_frames = available_frames.min(expected_frames);

                // Crossfade：与上一段的尾部混合
                if !prev_tail.is_empty() && xfade_frames > 0 && main_start < synth_stereo.len() {
                    let head_end = (main_start + (xfade_frames as usize) * 2).min(synth_stereo.len());
                    crossfade_into_ring(
                        &ring,
                        out_cursor,
                        &prev_tail,
                        &synth_stereo[main_start..head_end],
                        xfade_frames,
                    );
                }

                let tail = if available_frames > 0 && main_end <= synth_stereo.len() {
                    take_tail(&synth_stereo[main_start..main_end], xfade_frames)
                } else {
                    vec![0.0f32; (xfade_frames.min(expected_frames) as usize) * 2]
                };

                pending = Some(PendingClip {
                    start_frame: out_cursor,
                    end_frame: clip.end_frame,
                    buf: synth_stereo,
                    main_start,
                    main_end,
                    expected_frames,
                    available_frames,
                    write_offset: 0,
                    tail,
                });
            } else {
                // ── 处理 clip 间隙（passthrough from base_ring）───────────────
                let gap_end_frame = if clip_idx < clips.len() {
                    clips[clip_idx].start_frame
                } else {
                    project_frames.max(out_cursor + 1)
                };

                // 每次最多处理 0.5s 的间隙，避免大块阻塞
                let max_gap_frames = (sr as u64) / 2;
                let seg_end_frame = gap_end_frame.min(out_cursor + max_gap_frames);

                if seg_end_frame <= out_cursor {
                    thread::sleep(std::time::Duration::from_millis(2));
                    continue;
                }

                let gap_start_sec = (out_cursor as f64) / (sr as f64);
                let gap_end_sec = (seg_end_frame as f64) / (sr as f64);
                let expected_frames = seg_end_frame.saturating_sub(out_cursor);

                if debug {
                    eprintln!(
                        "pitch_stream_world: gap t0={:.3} t1={:.3} frames={}",
                        gap_start_sec, gap_end_sec, expected_frames
                    );
                }

                let mut pcm: Vec<f32> = vec![];
                let ok = read_base_stereo_from_ring(
                    base_ring.as_ref(),
                    sr,
                    gap_start_sec,
                    gap_end_sec,
                    &mut pcm,
                );
                if ok.is_none() {
                    thread::sleep(std::time::Duration::from_millis(6));
                    continue;
                }

                fit_stereo_to_frames(&mut pcm, expected_frames);

                // Crossfade：与上一段的尾部混合
                if !prev_tail.is_empty() && xfade_frames > 0 && !pcm.is_empty() {
                    let head_end = ((xfade_frames as usize) * 2).min(pcm.len());
                    crossfade_into_ring(
                        &ring,
                        out_cursor,
                        &prev_tail,
                        &pcm[..head_end],
                        xfade_frames,
                    );
                }

                if !pcm.is_empty() {
                    ring.write_interleaved(out_cursor, &pcm);
                    prev_tail = take_tail(&pcm, xfade_frames);
                    out_cursor = seg_end_frame;
                }
            }
        }
    });
}
