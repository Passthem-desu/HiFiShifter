# Spec: PCM 采样逻辑去重（方案 A）

## CHANGED Requirements

### Requirement: PCM 采样逻辑统一

`mix.rs` 中的 PCM 采样逻辑必须通过单一内部函数实现，不得在多个混音函数中重复。

#### Scenario: stretch_stream 覆盖时的 fast path
- **GIVEN** clip 有 `stretch_stream`，且 `stream.read_frame(local)` 返回 `Some((l, r))`
- **WHEN** 调用 `sample_clip_pcm(clip, local, local_adj)`
- **THEN** 返回 `Some((l, r))`，不执行线性插值

#### Scenario: stretch_stream 未覆盖时的 fallback
- **GIVEN** clip 有 `stretch_stream`，但 `stream.read_frame(local)` 返回 `None`
- **WHEN** 调用 `sample_clip_pcm(clip, local, local_adj)`
- **THEN** 执行线性插值采样，行为与重构前一致

#### Scenario: 无 stretch_stream 时的直接采样
- **GIVEN** clip 无 `stretch_stream`
- **WHEN** 调用 `sample_clip_pcm(clip, local, local_adj)`
- **THEN** 执行线性插值采样，行为与重构前一致

#### Scenario: 越界帧静音
- **GIVEN** 计算出的 `src_pos` 超出 `src_end_frame`（非 repeat 模式）
- **WHEN** 调用 `sample_clip_pcm`
- **THEN** 返回 `None`

#### Scenario: 两个混音函数行为不变
- **GIVEN** 任意 timeline 状态
- **WHEN** 分别调用重构前后的 `mix_snapshot_clips_into_scratch` 和 `mix_snapshot_clips_pitch_edited_into_scratch`
- **THEN** 输出 scratch buffer 内容与重构前完全一致
