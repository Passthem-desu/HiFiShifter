## ADDED Requirements

### Requirement: Aggregate progress calculation
系统必须(SHALL)基于所有clips的总工作量计算整体进度百分比，而非单个clip进度。

#### Scenario: Weighted progress by audio duration
- **WHEN** 计算整体进度
- **THEN** 系统必须基于每个clip的音频时长进行加权，长音频clips占更高权重

#### Scenario: Cache hit reduces workload
- **WHEN** 某个clip从缓存读取
- **THEN** 该clip在工作量计算中必须贡献极小权重（例如1%正常分析时间）

#### Scenario: Progress updates reflect true completion
- **WHEN** 10个clips中8个已完成，2个正在分析
- **THEN** 整体进度必须显示80%基础进度 + 正在分析clips的部分进度

### Requirement: Real-time progress updates
系统必须(SHALL)以合理频率更新进度，避免UI卡顿或过度刷新。

#### Scenario: Update frequency at least 1Hz
- **WHEN** 音高分析正在进行
- **THEN** 系统必须至少每秒更新一次整体进度

#### Scenario: Throttle individual clip updates
- **WHEN** 单个clip报告内部进度（例如WORLD分析的帧级进度）
- **THEN** 系统必须节流这些更新，避免每秒超过10次整体进度计算

#### Scenario: Final progress 100% on completion
- **WHEN** 所有clips分析完成且融合结束
- **THEN** 系统必须确保最终进度报告为100%

### Requirement: ETA estimation
系统必须(SHALL)提供剩余时间估算(ETA)，帮助用户预估等待时长。

#### Scenario: ETA based on average speed
- **WHEN** 已经完成部分clips的分析
- **THEN** 系统必须根据已完成clips的平均速度（秒/clip或秒/音频秒）估算剩余时间

#### Scenario: ETA adjusts dynamically
- **WHEN** 实际分析速度变化（例如遇到更复杂的音频）
- **THEN** 系统必须每10秒重新计算ETA，使用滑动窗口平均速度

#### Scenario: ETA excludes cached clips
- **WHEN** 部分clips从缓存读取
- **THEN** ETA计算必须仅基于需要实际分析的clips，不包含缓存命中的

### Requirement: Progress event payload
系统必须(SHALL)发送包含详细信息的进度事件到前端。

#### Scenario: Progress event includes percentage
- **WHEN** 发送进度事件
- **THEN** 事件必须包含progress字段（0.0-1.0浮点数）

#### Scenario: Progress event includes ETA
- **WHEN** 发送进度事件且ETA可计算
- **THEN** 事件必须包含eta_seconds字段（预估剩余秒数）

#### Scenario: Progress event includes stage info
- **WHEN** 发送进度事件
- **THEN** 事件可选包含当前阶段信息（例如"Analyzing clip 3/10"）

### Requirement: Thread-safe progress aggregation
系统必须(SHALL)确保多线程环境下的进度更新安全和一致性。

#### Scenario: Atomic progress updates
- **WHEN** 多个工作线程同时更新各自的clip进度
- **THEN** 系统必须使用原子操作或互斥锁保护共享的进度状态

#### Scenario: No progress regression
- **WHEN** 进度更新发生竞争
- **THEN** 系统必须确保整体进度百分比单调递增，不出现倒退

### Requirement: Cancellation-aware progress
系统必须(SHALL)在任务取消时停止进度更新。

#### Scenario: Stop progress on cancellation
- **WHEN** 用户取消音高分析任务
- **THEN** 系统必须停止发送进度事件，不发送取消后的进度

#### Scenario: Final cancelled event
- **WHEN** 任务被取消
- **THEN** 系统必须发送一个明确的"任务已取消"事件，而非进度100%

### Requirement: Progress granularity
系统必须(SHALL)提供合理的进度粒度，避免长时间停留在同一百分比。

#### Scenario: Minimum progress increment 1%
- **WHEN** 单个clip的分析进度更新
- **THEN** 仅当整体进度变化超过1%时才发送新的进度事件

#### Scenario: Long clips report intermediate progress
- **WHEN** 单个clip的分析时间超过5秒
- **THEN** 该clip必须报告内部阶段进度（例如F0分析进度），避免前端长时间无响应
