# Tasks: 音频合成链路优化（声码器抽象 + 工程化）

## 1. 后端：VocoderPipeline 抽象层

- [x] 1.1 在 `state.rs` 中新增 `SynthPipelineKind` 枚举（`WorldVocoder`、`NsfHifiganOnnx`），实现 `Serialize/Deserialize`，并添加 `from_track_algo` 转换方法
- [x] 1.2 新建 `backend/src-tauri/src/vocoder_pipeline.rs`，定义 `VocoderPipeline` trait（`kind`、`is_available`、`process`）和 `VocoderContext` 结构体
- [x] 1.3 在 `vocoder_pipeline.rs` 中实现 `WorldVocoderPipeline`，封装 `world_vocoder::vocode_pitch_shift_chunked`，将 pitch 映射闭包内联到 `process()` 中
- [x] 1.4 在 `vocoder_pipeline.rs` 中实现 `NsfHifiganPipeline`，封装 `nsf_hifigan_onnx::infer_pitch_edit_mono`，将 pitch 映射闭包内联到 `process()` 中
- [x] 1.5 在 `vocoder_pipeline.rs` 中实现 `get_pipeline(kind: SynthPipelineKind) -> &'static dyn VocoderPipeline` 注册表函数
- [x] 1.6 在 `lib.rs` 或 `main.rs` 中注册 `mod vocoder_pipeline`

## 2. 后端：pitch_editing 重构

- [x] 2.1 在 `pitch_editing.rs` 的 `maybe_apply_pitch_edit_to_clip_segment` 中，将原来的 `match algo { WorldVocoder => ..., NsfHifiganOnnx => ..., Bypass => ... }` 替换为通过 `vocoder_pipeline::get_pipeline(kind).process(&ctx)` 调用
- [x] 2.2 保留 `PitchEditAlgorithm` 枚举及 `is_pitch_edit_active`、`is_pitch_edit_backend_available` 等辅助函数，确保其他调用方不受影响

## 3. 后端：ProjectFile v2 + MessagePack

- [x] 3.1 在 `Cargo.toml` 中新增依赖 `rmp-serde = "1"`
- [x] 3.2 在 `project.rs` 中新增 `MediaEntry` 结构体（`id`、`original_path`、`relative_path`、`sha256: [u8; 32]`）和 `SynthConfig` 结构体（`default_pipeline: Option<SynthPipelineKind>`）
- [x] 3.3 在 `project.rs` 中更新 `ProjectFile`：`version` 默认值改为 2，新增 `#[serde(default)] pub media_registry: Vec<MediaEntry>` 和 `#[serde(default)] pub synth_config: SynthConfig` 字段
- [x] 3.4 在 `project.rs` 中新增 `load_project_file(bytes: &[u8]) -> Result<ProjectFile, String>` 函数，先尝试 `rmp_serde::from_slice`，失败则 fallback 到 `serde_json::from_slice`
- [x] 3.5 修改工程保存命令（`commands/project.rs` 或相关 Tauri command），将 `serde_json::to_string_pretty` 替换为 `rmp_serde::to_vec_named`，写入二进制文件
- [x] 3.6 修改工程加载命令，将 `serde_json::from_str` 替换为调用 `load_project_file`

## 4. 后端：导出质量预设

- [x] 4.1 在 `mixdown.rs` 中新增 `ExportFormat` 枚举（`Wav16`、`Wav24`、`Wav32f`）和 `QualityPreset` 枚举（`Realtime`、`Export`），为 `MixdownOptions` 新增这两个字段（带 `Default` 实现，默认 `Wav16` + `Realtime`）
- [x] 4.2 修改 `render_mixdown_wav`，根据 `opts.export_format` 选择对应的 `WavSpec`（16-bit int / 24-bit int / 32-bit float）
- [x] 4.3 修改导出 Tauri command，调用时传入 `export_format: Wav32f, quality_preset: Export`
