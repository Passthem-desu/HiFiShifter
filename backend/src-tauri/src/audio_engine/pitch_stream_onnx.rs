use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use super::ring::StreamRingStereo;
use crate::mixdown::{render_mixdown_interleaved, MixdownOptions};
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

fn mixdown_base_stereo(
    timeline: &TimelineState,
    sr: u32,
    start_sec: f64,
    end_sec: f64,
    stretch: StretchAlgorithm,
) -> Result<Vec<f32>, String> {
    let (_sr, _ch, _dur, pcm) = render_mixdown_interleaved(
        timeline,
        MixdownOptions {
            sample_rate: sr,
            start_sec,
            end_sec: Some(end_sec),
            stretch,
            apply_pitch_edit: false,
        },
    )?;
    Ok(pcm)
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
    preroll: Vec<f32>,
    main: Vec<f32>,
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
    let frames = xfade_frames as usize;
    if prev_tail.len() < frames * 2 || curr_preroll.len() < frames * 2 {
        return;
    }
    if boundary_frame < xfade_frames {
        return;
    }

    let mut blended = vec![0.0f32; frames * 2];
    for f in 0..frames {
        let w = if frames <= 1 {
            1.0
        } else {
            f as f32 / (frames as f32 - 1.0)
        };
        let w = clamp01(w);
        let a = 1.0 - w;
        let i = f * 2;
        blended[i] = prev_tail[i] * a + curr_preroll[i] * w;
        blended[i + 1] = prev_tail[i + 1] * a + curr_preroll[i + 1] * w;
    }

    ring.write_interleaved(boundary_frame - xfade_frames, &blended);
}

pub(crate) fn spawn_pitch_stream_onnx(
    timeline: TimelineState,
    sr: u32,
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

        let ctx_sec = env_f64("HIFISHIFTER_ONNX_VAD_CTX_SEC")
            .unwrap_or(1.5)
            .max(0.0);
        let xfade_ms = env_f64("HIFISHIFTER_ONNX_VAD_XFADE_MS")
            .unwrap_or(40.0)
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
                let total_frames = ((p.main.len() / 2) as u64).max(0);
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
                let start = (p.write_offset_frames as usize) * 2;
                let end = ((p.write_offset_frames + chunk_frames) as usize) * 2;
                if end <= p.main.len() {
                    ring.write_interleaved(out_cursor, &p.main[start..end]);
                    out_cursor = out_cursor.saturating_add(chunk_frames);
                    p.write_offset_frames = p.write_offset_frames.saturating_add(chunk_frames);
                } else {
                    // Safety: should not happen.
                    pending = None;
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

                    let pcm = match mixdown_base_stereo(
                        &timeline,
                        sr,
                        render_start,
                        render_end,
                        stretch.clone(),
                    ) {
                        Ok(v) => v,
                        Err(_) => {
                            thread::sleep(std::time::Duration::from_millis(30));
                            continue;
                        }
                    };

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
                    // We infer the entire remaining voiced segment (bounded by max_infer_sec),
                    // then stream the result into the ring in small chunks.
                    let pre_sec = (preroll_frames as f64) / (sr as f64);
                    let pad_pre = ctx_sec.max(pre_sec);
                    let pad_post = ctx_sec;

                    let seg_start_sec = t0;
                    let seg_end_sec = (seg_end_frame as f64) / (sr as f64);

                    let padded_start = (seg_start_sec - pad_pre).max(0.0);
                    let padded_end = (seg_end_sec + pad_post).min(project_sec.max(seg_end_sec));

                    let pcm = match mixdown_base_stereo(
                        &timeline,
                        sr,
                        padded_start,
                        padded_end,
                        stretch.clone(),
                    ) {
                        Ok(v) => v,
                        Err(_) => {
                            thread::sleep(std::time::Duration::from_millis(30));
                            continue;
                        }
                    };

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

                    let inferred_stereo = mono_to_stereo(&inferred);

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

                    let preroll = if preroll_frames > 0 {
                        let a = (pre_off as usize) * 2;
                        let b = (start_off as usize) * 2;
                        if b <= inferred_stereo.len() {
                            inferred_stereo[a..b].to_vec()
                        } else {
                            vec![]
                        }
                    } else {
                        vec![]
                    };

                    let mut main = {
                        let a = (start_off as usize) * 2;
                        let b = (end_off as usize) * 2;
                        inferred_stereo[a..b].to_vec()
                    };

                    fit_stereo_to_frames(&mut main, expected_frames);

                    if need_xfade && !prev_tail.is_empty() {
                        crossfade_into_ring(&ring, out_cursor, &prev_tail, &preroll, xfade_frames);
                    }

                    let tail = take_tail(&main, xfade_frames);
                    pending = Some(PendingVoiced {
                        start_frame: out_cursor,
                        end_frame: seg_end_frame,
                        preroll_frames,
                        preroll,
                        main,
                        write_offset_frames: 0,
                        tail,
                    });
                }
            }
        }
    });
}
