# Design: 音频合成链路优化（声码器抽象 + 工程化）

## Current State

```
state.rs
  Track { pitch_analysis_algo: PitchAnalysisAlgo }
  Clip  { id, track_id, gain, fade_in_beats, ... }

pitch_editing.rs
  maybe_apply_pitch_edit_to_clip_segment()
    → PitchEditAlgorithm::from_track_algo(&track.pitch_analysis_algo)
    → match algo {
        WorldVocoder    => world_vocoder::vocode_pitch_shift_chunked(...)
        NsfHifiganOnnx  => nsf_hifigan_onnx::infer_pitch_edit_mono(...)
        Bypass          => Ok(None)
      }                                               ← 直接 match，无抽象层

project.rs
  ProjectFile { version: u32=1, name, timeline }     ← JSON 格式，无媒体注册表

mixdown.rs
  render_mixdown_wav() → WavSpec { bits_per_sample: 16, SampleFormat::Int }
                                                      ← 固定 16-bit，无质量预设
```

## Goals

**Goals:**
- 通过 `VocoderPipeline` trait 解耦合成链路，未来新增声码器无需修改核心逻辑
- 工程文件升级为 MessagePack，向后兼容旧 JSON 格式
- 导出时支持多种位深，区分实时预览和最终导出质量

**Non-Goals:**
- 不实现共振峰/气声/张力等新声码器（仅建立扩展框架）
- 不优化实时合成延迟

## Design

### 1. VocoderPipeline 抽象层（新建 `vocoder_pipeline.rs`）

```rust
// vocoder_pipeline.rs

pub trait VocoderPipeline: Send + Sync {
    fn kind(&self) -> SynthPipelineKind;
    fn is_available(&self) -> bool;
    fn process(&self, ctx: &VocoderContext) -> Result<Vec<f32>, String>;
}

pub struct VocoderContext<'a> {
    pub mono_pcm: &'a [f32],
    pub sample_rate: u32,
    pub seg_start_sec: f64,
    pub clip_start_sec: f64,
    pub frame_period_ms: f64,
    pub pitch_edit: &'a [f32],
    pub clip_midi: &'a [f32],
}

// 注册表（静态分发）
pub fn get_pipeline(kind: SynthPipelineKind) -> &'static dyn VocoderPipeline {
    match kind {
        SynthPipelineKind::WorldVocoder    => &WORLD_PIPELINE,
        SynthPipelineKind::NsfHifiganOnnx  => &NSF_PIPELINE,
    }
}

static WORLD_PIPELINE: WorldVocoderPipeline = WorldVocoderPipeline;
static NSF_PIPELINE:   NsfHifiganPipeline   = NsfHifiganPipeline;
```

两个实现分别封装现有的 `world_vocoder::vocode_pitch_shift_chunked` 和 `nsf_hifigan_onnx::infer_pitch_edit_mono`，将 pitch 映射闭包内联到各自的 `process()` 实现中。

### 2. pitch_editing 重构

`pitch_editing.rs` 中的 `maybe_apply_pitch_edit_to_clip_segment` 改为通过 `VocoderPipeline` trait 调用声码器：

```rust
// 原来：直接 match
let algo = PitchEditAlgorithm::from_track_algo(&track.pitch_analysis_algo);
match algo {
    WorldVocoder   => world_vocoder::vocode_pitch_shift_chunked(...),
    NsfHifiganOnnx => nsf_hifigan_onnx::infer_pitch_edit_mono(...),
    Bypass         => Ok(None),
}

// 改为：通过 trait 调用
let kind = SynthPipelineKind::from_track_algo(&track.pitch_analysis_algo);
let pipeline = vocoder_pipeline::get_pipeline(kind);
if !pipeline.is_available() { return Ok(false); }
let out = pipeline.process(&ctx)?;
```

`PitchEditAlgorithm` 枚举保留（用于 `is_pitch_edit_active` 等辅助函数），仅 `maybe_apply_pitch_edit_to_clip_segment` 内部改为通过 trait 调用。

### 3. ProjectFile v2 + MessagePack

**`project.rs`**：

```rust
// 新增媒体注册表条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaEntry {
    pub id: String,
    pub original_path: String,
    pub relative_path: String,
    pub sha256: [u8; 32],
}

// ProjectFile v2
pub struct ProjectFile {
    pub version: u32,   // = 2
    pub name: String,
    pub timeline: TimelineState,
    #[serde(default)]
    pub media_registry: Vec<MediaEntry>,  // 新增
    #[serde(default)]
    pub synth_config: SynthConfig,        // 新增
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SynthConfig {
    pub default_pipeline: Option<SynthPipelineKind>,
}
```

**保存**：`rmp_serde::to_vec_named(&pf)` → 写入文件

**读取**（向后兼容）：
```rust
fn load_project_file(bytes: &[u8]) -> Result<ProjectFile, String> {
    // 先尝试 MessagePack
    if let Ok(pf) = rmp_serde::from_slice::<ProjectFile>(bytes) {
        return Ok(pf);
    }
    // fallback: JSON（兼容旧工程）
    serde_json::from_slice(bytes).map_err(|e| e.to_string())
}
```

**`Cargo.toml`** 新增：`rmp-serde = "1"`

### 4. 导出质量预设

**`mixdown.rs`**：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Wav16,   // 16-bit int（当前默认，用于实时预览）
    Wav24,   // 24-bit int
    Wav32f,  // 32-bit float（最高质量，用于最终导出）
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QualityPreset {
    Realtime,  // 快速，用于播放预览
    Export,    // 最高质量，用于最终导出
}

pub struct MixdownOptions {
    // ...现有字段...
    pub export_format: ExportFormat,    // 新增，默认 Wav16
    pub quality_preset: QualityPreset,  // 新增，默认 Realtime
}
```

`render_mixdown_wav` 根据 `export_format` 选择 `WavSpec`：
- `Wav16` → `bits_per_sample: 16, SampleFormat::Int`（现有行为）
- `Wav24` → `bits_per_sample: 24, SampleFormat::Int`
- `Wav32f` → `bits_per_sample: 32, SampleFormat::Float`

导出命令（Tauri command）调用时传入 `export_format: Wav32f, quality_preset: Export`。

## Key Decisions

| 决策 | 选择 | 理由 |
|------|------|------|
| VocoderPipeline 分发方式 | 静态 `&'static dyn Trait` | 避免 `Box<dyn>` 分配，声码器数量固定，静态分发足够 |
| SynthPipelineKind 与 PitchAnalysisAlgo 独立 | 独立枚举 | 分析算法和合成链路是不同关注点，解耦便于未来扩展 |
| MessagePack 格式检测 | 先 MsgPack 后 JSON fallback | 无需文件头魔数，代码简单，旧工程自动兼容 |
| 工程文件扩展名 | 保持 `.hsp` | 避免用户感知变化 |
| 导出格式默认值 | Wav16（现有行为不变） | 向后兼容，不影响现有导出命令 |

## Risks / Trade-offs

- **MessagePack 二进制格式**：工程文件不再可直接用文本编辑器查看，调试时需要额外工具。缓解：保留 JSON fallback 读取，开发时可手动保存为 JSON。
