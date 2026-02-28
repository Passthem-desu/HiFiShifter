# Spec: per-clip epoch cancel 细化（方案 D）

## ADDED Requirements

### Requirement: per-clip stretch_stream epoch

每个 clip 的 stretch_stream worker 必须由独立的 per-clip epoch 控制，而非全局单一 epoch。

#### Scenario: 单 clip 参数变化只 cancel 该 clip 的 worker
- **GIVEN** timeline 中有 clip A 和 clip B，两者都有 stretch_stream worker 运行
- **WHEN** 只有 clip A 的 `playback_rate` 发生变化（`UpdateTimeline`）
- **THEN** 只有 clip A 的 stretch_stream worker 被 cancel 并重建，clip B 的 worker 继续运行

#### Scenario: stretch 无关参数变化不 cancel stretch worker
- **GIVEN** clip 有 stretch_stream worker 运行
- **WHEN** 该 clip 的 `gain`、`fade_in_beats`、`fade_out_beats` 发生变化
- **THEN** 该 clip 的 stretch_stream worker 不被 cancel

#### Scenario: stretch 相关参数变化触发 cancel
- **GIVEN** clip 有 stretch_stream worker 运行
- **WHEN** 该 clip 的 `playback_rate`、`trim_start_beat` 或 `trim_end_beat` 发生变化
- **THEN** 该 clip 的 stretch_stream worker 被 cancel 并重建

#### Scenario: clip 删除时清理 epoch
- **GIVEN** timeline 中有 clip A，其 per-clip epoch 存在于 `clip_stretch_epochs` map
- **WHEN** `UpdateTimeline` 中 clip A 不再存在
- **THEN** `clip_stretch_epochs` 中 clip A 的 epoch 被清理

#### Scenario: 全局 epoch 仍控制 base_stream 和 pitch_stream
- **GIVEN** 任意 `UpdateTimeline`
- **WHEN** 处理命令
- **THEN** 全局 `stretch_stream_epoch` 仍然递增，base_stream 和 pitch_stream worker 仍被 cancel 并重建
