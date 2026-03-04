//! 渲染器模块：统一的音高合成渲染接口。
//!
//! 通过 [`Renderer`] trait 将合成链路与调用方解耦，
//! 未来新增渲染器只需实现该 trait 并在此处注册，
//! 无需修改 `pitch_editing.rs` 等核心逻辑。

mod traits;
mod utils;
mod world;
mod hifigan;

pub use traits::{Renderer, RenderContext, RendererCapabilities};
pub use utils::{edit_midi_at_time_or_none, clip_midi_at_time};

use crate::state::SynthPipelineKind;

// ─── 静态实例 ──────────────────────────────────────────────────────────────────

static WORLD_RENDERER: world::WorldRenderer = world::WorldRenderer;
static HIFIGAN_RENDERER: hifigan::HiFiGanRenderer = hifigan::HiFiGanRenderer;

// ─── 注册表 ────────────────────────────────────────────────────────────────────

/// 根据 [`SynthPipelineKind`] 返回对应的静态渲染器实例。
///
/// 使用静态分发（`&'static dyn Renderer`）避免堆分配，
/// 渲染器数量固定，静态分发足够高效。
pub fn get_renderer(kind: SynthPipelineKind) -> &'static dyn Renderer {
    match kind {
        SynthPipelineKind::WorldVocoder => &WORLD_RENDERER,
        SynthPipelineKind::NsfHifiganOnnx => &HIFIGAN_RENDERER,
    }
}

/// 列出所有已注册的渲染器（供前端 UI 展示或调试）。
#[allow(dead_code)]
pub fn all_renderers() -> Vec<&'static dyn Renderer> {
    vec![&WORLD_RENDERER, &HIFIGAN_RENDERER]
}
