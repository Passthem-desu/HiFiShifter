## Context

当前音高分析系统(`pitch_analysis.rs::compute_pitch_curve`)采用串行处理架构，每次刷新都对所有clips执行完整的分析流程：音频解码 → 重采样 → WORLD/ONNX F0分析 → 融合。这导致10个clips的timeline需要20-45秒分析时间，严重影响用户体验。关键问题：

1. **重复计算**：相同clip在每次刷新时都重新分析，即使文件和参数未变
2. **串行执行**：clips按顺序处理，无法利用多核CPU（8核机器仅使用1核）
3. **过度触发**：clip位置移动等不影响音高的操作也触发全量重新分析
4. **粗粒度进度**：进度条显示单clip进度，无法反映整体任务状态

现有代码结构：
- `pitch_analysis.rs`: 包含`compute_pitch_curve`主流程和`maybe_schedule_pitch_orig`调度器
- `pitch_clip.rs`: 提供`analyze_clip_pitch_curve`单clip分析函数
- `world.rs`: WORLD DLL封装，使用全局互斥锁`world_dll_mutex`
- `state.rs::AppState`: 包含`timeline: Mutex<TimelineState>`和`pitch_inflight: Mutex<HashSet<String>>`

约束条件：
- WORLD DLL不是线程安全的，需要全局互斥锁
- NSF-HiFiGAN ONNX可以并发执行（无锁）
- 必须保持现有API兼容性（frontend调用`start_pitch_refresh_task`）
- 缓存需要考虑内存限制（100个clips约500MB）

## Goals / Non-Goals

**Goals:**
- 实现clip级别音高缓存，基于文件签名和影响音高的参数生成键值
- 并行化clip分析，充分利用多核CPU（目标6-7倍加速）
- 增量刷新：仅重新分析变化的clips，位置移动不触发分析
- 优化融合算法，仅处理有clip覆盖的时间区域
- 统一WORLD和ONNX两条路径的缓存和并行化机制
- 整体进度报告（加权平均，而非单clip进度）
- 性能目标：首次分析3-7秒，重复分析<100ms，单clip编辑后1-4秒

**Non-Goals:**
- 不改变音高分析的输出格式和精度（保持Vec<f32> MIDI值）
- 不支持跨进程或持久化缓存（仅内存缓存）
- 不重构frontend的音高编辑UI
- 不修改WORLD或ONNX算法本身
- 不处理多root_track的并发分析（保持现有去重机制）

## Decisions

### Decision 1: 使用rayon进行clip并行化

**选择**: 使用`rayon::ThreadPool`并发处理clips。

**理由**:
- rayon为CPU密集型任务优化，适合音频处理
- work-stealing调度器自动负载均衡
- 简单的API（`par_iter()`），易于集成
- 相比tokio，无需处理async/await复杂性

**备选方案拒绝理由**:
- ~~tokio~~: 适合I/O密集型任务，音频分析为CPU密集型
- ~~手动线程池~~: 需要自己实现负载均衡和任务调度，复杂度高
- ~~std::thread::spawn~~: 无法限制线程数，可能创建过多线程

**实现细节**:
```rust
use rayon::prelude::*;

let clip_results: Vec<Result<ClipPitch, String>> = clips
    .par_iter()
    .map(|clip| analyze_single_clip(clip, cache, algo))
    .collect();
```

**WORLD锁处理**: WORLD算法仍需持有`world_dll_mutex`，这会串行化WORLD调用。解决方案：
- ONNX算法优先：无锁，可完全并行
- WORLD降级：当检测到WORLD时，限制并发度为1（通过rayon的`ParallelBridge`）
- 混合场景：分离WORLD和ONNX clips，ONNX并行处理，WORLD串行处理

### Decision 2: 缓存键基于blake3哈希

**选择**: 使用`blake3::Hasher`生成缓存键，包含以下参数：
- 源文件路径 + 文件大小 + mtime（文件签名）
- trim_start_beat + trim_end_beat（量化到0.001精度）
- playback_rate（量化到0.0001精度）
- 分析算法类型（WorldDll/NsfHifiganOnnx）+ f0_floor + f0_ceil
- 缓存格式版本号（当前为1）

**理由**:
- blake3快速且安全，适合生成哈希键
- 已在`build_root_pitch_key`中使用，代码一致性好
- 量化浮点数避免浮点误差导致的缓存未命中
- 文件签名（mtime+size）比内容哈希快，对于大音频文件性能更好

**不包含的参数**（位置无关性）:
- ~~start_beat~~: 仅影响timeline位置，不影响音高内容
- ~~track_id~~: clip可在不同轨道间移动
- ~~clip.id~~: 相同音频文件的不同clips应共享缓存

**备选方案拒绝理由**:
- ~~SHA256~~: 比blake3慢
- ~~文件内容哈希~~: 对大文件耗时数秒，不适合实时场景

### Decision 3: LRU缓存实现使用`lru` crate

**选择**: 使用`lru::LruCache<String, Arc<Vec<f32>>>`存储缓存。

**理由**:
- `lru` crate提供线程安全的LRU实现
- `Arc<Vec<f32>>`允许多线程共享音高曲线数据，避免拷贝
- 自动淘汰最久未用的条目，控制内存使用

**容量配置**: 默认100个clip条目（约500MB内存，假设每条曲线5000帧 × 4字节）

**线程安全**: `Arc<Mutex<LruCache<...>>>`保护并发访问，写入时需持锁。

**备选方案拒绝理由**:
- ~~HashMap + 手动LRU~~: 需要自己实现淘汰逻辑
- ~~moka缓存库~~: 功能过于复杂（支持TTL、统计等），增加依赖大小

### Decision 4: 增量刷新基于timeline快照比对

**选择**: 在`AppState`中新增`pitch_timeline_snapshot: Mutex<HashMap<String, TimelineSnapshot>>`，存储每个root_track的上次分析快照。

```rust
struct TimelineSnapshot {
    clips: HashMap<String, ClipCacheKey>,  // clip_id -> cache_key
    bpm: f64,
    frame_period_ms: f64,
}
```

**流程**:
1. 收到刷新请求时，生成当前timeline的快照
2. 与`pitch_timeline_snapshot`中的旧快照对比
3. 识别新增、修改、删除的clips
4. 仅对新增和修改的clips执行分析
5. 融合时合并新分析结果和缓存结果
6. 更新快照为当前状态

**理由**:
- 快照比对开销小（HashMap查找，O(N)复杂度）
- 准确识别参数变化（通过缓存键变化检测）
- 支持undo/redo（删除的clip缓存保留）

**备选方案拒绝理由**:
- ~~事件驱动更新~~: 需要在所有timeline修改点插入钩子，侵入性强
- ~~版本号机制~~: 无法区分"哪个字段变了"，只能判断"是否变了"

### Decision 5: 融合算法空间优化

**选择**: 预先构建`Vec<Option<Vec<usize>>>`区间覆盖表，每个timeline帧记录覆盖它的clip索引列表。

```rust
// 初始化阶段
let mut coverage: Vec<Option<Vec<usize>>> = vec![None; target_frames];
for (clip_idx, cp) in clip_pitches.iter().enumerate() {
    let start_frame = (cp.start_sec * 1000.0 / frame_period_ms) as usize;
    let end_frame = (cp.end_sec * 1000.0 / frame_period_ms) as usize;
    for frame in start_frame..end_frame.min(target_frames) {
        coverage[frame].get_or_insert_with(Vec::new).push(clip_idx);
    }
}

// 融合阶段
for (frame_idx, out_v) in out.iter_mut().enumerate() {
    let Some(active_clips) = &coverage[frame_idx] else {
        *out_v = 0.0;  // 无覆盖，直接跳过
        continue;
    };
    
    // 仅对active_clips执行winner-take-most
    for &clip_idx in active_clips {
        let cp = &clip_pitches[clip_idx];
        // ... weight计算和比较
    }
}
```

**理由**:
- 预计算覆盖表耗时O(N×M)，N为clips数，M为平均clip长度（帧数），可离线完成
- 融合时查表O(1)，快速跳过空白帧
- 单clip覆盖时直接读取，避免weight计算
- 内存开销可控（10个clips × 1000帧 × 8字节索引 = 80KB）

**备选方案拒绝理由**:
- ~~区间树~~: 查询O(log N)，但构建复杂，对小规模数据无优势
- ~~逐帧clip过滤~~: 每帧遍历所有clips，O(N)复杂度，无法优化空白区域

### Decision 6: 进度报告基于工作量加权

**选择**: 计算总工作量为`sum(clip_duration_sec × cache_miss_factor)`，每个clip完成后更新累计进度。

```rust
struct ProgressTracker {
    total_workload: f64,
    completed_workload: Arc<AtomicU64>,  // 用AtomicU64存储 workload×1000
}

// 每个clip完成时
let clip_workload = duration_sec * if cached { 0.01 } else { 1.0 };
completed_workload.fetch_add((clip_workload * 1000.0) as u64, Ordering::Relaxed);
let progress = completed_workload.load(Ordering::Relaxed) as f64 / (total_workload * 1000.0);
```

**理由**:
- 加权反映实际工作量，长clip进度贡献更大
- 缓存命中仅贡献1%权重，快速跳过
- AtomicU64无需Mutex，高并发性能好
- 整体进度单调递增，不会倒退

**备选方案拒绝理由**:
- ~~均等权重~~: 10秒clip和1秒clip进度贡献相同，不符合实际
- ~~基于clip数量~~: 无法反映缓存命中带来的加速

### Decision 7: 统一管道架构

**选择**: 重构为阶段化管道：

```
[Cache Query] → [Audio Decode] → [F0 Analysis] → [Postprocess] → [Fusion]
      ↓ hit                ↓ WORLD/ONNX          ↓ Hz→MIDI
   直接返回              并行执行              重采样到timeline
```

**实现**:
- 新增`analyze_clip_with_cache`函数，封装缓存查询 + 分析逻辑
- `compute_pitch_curve_parallel`作为新的入口点，替代现有串行流程
- `compute_pitch_curve_legacy`保留旧实现，作为降级备份

**理由**:
- 清晰的阶段划分，易于测试和调试
- WORLD和ONNX共享缓存和并行化代码
- 降级路径保证兼容性

**迁移计划**:
1. 第一阶段：实现新管道，默认关闭（通过feature flag或环境变量）
2. 第二阶段：Beta测试，收集性能数据
3. 第三阶段：默认开启新管道，旧实现保留1-2个版本后删除

## Risks / Trade-offs

### Risk 1: WORLD互斥锁限制并行性能

**风险**: WORLD DLL的全局互斥锁导致WORLD clips无法并行，性能提升受限。

**缓解措施**:
- 优先推荐用户使用ONNX算法（文档和UI提示）
- 混合场景下，将WORLD clips串行化，ONNX clips并行化
- 未来考虑多WORLD实例（多进程或重新编译WORLD为线程安全版本）

**影响**: 纯WORLD workflow加速有限（3-4倍而非6-7倍）

### Risk 2: 缓存内存占用过高

**风险**: 100个clips缓存约500MB，可能导致内存不足。

**缓解措施**:
- LRU自动淘汰机制
- 配置项允许用户调整缓存大小（默认100，可设为50或200）
- 监控内存使用，超过阈值时主动清理
- 长音频clips可以降采样存储（例如只存储每10帧，融合时线性插值）

**影响**: 极端场景（200个10分钟clips）可能需要手动清理缓存

### Risk 3: 缓存失效判断不准确

**风险**: 文件修改后缓存未失效，或参数变化后仍命中旧缓存，导致音高错误。

**缓解措施**:
- 全面测试缓存键生成逻辑，覆盖所有参数组合
- 缓存版本号机制，算法更新时全量失效
- 提供手动清理缓存的UI入口（"Clear Pitch Cache"按钮）
- 日志记录缓存命中率，便于诊断

**影响**: 用户可能需要手动清理缓存（低频事件）

### Risk 4: 并行化引入竞态条件

**风险**: 多线程访问共享状态（缓存、进度追踪）可能导致数据竞争。

**缓解措施**:
- 使用`Arc<Mutex<LruCache>>`保护缓存
- 使用`AtomicU64`保护进度计数器
- 严格隔离工作线程的栈内存，避免共享可变状态
- 充分的并发测试（thread sanitizer、loom）

**影响**: 性能略微下降（锁竞争开销）

### Risk 5: 增量刷新的边界情况

**风险**: BPM变化、frame_period_ms变化等全局参数改变时，clip缓存仍有效但融合结果错误。

**缓解措施**:
- timeline快照包含BPM和frame_period_ms
- 对比快照时，若这些参数变化，触发全量重新分析（清空缓存）
- 缓存键也包含这些参数（通过量化后的值）

**影响**: BPM变化时性能恢复到首次分析水平（可接受，该操作低频）

### Trade-off 1: 内存换时间

通过缓存牺牲500MB内存，换取99%的性能提升。对于8GB+内存的现代机器，这是合理的权衡。

### Trade-off 2: 代码复杂度 vs 性能

并行化和缓存显著增加代码复杂度（+500 LOC），但性能提升巨大（20-45秒 → 3-7秒）。考虑到音高分析是核心功能，这是值得的。

### Trade-off 3: 缓存一致性 vs 灵活性

缓存键固定了参数集合，未来新增影响音高的参数时需要递增版本号，使旧缓存失效。这是缓存系统的固有限制。

## Migration Plan

### Phase 1: 基础设施（Week 1）
1. 添加rayon和lru依赖到Cargo.toml
2. 实现`ClipPitchCache`模块（缓存键生成、LRU缓存）
3. 单元测试：缓存键正确性、LRU淘汰逻辑
4. 在`AppState`中添加`clip_pitch_cache`字段

### Phase 2: 并行化框架（Week 1-2）
1. 实现`analyze_clip_with_cache`函数（缓存查询 + 单clip分析）
2. 实现`compute_pitch_curve_parallel`并行入口
3. 实现`ProgressTracker`进度聚合器
4. 单元测试：并行正确性、进度计算
5. 集成测试：10个clips的并行分析

### Phase 3: 增量刷新（Week 2）
1. 定义`TimelineSnapshot`结构
2. 在`AppState`中添加`pitch_timeline_snapshot`字段
3. 实现快照比对逻辑（识别变化的clips）
4. 修改`maybe_schedule_pitch_orig`支持增量刷新
5. 单元测试：快照比对准确性

### Phase 4: 融合优化（Week 2-3）
1. 实现区间覆盖表构建
2. 重构融合算法使用覆盖表
3. 性能测试：对比旧融合算法的时间开销

### Phase 5: 统一管道（Week 3）
1. 重构ONNX分析路径使用新管道
2. 确保WORLD和ONNX共享缓存和并行化代码
3. 端到端测试：WORLD、ONNX、混合场景

### Phase 6: 前端适配（Week 3）
1. 修改进度事件payload（包含ETA、整体进度）
2. 更新前端进度UI显示逻辑
3. 添加"Clear Pitch Cache"菜单项

### Phase 7: 测试与优化（Week 4）
1. 性能基准测试：对比新旧实现的耗时
2. 内存分析：验证缓存内存使用
3. 压力测试：100个clips、长音频、边界情况
4. Bug修复和优化

### Rollback Strategy
- Feature flag `ENABLE_PARALLEL_PITCH`（默认关闭）
- 环境变量 `HIFISHIFTER_PARALLEL_PITCH=0` 强制禁用
- 保留`compute_pitch_curve_legacy`函数作为降级备份
- 若发现严重bug，通过hotfix禁用feature flag

## Open Questions

1. **WORLD多实例可行性**: 能否通过多进程（IPC）或重新编译WORLD实现真正的并行？需要调研WORLD源码。

2. **持久化缓存**: 未来是否需要支持磁盘缓存？需要考虑缓存失效策略和存储格式。

3. **GPU加速**: NSF-HiFiGAN ONNX是否可以用GPU运行（通过onnxruntime的CUDA provider）？性能提升如何？

4. **缓存预热**: 是否在工程加载时后台预热缓存（分析所有clips）？权衡：启动时间 vs 首次播放响应。

5. **跨root_track缓存共享**: 不同root_track的clips可以共享同一缓存吗？当前设计是隔离的。

6. **缓存统计**: 是否需要在UI显示缓存命中率、内存占用等统计信息？帮助用户理解性能。
