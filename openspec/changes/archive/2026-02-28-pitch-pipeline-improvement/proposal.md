# Proposal: 音频合成链路优化（声码器抽象 + 工程化）

## Why

当前音频合成链路存在以下几个工程化问题，随着功能扩展会逐渐成为瓶颈：

1. **合成链路耦合**：`pitch_editing.rs` 中通过 `match` 分支直接调用各声码器，缺乏统一抽象，未来新增声码器（共振峰、气声、张力等）需要修改核心逻辑，扩展成本高。
2. **工程文件格式低效**：当前使用 JSON 保存工程文件，体积大、解析慢，不适合大型工程的快速读写。
3. **导出质量不可控**：导出时缺少质量预设，无法区分实时预览和最终导出的质量策略。

## What Changes

- **VocoderPipeline 抽象层**：新建 `vocoder_pipeline.rs`，定义 `VocoderPipeline` trait，将 WORLD 和 NSF-HiFiGAN 等声码器封装为独立实现，`pitch_editing.rs` 改为通过 trait 调用，解耦合成链路。
- **MessagePack 工程文件**：工程文件保存格式从 JSON 升级为 MessagePack（`rmp-serde`），读取时向后兼容旧 JSON 格式；`ProjectFile` 升级至 v2，新增媒体注册表和合成配置字段。
- **导出质量预设**：新增 `ExportFormat`（Wav16/Wav24/Wav32f）和 `QualityPreset`（Realtime/Export）枚举，导出时自动使用最高质量预设。

## Requirements

- `vocoder-pipeline-trait`: 新建 `VocoderPipeline` trait 及注册表，WORLD 和 NSF-HiFiGAN 实现该 trait
- `pitch-editing-refactor`: `pitch_editing.rs` 改为通过 `VocoderPipeline` trait 调用声码器，移除直接 match 分支
- `project-file-v2-msgpack`: 工程文件升级为 MessagePack 格式，`ProjectFile` 版本号升至 v2，向后兼容 JSON
- `project-file-media-registry`: `ProjectFile` 新增 `media_registry` 字段，记录媒体文件路径和 SHA256
- `export-format-quality-preset`: 新增 `ExportFormat` 和 `QualityPreset`，导出时使用 Export 预设

## Impact

- **后端**：`state.rs`、`pitch_editing.rs`、`project.rs`、`mixdown.rs`、`Cargo.toml`，新增 `vocoder_pipeline.rs`
- **依赖新增**：`rmp-serde = "1.x"`（Rust）
- **无破坏性变更**：工程文件向后兼容旧 JSON 格式，现有合成行为不变
