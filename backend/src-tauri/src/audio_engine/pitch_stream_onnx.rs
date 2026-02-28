use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use super::ring::StreamRingStereo;
use crate::pitch_editing::PitchCurvesSnapshot;
use crate::state::TimelineState;
use crate::time_stretch::StretchAlgorithm;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SegmentKind {
    Unvoiced,
    Voiced,
}

fn env_f64(name: &str) -> Option<f64> {
    std::env::var(name)
        .ok()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite())
}

/// 根据 voiced 段时长动态计算 ctx_sec。
///
/// - 若用户手动设置了 `HIFISHIFTER_ONNX_VAD_CTX_SEC`，则始终使用该定制値。
/// - 否则按照 voiced 段时长自适应：
///   - voiced_dur < 0.5s  → ctx_sec = 0.5（短音节，减少无效帧）
///   - voiced_dur < 2.0s  → ctx_sec = 1.0
///   - voiced_dur ≥ 2.0s  → ctx_sec = 1.5（保持原默认値）
fn compute_adaptive_ctx_sec(voiced_dur_sec: f64, user_override: Option<f64>) -> f64 {
    if let Some(v) = user_override {
        return v.max(0.0);
    }
    if voiced_dur_sec < 0.5 {
        0.5
    } else if voiced_dur_sec < 2.0 {
        1.0
    } else {
        1.5
    }
}

fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

fn compute_voiced_intervals_sec(curves: &PitchCurvesSnapshot, project_sec: f64) -> Vec<(f64, f64)> {
    let fp = curves.frame_period_ms.max(0.1);
    let frames = curves.pitch_orig.len().max(curves.pitch_edit.len());
    if frames == 0 {
        return vec![];
    }

    let pad_ms = env_f64("HIFISHIFTER_ONNX_VAD_PAD_MS")
        .unwrap_or(120.0)
        .max(0.0);
    let pad_frames = ((pad_ms / fp).ceil() as isize).max(0);

    let mut raw: Vec<(isize, isize)> = Vec::new();
    let mut i: usize = 0;
    while i < frames {
        let o = curves.pitch_orig.get(i).copied().unwrap_or(0.0);
        let e = curves.pitch_edit.get(i).copied().unwrap_or(0.0);
        let voiced = (o.is_finite() && o > 0.0) || (e.is_finite() && e > 0.0);
        if !voiced {
            i += 1;
            continue;
        }

        let start = i as isize;
        let mut end = (i + 1) as isize;
        while (end as usize) < frames {
            let o = curves.pitch_orig.get(end as usize).copied().unwrap_or(0.0);
            let e = curves.pitch_edit.get(end as usize).copied().unwrap_or(0.0);
            let voiced = (o.is_finite() && o > 0.0) || (e.is_finite() && e > 0.0);
            if !voiced {
                break;
            }
            end += 1;
        }
        raw.push((start - pad_frames, end + pad_frames));
        i = end as usize;
    }

    if raw.is_empty() {
        return vec![];
    }

    raw.sort_by_key(|p| p.0);
    let mut merged: Vec<(isize, isize)> = Vec::new();
    for (a0, a1) in raw {
        let a0 = a0.max(0);
        let a1 = a1.max(a0 + 1).min(frames as isize);
        if let Some(last) = merged.last_mut() {
            if a0 <= last.1 {
                last.1 = last.1.max(a1);
                continue;
            }
        }
        merged.push((a0, a1));
    }

    let mut out: Vec<(f64, f64)> = Vec::new();
    for (i0, i1) in merged {
        let t0 = (i0 as f64) * fp / 1000.0;
        let t1 = (i1 as f64) * fp / 1000.0;
        let t0 = t0.clamp(0.0, project_sec.max(0.0));
        let t1 = t1.clamp(t0, project_sec.max(0.0));
        if t1 - t0 > 1e-6 {
            out.push((t0, t1));
        }
    }

    out
}

fn find_interval_idx(intervals: &[(f64, f64)], t: f64, mut idx: usize) -> usize {
    while idx < intervals.len() {
        let (_s, e) = intervals[idx];
        if e <= t {
            idx += 1;
        } else {
            break;
        }
    }
    idx
}

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

fn stereo_to_mono(pcm: &[f32]) -> Vec<f32> {
    let frames = pcm.len() / 2;
    let mut mono = Vec::with_capacity(frames);
    for f in 0..frames {
        let l = pcm[f * 2];
        let r = pcm[f * 2 + 1];
        mono.push((l + r) * 0.5);
    }
    mono
}

fn mono_to_stereo(mono: &[f32]) -> Vec<f32> {
    let mut out = Vec::with_capacity(mono.len() * 2);
    for &v in mono {
        out.push(v);
        out.push(v);
    }
    out
}

struct PendingVoiced {
    start_frame: u64,
    end_frame: u64,
    preroll_frames: u64,
    buf: Arc<Vec<f32>>,
    preroll_range: (usize, usize),
    main_range: (usize, usize),
    expected_frames: u64,
    available_main_frames: u64,
    write_offset_frames: u64,
    tail: Vec<f32>,
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

fn build_preroll_and_main_from_stereo(pcm: &[f32], preroll_frames: u64) -> (Vec<f32>, Vec<f32>) {
    let frames = (pcm.len() / 2) as u64;
    let pre = preroll_frames.min(frames) as usize;
    let pre_len = pre * 2;
    let preroll = pcm[..pre_len].to_vec();
    let main = pcm[pre_len..].to_vec();
    (preroll, main)
}

/// 在 voiced/unvoiced 边界处将 prev_tail 与 curr_preroll 做等功率 crossfade，
/// 并将混合结果写入 ring buffer 的 [boundary_frame - actual_frames, boundary_frame) 区间。
///
/// 等功率权重：w_prev = cos(t * π/2)，w_curr = sin(t * π/2)，满足 w_prev² + w_curr² = 1。
/// 当 prev_tail 或 curr_preroll 的实际长度不足 xfade_frames 时，
/// 使用两者中较小的可用帧数，避免越界，不产生 panic。
fn crossfade_into_ring(
    ring: &StreamRingStereo,
    boundary_frame: u64,
    prev_tail: &[f32],
    curr_preroll: &[f32],
    xfade_frames: u64,
) {
    if xfade_frames == 0 {
        return;
    }

    // 使用实际可用帧数（取两者最小值），避免越界。
    let prev_avail = prev_tail.len() / 2;
    let curr_avail = curr_preroll.len() / 2;
    let actual_frames = (xfade_frames as usize)
        .min(prev_avail)
        .min(curr_avail);
    if actual_frames == 0 {
        return;
    }
    if boundary_frame < actual_frames as u64 {
        return;
    }

    // prev_tail 取尾部 actual_frames 帧（最新的部分）。
    let prev_start = (prev_avail - actual_frames) * 2;
    let prev_slice = &prev_tail[prev_start..];

    // curr_preroll 取头部 actual_frames 帧。
    let curr_slice = &curr_preroll[..actual_frames * 2];

    let mut blended = vec![0.0f32; actual_frames * 2];
    for f in 0..actual_frames {
        // t ∈ [0, 1]：0 = 边界起点（prev 主导），1 = 边界终点（curr 主导）。
        let t = if actual_frames <= 1 {
            1.0f32
        } else {
            f as f32 / (actual_frames as f32 - 1.0)
        };
        let t = clamp01(t);
        // 等功率权重：cos²(t·π/2) + sin²(t·π/2) = 1，能量守恒。
        let angle = t * std::f32::consts::FRAC_PI_2;
        let w_prev = angle.cos();
        let w_curr = angle.sin();
        let i = f * 2;
        blended[i]     = prev_slice[i]     * w_prev + curr_slice[i]     * w_curr;
        blended[i + 1] = prev_slice[i + 1] * w_prev + curr_slice[i + 1] * w_curr;
    }

    ring.write_interleaved(boundary_frame - actual_frames as u64, &blended);
}

pub(crate) fn spawn_pitch_stream_onnx(
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
        let project_sec = timeline.project_duration_sec();
        let intervals = compute_voiced_intervals_sec(&curves, project_sec);

        // ctx_sec 不再全局固定，改为在每个 voiced 段内根据时长动态计算（见 compute_adaptive_ctx_sec）。
        // 若用户设置了 HIFISHIFTER_ONNX_VAD_CTX_SEC，则始终使用该值覆盖自适应逻辑。
        let ctx_sec_override = env_f64("HIFISHIFTER_ONNX_VAD_CTX_SEC");
        // 默认 80ms：比原来的 40ms 更宽裕，足以掩盖 voiced/unvoiced 过渡噪声。
        // 可通过环境变量 HIFISHIFTER_ONNX_VAD_XFADE_MS 覆盖。
        let xfade_ms = env_f64("HIFISHIFTER_ONNX_VAD_XFADE_MS")
            .unwrap_or(80.0)
            .max(0.0);
        let xfade_frames = ((xfade_ms / 1000.0) * (sr as f64)).round().max(0.0) as u64;

        let max_infer_sec = match env_f64("HIFISHIFTER_ONNX_VAD_MAX_SEC") {
            None => 60.0,
            Some(v) if !v.is_finite() => 60.0,
            Some(v) if v <= 0.0 => f64::INFINITY,
            Some(v) if v < 0.5 => 0.5,
            Some(v) => v,
        };

        let warmup_ahead_frames = ((sr as f64) / 4.0).round().max(256.0) as u64; // ~0.25s
        let lookahead_frames_normal = (sr as u64).max(256); // ~1s

        let stretch = if crate::rubberband::is_available() {
            StretchAlgorithm::RubberBand
        } else {
            StretchAlgorithm::LinearResample
        };
        let _ = stretch;

        let mut interval_idx: usize = 0;
        let mut out_cursor: u64 = position_frames.load(Ordering::Relaxed);
        let mut prev_kind: Option<SegmentKind> = None;
        let mut prev_tail: Vec<f32> = vec![];
        let mut pending: Option<PendingVoiced> = None;

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

            // Reset on large jumps (seek / transport changes).
            if now_abs < base || now_abs > write.saturating_add(sr as u64) {
                out_cursor = now_abs;
                ring.reset(now_abs);
                pending = None;
                prev_kind = None;
                prev_tail.clear();
                interval_idx = 0;
                thread::sleep(std::time::Duration::from_millis(2));
                continue;
            }

            if out_cursor < now_abs {
                out_cursor = now_abs;
            }

            let need_until = if write <= now_abs.saturating_add(warmup_ahead_frames) {
                now_abs.saturating_add(warmup_ahead_frames)
            } else {
                now_abs.saturating_add(lookahead_frames_normal)
            };
            if write >= need_until {
                thread::sleep(std::time::Duration::from_millis(3));
                continue;
            }

            // If we already have a pending voiced segment inference result, stream it into the ring.
            if let Some(p) = pending.as_mut() {
                let total_frames = p.expected_frames;
                if p.write_offset_frames >= total_frames {
                    // Done.
                    prev_kind = Some(SegmentKind::Voiced);
                    prev_tail = p.tail.clone();
                    out_cursor = p.end_frame;
                    pending = None;
                    continue;
                }

                // Write a small chunk so we never jump too far ahead.
                let remaining = total_frames.saturating_sub(p.write_offset_frames);
                let target_extra = need_until.saturating_sub(write);
                let chunk_frames = remaining
                    .min(target_extra.max(256))
                    .min((sr as u64) / 2 + 256);

                let mut wrote_frames: u64 = 0;

                // 1) Write available inferred audio.
                if p.write_offset_frames < p.available_main_frames {
                    let can = (p.available_main_frames - p.write_offset_frames).min(chunk_frames);
                    let start = p.main_range.0 + (p.write_offset_frames as usize) * 2;
                    let end = start + (can as usize) * 2;
                    if end <= p.main_range.1 && end <= p.buf.len() {
                        ring.write_interleaved(out_cursor, &p.buf[start..end]);
                        out_cursor = out_cursor.saturating_add(can);
                        p.write_offset_frames = p.write_offset_frames.saturating_add(can);
                        wrote_frames += can;
                    } else {
                        // Safety: should not happen.
                        pending = None;
                        continue;
                    }
                }

                // 2) If expected_frames is longer than available inferred frames, pad zeros.
                let remain_in_chunk = chunk_frames.saturating_sub(wrote_frames);
                if remain_in_chunk > 0 {
                    let zeros = vec![0.0f32; (remain_in_chunk as usize) * 2];
                    ring.write_interleaved(out_cursor, &zeros);
                    out_cursor = out_cursor.saturating_add(remain_in_chunk);
                    p.write_offset_frames = p.write_offset_frames.saturating_add(remain_in_chunk);
                }

                continue;
            }

            let t0 = (out_cursor as f64) / (sr.max(1) as f64);
            interval_idx = find_interval_idx(&intervals, t0, interval_idx);
            let in_voiced = interval_idx < intervals.len()
                && intervals[interval_idx].0 <= t0
                && t0 < intervals[interval_idx].1;

            let kind = if in_voiced {
                SegmentKind::Voiced
            } else {
                SegmentKind::Unvoiced
            };

            // Determine segment end.
            let mut seg_end_sec = if in_voiced {
                intervals[interval_idx].1
            } else {
                if interval_idx < intervals.len() {
                    intervals[interval_idx].0
                } else {
                    (t0 + 2.0).min(project_sec.max(t0))
                }
            };

            // Avoid pathological allocations.
            if (seg_end_sec - t0) > max_infer_sec {
                seg_end_sec = t0 + max_infer_sec;
            }

            let seg_end_frame = ((seg_end_sec * sr as f64).round().max(t0 * sr as f64)) as u64;
            if seg_end_frame <= out_cursor {
                thread::sleep(std::time::Duration::from_millis(2));
                continue;
            }

            let need_xfade = prev_kind.is_some() && prev_kind != Some(kind) && xfade_frames > 0;
            let preroll_frames = if need_xfade { xfade_frames } else { 0 };

            if debug {
                eprintln!(
                    "pitch_stream_onnx: kind={kind:?} t0={t0:.3} t1={:.3} preroll_frames={} pending=false",
                    (seg_end_frame as f64) / (sr as f64),
                    preroll_frames
                );
            }

            match kind {
                SegmentKind::Unvoiced => {
                    let expected_frames = seg_end_frame.saturating_sub(out_cursor);
                    let pre_sec = (preroll_frames as f64) / (sr as f64);
                    let render_start = (t0 - pre_sec).max(0.0);
                    let render_end = (seg_end_frame as f64) / (sr as f64);

                    let mut pcm: Vec<f32> = vec![];
                    let ok = read_base_stereo_from_ring(
                        base_ring.as_ref(),
                        sr,
                        render_start,
                        render_end,
                        &mut pcm,
                    );
                    if ok.is_none() {
                        thread::sleep(std::time::Duration::from_millis(6));
                        continue;
                    }

                    let (preroll, mut main) =
                        build_preroll_and_main_from_stereo(&pcm, preroll_frames);

                    fit_stereo_to_frames(&mut main, expected_frames);

                    if need_xfade && !prev_tail.is_empty() {
                        crossfade_into_ring(&ring, out_cursor, &prev_tail, &preroll, xfade_frames);
                    }

                    if !main.is_empty() {
                        ring.write_interleaved(out_cursor, &main);
                        out_cursor = seg_end_frame;
                        prev_kind = Some(SegmentKind::Unvoiced);
                        prev_tail = take_tail(&main, xfade_frames);
                    }
                }
                SegmentKind::Voiced => {
                    let expected_frames = seg_end_frame.saturating_sub(out_cursor);
                    // 根据 voiced 段时长动态计算 ctx_sec，减少短 voiced 段的无效推理帧。
                    let voiced_dur_sec = seg_end_sec - t0;
                    let ctx_sec = compute_adaptive_ctx_sec(voiced_dur_sec, ctx_sec_override);
                    // We infer the entire remaining voiced segment (bounded by max_infer_sec),
                    // then stream the result into the ring in small chunks.
                    let pre_sec = (preroll_frames as f64) / (sr as f64);
                    let pad_pre = ctx_sec.max(pre_sec);
                    let pad_post = ctx_sec;

                    let seg_start_sec = t0;
                    let seg_end_sec = (seg_end_frame as f64) / (sr as f64);

                    let padded_start = (seg_start_sec - pad_pre).max(0.0);
                    let padded_end = (seg_end_sec + pad_post).min(project_sec.max(seg_end_sec));

                    let mut pcm: Vec<f32> = vec![];
                    let ok = read_base_stereo_from_ring(
                        base_ring.as_ref(),
                        sr,
                        padded_start,
                        padded_end,
                        &mut pcm,
                    );
                    if ok.is_none() {
                        thread::sleep(std::time::Duration::from_millis(6));
                        continue;
                    }

                    let mono = stereo_to_mono(&pcm);
                    let inferred = match crate::nsf_hifigan_onnx::infer_pitch_edit_mono(
                        &mono,
                        sr,
                        padded_start,
                        |abs_time_sec| curves.midi_at_time(abs_time_sec),
                    ) {
                        Ok(v) => v,
                        Err(_) => {
                            thread::sleep(std::time::Duration::from_millis(30));
                            continue;
                        }
                    };

                    if inferred.len() != mono.len() {
                        thread::sleep(std::time::Duration::from_millis(30));
                        continue;
                    }

                    let inferred_stereo = Arc::new(mono_to_stereo(&inferred));

                    let start_off = ((seg_start_sec - padded_start) * (sr as f64))
                        .round()
                        .max(0.0) as u64;
                    let end_off = ((seg_end_sec - padded_start) * (sr as f64))
                        .round()
                        .max(0.0) as u64;
                    let pre_off = start_off.saturating_sub(preroll_frames);

                    let total_frames = (inferred_stereo.len() / 2) as u64;
                    if end_off > total_frames || start_off > end_off {
                        thread::sleep(std::time::Duration::from_millis(10));
                        continue;
                    }

                    // Convert frame offsets into interleaved-sample indices.
                    let preroll_range = if preroll_frames > 0 {
                        let a = (pre_off as usize) * 2;
                        let b = (start_off as usize) * 2;
                        if b <= inferred_stereo.len() {
                            (a, b)
                        } else {
                            (0, 0)
                        }
                    } else {
                        (0, 0)
                    };

                    let main_a = (start_off as usize) * 2;
                    let mut main_b = (end_off as usize) * 2;
                    if main_b > inferred_stereo.len() {
                        main_b = inferred_stereo.len();
                    }

                    // Align to expected_frames by truncating (or later padding zeros while streaming).
                    let available_main_frames = ((main_b.saturating_sub(main_a)) / 2) as u64;
                    let (main_range, available_main_frames) = if available_main_frames > expected_frames {
                        let b = main_a + (expected_frames as usize) * 2;
                        ((main_a, b), expected_frames)
                    } else {
                        ((main_a, main_b), available_main_frames)
                    };

                    if need_xfade && !prev_tail.is_empty() && preroll_range.1 > preroll_range.0 {
                        crossfade_into_ring(
                            &ring,
                            out_cursor,
                            &prev_tail,
                            &inferred_stereo[preroll_range.0..preroll_range.1],
                            xfade_frames,
                        );
                    }

                    let tail = if expected_frames <= available_main_frames {
                        take_tail(
                            &inferred_stereo[main_range.0..main_range.1],
                            xfade_frames,
                        )
                    } else {
                        // We will pad zeros for the tail; next crossfade should see silence.
                        vec![
                            0.0f32;
                            (xfade_frames.min(expected_frames) as usize) * 2
                        ]
                    };

                    pending = Some(PendingVoiced {
                        start_frame: out_cursor,
                        end_frame: seg_end_frame,
                        preroll_frames,
                        buf: inferred_stereo,
                        preroll_range,
                        main_range,
                        expected_frames,
                        available_main_frames,
                        write_offset_frames: 0,
                        tail,
                    });
                }
            }
        }
    });
}
