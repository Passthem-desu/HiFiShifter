## ADDED Requirements

### Requirement: Spatial optimization
系统必须(SHALL)仅对有clip覆盖的时间区域执行winner-take-most算法，跳过空白区域。

#### Scenario: Identify covered time ranges
- **WHEN** 执行融合算法
- **THEN** 系统必须预先计算所有clips的时间覆盖范围，生成区间列表

#### Scenario: Skip empty frames
- **WHEN** 某个timeline帧不在任何clip的覆盖范围内
- **THEN** 系统必须直接将该帧的输出设为0.0，不执行weight计算和比较

#### Scenario: Process only overlapping frames
- **WHEN** 某个timeline帧有多个clips覆盖
- **THEN** 系统必须仅对这些覆盖的clips执行weight计算和winner-take-most选择

### Requirement: Efficient interval query
系统必须(SHALL)使用高效的数据结构查询某个时间点被哪些clips覆盖。

#### Scenario: Interval tree or sorted list
- **WHEN** 初始化融合算法
- **THEN** 系统必须使用区间树或排序后的区间列表，支持O(log N)或O(N)复杂度的查询

#### Scenario: Fast skip for empty regions
- **WHEN** 遍历timeline帧时遇到大段空白区域
- **THEN** 系统必须批量跳过这些帧，而非逐帧判断

### Requirement: Winner-take-most with hysteresis
系统必须(SHALL)保持现有的winner-take-most算法逻辑，包括滞后(hysteresis)机制。

#### Scenario: Weight-based clip selection
- **WHEN** 计算某帧的音高值
- **THEN** 系统必须选择weight最高的clip作为winner，其音高值作为输出

#### Scenario: Hysteresis prevents jitter
- **WHEN** 当前帧的winner与前一帧不同
- **THEN** 系统必须仅在新winner的weight超过旧winner的1.1倍时才切换（滞后比例1.10）

#### Scenario: Weight calculation includes fades
- **WHEN** 计算clip的weight
- **THEN** 系统必须考虑fade-in、fade-out、track gain和clip局部位置

### Requirement: Performance target
系统必须(SHALL)将融合阶段的耗时控制在合理范围内。

#### Scenario: Fusion completes within 100ms
- **WHEN** 执行10个clips覆盖1000帧的融合任务
- **THEN** 融合阶段必须在100毫秒内完成（不包括clip分析时间）

#### Scenario: Linear time complexity with covered frames
- **WHEN** 增加timeline帧数但clips覆盖率不变
- **THEN** 融合时间必须与实际覆盖的帧数成线性关系，而非总帧数

### Requirement: Overlap detection optimization
系统必须(SHALL)快速检测clips的重叠关系，优化融合算法的执行路径。

#### Scenario: Single clip fast path
- **WHEN** 某个时间区域仅被一个clip覆盖
- **THEN** 系统必须跳过weight比较，直接使用该clip的音高值

#### Scenario: No overlap fast path
- **WHEN** 所有clips在时间上完全不重叠
- **THEN** 系统必须避免执行winner-take-most逻辑，直接拼接每个clip的音高曲线

#### Scenario: Full overlap careful processing
- **WHEN** 多个clips在同一时间区域完全重叠
- **THEN** 系统必须对每帧执行完整的weight计算和winner-take-most选择

### Requirement: Clip metadata pre-sorting
系统必须(SHALL)在融合前对clips按时间排序，加速区间查询。

#### Scenario: Sort clips by start time
- **WHEN** 准备融合算法的输入数据
- **THEN** 系统必须按clip的start_sec升序排序clips列表

#### Scenario: Binary search for active clips
- **WHEN** 查询某个时间点的活跃clips
- **THEN** 系统必须使用二分查找快速定位可能覆盖该时间点的clips

### Requirement: Memory efficiency
系统必须(SHALL)优化融合算法的内存使用，避免不必要的拷贝。

#### Scenario: In-place output writing
- **WHEN** 将winner的音高值写入输出曲线
- **THEN** 系统必须直接写入预分配的输出缓冲区，避免临时Vec分配

#### Scenario: Reuse weight calculation buffers
- **WHEN** 多次计算clip weight
- **THEN** 系统必须复用临时计算缓冲区，减少堆内存分配
