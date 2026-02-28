## Context

当前 ONNX 推理链路在实时播放场景下存在三处可量化的延迟来源：

1. **TLS Session 冷启动**：`infer_pitch_edit_mono()` 通过 `thread_local! { static TLS_SESSION }` 持有 `NsfHifiganOnnx`，每个新线程首次调用时执行 `NsfHifiganOnnx::load()`（读取 ONNX 文件 + 初始化 ORT Session），耗时 1-3 秒。`pitch_stream_onnx` 每次播放都会 `thread::spawn` 一个新线程，因此每次播放都会触发冷启动。

2. **Mel 投影手写循环**：`mel_from_audio_fast()` 中的 Mel 投影是双重 `for` 循环（`n_mels × n_freqs = 128 × 1025`），无 SIMD 向量化。对于 1 秒音频（约 86 帧），这是约 1130 万次浮点乘加，是 CPU 侧最大的热点。

3. **固定 ctx_sec padding**：实时路径中每个 voiced 段的实际推理范围为 `voiced_duration + ctx_sec × 2`（前后各 1.5s），对于短 voiced 段（< 0.5s 的单音节），推理的音频中 voiced 内容占比不足 15%，大量计算浪费在上下文帧上。

## Goals / Non-Goals

**Goals:**
- 消除每次播放的 Session 冷启动延迟（目标：首次推理延迟 < 100ms）
- 降低 Mel 特征提取的 CPU 占用（目标：mel 计算耗时减少 ≥ 50%）
- 减少短 voiced 段的无效推理帧数（目标：voiced 段 < 0.5s 时 ctx_sec ≤ 0.5s）
- 不改变音频输出质量，不引入新的边界伪影

**Non-Goals:**
- 模型量化（INT8/FP16）
- 分段推理（SEGMENT_FRAMES）的边界伪影修复
- 多 GPU 支持
- 离线导出路径的性能优化

## Decisions

### 决策 1：Session 改为 `OnceLock<Arc<Session>>` 全局共享

**选项对比：**

| 方案 | 优点 | 缺点 |
|------|------|------|
| 保持 TLS（现状） | 无锁竞争 | 每线程冷启动，内存 × 线程数 |
| `Arc<Mutex<Session>>` | 简单 | run() 串行，并发推理阻塞 |
| `OnceLock<Arc<Session>>` | 一次初始化，run() 并发安全 | 需确认 ORT Session::run 线程安全性 |
| 线程池 + channel | 最灵活 | 复杂度高，当前无必要 |

**选择：`OnceLock<Arc<Session>>`**

ORT 的 `Session::run()` 是线程安全的（ORT 文档明确说明 Session 可跨线程共享）。将 `session: Session` 从 `NsfHifiganOnnx` 中分离，改为 `static SHARED_SESSION: OnceLock<Arc<Session>>`，`NsfHifiganOnnx` 持有 `Arc<Session>` 引用。

`NsfHifiganOnnx` 中的其余字段（`mel_fb`、`window`、`fft`、`fft_buf`、`mag_buf`、`pad_buf`、`audio_resample_buf`）是每次推理的工作缓冲区，仍保持 TLS 持有，避免锁竞争。

**初始化时机**：应用启动时（或首次 `is_available()` 调用时）在后台线程预热 Session，而非等到第一次推理时才加载。

---

### 决策 2：Mel 投影改用 `ndarray` 矩阵乘法

**选项对比：**

| 方案 | 加速比（估算） | 侵入性 |
|------|--------------|--------|
| 手写循环（现状） | 1× | — |
| 手写 SIMD（unsafe） | 4-8× | 高，平台相关 |
| `ndarray` + `matrixmultiply` | 3-5× | 低，纯 safe Rust |
| `faer` | 5-10× | 中，新依赖 |

**选择：`ndarray` + `matrixmultiply`**

`matrixmultiply` crate 是 `ndarray` 的默认 BLAS 后端，自动利用 AVX2/AVX-512 SIMD，无需 unsafe 代码。

具体改动：将 `mel_fb: Vec<Vec<f32>>` 改为 `mel_fb_matrix: Array2<f32>`（shape: `[n_mels, n_freqs]`），在 `mel_from_audio_fast()` 中将每帧的 `mag_buf` 累积为 `Array2<f32>`（shape: `[n_freqs, n_frames]`），然后用一次矩阵乘法 `mel_fb_matrix.dot(&mag_matrix)` 替代双重循环。

---

### 决策 3：`ctx_sec` 根据 voiced 段时长动态缩放

**规则：**

```
voiced_dur = seg_end_sec - seg_start_sec

ctx_sec = match voiced_dur {
    d if d < 0.5  => 0.5,
    d if d < 2.0  => 1.0,
    _             => 1.5,   // 保持原默认值
}
```

上限仍受 `HIFISHIFTER_ONNX_VAD_CTX_SEC` 环境变量控制（若用户手动设置则不覆盖）。

**为什么不直接降低全局默认值？** 长 voiced 段（歌唱连音）需要足够的上下文才能保证音质，1.5s 是经过验证的安全值。短 voiced 段（说话音节）对上下文不敏感，0.5s 已足够。

## Risks / Trade-offs

- **Session 共享的线程安全**：ORT `Session::run()` 线程安全已有文档保证，但需在集成测试中验证并发推理无数据竞争。→ 缓解：保留 TLS 工作缓冲区，仅共享 Session 对象。

- **ndarray 依赖引入**：若项目已有 `ndarray`（需检查 `Cargo.toml`），则无额外成本；若没有，增加约 200KB 编译产物。→ 缓解：先检查现有依赖，若已有则直接使用。

- **动态 ctx_sec 对音质的影响**：短 voiced 段使用更小的 ctx_sec 可能在极端情况下（voiced 段紧邻另一 voiced 段）引入轻微音质下降。→ 缓解：阈值保守设置（0.5s 而非更小），且仅在用户未手动设置 `HIFISHIFTER_ONNX_VAD_CTX_SEC` 时生效。

- **预热时机**：后台预热 Session 需要在应用启动后尽早触发，否则首次播放仍有延迟。→ 缓解：在 `is_available()` 首次调用时同步初始化 `SHARED_SESSION`（与现有 `PROBE` 逻辑合并）。
