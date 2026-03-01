## Why

音高分析当前存在严重的性能瓶颈，每次刷新需要数分钟。主要问题是：1) 每个clip都重复执行完整的音频解码、重采样和WORLD/ONNX F0分析；2) clips按串行方式逐个处理，无法利用多核CPU；3) clip位置移动等不影响音高的操作也会触发全量重新分析。这导致用户体验极差，影响正常编辑工作流。

## What Changes

- 实现clip级别的音高缓存机制，基于源文件、trim参数和分析算法参数生成缓存键
- 并行化clip音高分析，利用多核CPU加速处理
- 智能检测clip变化，仅对修改过的clips重新分析（增量更新）
- 优化clip位置变化的处理逻辑，水平移动不触发音高重新分析
- 改进融合算法，仅对重叠区域执行winner-take-most选择，减少不必要的计算
- 统一WORLD和NSF-HiFiGAN ONNX两条分析链路的缓存和并行化机制
- 重构进度报告系统，显示整体进度而非单个clip进度

## Capabilities

### New Capabilities

- `clip-pitch-cache`: Clip级别音高缓存系统，支持基于文件签名和参数的智能缓存键生成、LRU淘汰策略、内存管理
- `parallel-pitch-analysis`: 并行音高分析框架，支持多线程clip分析、进度聚合、错误隔离
- `incremental-pitch-refresh`: 增量音高更新机制，检测timeline变化并仅重新分析受影响的clips
- `position-invariant-cache`: 位置无关缓存键生成，区分影响音高的参数（trim、playback_rate）和不影响的参数（start_beat）

### Modified Capabilities

- `pitch-analysis-pipeline`: 重构现有音高分析流程，从串行改为并行，增加缓存查询阶段，统一WORLD和ONNX路径
- `pitch-fusion-algorithm`: 优化融合算法性能，仅对有clip覆盖的时间区域执行winner-take-most，跳过空白区域
- `pitch-progress-reporting`: 改进进度报告逻辑，从单clip进度改为多clip聚合进度（weighted average based on estimated workload）

## Impact

**受影响的代码模块：**
- `backend/src-tauri/src/pitch_analysis.rs`: 核心音高分析流程，需要大幅重构
- `backend/src-tauri/src/pitch_clip.rs`: 单clip分析逻辑，需要抽取并适配并行框架
- `backend/src-tauri/src/world.rs`: WORLD算法包装，需要评估互斥锁对并行的影响
- `backend/src-tauri/src/pitch_refresh_async.rs`: 异步刷新任务管理，需要适配新的进度报告
- `backend/src-tauri/src/state.rs`: AppState，需要添加缓存存储结构
- Frontend进度UI: 需要适配新的进度报告格式

**依赖变化：**
- 需要引入 `rayon` 或 `tokio` 用于并行化（推荐rayon for CPU-bound tasks）
- 可能需要 `lru` crate 用于LRU缓存实现

**性能预期：**
- 首次分析：22-45秒（无变化）→ 3-7秒（6-7倍加速，8核CPU）
- 重复分析：22-45秒 → <100ms（减少99%+）
- 编辑单个clip后刷新：22-45秒 → 1-4秒（仅重新分析1个clip）
- 移动clip位置：22-45秒 → <50ms（直接跳过分析）

**兼容性：**
- 缓存格式需要版本化，支持未来算法更新时的缓存失效
- 需要保留降级路径（缓存失败时fallback到全量分析）
