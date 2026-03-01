## Context

**当前状态**:
- ONNX HiFiGAN vocoder 作为可选特性编译（`--features onnx`），运行时可能因模型路径错误、依赖缺失、EP 配置失败导致不可用
- 音高检测使用 WORLD vocoder（Harvest/Dio），当多个 clip 在时间轴上重叠时，缓存键计算基于 clip ID，可能导致相同音频区域被重复分析
- 检测过程在后端同步执行，前端无法获知进度，长文件分析时用户体验差
- 现有 `pitch_analysis.rs` 已有 per-clip 缓存和并行处理，但缺少边界优化和进度报告

**技术约束**:
- Tauri IPC 通信机制（命令式调用为主，事件推送为辅）
- WORLD 库为外部 DLL，F0 提取为 CPU 密集型操作
- React 前端使用 Redux Toolkit 状态管理
- ONNX Runtime 支持多种 EP（CPU/CUDA/DirectML）

## Goals / Non-Goals

**Goals:**
- 诊断 ONNX 不可用的根因，提供清晰错误信息和修复建议
- 优化重叠 clip 的音高检测，避免冗余计算，提升整体速度
- 前端展示实时进度（已处理/总数、预计时间），提升长文件编辑体验
- 保持向后兼容，不破坏现有音高编辑功能

**Non-Goals:**
- 不替换 WORLD vocoder（性能优化限于算法层面，不引入新依赖如 Crepe/PYIN）
- 不重构整个音高编辑架构（局部改进为主）
- 不处理 ONNX 模型本身的质量问题（假设模型文件正常）

## Decisions

### 1. ONNX 诊断策略：启动时主动检查 + 详细错误日志

**决策**: 在 `nsf_hifigan_onnx.rs` 中添加 `diagnose()` 函数，检查：
- 模型文件是否存在（路径解析正确性）
- ONNX Runtime 库是否可加载
- 执行提供器是否成功注册（EP 回退链：CUDA → DirectML → CPU）
- 模型 session 创建是否成功

将结果通过新增 `get_onnx_diagnostic_info` 命令暴露给前端，在 UI 中显示具体失败原因（如 "Model file not found at xxx" 或 "CUDA EP unavailable, CPU fallback failed"）。

**备选方案**: 静默降级到 WORLD，隐藏 ONNX 选项。
**拒绝理由**: 用户无法知晓高质量功能可用但未启用，且无法主动修复问题。

### 2. 重叠 Clip 处理：基于时间区间的去重缓存

**决策**: 在 `pitch_analysis.rs` 中改进缓存键计算：
- 当前使用 `clip.id` 作为缓存键，重叠 clip 仍会重复分析相同音频
- 改为 `(track_id, time_range_hash)` 组合键，相同音轨相同时间区间共享缓存
- 引入区间合并逻辑：检测重叠时，先查询是否已有覆盖该区间的缓存条目

**实现细节**:
```rust
// 伪代码
fn compute_cache_key(clip: &Clip) -> String {
    let time_range = (clip.start_time, clip.end_time);
    let range_hash = blake3::hash(format!("{}-{}", time_range.0, time_range.1));
    format!("{}:{}", clip.track_id, range_hash)
}
```

**备选方案**: 按采样点范围拆分为固定大小块（如 1 秒块）。
**拒绝理由**: 增加缓存管理复杂度，且 clip 边界对齐更符合用户操作习惯。

### 3. 进度报告机制：共享状态 + 轮询查询

**决策**: 
- 后端在 `AppState` 中添加 `pitch_analysis_progress: Arc<RwLock<ProgressState>>` 
- `ProgressState` 包含 `{total_clips, processed_clips, current_clip_name, estimated_remaining_ms}`
- 前端通过 `get_pitch_analysis_progress` 命令每 500ms 轮询一次

**实现**:
```rust
pub struct PitchProgressState {
    pub total: usize,
    pub completed: usize,
    pub current_task: Option<String>,
    pub start_time: Instant,
}

#[tauri::command]
fn get_pitch_progress(state: State<AppState>) -> Option<PitchProgressState> {
    state.pitch_progress.read().unwrap().clone()
}
```

**备选方案**: 使用 Tauri Event 推送进度更新。
**拒绝理由**: 需要建立事件监听器管理，轮询对于 0.5-2 秒级更新频率足够高效，且实现更简单。

### 4. 性能优化方向：增加并行度 + VAD 预过滤

**决策**:
- 当前 `rayon::par_iter()` 已启用并行解码，但 WORLD F0 提取仍为串行
- 在 F0 提取前增加 VAD（Voice Activity Detection）预处理，跳过静音段
- 将长 clip 拆分为多个独立段并行分析，最后拼接结果

**VAD 实现**:
```rust
fn detect_voice_segments(audio: &[f32]) -> Vec<(usize, usize)> {
    // 简单 RMS 阈值法
    let rms_threshold = 0.02;
    // 返回 [(start_sample, end_sample), ...]
}
```

**备选方案**: 引入 GPU 加速 F0 提取（CUDA kernels）。
**拒绝理由**: 开发复杂度高，且 WORLD 库无 GPU 版本，需重新实现算法。

## Risks / Trade-offs

### Risk 1: 时间区间哈希缓存在微调 clip 边界时失效
- **场景**: 用户轻微拖动 clip 边界，导致 `(start, end)` 改变，缓存未命中
- **缓解**: 引入 "fuzzy match" 逻辑，允许 ±10ms 的边界容差仍命中缓存
- **Trade-off**: 增加缓存查询复杂度（需遍历现有条目检查重叠）

### Risk 2: 轮询进度可能导致前端性能开销
- **场景**: 多个组件同时轮询，或轮询间隔过短
- **缓解**: 单例轮询策略（全局仅一个定时器），间隔 >= 500ms
- **Trade-off**: 进度更新略有延迟（最多 0.5 秒），但不影响实际体验

### Risk 3: VAD 预过滤可能漏掉轻柔音符
- **场景**: 极低音量的音符被误判为静音跳过
- **缓解**: 设置保守的 RMS 阈值（0.02），并保留段间 50ms 上下文
- **Trade-off**: 性能提升幅度低于理想情况（需分析更多段）

### Risk 4: ONNX 诊断信息可能因路径差异在不同环境下不准确
- **场景**: 开发环境路径 vs 打包后相对路径
- **缓解**: 使用 Tauri 资源解析 API 获取规范化路径，日志记录完整路径
- **Trade-off**: 错误信息可能暴露内部路径结构

## Migration Plan

**部署步骤**:
1. 后端添加进度状态和诊断命令（保持旧命令兼容）
2. 前端添加进度条 UI，默认隐藏（检测到分析任务时显示）
3. 逐步灰度启用新缓存策略（通过配置开关）

**回滚策略**:
- 如缓存逻辑出现问题，可通过环境变量 `DISABLE_RANGE_CACHE=1` 回退到 clip ID 缓存
- 进度轮询失败不影响核心功能，仅导致进度条不显示

**验证计划**:
- 单元测试覆盖缓存键计算逻辑（重叠场景）
- 手动测试 ONNX 诊断信息准确性（有/无模型文件、不同 EP 配置）
- 性能基准：10 个 30 秒 clip，50% 重叠，对比优化前后总检测时长

## Open Questions

1. **VAD 阈值是否需要用户可配置？** 当前硬编码 0.02，不同录音音量可能需要调整。
2. **进度状态是否需要持久化？** 重启应用后进度丢失，是否需要恢复中断的分析任务？
3. **ONNX 诊断是否应自动尝试修复？** 如自动下载缺失的 EP 库，或重新生成模型索引。
