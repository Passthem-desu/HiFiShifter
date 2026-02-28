# Proposal: Audio Engine Refactor (A–E)

## Why

音频引擎核心模块（`engine.rs`、`snapshot.rs`、`mix.rs`）随功能迭代积累了大量技术债：代码重复、职责混杂、模块边界模糊，导致维护成本高、新功能扩展困难，并存在可感知的实时播放延迟问题。

## What Changes

本次重构涵盖五个独立但相互协同的改进方向：

- **方案 A（消除 mix.rs 代码重复）**：提取 `sample_clip_frame` 公共函数，消除 `mix_snapshot_clips_into_scratch` 与 `mix_snapshot_clips_pitch_edited_into_scratch` 之间约 80 行的重复 PCM 采样逻辑。

- **方案 B（stretch_stream 独立模块化）**：将 `snapshot.rs` 中内联的 stretch_stream worker（约 150 行）提取为独立的 `stretch_stream.rs` 模块，与已有的 `base_stream.rs` 和 `pitch_stream_onnx.rs` 对齐，使 `snapshot.rs` 职责单一化。

- **方案 C（engine.rs 命令处理函数化）**：将 `engine.rs` Worker 循环中各命令的处理逻辑（`UpdateTimeline`、`AudioReady`、`StretchReady`、`ClipPitchReady` 等）提取为独立函数，消除约 200 行的内联 match 分支。

- **方案 D（epoch cancel 机制细化）**：将全局 `stretch_stream_epoch` 细化为 per-clip epoch，使参数变化时只 cancel 受影响 clip 的 stretch worker，避免无关 clip 的 worker 被打断重建，减少实时播放延迟。

- **方案 E（EngineSnapshot clips 改为 Arc 共享）**：将 `EngineSnapshot.clips` 从 `Vec<EngineClip>` 改为 `Arc<Vec<EngineClip>>`，在 `StretchReady`/`AudioReady` 触发的 `build_snapshot` 重建中复用未变化的 clips 列表，减少内存分配。

## Why Now

- `snapshot.rs` 已达 860 行，`engine.rs` Worker 循环约 400 行，认知负担已影响日常开发效率。
- `mix.rs` 的代码重复已是潜在 bug 温床（修复一处易遗漏另一处）。
- 用户反馈实时播放存在可感知延迟，方案 D 是直接针对该问题的改进。

## Impact

- **受影响文件**：`audio_engine/engine.rs`、`audio_engine/snapshot.rs`、`audio_engine/mix.rs`、`audio_engine/types.rs`
- **新增文件**：`audio_engine/stretch_stream.rs`
- **外部接口**：无变化（所有改动为内部重构）
- **音频行为**：方案 A/B/C/E 为纯重构，不改变音频输出；方案 D 改变 cancel 粒度，需回归测试实时播放的正确性
