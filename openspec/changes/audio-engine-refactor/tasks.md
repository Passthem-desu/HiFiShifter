# Tasks: Audio Engine Refactor (A–E)

## 1. 方案 E：EngineSnapshot.clips 改为 Arc（types.rs）

- [x] 1.1 修改 `types.rs`：将 `EngineSnapshot.clips` 类型从 `Vec<EngineClip>` 改为 `Arc<Vec<EngineClip>>`
- [x] 1.2 修改 `snapshot.rs`：`build_snapshot` 返回时将 `clips_out` 包装为 `Arc::new(clips_out)`
- [x] 1.3 修改 `snapshot.rs`：`build_snapshot_for_file` 中的 clips 同步改为 `Arc::new(vec![...])`
- [x] 1.4 修改 `snapshot.rs`：`build_snapshot` 内部构建临时 `EngineSnapshot`（用于 base_stream/pitch_stream）时同步改为 `Arc::new(...)`
- [x] 1.5 修改 `engine.rs`：`EngineSnapshot::empty` 调用处确认兼容（如有 `empty` 构造函数，同步修改）
- [x] 1.6 编译验证：`cargo check` 通过，无类型错误

## 2. 方案 A：提取 sample_clip_pcm 消除 mix.rs 代码重复

- [x] 2.1 在 `mix.rs` 中提取内联函数 `sample_clip_pcm(clip: &EngineClip, local: u64, local_adj: f64) -> Option<(f32, f32)>`，包含 stretch_stream fast path 和线性插值 fallback
- [x] 2.2 重构 `mix_snapshot_clips_into_scratch`：用 `sample_clip_pcm` 替换内联的 PCM 采样逻辑（约 80 行），保持 gain/fade 应用逻辑不变
- [x] 2.3 重构 `mix_snapshot_clips_pitch_edited_into_scratch`：用 `sample_clip_pcm` 替换内联的 PCM 采样逻辑（约 80 行），保持 seg buffer、pitch edit、gain/fade 应用逻辑不变
- [x] 2.4 编译验证：`cargo check` 通过
- [x] 2.5 行为验证：对比重构前后两个函数的输出，确认 scratch buffer 内容一致

## 3. 方案 B：stretch_stream worker 提取为独立模块

- [x] 3.1 新建 `audio_engine/stretch_stream.rs`，定义 `pub(crate) fn spawn_stretch_stream(...)` 函数，将 `snapshot.rs` 中 `build_snapshot` 内的 `thread::spawn` 闭包（stretch_stream 部分，约 150 行）迁移至此
- [x] 3.2 `spawn_stretch_stream` 参数：`ring: Arc<StreamRingStereo>`、`src: ResampledStereo`、`src_start: u64`、`src_end: u64`、`playback_rate: f64`、`start_frame: u64`、`length_frames: u64`、`repeat: bool`、`silence_frames: u64`、`out_rate: u32`、`position_frames: Arc<AtomicU64>`、`is_playing: Arc<AtomicBool>`、`epoch: Arc<AtomicU64>`、`my_epoch: u64`
- [x] 3.3 修改 `audio_engine/mod.rs`：添加 `pub(crate) mod stretch_stream;`
- [x] 3.4 修改 `snapshot.rs`：在 stretch_stream 启动处调用 `stretch_stream::spawn_stretch_stream(...)`，删除原内联 `thread::spawn` 闭包
- [x] 3.5 编译验证：`cargo check` 通过
- [x] 3.6 验证 `snapshot.rs` 的 `build_snapshot` 函数不再包含 stretch_stream 相关的 `thread::spawn`

## 4. 方案 C：engine.rs 命令处理函数化

- [x] 4.1 在 `engine.rs` 中定义 `EngineContext` 结构体，持有 Worker 线程所有可变状态的引用（`sr`、`is_playing`、`target`、`base_frames`、`position_frames`、`duration_frames`、`snapshot`、`cache`、`stretch_cache`、`stretch_inflight`、`stretch_tx`、`stretch_stream_epoch`、`resources`、`tx`、`last_timeline`、`last_play_file`）
- [x] 4.2 提取 `fn handle_stop(ctx: &mut EngineContext)`：处理 `EngineCommand::Stop`
- [x] 4.3 提取 `fn handle_seek_sec(ctx: &mut EngineContext, sec: f64)`：处理 `EngineCommand::SeekSec`
- [x] 4.4 提取 `fn handle_set_playing(ctx: &mut EngineContext, playing: bool, target: Option<String>)`：处理 `EngineCommand::SetPlaying`
- [x] 4.5 提取 `fn handle_update_timeline(ctx: &mut EngineContext, tl: TimelineState)`：处理 `EngineCommand::UpdateTimeline`（含 PCM 预请求、stretch 调度、pitch 调度、build_snapshot）
- [x] 4.6 提取 `fn handle_stretch_ready(ctx: &mut EngineContext, key: StretchKey)`：处理 `EngineCommand::StretchReady`
- [x] 4.7 提取 `fn handle_clip_pitch_ready(ctx: &mut EngineContext, clip_id: String)`：处理 `EngineCommand::ClipPitchReady`
- [x] 4.8 提取 `fn handle_audio_ready(ctx: &mut EngineContext)`：处理 `EngineCommand::AudioReady`
- [x] 4.9 提取 `fn handle_play_file(ctx: &mut EngineContext, path: PathBuf, offset_sec: f64, target: String)`：处理 `EngineCommand::PlayFile`
- [x] 4.10 重构 Worker 循环：每个 `match` 分支只调用对应的 handle 函数
- [x] 4.11 编译验证：`cargo check` 通过，借用检查无误

## 5. 方案 D：per-clip epoch cancel 细化

- [x] 5.1 修改 `engine.rs`：在 Worker 状态中添加 `clip_stretch_epochs: HashMap<String, Arc<AtomicU64>>`
- [x] 5.2 修改 `EngineContext`（或 `handle_update_timeline` 参数）：传入 `clip_stretch_epochs` 的可变引用
- [x] 5.3 实现 `fn clip_stretch_params_changed(old: &Clip, new: &Clip) -> bool`：比较 `playback_rate`、`trim_start_beat`、`trim_end_beat`
- [x] 5.4 修改 `handle_update_timeline`：遍历新 timeline 的 clips，对参数变化的 clip 递增其 per-clip epoch；清理已删除 clip 的 epoch
- [x] 5.5 修改 `build_snapshot` 签名：新增 `clip_stretch_epochs: &HashMap<String, Arc<AtomicU64>>` 参数
- [x] 5.6 修改 `build_snapshot` 内部：为每个 clip 的 `spawn_stretch_stream` 传入 per-clip epoch（从 `clip_stretch_epochs` 取，不存则用全局 epoch 兆底）
- [x] 5.7 修改 `stretch_stream::spawn_stretch_stream`：接收 per-clip epoch 参数（已在方案 B 中定义，此处确认参数类型正确）
- [x] 5.8 编译验证：`cargo check` 通过
- [x] 5.9 行为验证：手动测试拖动非 stretch 参数（gain/fade）时，stretch_stream worker 不被打断（可通过日志或 stats 观察）