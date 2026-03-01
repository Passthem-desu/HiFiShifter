## 1. 依赖与数据结构准备

- [x] 1.1 在 `backend/src-tauri/Cargo.toml` 中添加 `rayon = "1"` 依赖（非 optional）
- [x] 1.2 在 `backend/src-tauri/src/state.rs` 的 `AppState` 中添加 `clip_pitch_cache: Mutex<HashMap<String, Vec<f32>>>` 字段并完成初始化
- [x] 1.3 在 `AppState::new()` 中初始化 `clip_pitch_cache` 为空 HashMap

## 2. ONNX 可用性上报（后端）

- [x] 2.1 在 `nsf_hifigan_onnx_stub.rs` 中添加 `pub fn compiled() -> bool { false }` 和 `pub fn model_load_error() -> Option<String> { Some("onnx feature not compiled".to_string()) }` 函数
- [x] 2.2 在 `nsf_hifigan_onnx.rs` 中添加 `pub fn compiled() -> bool { true }` 并添加 `pub fn model_load_error() -> Option<String>` — 返回全局 Session 初始化的错误信息或 None
- [x] 2.3 在 `src/commands.rs`（或新建 `src/commands/onnx_status.rs`）中添加 `#[tauri::command] fn get_onnx_status()` — 返回 `{ compiled, model_available, ep_choice, error_message }` 的 serde Serialize 结构体
- [x] 2.4 在 `lib.rs` 的 `generate_handler!` 宏中注册 `get_onnx_status` command

## 3. ONNX 播放层回退修复（后端）

- [x] 3.1 在 `pitch_editing.rs` 的 `PitchEditAlgorithm::from_track_algo` 中移除 ONNX 回退逻辑（保持 ONNX 选择）
- [x] 3.2 在 `audio_engine/pitch_stream_onnx.rs` 中移除 hard-start 自动回退逻辑（保持阻塞等待）
- [x] 3.4 在 `commands/playback.rs` 中：当选择 ONNX 且不可用时，播放返回错误并不启动

## 4. 前端 ONNX 状态展示

- [x] 4.1 在前端参数面板 Algo 选择器组件（位于 `frontend/src/features/` 或 `components/` 的 param panel 相关文件）中，于 `useEffect` / 初始化时调用 `invoke("get_onnx_status")` 并将结果存入组件 state
- [x] 4.2 当 `model_available === false` 时，在 `NSF-HiFiGAN (ONNX)` 选项文案后追加 ` (unavailable)` 标记并应用警告色（`text-yellow-400` 或类似 Tailwind class）
- [x] 4.3 当 `compiled === false` 时额外在选项 tooltip 中显示" 需使用 --features onnx 编译"提示

## 5. 音高分析性能优化（per-clip 缓存）

- [x] 5.1 在 `pitch_analysis.rs` 中新增 `clip_cache_key(clip: &Clip, in_rate: u32, frame_period_ms: f64) -> String` 函数，使用 blake3 对文件签名 + trim + playback_rate + in_rate + fp_ms 做哈希
- [x] 5.2 在 `compute_pitch_curve` 的 per-clip 循环开始处，尝试从 `state.clip_pitch_cache` 命中缓存；命中则跳过解码+分析，直接使用缓存的 MIDI curve
- [x] 5.3 未命中时，分析完成后将结果写入 `state.clip_pitch_cache`
- [x] 5.4 将 `compute_pitch_curve` 中 `clip` 循环改为 `rayon::par_iter()`，收集结果为 `Vec<Option<ClipPitch>>`，汇总后进入融合阶段
- [x] 5.5 在 per-clip 解码后，若 `src_i1 - src_i0` 对应时长超过 `HIFISHIFTER_PITCH_MAX_SEGMENT_SEC`（默认 60），截断 `src_i1` 并补零
- [x] 5.6 读取 `HIFISHIFTER_PITCH_PARALLEL_CLIPS` 环境变量，若设置则限制 Rayon 本地线程池并发度（通过 `rayon::ThreadPoolBuilder`）

## 6. 验证与收尾

- [x] 6.1 `cargo check` 和 `cargo check --features onnx` 均通过，无新 warning

_注：修复了 ort 2.0 中 Session::run() 需要 &mut self 的问题，将 Arc<Session> 改为 Arc<Mutex<Session>>；解决了 infer_from_audio_and_midi 中的借用冲突。编译通过，只有 6-8 个已存在的 warning。_
