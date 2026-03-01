## Why

切换到 NSF-HiFiGAN ONNX 模式后，用户完全听不到合成后的声音；同时，每次打开根轨 C 开关时音高检测要等待较长时间（多 clip / 长音频场景尤为明显），严重影响编辑体验。这两个问题均在 Tauri/Rust MVP 可用的核心路径上，需优先修复。

## What Changes

- **ONNX 模式静音修复**：
  - 当 `onnx` Cargo feature 未编译，或模型路径未配置，或 ONNX 推理初始化失败时，播放层不再静音等待，而是立即回退到 WORLD vocoder 输出（含 pitch_edit 应用）
  - `pitch_stream_onnx` 的 hard-start 逻辑增加超时兜底：若在指定时间内 voiced intervals 为空（pitch_orig 尚未分析）或推理失败，自动切换到非 hard-start 模式播放原音
  - 前端 ONNX Algo 选项旁增加可用状态标记（`(unavailable)` / `⚠`），当后端报告 `onnx_available: false` 时 UI 禁用该选项或显示警告

- **音高检测性能优化**：
  - 将 `compute_pitch_curve` 中的逐 clip 串行分析改为并行（Rayon 线程池）
  - 引入 per-clip pitch 缓存（key = 文件签名 + trim + playback_rate + frame_period_ms），跳过未变化 clip 的重复计算
  - 当 clip 音频远长于时间线上实际用到的片段时，仅截取用到的区段做分析

## Capabilities

### New Capabilities
- `onnx-fallback`: ONNX 不可用时播放层安全回退行为（状态上报 + 自动降级逻辑）
- `pitch-analysis-perf`: 并行 per-clip pitch 分析 + per-clip 缓存

### Modified Capabilities
- `onnx-session-sharing`: 需更新 ONNX 可用性上报接口，使前端可查询编译时的 feature 开关与运行时的会话状态

## Impact

- `backend/src-tauri/src/pitch_analysis.rs`：并行化 + 引入 per-clip 缓存结构
- `backend/src-tauri/src/audio_engine/pitch_stream_onnx.rs`：hard-start 超时兜底
- `backend/src-tauri/src/nsf_hifigan_onnx_stub.rs` / `nsf_hifigan_onnx.rs`：新增 `is_available()` / 可用状态上报
- `backend/src-tauri/src/commands.rs` 或 `state.rs`：新增 `get_onnx_status` command
- `frontend/src/`（参数面板 Algo 选择器）：读取 ONNX 状态并显示警告/禁用
- 依赖新增：`rayon`（Rust 并行库），无前端新依赖
