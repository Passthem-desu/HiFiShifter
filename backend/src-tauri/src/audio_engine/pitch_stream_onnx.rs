use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use super::ring::StreamRingStereo;
use crate::pitch_editing::PitchCurvesSnapshot;
use crate::state::TimelineState;
use crate::time_stretch::StretchAlgorithm;

// 鈹€鈹€鈹€ 鐜鍙橀噺璇诲彇 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

fn env_f64(name: &str) -> Option<f64> {
    std::env::var(name)
        .ok()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite())
}

fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

// 鈹€鈹€鈹€ PCM 宸ュ叿鍑芥暟 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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
    if base_ring.read_interleaved_into(start_frame, out.as_mut_slice()) {
        return Some((start_frame, end_frame));
    }

    // 完整区间不可用：可能 playhead 在 clip 中间，base_ring 只覆盖 [base_frame, write_frame)。
    // 将 [start_frame, base_frame) 填零，只读取 [base_frame, min(end_frame, write_frame)) 的可用部分。
    let ring_base = base_ring.base_frame.load(Ordering::Acquire);
    let ring_write = base_ring.write_frame.load(Ordering::Acquire);

    // base_ring 还完全没有覆盖到 end_frame → 真的需要等
    if ring_write <= start_frame {
        return None;
    }

    // 计算可读取的区间
    let read_start = start_frame.max(ring_base);
    let read_end = end_frame.min(ring_write);
    if read_end <= read_start {
        // 可读区间为空但 ring_write > start_frame，说明数据在中间缺失，
        // 返回全零填充的 buffer 让推理继续。
        out.fill(0.0);
        return Some((start_frame, end_frame));
    }

    // 前段填零
    out.fill(0.0);

    // 读取可用部分
    let offset_frames = read_start.saturating_sub(start_frame) as usize;
    let read_frames = read_end.saturating_sub(read_start) as usize;
    let read_samples = read_frames * 2;
    let mut tmp = vec![0.0f32; read_samples];
    if base_ring.read_interleaved_into(read_start, &mut tmp) {
        let dst_start = offset_frames * 2;
        let dst_end = dst_start + read_samples;
        if dst_end <= out.len() {
            out[dst_start..dst_end].copy_from_slice(&tmp);
        }
    }
    // 即使部分读取失败（竞态），也返回部分填零的 buffer，避免死循环
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

// 鈹€鈹€鈹€ Crossfade 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/// 鍦?clip 杈圭晫澶勫皢 prev_tail 涓?curr_head 鍋氱瓑鍔熺巼 crossfade锛?/// 骞跺皢娣峰悎缁撴灉鍐欏叆 ring buffer 鐨?[boundary_frame - actual_frames, boundary_frame) 鍖洪棿銆?///
/// 绛夊姛鐜囨潈閲嶏細w_prev = cos(t * 蟺/2)锛寃_curr = sin(t * 蟺/2)锛屾弧瓒?w_prev虏 + w_curr虏 = 1銆?fn crossfade_into_ring(
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

// 鈹€鈹€鈹€ 娴佸紡鍐欏叆鐘舵€?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/// 宸插畬鎴愭帹鐞嗙殑 clip 鏁版嵁锛岀瓑寰呭垎鎵规祦寮忓啓鍏?ring銆?struct PendingClip {
    /// 鍦ㄥ叏灞€ ring 涓殑鍐欏叆璧峰甯?    start_frame: u64,
    /// 鍦ㄥ叏灞€ ring 涓殑鍐欏叆缁撴潫甯э紙exclusive锛?    end_frame: u64,
    /// 鎺ㄧ悊缁撴灉锛坰tereo interleaved锛?    buf: Arc<Vec<f32>>,
    /// buf 涓湁鏁堜富浣撴暟鎹殑鏍锋湰鑼冨洿 [main_start, main_end)
    main_start: usize,
    main_end: usize,
    /// 鏈熸湜鍐欏叆鐨勬€诲抚鏁帮紙= end_frame - start_frame锛?    expected_frames: u64,
    /// buf 涓疄闄呭彲鐢ㄧ殑涓讳綋甯ф暟
    available_frames: u64,
    /// 宸插啓鍏ョ殑甯ф暟鍋忕Щ
    write_offset: u64,
    /// 鐢ㄤ簬涓嬩竴娆?crossfade 鐨勫熬閮ㄦ暟鎹?    tail: Vec<f32>,
}

// 鈹€鈹€鈹€ Clip 鎻忚堪 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/// 浠?timeline 鎻愬彇鐨?clip 鏃堕棿绾夸俊鎭紙鎸?start_frame 鎺掑簭锛夈€?#[derive(Clone)]
struct ClipInfo {
    clip_id: String,
    /// clip 鍦?timeline 涓婄殑璧峰甯э紙缁濆锛?    start_frame: u64,
    /// clip 鍦?timeline 涓婄殑缁撴潫甯э紙exclusive锛?    end_frame: u64,
}

/// 璁＄畻 clip 鐨勫弬鏁板搱甯岋紝鐢ㄤ簬 [`crate::synth_clip_cache::SynthClipCacheKey`]銆?///
/// 濮旀墭缁?[`crate::synth_clip_cache::compute_param_hash`]锛?/// 瑕嗙洊 clip_id銆佸抚鑼冨洿銆侀噰鏍风巼鍜?pitch_edit 鏇茬嚎鐗囨銆?fn compute_clip_param_hash(clip: &ClipInfo, sr: u32, curves: &PitchCurvesSnapshot) -> u64 {
    crate::synth_clip_cache::compute_param_hash(
        &clip.clip_id,
        clip.start_frame,
        clip.end_frame,
        sr,
        curves,
    )
}

/// 浠?TimelineState 鎻愬彇鎵€鏈夋湁鏁?clip 鐨勬椂闂寸嚎淇℃伅锛屾寜 start_frame 鍗囧簭鎺掑垪銆?fn collect_clip_infos(timeline: &TimelineState, sr: u32) -> Vec<ClipInfo> {
    let bpm = timeline.bpm.max(1.0);
    let bs = 60.0 / bpm; // beats 鈫?seconds

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
            let end_frame = ((start_sec + len_sec) * sr as f64).round().max(start_frame as f64 + 1) as u64;
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

// 鈹€鈹€鈹€ 涓诲叆鍙?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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
        // 鈹€鈹€ 鍙傛暟璇诲彇 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
        let xfade_ms = env_f64("HIFISHIFTER_ONNX_VAD_XFADE_MS")
            .unwrap_or(80.0)
            .max(0.0);
        let xfade_frames = ((xfade_ms / 1000.0) * (sr as f64)).round().max(0.0) as u64;

        let chunk_sec = crate::nsf_hifigan_onnx::env_chunk_sec();
        let overlap_sec = crate::nsf_hifigan_onnx::env_overlap_sec();

        // 閫夋嫨鏃堕棿鎷変几绠楁硶锛氫紭鍏堜娇鐢?RubberBand锛堥煶楂樹繚鎸侊級锛屼笉鍙敤鏃跺洖閫€鍒扮嚎鎬ч噸閲囨牱銆?        let stretch = if crate::rubberband::is_available() {
            StretchAlgorithm::RubberBand
        } else {
            StretchAlgorithm::LinearResample
        };

        let warmup_ahead_frames = {
            // HIFISHIFTER_ONNX_WARMUP_MS锛歸armup 鍓嶇灮鏃堕暱锛堟绉掞級锛岄粯璁?250ms銆?            // 鎺у埗鎾斁寮€濮嬫椂蹇€熷～鍏呯紦鍐茬殑鐩爣甯ф暟銆?            let ms = env_f64("HIFISHIFTER_ONNX_WARMUP_MS")
                .unwrap_or(250.0)
                .max(0.0);
            ((ms / 1000.0) * sr as f64).round().max(256.0) as u64
        };
        let lookahead_frames_normal = {
            // HIFISHIFTER_ONNX_LOOKAHEAD_SEC锛氭甯告挱鏀炬椂鐨勫墠鐬绘椂闀匡紙绉掞級锛岄粯璁?1.0s銆?            // 鎺у埗 ring buffer 涓淮鎸佺殑鍓嶇灮鏁版嵁閲忋€?            let sec = env_f64("HIFISHIFTER_ONNX_LOOKAHEAD_SEC")
                .unwrap_or(1.0)
                .max(0.0);
            ((sec * sr as f64).round().max(256.0) as u64).max(warmup_ahead_frames)
        };
        let prefetch_ahead_frames = {
            // HIFISHIFTER_ONNX_PREFETCH_SEC锛歱refetch 瑙﹀彂璺濈锛堢锛夛紝榛樿 2.0s銆?            // 褰?out_cursor 璺濈涓嬩竴涓?clip 鐨?start_frame 灏忎簬姝ゅ€兼椂锛屾彁鍓嶅紓姝ユ帹鐞嗐€?            let sec = env_f64("HIFISHIFTER_ONNX_PREFETCH_SEC")
                .unwrap_or(2.0)
                .max(0.0);
            (sec * sr as f64).round().max(0.0) as u64
        };

        // 鈹€鈹€ Clip 鍒楄〃 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
        let clips = collect_clip_infos(&timeline, sr);
        let project_sec = timeline.project_duration_sec();
        let project_frames = (project_sec * sr as f64).round().max(0.0) as u64;

        // 鈹€鈹€ 鐘舵€?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

            // 鈹€鈹€ Seek 妫€娴?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
            if now_abs < base || now_abs > write.saturating_add(sr as u64) {
                out_cursor = now_abs;
                ring.reset(now_abs);
                pending = None;
                prev_tail.clear();
                // 閲嶆柊瀹氫綅 clip_idx 鍒板綋鍓嶆挱鏀句綅缃?                clip_idx = clips
                    .iter()
                    .position(|c| c.end_frame > now_abs)
                    .unwrap_or(clips.len());
                thread::sleep(std::time::Duration::from_millis(2));
                continue;
            }

            if out_cursor < now_abs {
                out_cursor = now_abs;
            }

            // 鈹€鈹€ 鍓嶇灮鎺у埗 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
            let need_until = if write <= now_abs.saturating_add(warmup_ahead_frames) {
                now_abs.saturating_add(warmup_ahead_frames)
            } else {
                now_abs.saturating_add(lookahead_frames_normal)
            };
            if write >= need_until {
                thread::sleep(std::time::Duration::from_millis(3));
                continue;
            }

            // 鈹€鈹€ 娴佸紡鍐欏叆 pending clip 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

                // 鍐欏叆鎺ㄧ悊缁撴灉
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

                // 鎺ㄧ悊甯т笉瓒虫椂琛ラ浂
                let remain_in_chunk = chunk_frames.saturating_sub(wrote_frames);
                if remain_in_chunk > 0 {
                    let zeros = vec![0.0f32; (remain_in_chunk as usize) * 2];
                    ring.write_interleaved(out_cursor, &zeros);
                    out_cursor = out_cursor.saturating_add(remain_in_chunk);
                    p.write_offset = p.write_offset.saturating_add(remain_in_chunk);
                }

                continue;
            }

            // 鈹€鈹€ 宸ョ▼缁撴潫 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
            if out_cursor >= project_frames && project_frames > 0 {
                thread::sleep(std::time::Duration::from_millis(8));
                continue;
            }

            // 鈹€鈹€ 鎺ㄨ繘 clip_idx 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
            // 璺宠繃宸茬粡鍦?out_cursor 涔嬪墠缁撴潫鐨?clip
            while clip_idx < clips.len() && clips[clip_idx].end_frame <= out_cursor {
                clip_idx += 1;
            }

            // 鈹€鈹€ 鍒ゆ柇褰撳墠浣嶇疆灞炰簬 clip 鍐呰繕鏄?clip 闂撮殭 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
            let in_clip = clip_idx < clips.len()
                && clips[clip_idx].start_frame <= out_cursor
                && out_cursor < clips[clip_idx].end_frame;

            if in_clip {
                // 鈹€鈹€ 澶勭悊褰撳墠 clip 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
                let clip = &clips[clip_idx];
                let clip_start_sec = (clip.start_frame as f64) / (sr as f64);
                let clip_end_sec = (clip.end_frame as f64) / (sr as f64);
                let expected_frames = clip.end_frame.saturating_sub(out_cursor);

                if debug {
                    eprintln!(
                        "pitch_stream_onnx: clip={} t0={:.3} t1={:.3} expected_frames={}",
                        clip.clip_id, clip_start_sec, clip_end_sec, expected_frames
                    );
                }

                // 鈹€鈹€ 鏌ヨ per-clip 缂撳瓨 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

                let inferred_stereo: std::sync::Arc<Vec<f32>> = if let Some(pcm) = cached_pcm {
                    // 缂撳瓨鍛戒腑锛氱洿鎺ュ鐢紝璺宠繃鎺ㄧ悊
                    if debug {
                        eprintln!(
                            "pitch_stream_onnx: cache hit for clip={} hash={:#x}",
                            clip.clip_id, param_hash
                        );
                    }
                    pcm
                } else {
                    // 缂撳瓨鏈懡涓細璇诲彇 PCM 骞舵帹鐞?                    let mut pcm: Vec<f32> = vec![];
                    let ok = read_base_stereo_from_ring(
                        base_ring.as_ref(),
                        sr,
                        clip_start_sec,
                        clip_end_sec,
                        &mut pcm,
                    );
                    if ok.is_none() {
                        thread::sleep(std::time::Duration::from_millis(6));
                        continue;
                    }

                    let mono = stereo_to_mono(&pcm);

                    // 璋冪敤鍒嗗潡鎺ㄧ悊锛堣嚜鍔ㄥ鐞嗛暱 clip锛?                    let inferred = match crate::nsf_hifigan_onnx::infer_pitch_edit_chunked(
                        &mono,
                        sr,
                        clip_start_sec,
                        |abs_time_sec| curves.midi_at_time(abs_time_sec),
                        chunk_sec,
                        overlap_sec,
                    ) {
                        Ok(v) => v,
                        Err(e) => {
                            if debug {
                                eprintln!("pitch_stream_onnx: infer error for clip {}: {}", clip.clip_id, e);
                            }
                            thread::sleep(std::time::Duration::from_millis(30));
                            continue;
                        }
                    };

                    if inferred.is_empty() {
                        thread::sleep(std::time::Duration::from_millis(30));
                        continue;
                    }

                    // 瀵归綈鎺ㄧ悊杈撳嚭甯ф暟鍒?clip 鏈熸湜甯ф暟
                    let clip_total_frames = ((clip_end_sec - clip_start_sec) * sr as f64)
                        .round()
                        .max(1.0) as usize;
                    let aligned_mono = if inferred.len() != clip_total_frames {
                        crate::time_stretch::time_stretch_interleaved(
                            &inferred,
                            1, // mono
                            sr,
                            clip_total_frames,
                            stretch,
                        )
                    } else {
                        inferred
                    };

                    let stereo = std::sync::Arc::new(mono_to_stereo(&aligned_mono));

                    // 鍐欏叆缂撳瓨
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

                // 璁＄畻褰撳墠 out_cursor 鍦?clip 鍐呯殑鍋忕Щ
                let cursor_off_in_clip = out_cursor.saturating_sub(clip.start_frame) as usize;
                let main_start = cursor_off_in_clip * 2;
                let mut main_end = inferred_stereo.len();

                // 鎴柇鍒?expected_frames
                let max_end = main_start + (expected_frames as usize) * 2;
                if main_end > max_end {
                    main_end = max_end;
                }

                let available_frames = ((main_end.saturating_sub(main_start)) / 2) as u64;
                let available_frames = available_frames.min(expected_frames);

                // Crossfade锛氫笌涓婁竴娈碉紙clip 鎴栭棿闅欙級鐨勫熬閮ㄦ贩鍚?                if !prev_tail.is_empty() && xfade_frames > 0 && main_start < inferred_stereo.len() {
                    let head_end = (main_start + (xfade_frames as usize) * 2).min(inferred_stereo.len());
                    crossfade_into_ring(
                        &ring,
                        out_cursor,
                        &prev_tail,
                        &inferred_stereo[main_start..head_end],
                        xfade_frames,
                    );
                }

                let tail = if available_frames > 0 && main_end <= inferred_stereo.len() {
                    take_tail(&inferred_stereo[main_start..main_end], xfade_frames)
                } else {
                    vec![0.0f32; (xfade_frames.min(expected_frames) as usize) * 2]
                };

                pending = Some(PendingClip {
                    start_frame: out_cursor,
                    end_frame: clip.end_frame,
                    buf: inferred_stereo,
                    main_start,
                    main_end,
                    expected_frames,
                    available_frames,
                    write_offset: 0,
                    tail,
                });
            } else {
                // 鈹€鈹€ 澶勭悊 clip 闂撮殭锛坧assthrough from base_ring锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
                let gap_end_frame = if clip_idx < clips.len() {
                    clips[clip_idx].start_frame
                } else {
                    project_frames.max(out_cursor + 1)
                };

                // 鈹€鈹€ Prefetch锛氭彁鍓嶆帹鐞嗕笅涓€涓?clip 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
                if clip_idx < clips.len() {
                    let next_clip = &clips[clip_idx];
                    let dist = next_clip.start_frame.saturating_sub(out_cursor);
                    if dist < prefetch_ahead_frames {
                        let next_hash = compute_clip_param_hash(next_clip, sr, &curves);
                        let next_key = crate::synth_clip_cache::SynthClipCacheKey {
                            clip_id: next_clip.clip_id.clone(),
                            param_hash: next_hash,
                        };
                        let already_cached = {
                            let mut cache = crate::synth_clip_cache::global_synth_clip_cache()
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            cache.get(&next_key).is_some()
                        };
                        if !already_cached {
                            // 寮傛鎺ㄧ悊锛氬湪鐙珛绾跨▼涓帹鐞嗗苟鍐欏叆缂撳瓨
                            let prefetch_clip = next_clip.clone();
                            let prefetch_curves = curves.clone();
                            let prefetch_base_ring = base_ring.clone();
                            let prefetch_chunk_sec = chunk_sec;
                            let prefetch_overlap_sec = overlap_sec;
                            let prefetch_stretch = stretch;
                            let prefetch_sr = sr;
                            let prefetch_key = next_key;
                            if debug {
                                eprintln!(
                                    "pitch_stream_onnx: prefetch clip={} dist={}",
                                    prefetch_clip.clip_id, dist
                                );
                            }
                            thread::spawn(move || {
                                let clip_start_sec =
                                    prefetch_clip.start_frame as f64 / prefetch_sr as f64;
                                let clip_end_sec =
                                    prefetch_clip.end_frame as f64 / prefetch_sr as f64;

                                let mut pcm: Vec<f32> = vec![];
                                if read_base_stereo_from_ring(
                                    prefetch_base_ring.as_ref(),
                                    prefetch_sr,
                                    clip_start_sec,
                                    clip_end_sec,
                                    &mut pcm,
                                )
                                .is_none()
                                {
                                    return;
                                }

                                let mono = stereo_to_mono(&pcm);
                                let inferred = match crate::nsf_hifigan_onnx::infer_pitch_edit_chunked(
                                    &mono,
                                    prefetch_sr,
                                    clip_start_sec,
                                    |abs_time_sec| prefetch_curves.midi_at_time(abs_time_sec),
                                    prefetch_chunk_sec,
                                    prefetch_overlap_sec,
                                ) {
                                    Ok(v) => v,
                                    Err(_) => return,
                                };
                                if inferred.is_empty() {
                                    return;
                                }

                                let clip_total_frames =
                                    ((clip_end_sec - clip_start_sec) * prefetch_sr as f64)
                                        .round()
                                        .max(1.0) as usize;
                                let aligned_mono = if inferred.len() != clip_total_frames {
                                    crate::time_stretch::time_stretch_interleaved(
                                        &inferred,
                                        1,
                                        prefetch_sr,
                                        clip_total_frames,
                                        prefetch_stretch,
                                    )
                                } else {
                                    inferred
                                };

                                let stereo = std::sync::Arc::new(mono_to_stereo(&aligned_mono));
                                let mut cache = crate::synth_clip_cache::global_synth_clip_cache()
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner());
                                cache.insert(
                                    prefetch_key,
                                    crate::synth_clip_cache::SynthClipCacheEntry {
                                        pcm_stereo: stereo.clone(),
                                        frames: (stereo.len() / 2) as u64,
                                        sample_rate: prefetch_sr,
                                    },
                                );
                            });
                        }
                    }
                }

                // 姣忔鏈€澶氬鐞?0.5s 鐨勯棿闅欙紝閬垮厤澶у潡闃诲
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
                        "pitch_stream_onnx: gap t0={:.3} t1={:.3} frames={}",
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

                // Crossfade锛氫笌涓婁竴娈电殑灏鹃儴娣峰悎
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
