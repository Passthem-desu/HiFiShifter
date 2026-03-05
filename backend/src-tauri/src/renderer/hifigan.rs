//! 基于 NSF-HiFiGAN ONNX 的渲染器实现。
//!
//! # F0 数据源
//!
//! `midi_at_time` 回调与 [`WorldRenderer`] 共用同一套 F0 数据源：
//! - `clip_midi`：由 Harvest 分析得到的原始 MIDI 曲线（时间轴对齐）
//! - `pitch_edit`：用户编辑的目标 MIDI 曲线（0 表示无编辑）
//!
//! 两条链路切换时无需重新分析，直接复用已有的 `clip_midi`。
//! 若 `clip_midi` 为空（Harvest 尚未完成），则跳过推理并返回原始 PCM。

use crate::state::SynthPipelineKind;
use super::traits::{Renderer, RenderContext, RendererCapabilities};
use super::utils::{clip_midi_at_time, edit_midi_at_time_or_none};

/// 基于 NSF-HiFiGAN ONNX 的渲染器。
pub struct HiFiGanRenderer;

impl Renderer for HiFiGanRenderer {
    fn id(&self) -> &str {
        "nsf_hifigan_onnx"
    }

    fn display_name(&self) -> &str {
        "NSF-HiFiGAN (ONNX)"
    }

    fn kind(&self) -> SynthPipelineKind {
        SynthPipelineKind::NsfHifiganOnnx
    }

    fn is_available(&self) -> bool {
        crate::nsf_hifigan_onnx::is_available()
    }

    fn render(&self, ctx: &RenderContext<'_>) -> Result<Vec<f32>, String> {
        let fp = ctx.frame_period_ms;
        let clip_start = ctx.clip_start_sec;
        let pitch_edit = ctx.pitch_edit;
        let clip_midi = ctx.clip_midi;

        // clip_midi 为空时明确跳过，与 WORLD 链路行为一致。
        // Harvest 分析尚未完成时 clip_midi 可能为空，此时返回原始 PCM。
        if clip_midi.is_empty() {
            if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
                eprintln!(
                    "HiFiGanRenderer::render: clip_midi is empty (Harvest not ready?), \
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
        let param_hash = crate::synth_clip_cache::compute_param_hash(
            ctx.clip_id,
            seg_start_frame,
            seg_end_frame,
            sr,
            self.id(),
            &curves_snapshot,
        );
        let cache_key = crate::synth_clip_cache::SynthClipCacheKey {
            clip_id: ctx.clip_id.to_string(),
            param_hash,
        };

        // 命中缓存：直接返回 mono PCM（从 stereo 取左声道）
        {
            let mut cache = crate::synth_clip_cache::global_synth_clip_cache()
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
        // 的组合逻辑，与 WorldRenderer 共用同一套 F0 查询语义。
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
            let mut cache = crate::synth_clip_cache::global_synth_clip_cache()
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            cache.insert(
                cache_key,
                crate::synth_clip_cache::SynthClipCacheEntry {
                    pcm_stereo: std::sync::Arc::new(stereo),
                    frames,
                    sample_rate: sr,
                },
            );
        }

        Ok(result)
    }

    fn capabilities(&self) -> RendererCapabilities {
        RendererCapabilities {
            supports_realtime: false,
            prefers_prerender: true,
            max_pitch_shift_semitones: 24.0,
        }
    }
}
