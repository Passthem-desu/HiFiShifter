# Spec: engine.rs 命令处理函数化（方案 C）

## CHANGED Requirements

### Requirement: Worker 循环命令处理函数化

`engine.rs` Worker 循环中每个命令的处理逻辑必须提取为独立的私有函数，不得内联在 `match` 分支中。

#### Scenario: 命令处理函数存在
- **GIVEN** 重构完成后
- **WHEN** 查看 `engine.rs`
- **THEN** 存在以下私有函数：`handle_update_timeline`、`handle_stretch_ready`、`handle_clip_pitch_ready`、`handle_audio_ready`、`handle_play_file`、`handle_seek_sec`、`handle_set_playing`、`handle_stop`

#### Scenario: Worker 循环简洁
- **GIVEN** 重构完成后
- **WHEN** 查看 Worker 循环的 `match` 分支
- **THEN** 每个分支只包含一次函数调用，不包含业务逻辑

#### Scenario: 命令处理行为不变
- **GIVEN** 任意命令序列
- **WHEN** 通过 `AudioEngine` 发送命令
- **THEN** 音频引擎行为与重构前完全一致
