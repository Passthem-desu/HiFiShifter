## ADDED Requirements

### Requirement: Timeline change detection
系统必须(SHALL)检测timeline的变化，识别哪些clips被添加、修改或删除。

#### Scenario: Detect new clips
- **WHEN** timeline中出现新的clip_id
- **THEN** 系统必须将该clip标记为需要分析

#### Scenario: Detect modified clips
- **WHEN** 现有clip的缓存键相关参数（trim、playback_rate、source_path）发生变化
- **THEN** 系统必须将该clip标记为需要重新分析

#### Scenario: Detect deleted clips
- **WHEN** timeline中某个clip被删除
- **THEN** 系统必须从分析计划中移除该clip，但保留其缓存条目（用于可能的undo操作）

#### Scenario: Ignore position-only changes
- **WHEN** clip仅修改了start_beat（时间轴位置）而其他参数未变
- **THEN** 系统必须不将该clip标记为需要重新分析

### Requirement: Incremental analysis execution
系统必须(SHALL)仅对变化的clips执行分析，未变化的clips直接复用上次的结果。

#### Scenario: Reuse unchanged clip results
- **WHEN** 执行增量刷新且某个clip的缓存键未变化
- **THEN** 系统必须跳过该clip的分析，直接使用缓存中的音高曲线

#### Scenario: Analyze only changed clips
- **WHEN** timeline有10个clips，其中仅2个被修改
- **THEN** 系统必须仅分析这2个修改的clips，其余8个直接从缓存读取

#### Scenario: Full analysis fallback
- **WHEN** 无法可靠检测timeline变化（例如首次加载工程）
- **THEN** 系统必须执行全量分析，为所有clips生成或更新缓存

### Requirement: Fusion with cached results
系统必须(SHALL)将新分析的结果与缓存的结果合并，生成完整的音高曲线。

#### Scenario: Combine new and cached curves
- **WHEN** 增量分析完成
- **THEN** 系统必须将新分析的clips音高曲线与缓存中的clips音高曲线一起传入融合算法

#### Scenario: Maintain timeline consistency
- **WHEN** 融合新旧音高曲线
- **THEN** 系统必须确保所有clips（新分析和缓存）的时间对齐参数一致（使用当前timeline的BPM和frame_period_ms）

### Requirement: Change tracking persistence
系统必须(SHALL)在内存中维护timeline状态快照，用于下次刷新时的变化比对。

#### Scenario: Store timeline snapshot
- **WHEN** 音高分析任务完成
- **THEN** 系统必须保存当前timeline的clips配置快照（clip_id、缓存键）

#### Scenario: Compare with previous snapshot
- **WHEN** 用户触发新的音高刷新
- **THEN** 系统必须将当前timeline与上次快照对比，生成变化列表

#### Scenario: Snapshot invalidation
- **WHEN** 用户切换到不同的root_track或加载不同的工程
- **THEN** 系统必须清空旧的timeline快照，强制执行全量分析

### Requirement: Progress reporting for incremental analysis
系统必须(SHALL)在增量分析时准确报告进度，区分缓存命中和新分析的工作量。

#### Scenario: Fast progress for cached clips
- **WHEN** 从缓存读取clip音高曲线
- **THEN** 该clip的进度必须立即跳到100%，不占用实际分析时间

#### Scenario: Realistic ETA for incremental refresh
- **WHEN** 10个clips中仅2个需要重新分析
- **THEN** 进度条ETA必须基于这2个clips的预估时间，而非全部10个
