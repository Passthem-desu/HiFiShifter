## Why

实时播放时 ONNX 推理链路延迟过高，主要瓶颈集中在三处：每个新线程首次调用时重复加载 ORT Session（1-3 秒冷启动）、Mel 特征提取使用手写循环未利用 SIMD 加速、实时路径的上下文 padding 固定为 1.5s 导致短 voiced 段也要推理过多无效帧。这三个问题叠加，使得实时变声在首次触发和短音节场景下延迟明显。

## What Changes

- **共享 ORT Session**：将 `NsfHifiganOnnx` 的 ORT Session 从 thread-local 改为全局 `Arc<Session>` 共享，消除多线程重复加载开销
- **Mel 投影矩阵乘法加速**：将 `mel_from_audio_fast()` 中的手写 Mel 投影循环替换为矩阵乘法（ndarray + matrixmultiply），利用 SIMD 自动向量化
- **动态 ctx_sec**：实时路径根据 voiced 段时长动态调整上下文 padding，短 voiced 段使用更小的 ctx_sec，减少无效推理帧数

## Capabilities

### New Capabilities

- `onnx-session-sharing`：全局共享 ORT Session，支持多线程并发推理，消除冷启动延迟
- `mel-simd-acceleration`：Mel 特征提取使用矩阵乘法加速，替代手写循环
- `adaptive-ctx-padding`：实时推理路径根据 voiced 段长度自适应调整上下文 padding 大小

### Modified Capabilities

- `vocoder-pipeline`：NsfHifiganOnnx 的 Session 生命周期管理方式变更，从 thread-local 改为 Arc 共享

## Impact

- `backend/src-tauri/src/nsf_hifigan_onnx.rs`：Session 初始化与持有方式重构
- `backend/src-tauri/src/audio_engine/pitch_stream_onnx.rs`：ctx_sec 动态计算逻辑
- `Cargo.toml`：可能新增 `ndarray`、`matrixmultiply` 依赖（如尚未引入）
- 不影响对外 API 和音频质量，仅为性能优化
