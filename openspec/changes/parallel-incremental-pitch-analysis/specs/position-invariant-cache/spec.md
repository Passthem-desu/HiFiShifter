## ADDED Requirements

### Requirement: Distinguish cache-affecting parameters
系统必须(SHALL)明确区分影响音高分析结果的参数和不影响结果的参数。

#### Scenario: Include trim parameters in cache key
- **WHEN** 生成clip的缓存键
- **THEN** 缓存键必须包含trim_start_beat和trim_end_beat（影响分析的音频片段）

#### Scenario: Include playback rate in cache key
- **WHEN** 生成clip的缓存键
- **THEN** 缓存键必须包含playback_rate（影响音高分析的时间拉伸）

#### Scenario: Exclude position from cache key
- **WHEN** 生成clip的缓存键
- **THEN** 缓存键必须不包含start_beat（仅影响时间轴位置，不影响音高内容）

#### Scenario: Exclude track assignment from cache key
- **WHEN** 生成clip的缓存键
- **THEN** 缓存键必须不包含track_id（clip移动到不同轨道不改变音高内容）

### Requirement: Cache reuse on position change
系统必须(SHALL)在clip水平移动时复用缓存，避免重新分析。

#### Scenario: Position change triggers fusion only
- **WHEN** clip的start_beat改变但其他参数不变
- **THEN** 系统必须跳过音高分析，直接从缓存读取，仅重新执行融合算法更新时间对齐

#### Scenario: Dragging clip does not invalidate cache
- **WHEN** 用户在timeline上拖动clip到新位置
- **THEN** 系统必须保持该clip的缓存有效性，不触发重新分析

### Requirement: Parameter hashing algorithm
系统必须(SHALL)使用稳定的哈希算法生成缓存键，确保相同参数组合产生相同键值。

#### Scenario: Consistent hash for identical parameters
- **WHEN** 两个clips具有相同的源文件、trim参数和playback_rate
- **THEN** 系统必须为它们生成完全相同的缓存键

#### Scenario: Quantization for floating-point parameters
- **WHEN** 对浮点参数（如playback_rate、trim_start_beat）哈希
- **THEN** 系统必须先量化到合理精度（例如小数点后3位），避免浮点误差导致缓存未命中

#### Scenario: File identity by mtime and size
- **WHEN** 确定源文件的身份
- **THEN** 系统必须使用文件路径、修改时间(mtime)和大小(size)的组合，而非文件内容哈希

### Requirement: Cache key documentation
系统必须(SHALL)在代码中明确文档化哪些参数影响缓存键。

#### Scenario: Clear parameter classification
- **WHEN** 新增clip参数或修改现有参数的语义
- **THEN** 开发者必须更新缓存键生成函数，明确该参数是否影响音高分析结果

#### Scenario: Cache key version bump on parameter change
- **WHEN** 修改缓存键包含的参数列表
- **THEN** 系统必须递增缓存格式版本号，使旧缓存失效

### Requirement: Fusion-phase position mapping
系统必须(SHALL)在融合阶段正确映射缓存的音高曲线到timeline时间轴。

#### Scenario: Time offset calculation
- **WHEN** 从缓存读取clip音高曲线
- **THEN** 融合算法必须根据clip的start_beat计算该曲线在timeline上的起始时间

#### Scenario: Overlapping clips from cache
- **WHEN** 两个clips位置重叠且都从缓存读取
- **THEN** 融合算法必须正确处理它们的时间窗口，执行winner-take-most选择
