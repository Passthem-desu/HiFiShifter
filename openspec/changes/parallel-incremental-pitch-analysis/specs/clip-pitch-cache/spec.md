## ADDED Requirements

### Requirement: Cache key generation
系统必须(SHALL)为每个clip生成唯一的缓存键，键值基于所有影响音高分析结果的参数计算。

#### Scenario: Cache key includes file identity
- **WHEN** 生成clip的缓存键
- **THEN** 缓存键必须包含源文件路径、文件大小和修改时间

#### Scenario: Cache key includes trim parameters
- **WHEN** 生成clip的缓存键
- **THEN** 缓存键必须包含trim_start_beat、trim_end_beat和playback_rate

#### Scenario: Cache key includes analysis configuration
- **WHEN** 生成clip的缓存键
- **THEN** 缓存键必须包含分析算法类型(WORLD/ONNX)、F0范围(f0_floor/f0_ceil)和帧周期

#### Scenario: Cache key excludes position parameters
- **WHEN** 生成clip的缓存键
- **THEN** 缓存键必须不包含start_beat（时间轴位置）

### Requirement: Cache hit and retrieval
系统必须(SHALL)在分析前查询缓存，命中时直接返回缓存的音高曲线。

#### Scenario: Cache hit returns cached curve
- **WHEN** 请求分析一个clip且缓存中存在有效条目
- **THEN** 系统必须跳过音频解码和F0分析，直接返回缓存的MIDI音高曲线

#### Scenario: Cache miss triggers analysis
- **WHEN** 请求分析一个clip且缓存中不存在条目
- **THEN** 系统必须执行完整的音频解码和F0分析流程

#### Scenario: Cache invalidation on file change
- **WHEN** 源音频文件被修改（mtime或size变化）
- **THEN** 系统必须使旧缓存条目失效并触发重新分析

### Requirement: LRU eviction policy
系统必须(SHALL)实现LRU(Least Recently Used)淘汰策略，在内存不足时自动删除最久未用的缓存条目。

#### Scenario: Evict oldest entry when limit reached
- **WHEN** 缓存大小达到配置的最大条目数(例如100个clips)
- **THEN** 系统必须删除最久未访问的缓存条目以腾出空间

#### Scenario: Update access time on hit
- **WHEN** 缓存命中时
- **THEN** 系统必须更新该条目的最后访问时间

### Requirement: Cache versioning
系统必须(SHALL)支持缓存格式版本控制，确保算法更新后旧缓存失效。

#### Scenario: Version mismatch invalidates cache
- **WHEN** 缓存条目的版本号与当前算法版本不匹配
- **THEN** 系统必须忽略该缓存条目并重新分析

#### Scenario: Version included in cache key
- **WHEN** 生成缓存键
- **THEN** 缓存键必须包含当前缓存格式版本号

### Requirement: Thread-safe cache access
系统必须(SHALL)确保多线程环境下的缓存访问安全。

#### Scenario: Concurrent cache reads
- **WHEN** 多个线程同时读取不同的缓存条目
- **THEN** 系统必须允许并发读取而不阻塞

#### Scenario: Concurrent cache write
- **WHEN** 多个线程同时写入不同的缓存条目
- **THEN** 系统必须通过互斥锁确保写入操作的原子性

#### Scenario: Duplicate analysis prevention
- **WHEN** 多个线程尝试分析同一个clip（相同缓存键）
- **THEN** 系统必须确保只有一个线程执行分析，其他线程等待并共享结果
