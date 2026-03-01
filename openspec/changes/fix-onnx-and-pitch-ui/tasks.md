## 1. ONNX 诊断系统

- [x] 1.1 在 `nsf_hifigan_onnx.rs` 中添加 `OnnxDiagnosticInfo` 结构体（字段：is_available, error_details, ep_status, model_path, ort_library_loaded）
- [x] 1.2 实现 `diagnose_onnx_availability()` 函数，检查模型文件存在性、ORT 库加载、EP 可用性、session 创建
- [x] 1.3 在 stub 模块 `nsf_hifigan_onnx_stub.rs` 中添加对应的空实现，返回 "ONNX feature not compiled"
- [x] 1.4 创建新命令 `commands/onnx_diagnostics.rs`，暴露 `get_onnx_diagnostic_info()` Tauri 命令
- [x] 1.5 在应用启动时调用诊断函数，将结果缓存到 `AppState.onnx_diagnostic_cache: Arc<RwLock<OnnxDiagnosticInfo>>`
- [x] 1.6 在 ONNX 加载失败时记录详细日志（模型路径、EP 尝试顺序、错误代码）
- [x] 1.7 在前端 `types/api.ts` 中定义 `OnnxDiagnosticResult` 接口
- [x] 1.8 在 `services/coreApi.ts` 中添加 `getOnnxDiagnostic()` 方法
- [x] 1.9 在 `PianoRollPanel.tsx` 或算法选择器组件中调用诊断 API，ONNX 不可用时显示警告 Badge
- [x] 1.10 为 ONNX 警告 Badge 添加 Tooltip，显示 error_details 和修复建议（如 "Run cargo tauri dev --features onnx"）

## 2. 时间区间缓存优化

- [x] 2.1 在 `pitch_analysis.rs` 中修改缓存键计算函数，从 `clip.id` 改为 `compute_range_cache_key(track_id, start_time, end_time)`
- [x] 2.2 实现 `compute_range_cache_key()` 函数，使用 Blake3 哈希 `format!("{}-{}-{}", track_id, start_ms, end_ms)`
- [x] 2.3 添加 `fuzzy_cache_lookup()` 函数，支持 ±10ms 边界容差匹配
- [x] 2.4 在 `AppState` 中添加 `range_cache_enabled: bool` 配置开关（默认 true，可通过环境变量禁用）
- [x] 2.5 修改 `compute_pitch_curve()` 函数，检测重叠区间时先查询缓存再分析
- [x] 2.6 实现部分重叠的缓存段合并逻辑（从缓存提取已有部分，仅分析新区间）
- [x] 2.7 添加缓存段边界的 crossfade 处理，避免拼接时的相位跳变

## 3. 音高分析进度报告

- [x] 3.1 在 `AppState` 中添加 `pitch_analysis_progress: Arc<RwLock<Option<PitchProgressState>>>` 字段
- [x] 3.2 定义 `PitchProgressState` 结构体（字段：total_clips, completed_clips, current_task, start_time）
- [x] 3.3 在 `pitch_analysis.rs` 中，分析开始时初始化进度状态（设置 total_clips 和 start_time）
- [x] 3.4 在每个 clip 分析完成后更新 `completed_clips` 和 `current_task`（显示 clip 名称或文件名）
- [x] 3.5 在分析完成或失败时清空进度状态（设为 None）
- [x] 3.6 创建新命令 `commands/pitch_progress.rs`，暴露 `get_pitch_analysis_progress()` 返回当前进度
- [x] 3.7 在前端 `types/api.ts` 中定义 `PitchProgressPayload` 接口（字段：total, completed, currentTask, elapsedMs, estimatedRemainingMs）
- [x] 3.8 在 `services/coreApi.ts` 中添加 `getPitchAnalysisProgress()` 方法
- [x] 3.9 创建新组件 `components/PitchAnalysisProgressBar.tsx`，轮询后端每 500ms，显示进度条和百分比
- [x] 3.10 在进度组件中计算并显示预计剩余时间（基于已处理 clip 的平均耗时）
- [x] 3.11 在参数编辑面板中集成进度条组件，检测到分析任务时自动显示
- [x] 3.12 添加进度条淡出动画，分析完成后 1 秒后自动隐藏

## 4. VAD 性能优化

- [x] 4.1 在 `pitch_analysis.rs` 中实现 `detect_voice_segments(audio: &[f32], rms_threshold: f32) -> Vec<(usize, usize)>` 函数
- [x] 4.2 在 VAD 函数中使用滑动窗口计算 RMS，标记超过阈值的区间为有声段
- [x] 4.3 合并距离 < 50ms 的相邻有声段，避免过度碎片化
- [x] 4.4 在 F0 提取前调用 VAD，仅对有声段执行 WORLD Harvest/Dio
- [x] 4.5 为静音段填充默认 F0 值（0 或 NaN），保持时间轴对齐
- [x] 4.6 添加配置项 `vad_rms_threshold`（默认 0.02），通过环境变量可调整
- [x] 4.7 添加性能日志，记录 VAD 跳过的静音时长占比

## 5. 国际化和文案

- [x] 5.1 在 `assets/lang/zh_CN.json` 中添加进度相关文案（"正在分析音高", "已处理 X/Y 片段", "预计剩余时间"）
- [x] 5.2 在 `assets/lang/en_US.json` 中添加对应英文文案
- [x] 5.3 添加 ONNX 诊断错误提示文案（"ONNX 不可用", "模型文件缺失", "编译时未启用 ONNX 特性"）
- [x] 5.4 为 ONNX 修复建议添加文案（"请使用 --features onnx 重新编译"）

## 6. 集成和文档

- [x] 6.1 更新 README.md 用户手册，说明 ONNX 编译选项和诊断功能
- [x] 6.2 更新 DEVELOPMENT.md 开发文档，记录缓存优化策略和进度系统架构
