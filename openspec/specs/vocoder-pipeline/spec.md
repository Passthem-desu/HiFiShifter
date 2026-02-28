## Capability: 声码器管线

### Context

声码器管线通过 trait 抽象将声码器实现与调用方解耦，支持 WorldVocoder 和 NsfHifiganOnnx 等多种声码器，新增声码器无需修改核心调用逻辑。

---

## Requirements

### Requirement: vocoder-pipeline-trait

**Requirement text:** 新建 `vocoder_pipeline.rs`，定义 `VocoderPipeline` trait，将声码器实现与调用方解耦。

#### Scenario: WorldVocoder 通过 trait 调用
- **GIVEN** `SynthPipelineKind::WorldVocoder` 且 world_vocoder 可用
- **WHEN** 调用 `get_pipeline(kind).process(&ctx)`
- **THEN** 返回与原 `world_vocoder::vocode_pitch_shift_chunked` 等价的处理结果

#### Scenario: NsfHifiganOnnx 通过 trait 调用
- **GIVEN** `SynthPipelineKind::NsfHifiganOnnx` 且 nsf_hifigan_onnx 可用
- **WHEN** 调用 `get_pipeline(kind).process(&ctx)`
- **THEN** 返回与原 `nsf_hifigan_onnx::infer_pitch_edit_mono` 等价的处理结果

#### Scenario: 声码器不可用时返回 false
- **GIVEN** `SynthPipelineKind::WorldVocoder` 但 world_vocoder 不可用（DLL 未加载）
- **WHEN** 调用 `pipeline.is_available()`
- **THEN** 返回 `false`，`maybe_apply_pitch_edit_to_clip_segment` 返回 `Ok(false)`

---

### Requirement: pitch-editing-refactor

**Requirement text:** `pitch_editing.rs` 中的 `maybe_apply_pitch_edit_to_clip_segment` 改为通过 `VocoderPipeline` trait 调用声码器，移除直接 match 分支。

#### Scenario: 重构后行为与原实现一致
- **GIVEN** 相同的 timeline 状态、clip 数据和 PCM 输入
- **WHEN** 调用重构后的 `maybe_apply_pitch_edit_to_clip_segment`
- **THEN** 输出 PCM 与重构前完全一致

#### Scenario: 新增声码器无需修改 pitch_editing.rs
- **GIVEN** 新增一个实现了 `VocoderPipeline` trait 的声码器
- **WHEN** 将其注册到 `get_pipeline` 注册表
- **THEN** `pitch_editing.rs` 无需任何修改即可使用新声码器
