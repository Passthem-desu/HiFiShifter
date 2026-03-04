//! 渲染器统一接口定义。
//!
//! 通过 [`Renderer`] trait 将合成链路与调用方解耦，
//! 未来新增渲染器只需实现该 trait 并在 `mod.rs` 中注册。

use crate::state::SynthPipelineKind;

// ─── 上下文 ────────────────────────────────────────────────────────────────────

/// 传递给渲染器的处理上下文（借用，零拷贝）。
pub struct RenderContext<'a> {
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
    /// 全局 pitch_edit 曲线（绝对 MIDI；0 表示无编辑）。
    pub pitch_edit: &'a [f32],
    /// Clip 原始 MIDI 曲线（时间轴对齐）。
    pub clip_midi: &'a [f32],
    /// 所属 Clip 的唯一标识，用于 per-segment 推理缓存。
    pub clip_id: &'a str,
}

// ─── 能力描述 ──────────────────────────────────────────────────────────────────

/// 渲染器能力描述。
#[derive(Debug, Clone)]
pub struct RendererCapabilities {
    /// 是否支持实时渲染（audio callback 级低延迟）。
    pub supports_realtime: bool,
    /// 是否推荐预渲染（在后台线程执行）。
    pub prefers_prerender: bool,
    /// 最大支持的变调半音数。
    pub max_pitch_shift_semitones: f64,
}

impl Default for RendererCapabilities {
    fn default() -> Self {
        Self {
            supports_realtime: false,
            prefers_prerender: true,
            max_pitch_shift_semitones: 24.0,
        }
    }
}

// ─── Trait ──────────────────────────────────────────────────────────────────────

/// 渲染器插件接口（类似 OpenUtau 的 IRenderer）。
///
/// 实现者必须是 `Send + Sync`，以便在多线程渲染中安全使用。
pub trait Renderer: Send + Sync {
    /// 渲染器唯一标识符（如 "world_vocoder", "nsf_hifigan_onnx"）。
    fn id(&self) -> &str;

    /// 人类可读的显示名称。
    fn display_name(&self) -> &str;

    /// 返回该渲染器对应的 [`SynthPipelineKind`]。
    fn kind(&self) -> SynthPipelineKind;

    /// 检查渲染器是否可用（动态库已加载 / ONNX 模型已就绪等）。
    fn is_available(&self) -> bool;

    /// 对输入 PCM 执行音高编辑，返回处理后的单声道 PCM。
    fn render(&self, ctx: &RenderContext<'_>) -> Result<Vec<f32>, String>;

    /// 声明该渲染器支持的能力。
    fn capabilities(&self) -> RendererCapabilities {
        RendererCapabilities::default()
    }
}
