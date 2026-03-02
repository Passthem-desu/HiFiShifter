//! 声码器管线抽象层。
//!
//! 通过 [`VocoderPipeline`] trait 将合成链路与调用方解耦，
//! 未来新增声码器只需实现该 trait 并在 [`get_pipeline`] 中注册，
//! 无需修改 `pitch_editing.rs` 等核心逻辑。

use crate::state::SynthPipelineKind;

// ─── 上下文 ────────────────────────────────────────────────────────────────────

/// 传递给声码器的处理上下文（借用，零拷贝）。
pub struct VocoderContext<'a> {
    /// 单声道 PCM 输入（f32，已归一化）。
    pub mono_pcm: &'a [f32],
    /// 采样率（Hz）。
    pub sample_rate: u32,
    /// 当前片段在时间轴上的起始时间（秒）。
    pub seg_start_sec: f64,
    /// 当前片段在时间轴上的结束时间（秒）。
    pub seg_end_sec: f64,
    /// 所属 Clip 在时间轴上的起始时间（秒），用于 MIDI 曲线对齐。
    pub clip_start_sec: f64,
    /// 分析帧周期（毫秒）。
    pub frame_period_ms: f64,
    /// 全局 pitch_edit 曲线（绝对 MIDI，0 表示无编辑）。
    pub pitch_edit: &'a [f32],
    /// Clip 原始 MIDI 曲线（时间轴对齐）。
    pub clip_midi: &'a [f32],
    /// 所属 Clip 的唯一标识，用于 per-segment 推理缓存。
    pub clip_id: &'a str,
}

// ─── Trait ─────────────────────────────────────────────────────────────────────

/// 声码器管线接口。
///
/// 实现者必须是 `Send + Sync`，以便在多线程渲染中安全使用。
pub trait VocoderPipeline: Send + Sync {
    /// 返回该管线对应的 [`SynthPipelineKind`]。
    fn kind(&self) -> SynthPipelineKind;

    /// 检查后端是否可用（动态库已加载 / ONNX 模型已就绪等）。
    fn is_available(&self) -> bool;

    /// 对输入 PCM 执行音高编辑，返回处理后的单声道 PCM。
    fn process(&self, ctx: &VocoderContext<'_>) -> Result<Vec<f32>, String>;
}

// ─── 辅助函数（供实现内部使用）────────────────────────────────────────────────

/// 在 pitch_edit 曲线中插值，返回目标 MIDI（无编辑时返回 None）。
fn edit_midi_at_time_or_none(
    frame_period_ms: f64,
    pitch_edit: &[f32],
    abs_time_sec: f64,
) -> Option<f64> {
    if !(abs_time_sec.is_finite() && abs_time_sec >= 0.0) {
        return None;
    }
    let fp = frame_period_ms.max(0.1);
    let idx_f = (abs_time_sec * 1000.0) / fp;
    if !(idx_f.is_finite() && idx_f >= 0.0) {
        return None;
    }
    let i0 = idx_f.floor() as isize;
    if i0 < 0 {
        return None;
    }
    let i0 = i0 as usize;
    if i0 >= pitch_edit.len() {
        return None;
    }
    let i1 = (i0 + 1).min(pitch_edit.len().saturating_sub(1));
    let frac = (idx_f - (i0 as f64)).clamp(0.0, 1.0);

    let e0 = pitch_edit.get(i0).copied().unwrap_or(0.0) as f64;
    let e1 = pitch_edit.get(i1).copied().unwrap_or(0.0) as f64;

    let e0 = if e0.is_finite() && e0 > 0.0 { Some(e0) } else { None };
    let e1 = if e1.is_finite() && e1 > 0.0 { Some(e1) } else { None };

    match (e0, e1) {
        (None, None) => None,
        (Some(v), None) | (None, Some(v)) => Some(v),
        (Some(a), Some(b)) => {
            let v = a + (b - a) * frac;
            if v.is_finite() && v > 0.0 { Some(v) } else { None }
        }
    }
}

/// 在 clip_midi 曲线中插值，返回原始 MIDI（无效时返回 0.0）。
fn clip_midi_at_time(
    frame_period_ms: f64,
    clip_start_sec: f64,
    clip_midi: &[f32],
    abs_time_sec: f64,
) -> f64 {
    if !(abs_time_sec.is_finite() && abs_time_sec >= clip_start_sec) {
        return 0.0;
    }
    let local_sec = abs_time_sec - clip_start_sec;
    let fp = frame_period_ms.max(0.1);
    let idx_f = (local_sec * 1000.0) / fp;
    if !(idx_f.is_finite() && idx_f >= 0.0) {
        return 0.0;
    }
    let i0 = idx_f.floor() as isize;
    if i0 < 0 {
        return 0.0;
    }
    let i0 = i0 as usize;
    if i0 >= clip_midi.len() {
        return 0.0;
    }
    let i1 = (i0 + 1).min(clip_midi.len().saturating_sub(1));
    let frac = (idx_f - (i0 as f64)).clamp(0.0, 1.0);

    let a = clip_midi.get(i0).copied().unwrap_or(0.0) as f64;
    let b = clip_midi.get(i1).copied().unwrap_or(0.0) as f64;

    let mut a = if a.is_finite() && a > 0.0 { a } else { 0.0 };
    let mut b = if b.is_finite() && b > 0.0 { b } else { 0.0 };
    if a <= 0.0 && b > 0.0 { a = b; }
    if b <= 0.0 && a > 0.0 { b = a; }
    if a <= 0.0 || b <= 0.0 { return 0.0; }

    let v = a + (b - a) * frac;
    if v.is_finite() { v } else { 0.0 }
}

// ─── WorldVocoderPipeline ──────────────────────────────────────────────────────

/// 基于 WORLD 声码器的管线实现。
pub struct WorldVocoderPipeline;

impl VocoderPipeline for WorldVocoderPipeline {
    fn kind(&self) -> SynthPipelineKind {
        SynthPipelineKind::WorldVocoder
    }

    fn is_available(&self) -> bool {
        crate::world_vocoder::is_available()
    }

    fn process(&self, ctx: &VocoderContext<'_>) -> Result<Vec<f32>, String> {
        let f0_floor = 40.0;
        let f0_ceil = 1600.0;
        let fp = ctx.frame_period_ms;
        let clip_start = ctx.clip_start_sec;
        let pitch_edit = ctx.pitch_edit;
        let clip_midi = ctx.clip_midi;

        crate::world_vocoder::vocode_pitch_shift_chunked(
            ctx.mono_pcm,
            ctx.sample_rate,
            ctx.seg_start_sec,
            fp,
            f0_floor,
            f0_ceil,
            move |abs_time_sec| {
                let orig = clip_midi_at_time(fp, clip_start, clip_midi, abs_time_sec);
                if !(orig.is_finite() && orig > 0.0) {
                    return 0.0;
                }
                let target = match edit_midi_at_time_or_none(fp, pitch_edit, abs_time_sec) {
                    Some(v) => v,
                    None => orig,
                };
                let shift = (target - orig).clamp(-24.0, 24.0);
                if shift.is_finite() { shift } else { 0.0 }
            },
        )
    }
}

// ─── NsfHifiganPipeline ────────────────────────────────────────────────────────

/// 基于 NSF-HiFiGAN ONNX 的管线实现。
///
/// # F0 数据源
///
/// `midi_at_time` 回调与 [`WorldVocoderPipeline`] 共用同一套 F0 数据源：
/// - `clip_midi`：由 Harvest 分析得到的原始 MIDI 曲线（时间轴对齐）
/// - `pitch_edit`：用户编辑的目标 MIDI 曲线（0 表示无编辑）
///
/// 两条链路切换时无需重新分析，直接复用已有的 `clip_midi`。
/// 若 `clip_midi` 为空（Harvest 尚未完成），则跳过推理并返回原始 PCM。
pub struct NsfHifiganPipeline;

impl VocoderPipeline for NsfHifiganPipeline {
    fn kind(&self) -> SynthPipelineKind {
        SynthPipelineKind::NsfHifiganOnnx
    }

    fn is_available(&self) -> bool {
        crate::nsf_hifigan_onnx::is_available()
    }

    fn process(&self, ctx: &VocoderContext<'_>) -> Result<Vec<f32>, String> {
        let fp = ctx.frame_period_ms;
        let clip_start = ctx.clip_start_sec;
        let pitch_edit = ctx.pitch_edit;
        let clip_midi = ctx.clip_midi;

        // clip_midi 为空时明确跳过，与 WORLD 链路行为一致。
        // Harvest 分析尚未完成时 clip_midi 可能为空，此时返回原始 PCM。
        if clip_midi.is_empty() {
            if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
                eprintln!(
                    "NsfHifiganPipeline::process: clip_midi is empty (Harvest not ready?), \
                     skipping inference and returning original PCM"
                );
            }
            return Ok(ctx.mono_pcm.to_vec());
        }

        // ── 查询 per-segment 缓存 ─────────────────────────────────────────────
        // 用 clip_id + seg 范围 + pitch_edit 片段 计算 param_hash，
        // 实现离线渲染路径的推理结果复用。
        let sr = ctx.sample_rate;
        let seg_start_frame = (ctx.seg_start_sec * sr as f64).round().max(0.0) as u64;
        let seg_end_frame = (ctx.seg_end_sec * sr as f64).round().max(0.0) as u64;
        let curves_snapshot = crate::pitch_editing::PitchCurvesSnapshot {
            frame_period_ms: fp,
            pitch_orig: vec![],  // 离线路径不需要 pitch_orig 参与 hash
            pitch_edit: pitch_edit.to_vec(),
        };
        let param_hash = crate::onnx_clip_cache::compute_param_hash(
            ctx.clip_id,
            seg_start_frame,
            seg_end_frame,
            sr,
            &curves_snapshot,
        );
        let cache_key = crate::onnx_clip_cache::OnnxClipCacheKey {
            clip_id: ctx.clip_id.to_string(),
            param_hash,
        };

        // 命中缓存：直接返回 mono PCM（从 stereo 取左声道）
        {
            let mut cache = crate::onnx_clip_cache::global_onnx_clip_cache()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = cache.get(&cache_key) {
                let frames = (entry.pcm_stereo.len() / 2).min(ctx.mono_pcm.len());
                let mut mono_out = vec![0.0f32; ctx.mono_pcm.len()];
                for f in 0..frames {
                    mono_out[f] = entry.pcm_stereo[f * 2];
                }
                return Ok(mono_out);
            }
        }

        // 未命中：推理后写入缓存
        // midi_at_time 回调使用 clip_midi_at_time + edit_midi_at_time_or_none
        // 的组合逻辑，与 WorldVocoderPipeline 共用同一套 F0 查询语义。
        // 区别：WORLD 返回 semitone shift，ONNX 返回目标绝对 MIDI（模型输入语义不同）。
        let chunk_sec = crate::nsf_hifigan_onnx::env_chunk_sec();
        let overlap_sec = crate::nsf_hifigan_onnx::env_overlap_sec();

        let result = crate::nsf_hifigan_onnx::infer_pitch_edit_chunked(
            ctx.mono_pcm,
            sr,
            ctx.seg_start_sec,
            move |abs_time_sec| {
                // 原始 MIDI（来自 Harvest，与 WORLD 链路共用同一数据源）
                let orig = clip_midi_at_time(fp, clip_start, clip_midi, abs_time_sec);
                if !(orig.is_finite() && orig > 0.0) {
                    return 0.0;
                }
                // 目标 MIDI：有编辑时用编辑值，否则用原始值（保持音高不变）
                let target = match edit_midi_at_time_or_none(fp, pitch_edit, abs_time_sec) {
                    Some(v) => v,
                    None => orig,
                };
                if target.is_finite() && target > 0.0 { target } else { 0.0 }
            },
            chunk_sec,
            overlap_sec,
        )?;

        // 写入缓存（stereo = mono 复制到双声道）
        if !result.is_empty() {
            let mut stereo = Vec::with_capacity(result.len() * 2);
            for &v in &result {
                stereo.push(v);
                stereo.push(v);
            }
            let frames = result.len() as u64;
            let mut cache = crate::onnx_clip_cache::global_onnx_clip_cache()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            cache.insert(
                cache_key,
                crate::onnx_clip_cache::OnnxClipCacheEntry {
                    pcm_stereo: std::sync::Arc::new(stereo),
                    frames,
                    sample_rate: sr,
                },
            );
        }

        Ok(result)
    }
}

// ─── 注册表 ────────────────────────────────────────────────────────────────────

static WORLD_PIPELINE: WorldVocoderPipeline = WorldVocoderPipeline;
static NSF_PIPELINE: NsfHifiganPipeline = NsfHifiganPipeline;

/// 根据 [`SynthPipelineKind`] 返回对应的静态管线实例。
///
/// 使用静态分发（`&'static dyn VocoderPipeline`）避免堆分配，
/// 声码器数量固定，静态分发足够高效。
pub fn get_pipeline(kind: SynthPipelineKind) -> &'static dyn VocoderPipeline {
    match kind {
        SynthPipelineKind::WorldVocoder => &WORLD_PIPELINE,
        SynthPipelineKind::NsfHifiganOnnx => &NSF_PIPELINE,
    }
}
