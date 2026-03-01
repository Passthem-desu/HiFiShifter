## MODIFIED Requirements

### Requirement: onnx-session-sharing-global
ORT Session SHALL 在进程级别以 `OnceLock<Arc<Session>>` 形式全局共享，所有线程复用同一 Session 实例，消除每线程冷启动开销。Session 初始化成功与否的状态 SHALL 可通过 `get_onnx_status` command 向前端查询。

#### Scenario: 首次调用后 Session 已初始化
- **WHEN** `is_available()` 或 `infer_pitch_edit_mono()` 首次被调用
- **THEN** `SHARED_SESSION` 被初始化一次，后续调用直接复用，不再执行 `build_session_with_ep()`

#### Scenario: 多线程并发推理不阻塞
- **WHEN** 两个线程同时调用 `infer_pitch_edit_mono()`
- **THEN** 两次推理可并发执行，不因 Mutex 锁而串行等待

#### Scenario: TLS 工作缓冲区仍保持线程本地
- **WHEN** 多线程并发调用 `mel_from_audio_fast()`
- **THEN** 每个线程使用独立的 `fft_buf`、`mag_buf`、`pad_buf`、`audio_resample_buf`，无数据竞争

#### Scenario: Session 初始化失败时行为不变且状态可查
- **WHEN** ONNX 模型文件不存在或 ORT 初始化失败
- **THEN** `is_available()` 返回 `false`，`infer_pitch_edit_mono()` 返回 `Err`；`get_onnx_status` SHALL 返回 `model_available: false` 并附带失败原因字符串
