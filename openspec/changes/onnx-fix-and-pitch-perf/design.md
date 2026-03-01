## Context

当前 Tauri/Rust 后端存在两个影响核心体验的问题：

1. **NSF-HiFiGAN ONNX 模式无声**：`Cargo.toml` 中 `onnx` feature 不在 `default` 集合，`cargo tauri dev`（不加 `--features onnx`）时编译的是 `nsf_hifigan_onnx_stub.rs` 版本，其 `infer_pitch_edit_mono` 直接 bypass（返回原始 PCM）。`pitch_stream_onnx.rs` 内的 hard-start 逻辑在 voiced intervals 为空时（`pitch_orig` 未就绪）会抑制音频输出，导致静音。即使 `onnx` feature 启用，若模型路径未配置，推理同样会失败并卡在 hard-start 等待状态。前端无法感知后端的 ONNX 可用性，因此不会提示用户。

2. **音高检测慢**：`compute_pitch_curve` 对每个 clip 逐一执行「解码 → 重采样 → 转 mono → DC 去除 → WORLD Harvest」。多 clip 项目下该过程完全串行，且没有 per-clip 级别的缓存。每次根轨 pitch_orig_key 变化（如 clip 移动、新增）都触发所有 clip 的重新计算。

## Goals / Non-Goals

**Goals:**
- 消除"ONNX 切换后完全静音"的用户感知：无论 `onnx` feature 状态如何，切换后都应有可听到的声音（即使是 WORLD 回退）
- 后端新增 `get_onnx_status` command，报告编译期 feature 开关 + 运行时模型可用性
- 前端 Algo 选择器在 ONNX 不可用时显示 `(unavailable)` 提示
- 多 clip 音高分析并行化，大幅缩短分析时长
- 引入 per-clip pitch 缓存，跳过未变化 clip 的重复计算

**Non-Goals:**
- 不在此次变更中修改 WORLD vocoder 本身的分析精度
- 不修改 ONNX 模型结构或推理算法
- 不引入 WASM/worker 线程的前端并行

## Decisions

### D1：ONNX 不可用时播放层回退策略

**决定**：`pitch_stream_onnx` 在启动前检查 `nsf_hifigan_onnx::is_available()`。若不可用，播放器应立即回退到 WORLD vocoder 模式（不等待、不 hard-start），而非保持 hard-start 静音状态。

**备选**：
- 不做回退，保持当前"静音等待"：用户体验极差，排除。
- 回退到 bypass（播放原音，不做 pitch edit）：比 WORLD 差，用户调了 pitch 曲线却看不到效果。
- 回退到 WORLD：最佳用户体验，且 WORLD 已是默认 algo，逻辑一致。

### D2：ONNX 可用性上报方式

**决定**：新增 `get_onnx_status` Tauri command，返回 `{ compiled: bool, model_available: bool, ep_choice: String }`。前端在 mount 时调用一次并缓存到 store，Algo 选择器读取该状态。

**备选**：
- 用 Tauri 事件在启动时推送：前端需要时序处理，初次渲染可能拿不到；不如主动 command 简单。

### D3：per-clip 并行方案

**决定**：使用 `rayon::par_iter()` 对 `job.timeline.clips` 并行执行「解码 + 分析」，收集 `Vec<ClipPitch>` 后合并到 root 融合循环（融合循环本身保持串行）。

**备选**：
- `std::thread::spawn` 手动 join：需要更多样板代码，且难以控制线程上限，排除。
- Tokio async：此处是 CPU 密集任务，不适合异步 IO 线程池，排除。

### D4：per-clip 缓存粒度

**决定**：缓存 key = `blake3(source_path + file_sig + trim_start + trim_end + playback_rate + in_rate + frame_period_ms)`，缓存值 = `Vec<f32>` MIDI curve（clip 时间线空间）。缓存存放在 `AppState` 内的 `Mutex<HashMap<String, Vec<f32>>>`，进程生命周期内有效。

**备选**：
- 写磁盘缓存：持久化长但实现复杂，且 clip trim 变更时需要失效；本次不引入。
- 缓存放在 `PitchJob`：job 是一次性的对象，放在 state 中才能跨 job 复用。

### D5：分析音频截取优化

**决定**：仅截取 clip 在时间线上实际用到的源音频区段（已有 `src_i0`/`src_i1` 变量）送入 WORLD，不分析 trim 掉的尾部。当前代码已有此变量但未完整利用：若 `src_i1 - src_i0` 超过某阈值（默认 60s），将 clip 分段分析并拼合，防止超长音频导致单次调用阻塞太久。

## Risks / Trade-offs

- `rayon` 并行引入 crate 依赖（约 240KB 编译增量），影响可接受 → 轻量，业界标准库
- per-clip 缓存使用内存：单 clip MIDI curve 约 `frame_period_ms=5ms + 120s = 24000 f32`（96KB），10 个 clip ≈ 1MB，可接受 → 若有需要可加 LRU 上限（本次不引入）
- 并行 WORLD 调用在极低内存机器上可能产生内存压力 → 添加 `HIFISHIFTER_PITCH_PARALLEL_CLIPS` 环境变量允许限制并行度（默认 = CPU 数量）
- hard-start 回退逻辑改变可能影响已有 ONNX 工作流（有 CUDA 的用户）→ 仅当 `is_available()` 返回 false 时才回退，不改变 ONNX 正常路径

## Migration Plan

1. 在 `Cargo.toml` 中将 `onnx` 从可选 feature 改为文档化「需显式开启」，但在 `tauri.conf.json` 的 `beforeDevCommand`（或 `build_and_run.bat`）中默认加上 `--features onnx`（生产 + 开发都要 ONNX 路径可用）
2. 添加 `rayon` 依赖
3. 在 `state.rs` 添加 `clip_pitch_cache: Mutex<HashMap<String, Vec<f32>>>`
4. 修改 `pitch_analysis.rs`：并行 + 缓存
5. 修改 `audio_engine/pitch_stream_onnx.rs`：回退逻辑
6. 添加 `get_onnx_status` command
7. 前端 Algo 选择器消费 `get_onnx_status`

回滚：全部改动可独立还原，缓存结构增量添加到 state，不破坏现有序列化格式。

## Open Questions

- 是否在此次变更中也将 `onnx` feature 加入 CI 构建矩阵？（建议是，但 CI 配置不在 Rust 源码里，需单独确认）
- `HIFISHIFTER_PITCH_PARALLEL_CLIPS` 默认值是否需要保守一些（如限制为 4）以避免 low-RAM 设备 OOM？
