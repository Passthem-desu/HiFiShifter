# 渲染器插件化 + Clip 级预渲染缓存 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 World 和 HiFiGAN 声码器重构为统一的 `Renderer` trait 插件，并将播放链路从"整体预渲染 WAV"改为"Clip 级预渲染缓存 + 实时混音"。

**Architecture:** Phase 1 纯重构渲染器接口（不改功能），Phase 2 改造播放链路。两个 Phase 互不耦合，Phase 1 可独立提交。

**Tech Stack:** Rust, Tauri, cpal, ONNX Runtime (optional feature)

---

## Phase 1：渲染器插件化（纯重构，不改功能）

### 概述

将现有的 `vocoder_pipeline.rs`（单文件，含 trait + 两个实现 + 注册表）拆分为 `renderer/` 目录下的独立模块，使每个渲染器成为独立插件。

### 当前结构

```
vocoder_pipeline.rs
├── VocoderContext (struct)
├── VocoderPipeline (trait)
├── WorldVocoderPipeline (impl)
├── NsfHifiganPipeline (impl)
├── get_pipeline(kind) → &'static dyn VocoderPipeline
└── 辅助函数: edit_midi_at_time_or_none, clip_midi_at_time
```

### 目标结构

```
renderer/
├── mod.rs          — 统一导出 + RendererRegistry
├── traits.rs       — Renderer trait + RenderContext + RenderResult + RendererCapabilities
├── world.rs        — WorldRenderer (从 WorldVocoderPipeline 迁移)
├── hifigan.rs      — HiFiGanRenderer (从 NsfHifiganPipeline 迁移)
└── utils.rs        — 共享辅助函数 (edit_midi_at_time_or_none, clip_midi_at_time)
```

### 调用方改动

仅 2 个文件引用了 `vocoder_pipeline`：
1. `pitch_editing.rs:439` — `crate::vocoder_pipeline::get_pipeline(kind).process(&ctx)`
2. `pitch_editing.rs:444` — `crate::vocoder_pipeline::VocoderContext { ... }`

改为：
1. `crate::renderer::get_renderer(kind).render(&ctx)`
2. `crate::renderer::RenderContext { ... }`

---

### Task 1: 创建 `renderer/traits.rs` — 定义新 trait

**Files:**
- Create: `backend/src-tauri/src/renderer/traits.rs`

**内容：**

```rust
//! 渲染器统一接口定义。

use crate::state::SynthPipelineKind;

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

/// 渲染器插件接口。
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
```

---

### Task 2: 创建 `renderer/utils.rs` — 迁移共享辅助函数

**Files:**
- Create: `backend/src-tauri/src/renderer/utils.rs`

**内容：** 将 `vocoder_pipeline.rs` 中的 `edit_midi_at_time_or_none` 和 `clip_midi_at_time` 迁移到此文件。
这两个函数在 `vocoder_pipeline.rs` 和 `pitch_editing.rs` 中各有一份完全相同的拷贝，迁移后两处都可以统一引用。

```rust
//! 渲染器共享辅助函数。

/// 在 pitch_edit 曲线中插值，返回目标 MIDI（无编辑时返回 None）。
pub fn edit_midi_at_time_or_none(
    frame_period_ms: f64,
    pitch_edit: &[f32],
    abs_time_sec: f64,
) -> Option<f64> {
    // ... 从 vocoder_pipeline.rs 原样迁移
}

/// 在 clip_midi 曲线中插值，返回原始 MIDI（无效时返回 0.0）。
pub fn clip_midi_at_time(
    frame_period_ms: f64,
    clip_start_sec: f64,
    clip_midi: &[f32],
    abs_time_sec: f64,
) -> f64 {
    // ... 从 vocoder_pipeline.rs 原样迁移
}
```

---

### Task 3: 创建 `renderer/world.rs` — 迁移 WorldVocoderPipeline

**Files:**
- Create: `backend/src-tauri/src/renderer/world.rs`

**内容：** 将 `WorldVocoderPipeline` 迁移为 `WorldRenderer`，实现新的 `Renderer` trait。

```rust
use crate::state::SynthPipelineKind;
use super::traits::{Renderer, RenderContext, RendererCapabilities};
use super::utils::{clip_midi_at_time, edit_midi_at_time_or_none};

pub struct WorldRenderer;

impl Renderer for WorldRenderer {
    fn id(&self) -> &str { "world_vocoder" }
    fn display_name(&self) -> &str { "WORLD Vocoder" }
    fn kind(&self) -> SynthPipelineKind { SynthPipelineKind::WorldVocoder }
    fn is_available(&self) -> bool { crate::world_vocoder::is_available() }

    fn render(&self, ctx: &RenderContext<'_>) -> Result<Vec<f32>, String> {
        // 与现有 WorldVocoderPipeline::process 逻辑完全一致
        // ...
    }

    fn capabilities(&self) -> RendererCapabilities {
        RendererCapabilities {
            supports_realtime: true,  // WORLD 足够快
            prefers_prerender: false,
            max_pitch_shift_semitones: 24.0,
        }
    }
}
```

---

### Task 4: 创建 `renderer/hifigan.rs` — 迁移 NsfHifiganPipeline

**Files:**
- Create: `backend/src-tauri/src/renderer/hifigan.rs`

**内容：** 将 `NsfHifiganPipeline` 迁移为 `HiFiGanRenderer`，实现新的 `Renderer` trait。

```rust
use crate::state::SynthPipelineKind;
use super::traits::{Renderer, RenderContext, RendererCapabilities};
use super::utils::{clip_midi_at_time, edit_midi_at_time_or_none};

pub struct HiFiGanRenderer;

impl Renderer for HiFiGanRenderer {
    fn id(&self) -> &str { "nsf_hifigan_onnx" }
    fn display_name(&self) -> &str { "NSF-HiFiGAN (ONNX)" }
    fn kind(&self) -> SynthPipelineKind { SynthPipelineKind::NsfHifiganOnnx }
    fn is_available(&self) -> bool { crate::nsf_hifigan_onnx::is_available() }

    fn render(&self, ctx: &RenderContext<'_>) -> Result<Vec<f32>, String> {
        // 与现有 NsfHifiganPipeline::process 逻辑完全一致
        // 包含 per-segment 缓存查询/写入
        // ...
    }

    fn capabilities(&self) -> RendererCapabilities {
        RendererCapabilities {
            supports_realtime: false,  // ONNX 推理较慢
            prefers_prerender: true,
            max_pitch_shift_semitones: 24.0,
        }
    }
}
```

---

### Task 5: 创建 `renderer/mod.rs` — 注册表 + 统一导出

**Files:**
- Create: `backend/src-tauri/src/renderer/mod.rs`

**内容：**

```rust
//! 渲染器模块：统一的音高合成渲染接口。
//!
//! 通过 [`Renderer`] trait 将合成链路与调用方解耦，
//! 未来新增渲染器只需实现该 trait 并在此处注册。

mod traits;
mod utils;
mod world;
mod hifigan;

pub use traits::{Renderer, RenderContext, RendererCapabilities};
pub use utils::{edit_midi_at_time_or_none, clip_midi_at_time};

use crate::state::SynthPipelineKind;

static WORLD_RENDERER: world::WorldRenderer = world::WorldRenderer;
static HIFIGAN_RENDERER: hifigan::HiFiGanRenderer = hifigan::HiFiGanRenderer;

/// 根据 [`SynthPipelineKind`] 返回对应的静态渲染器实例。
pub fn get_renderer(kind: SynthPipelineKind) -> &'static dyn Renderer {
    match kind {
        SynthPipelineKind::WorldVocoder => &WORLD_RENDERER,
        SynthPipelineKind::NsfHifiganOnnx => &HIFIGAN_RENDERER,
    }
}

/// 列出所有已注册的渲染器。
pub fn all_renderers() -> Vec<&'static dyn Renderer> {
    vec![&WORLD_RENDERER, &HIFIGAN_RENDERER]
}
```

---

### Task 6: 更新 `lib.rs` — 替换模块注册

**Files:**
- Modify: `backend/src-tauri/src/lib.rs`

**改动：**

```diff
- mod vocoder_pipeline;
+ mod renderer;
```

---

### Task 7: 更新 `pitch_editing.rs` — 切换到新接口

**Files:**
- Modify: `backend/src-tauri/src/pitch_editing.rs`

**改动（2 处）：**

```diff
- let pipeline = crate::vocoder_pipeline::get_pipeline(kind);
- if !pipeline.is_available() {
+ let renderer = crate::renderer::get_renderer(kind);
+ if !renderer.is_available() {
     return Ok(None);
  }

- let ctx = crate::vocoder_pipeline::VocoderContext {
+ let ctx = crate::renderer::RenderContext {
     mono_pcm: mono.as_slice(),
     ...
  };
- let out = pipeline.process(&ctx)?;
+ let out = renderer.render(&ctx)?;
```

---

### Task 8: 删除 `vocoder_pipeline.rs`

**Files:**
- Delete: `backend/src-tauri/src/vocoder_pipeline.rs`

---

### Task 9: 编译验证

```bash
cd backend/src-tauri && cargo check 2>&1
```

修复编译错误（如有）。

---

## Phase 2：Clip 级预渲染缓存 + 实时混音

### 概述

将 `play_original` 从"整体渲染 WAV → play_file"改为"Clip 级预渲染缓存 + audio callback 实时混音"。

### 核心流程

```
play_original
  ├── 无 pitch edit → 直接 seek + set_playing（零延迟，不变）
  └── 有 pitch edit：
       ├── 后台线程：对每个有 pitch edit 的 clip 调用 Renderer.render()
       │    └── 渲染结果写入 RenderedClipCache（key = clip_id + param_hash）
       ├── 全部 clip 渲染完成 → rebuild_snapshot → set_playing
       └── audio callback：
            └── sample_clip_pcm 中优先读取 rendered_pcm
```

### Task 10: 扩展 `EngineClip` — 添加 `rendered_pcm` 字段

**Files:**
- Modify: `backend/src-tauri/src/audio_engine/types.rs`

**改动：**

```diff
  pub(crate) struct EngineClip {
      // ... 现有字段 ...

+     /// 预渲染后的 stereo interleaved PCM（优先级最高）。
+     /// 当有 pitch edit 时，由后台线程预渲染并填充。
+     pub(crate) rendered_pcm: Option<Arc<Vec<f32>>>,
  }
```

---

### Task 11: 扩展 `synth_clip_cache.rs` — 新增整 Clip 渲染缓存

**Files:**
- Modify: `backend/src-tauri/src/synth_clip_cache.rs`

**改动：** 新增 `RenderedClipCache`（与现有 per-segment `SynthClipCache` 共存），
容量上限 128 个 clip，key 为 `clip_id + pitch_edit_hash + source_hash`，
value 为完整 clip 渲染后的 stereo PCM。

---

### Task 12: 修改 `mix.rs` — `sample_clip_pcm` 支持 rendered_pcm

**Files:**
- Modify: `backend/src-tauri/src/audio_engine/mix.rs`

**改动：** 在 `sample_clip_pcm` 中增加最高优先级分支：

```rust
fn sample_clip_pcm(clip: &EngineClip, local: u64, local_adj: f64) -> Option<(f32, f32)> {
    // 最高优先级：预渲染 PCM（有 pitch edit 时由后台线程渲染）
    if let Some(ref rendered) = clip.rendered_pcm {
        let idx = (local as usize) * 2;
        if idx + 1 < rendered.len() {
            return Some((rendered[idx], rendered[idx + 1]));
        }
    }

    // ... 现有 stretch_stream / fallback 逻辑不变 ...
}
```

---

### Task 13: 修改 `snapshot.rs` — 填充 rendered_pcm

**Files:**
- Modify: `backend/src-tauri/src/audio_engine/snapshot.rs`

**改动：** `build_snapshot` 中对有 pitch edit 的 clip，查询 `RenderedClipCache`，
命中则填充 `rendered_pcm`。

---

### Task 14: 重写 `play_original` — Clip 级预渲染

**Files:**
- Modify: `backend/src-tauri/src/commands/playback.rs`

**改动：** 将"整体渲染 WAV → play_file"改为：

1. 检查每个有 pitch edit 的 clip 是否在 `RenderedClipCache` 中命中
2. 对 miss 的 clip 后台调用 `Renderer.render()` 并写入缓存
3. 全部完成 → rebuild_snapshot → set_playing

---

### Task 15: 编译验证 + 集成测试

```bash
cd backend/src-tauri && cargo check 2>&1
```

---

## 依赖关系

```
Phase 1:
  Task 1 (traits.rs)
    ↓
  Task 2 (utils.rs) + Task 3 (world.rs) + Task 4 (hifigan.rs) — 可并行
    ↓
  Task 5 (mod.rs)
    ↓
  Task 6 (lib.rs) + Task 7 (pitch_editing.rs) + Task 8 (删除文件) — 可并行
    ↓
  Task 9 (编译验证)

Phase 2:
  Task 10 (types.rs) + Task 11 (synth_clip_cache.rs) — 可并行
    ↓
  Task 12 (mix.rs) + Task 13 (snapshot.rs) — 可并行
    ↓
  Task 14 (playback.rs)
    ↓
  Task 15 (编译验证)
```
