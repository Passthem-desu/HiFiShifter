## ADDED Requirements

### Requirement: Parallel clip analysis
系统必须(SHALL)支持并行处理多个clips的音高分析，充分利用多核CPU资源。

#### Scenario: Concurrent clip processing
- **WHEN** 执行包含N个clips的音高分析任务
- **THEN** 系统必须使用线程池并发处理多个clips，而非串行逐个处理

#### Scenario: Independent clip analysis
- **WHEN** 分析一个clip时发生错误
- **THEN** 系统必须隔离该错误，不影响其他clips的并行分析

#### Scenario: Thread pool size configuration
- **WHEN** 初始化并行分析引擎
- **THEN** 系统必须自动检测CPU核心数并配置合理的线程池大小（建议核心数-1或核心数）

### Requirement: Progress aggregation
系统必须(SHALL)聚合所有并行任务的进度，呈现整体进度百分比。

#### Scenario: Weighted progress calculation
- **WHEN** 计算整体进度
- **THEN** 系统必须基于每个clip的预估工作量（音频时长）进行加权平均计算

#### Scenario: Real-time progress updates
- **WHEN** 任意clip的分析进度更新
- **THEN** 系统必须重新计算并报告整体进度，刷新频率不低于每秒1次

#### Scenario: Completed clips contribute 100%
- **WHEN** 某个clip分析完成
- **THEN** 该clip在整体进度计算中必须贡献其全部权重

### Requirement: Load balancing
系统必须(SHALL)智能分配clips到工作线程，避免负载不均衡。

#### Scenario: Sort clips by estimated workload
- **WHEN** 开始并行分析任务
- **THEN** 系统必须按预估工作量（音频时长 × 未缓存标志）降序排序clips，优先分配大任务

#### Scenario: Dynamic task stealing
- **WHEN** 某个工作线程空闲而其他线程仍有待处理任务
- **THEN** 空闲线程必须从待处理队列中取出新任务继续执行

### Requirement: Error handling and partial results
系统必须(SHALL)在部分clips分析失败时，仍返回成功clips的结果。

#### Scenario: Partial success returns valid curves
- **WHEN** 10个clips中有2个分析失败
- **THEN** 系统必须返回8个成功clips的音高曲线，并在融合阶段跳过失败的clips

#### Scenario: Error reporting per clip
- **WHEN** clip分析失败
- **THEN** 系统必须记录该clip的错误信息（clip_id、错误原因），并在任务完成后汇总报告

#### Scenario: Critical failure threshold
- **WHEN** 失败clips数量超过总数的50%
- **THEN** 系统必须将整个任务标记为失败状态并报告给用户

### Requirement: Cancellation support
系统必须(SHALL)支持取消正在进行的并行分析任务。

#### Scenario: Graceful cancellation
- **WHEN** 用户请求取消音高分析任务
- **THEN** 系统必须停止所有待处理的clip任务，等待当前正在执行的任务完成，然后清理资源

#### Scenario: Cancellation within 1 second
- **WHEN** 用户请求取消
- **THEN** 系统必须在1秒内响应取消请求并停止进度报告

### Requirement: Resource cleanup
系统必须(SHALL)在任务完成或取消后正确清理所有资源。

#### Scenario: Thread pool shutdown
- **WHEN** 音高分析任务完成（成功或失败）
- **THEN** 系统必须优雅地关闭线程池或将线程归还给全局池

#### Scenario: Memory release
- **WHEN** 临时分析数据（解码的PCM、中间F0曲线）不再需要
- **THEN** 系统必须及时释放内存，避免峰值内存过高
