## 1. Session 全局共享（onnx-session-sharing）

- [x] 1.1 在 `nsf_hifigan_onnx.rs` 中新增 `static SHARED_SESSION: OnceLock<Arc<Session>>`，在 `ensure_ort_init()` 之后初始化
- [x] 1.2 将 `NsfHifiganOnnx` 中的 `session: Session` 字段改为 `session: Arc<Session>`，`load()` 时从 `SHARED_SESSION` 获取或初始化
- [x] 1.3 将 `run_model()` 中的 `self.session.run()` 改为通过 `Arc<Session>` 调用，确保不持有 `&mut self` 对 session 的独占引用
- [x] 1.4 验证 `PROBE` 与 `SHARED_SESSION` 初始化逻辑合并：`probe()` 调用时同步初始化 `SHARED_SESSION`，消除重复加载
- [x] 1.5 验证多线程场景：两个线程并发调用 `infer_pitch_edit_mono()` 时无 panic 且结果正确

## 2. Mel 投影矩阵乘法加速（mel-simd-acceleration）

- [x] 2.1 在 `Cargo.toml` 中确认 `ndarray` 已作为直接依赖引入（当前仅在 Cargo.lock 中作为间接依赖）
- [x] 2.2 将 `NsfHifiganOnnx` 中的 `mel_fb: Vec<Vec<f32>>` 改为 `mel_fb_matrix: ndarray::Array2<f32>`（shape: `[n_mels, n_freqs]`），在 `load()` 中从 `mel_filterbank_slaney()` 结果构建
- [x] 2.3 在 `mel_from_audio_fast()` 中，将每帧 `mag_buf` 累积为 `Array2<f32>`（shape: `[n_freqs, n_frames]`），替代逐帧写入 `mel` 向量的内层循环
- [x] 2.4 用 `mel_fb_matrix.dot(&mag_matrix)` 替代双重循环，结果 reshape 为 `[n_mels * n_frames]` 的 `Vec<f32>`
- [x] 2.5 验证数值一致性：对同一音频输入，矩阵乘法版本与原循环版本的 mel 输出逐元素误差 < 1e-5

## 3. 动态 ctx_sec（adaptive-ctx-padding）

- [x] 3.1 在 `pitch_stream_onnx.rs` 的 `spawn_pitch_stream_onnx()` 中，将固定 `ctx_sec` 的计算移入 voiced 段处理分支
- [x] 3.2 实现 `compute_adaptive_ctx_sec(voiced_dur_sec: f64, user_override: Option<f64>) -> f64` 辅助函数，按设计文档中的阈值规则返回 ctx_sec
- [x] 3.3 在 voiced 段处理时，用 `compute_adaptive_ctx_sec(voiced_dur, env_override)` 替换原 `ctx_sec` 变量
- [x] 3.4 验证：voiced 段 < 0.5s 时 `pad_pre` 和 `pad_post` 均使用 0.5s；voiced 段 ≥ 2.0s 时仍使用 1.5s
- [x] 3.5 验证：设置 `HIFISHIFTER_ONNX_VAD_CTX_SEC=2.0` 时，所有 voiced 段均使用 2.0s，不受时长影响
