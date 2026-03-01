# Tasks: Pitch Analysis Performance Optimization

## 1. 配置系统与数据结构 (Configuration System)

- [ ] 1.1 在 `backend/src-tauri/src/pitch_config.rs` 中添加 `analysis_sr: u32` 字段到 `PitchAnalysisConfig`
- [ ] 1.2 在 `global()` 中读取 `HIFISHIFTER_PITCH_ANALYSIS_SR` 环境变量，默认值 16000，范围限制 8000-44100
- [ ] 1.3 添加 `chunk_sec: f64` 字段，读取 `HIFISHIFTER_PITCH_CHUNK_SEC`，默认 30.0
- [ ] 1.4 添加 `chunk_ctx_sec: f64` 字段，读取 `HIFISHIFTER_PITCH_CHUNK_CTX_SEC`，默认 0.3
- [ ] 1.5 添加 `max_segment_sec: f64` 字段，读取 `HIFISHIFTER_PITCH_MAX_SEGMENT_SEC`，默认 60.0
- [ ] 1.6 将 `silence_rms_threshold` 重命名为 `vad_rms_threshold`，环境变量改为 `HIFISHIFTER_VAD_RMS_THRESHOLD`，默认值改为 0.02
- [ ] 1.7 添加 `vad_merge_gap_ms: f64` 字段，读取 `HIFISHIFTER_VAD_MERGE_GAP_MS`，默认 50.0

## 2. VAD 声音活动检测 (Voice Activity Detection)

- [ ] 2.1 在 `pitch_config.rs` 中实现 `classify_voiced_ranges(audio: &[f32], rms_threshold: f32, sr: u32) -> Vec<Range<usize>>` 函数
- [ ] 2.2 使用 50ms 非重叠窗口计算 RMS，返回 RMS ≥ threshold 的样本区间列表
- [ ] 2.3 在 `pitch_config.rs` 中实现 `merge_adjacent_voiced_ranges(ranges: Vec<Range<usize>>, merge_gap_samples: usize) -> Vec<Range<usize>>` 函数
- [ ] 2.4 合并相邻区间，如果间隔 ≤ merge_gap_samples（由 vad_merge_gap_ms 换算）
- [ ] 2.5 添加 debug 日志输出：voiced_pct、skip_pct（跳过的静音百分比）

## 3. 音频重采样管道 (Resampling Pipeline)

- [ ] 3.1 在 `pitch_analysis.rs` 的 `compute_pitch_curve` 中，解码后添加重采样步骤：将 PCM 从 project SR 降采样到 `config.analysis_sr`
- [ ] 3.2 使用现有的 `rubato` crate 或 `symphonia` 重采样功能（检查 codebase 中已有实现）
- [ ] 3.3 确保单声道 downmix 在重采样之前完成（避免重采样立体声浪费）
- [ ] 3.4 验证重采样后 PCM 长度正确：`new_len = (old_len * analysis_sr / old_sr)`

## 4. 分块处理与上下文填充 (Chunked Processing)

- [ ] 4.1 在 `pitch_config.rs` 中实现 `split_into_chunks(range: Range<usize>, chunk_samples: usize) -> Vec<Range<usize>>` 函数
- [ ] 4.2 将输入区间按 chunk_samples 大小分割，最后一个 chunk 可能小于标准大小
- [ ] 4.3 实现 `extend_with_context(range: Range<usize>, ctx_samples: usize, total_len: usize) -> Range<usize>` 函数
- [ ] 4.4 在原 range 两侧扩展 ctx_samples，边界处截断到 [0, total_len)
- [ ] 4.5 实现 `trim_context_from_f0(f0: &[f64], ctx_frames: usize) -> Vec<f64>` 辅助函数
- [ ] 4.6 从 F0 结果中移除两侧 ctx_frames，仅保留核心区域

## 5. 交叉淡化合并 (Crossfade Merging)

- [ ] 5.1 在 `pitch_config.rs` 中实现 `apply_crossfade(target: &mut [f64], source: &[f64], crossfade_frames: usize, start_idx: usize)` 函数
- [ ] 5.2 在 start_idx 位置的前 crossfade_frames 区域进行线性混合：`target[i] = target[i] * (1-t) + source[i] * t`，其中 `t = i / crossfade_frames`
- [ ] 5.3 crossfade_frames 之后的部分直接覆盖写入
- [ ] 5.4 处理边界情况：第一个 chunk（无前向淡化）、最后一个 chunk（无后向淡化）

## 6. 集成 VAD 和分块到主分析流程 (Integration)

- [ ] 6.1 修改 `pitch_analysis.rs` 中的 per-clip 分析循环：在调用 WORLD 前，先对重采样后的 PCM 运行 VAD
- [ ] 6.2 获取 voiced_ranges 后调用 merge_adjacent_voiced_ranges 合并
- [ ] 6.3 为每个 voiced_range 检查长度是否超过 `max_segment_sec * analysis_sr`，超过则截断并 warning
- [ ] 6.4 对每个 voiced_range，调用 split_into_chunks 分块（如果 range 长度 > chunk_samples）
- [ ] 6.5 对每个 chunk：调用 extend_with_context 添加上下文 → 调用 WORLD Harvest → trim_context_from_f0 提取核心 F0 → apply_crossfade 写入结果
- [ ] 6.6 对 unvoiced ranges：填充 `f0 = 0.0` 到输出 Vec
- [ ] 6.7 确保最终 F0 Vec 长度与时间轴帧数一致

## 7. 进度报告优化 (Progress Reporting)

- [ ] 7.1 在分析开始时，遍历所有 clips 和 voiced_ranges，估算总 chunk 数量：`total_chunks = sum(clip.voiced_ranges.map(|r| estimate_chunks(r)))`
- [ ] 7.2 在每个 chunk 处理完成后调用 progress_callback，传入 `(completed_chunks, total_chunks)`
- [ ] 7.3 修改前端 `PitchAnalysisProgressBar.tsx` 或后端 `PitchProgressState` 以支持更细粒度的进度（已支持，无需修改）
- [ ] 7.4 验证长文件（5 分钟+）的进度更新频率：应该每 3-5 秒更新一次，而不是停留在 0%

## 8. 并行处理支持（可选，暂不实现）

- [ ] 8.1 读取 `HIFISHIFTER_PITCH_PARALLEL_CLIPS` 环境变量
- [ ] 8.2 如果设置，使用 `rayon::ThreadPoolBuilder` 创建有限线程池
- [ ] 8.3 将 per-clip 循环改为 `rayon::par_iter()`
- [ ] 8.4 处理并发下的 progress_callback（使用 AtomicUsize 或 Mutex）

_注：8.1-8.4 标记为可选，当前 MVP 保持串行处理_

## 9. 测试与验证 (Testing)

- [ ] 9.1 创建单元测试：`test_classify_voiced_ranges` 验证 VAD 正确分类有声/无声
- [ ] 9.2 创建单元测试：`test_merge_adjacent_voiced_ranges` 验证间隔合并逻辑
- [ ] 9.3 创建单元测试：`test_split_into_chunks` 验证分块算法
- [ ] 9.4 创建单元测试：`test_crossfade_merge` 验证淡化合并无跳变
- [ ] 9.5 创建集成测试：对比 1 分钟短音频在 16k 和 44.1k 分析结果，median pitch error <0.5 cents
- [ ] 9.6 性能基准测试：分析 1min、5min、10min 测试文件，记录耗时，验证 5x+ 加速

## 10. 文档更新 (Documentation)

- [ ] 10.1 更新 `README.md`：在"音高分析"章节添加性能优化说明（降采样、分块、VAD）
- [ ] 10.2 在 `DEVELOPMENT.md` 的环境变量表中添加新变量：`HIFISHIFTER_PITCH_ANALYSIS_SR`、`HIFISHIFTER_VAD_RMS_THRESHOLD`、`HIFISHIFTER_VAD_MERGE_GAP_MS`、`HIFISHIFTER_PITCH_CHUNK_SEC`、`HIFISHIFTER_PITCH_CHUNK_CTX_SEC`、`HIFISHIFTER_PITCH_MAX_SEGMENT_SEC`
- [ ] 10.3 添加性能优化章节到 `DEVELOPMENT.md`：解释分析流程（resample → VAD → chunk → WORLD → merge）
- [ ] 10.4 在 `DEVELOPMENT.md` 中记录典型性能数据（1min: 0.8s, 5min: 3.2s, 10min: 6.1s）
