## Context

**当前状态**:
- 参数面板刷新按钮直接调用 Tauri 命令触发音高数据重算，该操作在前端等待返回期间阻塞 UI
- 波形 Canvas 渲染在单次 paint 周期内完成所有路径绘制，大文件（>2 分钟）会导致帧率骤降甚至假死
- 前端无法感知后端长时间操作的进度，无法提前终止任务
- 现有音高分析已支持并行解码（Rayon），但前端调用为同步阻塞模式

**技术约束**:
- Tauri IPC 命令默认为同步调用（前端 await 结果）
- React 组件渲染和 Canvas 绘制共享主线程
- JavaScript 无真正多线程（Web Worker 需序列化数据传输）
- 音高数据结构较大（数千个采样点），传输成本不可忽视

**性能目标**:
- 参数面板刷新点击后 UI 响应时间 < 100ms（显示 Loading 状态）
- 波形渲染保持 60fps，大文件分帧绘制总耗时 < 1 秒
- 取消操作响应时间 < 500ms

## Goals / Non-Goals

**Goals:**
- 参数面板刷新异步化，不阻塞 UI 主线程
- 波形渲染支持增量绘制，大文件流畅显示
- 提供清晰的加载状态反馈和取消机制
- 保持现有功能不受影响（向后兼容）

**Non-Goals:**
- 不重构整个音高分析架构（利用现有并行处理能力）
- 不引入复杂的任务队列系统（简单任务 ID 管理即可）
- 不处理网络传输优化（本地 IPC 已足够快）
- 不优化音高算法本身（算法优化在另一个 change 中处理）

## Decisions

### 1. 异步音高刷新：任务 ID + 轮询状态模式

**决策**: 
- 参数面板刷新按钮调用新命令 `start_pitch_refresh_task()` 返回 `task_id`
- 前端通过 `get_pitch_refresh_status(task_id)` 轮询任务状态（每 500ms）
- 后端在 `AppState` 中维护 `active_pitch_tasks: HashMap<TaskId, TaskStatus>`
- 任务完成后清理状态，失败返回错误信息

**后端伪代码**:
```rust
#[tauri::command]
async fn start_pitch_refresh_task(state: State<AppState>) -> Result<String, String> {
    let task_id = Uuid::new_v4().to_string();
    let state_clone = state.inner().clone();
    
    tokio::spawn(async move {
        // 执行音高重算
        let result = compute_pitch_curve(...);
        state_clone.pitch_tasks.lock().unwrap().insert(task_id, result);
    });
    
    Ok(task_id)
}

#[tauri::command]
fn get_pitch_refresh_status(task_id: String, state: State<AppState>) -> TaskStatus {
    state.pitch_tasks.lock().unwrap().get(&task_id).cloned()
}
```

**备选方案**: 使用 Tauri Event 推送任务完成通知。
**拒绝理由**: 需要建立事件监听管理，轮询模式更简单且足够高效。

### 2. 波形增量渲染：requestAnimationFrame + 分片策略

**决策**:
- 将波形数据按时间分段（每段 5 秒音频）
- 使用 `requestAnimationFrame()` 调度，每帧绘制一段
- 维护 `renderProgress` 状态，已绘制段显示实线，未绘制段显示占位符
- 用户滚动到未渲染区域时优先加载该段

**前端伪代码**:
```typescript
const renderWaveformIncremental = (data: Float32Array, canvas: HTMLCanvasElement) => {
    const CHUNK_SIZE = SAMPLE_RATE * 5; // 5 秒
    let offset = 0;
    
    const renderNextChunk = () => {
        if (offset >= data.length) return;
        
        const chunk = data.slice(offset, offset + CHUNK_SIZE);
        drawWaveformChunk(ctx, chunk, offset);
        offset += CHUNK_SIZE;
        
        requestAnimationFrame(renderNextChunk);
    };
    
    requestAnimationFrame(renderNextChunk);
};
```

**备选方案**: 使用 OffscreenCanvas + Web Worker 绘制。
**拒绝理由**: OffscreenCanvas 兼容性差，且数据序列化传输开销大。

### 3. 取消机制：中断令牌 + 定期检查点

**决策**:
- 前端使用 `AbortController` 管理取消信号
- 后端音高分析循环中插入中断检查点：`if should_cancel { return Err(...) }`
- 取消命令 `cancel_pitch_task(task_id)` 设置任务状态为 `Cancelled`
- 后端在每个 clip 分析完成后检查取消标志

**后端中断点伪代码**:
```rust
for clip in clips {
    if state.pitch_tasks.lock().unwrap().get(&task_id) == Some(TaskStatus::Cancelled) {
        return Err("Task cancelled by user".into());
    }
    
    analyze_clip(clip)?; // 正常分析
}
```

**备选方案**: 使用 Tokio 的 CancellationToken。
**拒绝理由**: 需要将整个分析流程改为 async，改动过大。

### 4. 加载状态反馈：React Hook + 状态机

**决策**:
- 创建 `useAsyncPitchRefresh()` Hook 封装刷新逻辑
- 状态机：`idle → loading → success | error`
- Loading 状态显示 Spinner + "正在刷新音高数据..." 文案
- 显示取消按钮，点击调用 `cancelPitchTask()`

**Hook 接口**:
```typescript
const { 
    isLoading, 
    error, 
    progress, // 0-100
    startRefresh, 
    cancelRefresh 
} = useAsyncPitchRefresh();
```

**备选方案**: 使用 Redux Toolkit 管理全局刷新状态。
**拒绝理由**: 刷新是局部操作，Hook 更轻量且更符合 React 惯例。

## Risks / Trade-offs

### Risk 1: 轮询任务状态增加后端查询负担
- **场景**: 多个组件同时轮询不同任务
- **缓解**: 限制并发任务数（最多 3 个），超出时排队
- **Trade-off**: 需要增加任务队列管理逻辑

### Risk 2: 分片渲染在快速滚动时可能显示不完整波形
- **场景**: 用户快速拖动时间轴，未渲染区域显示空白
- **缓解**: 滚动停止后 100ms 触发优先渲染可见区域
- **Trade-off**: 滚动时实时预览质量略降，但不影响编辑功能

### Risk 3: 取消操作可能留下不一致的缓存状态
- **场景**: 任务取消时部分 clip 已分析完成，缓存中有脏数据
- **缓解**: 取消时清空相关缓存条目，或标记为 "partial"
- **Trade-off**: 取消后重新刷新需要从头开始，无法增量恢复

### Risk 4: 异步刷新可能导致竞态条件
- **场景**: 用户快速点击刷新 → 取消 → 再刷新，任务执行顺序不确定
- **缓解**: 自动取消旧任务，仅保留最新一次刷新
- **Trade-off**: 需要维护 "latest task ID" 状态

## Migration Plan

**部署步骤**:
1. 后端添加异步任务命令（保持旧同步命令兼容，标记为 deprecated）
2. 前端添加新 Hook 和组件，参数面板优先使用新逻辑
3. 波形组件独立部署增量渲染，不影响其他模块

**回滚策略**:
- 如异步模式出现问题，可通过环境变量 `USE_SYNC_REFRESH=1` 回退到旧逻辑
- 波形渲染可通过 Canvas size 阈值判断是否启用增量模式（< 5000 像素宽用旧逻辑）

**验证计划**:
- 功能测试：刷新 → 取消 → 再刷新，确认状态正确
- 性能测试：10 个 clip + 2 分钟音频，测试波形渲染帧率和刷新响应时间
- 压力测试：连续点击刷新 10 次，确认无内存泄漏和任务堆积
- 兼容性测试：在低端设备（4GB RAM）上验证 UI 流畅度

## Open Questions

1. **任务超时时间如何设置？** 音高分析可能因文件大小差异耗时 10 秒到 5 分钟不等，固定超时不合理。
2. **波形分片粒度是否需要动态调整？** 当前固定 5 秒，短文件可能过度分片，长文件单片仍可能卡顿。
3. **是否需要持久化未完成的任务？** 应用重启后任务丢失，用户需要重新刷新。
