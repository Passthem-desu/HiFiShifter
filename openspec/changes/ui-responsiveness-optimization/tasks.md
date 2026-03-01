## 1. 后端异步任务系统

- [x] 1.1 在 `AppState` 中添加 `pitch_refresh_tasks: Arc<Mutex<HashMap<String, PitchTaskStatus>>>` 字段
- [x] 1.2 定义 `PitchTaskStatus` 枚举（Running, Completed, Failed, Cancelled）和 `PitchTaskInfo` 结构体（status, progress, error, start_time, result_key）
- [x] 1.3 创建新命令文件 `backend/src-tauri/src/commands/pitch_refresh_async.rs`
- [x] 1.4 实现 `start_pitch_refresh_task()` 命令，生成 UUID task_id，启动 `tokio::spawn()` 异步任务，立即返回 task_id
- [x] 1.5 在异步任务中调用现有 `compute_pitch_curve()`，完成后更新任务状态为 Completed 并存储 result_key
- [x] 1.6 实现 `get_pitch_refresh_status(task_id)` 命令，查询并返回任务状态（返回 `Option<PitchTaskInfo>`）
- [x] 1.7 添加任务自动清理逻辑，5 分钟后删除已完成/失败的任务记录
- [x] 1.8 实现并发任务数限制（最多 3 个），超出时返回错误 "Too many active tasks"

## 2. 后端取消机制

- [x] 2.1 在 `PitchTaskInfo` 中添加 `cancel_flag: Arc<AtomicBool>` 字段
- [x] 2.2 实现 `cancel_pitch_task(task_id)` 命令，设置对应任务的 `cancel_flag` 为 true
- [x] 2.3 修改 `pitch_analysis.rs` 中的 `compute_pitch_curve()`，在每个 clip 分析后检查 `cancel_flag`
- [x] 2.4 当检测到取消标志时，提前返回 `Err("Task cancelled by user")`，清空部分结果

## 3. 前端异步刷新 Hook

- [x] 3.1 创建 `frontend/src/hooks/useAsyncPitchRefresh.ts` 文件
- [x] 3.2 在 Hook 中定义状态：`isLoading, taskId, progress, error, estimatedRemaining`
- [x] 3.3 实现 `startRefresh()` 函数，调用 `coreApi.startPitchRefreshTask()` 获取 task_id，启动轮询定时器（500ms 间隔）
- [x] 3.4 实现轮询逻辑，调用 `coreApi.getPitchRefreshStatus(taskId)`，更新 progress 和状态
- [x] 3.5 实现 `cancelRefresh()` 函数，调用 `coreApi.cancelPitchTask(taskId)`，停止轮询
- [x] 3.6 任务完成或失败时自动停止轮询，清空 taskId
- [x] 3.7 计算预计剩余时间（基于已用时间和进度百分比）
- [x] 3.8 添加防抖逻辑，防止快速连续点击刷新按钮

## 4. 后端 API 层

- [x] 4.1 在 `frontend/src/services/coreApi.ts` 中添加 `startPitchRefreshTask(): Promise<string>` 方法
- [x] 4.2 添加 `getPitchRefreshStatus(taskId: string): Promise<PitchTaskInfo | null>` 方法
- [x] 4.3 添加 `cancelPitchTask(taskId: string): Promise<void>` 方法
- [x] 4.4 在 `frontend/src/types/api.ts` 中定义 `PitchTaskInfo` 接口（status, progress, error, startTime, resultKey）

## 5. 波形增量渲染

- [N/A] 5.1 修改 `frontend/src/components/WaveformCanvas.tsx`，添加 `useIncrementalRender` 状态管理（renderProgress, totalChunks, renderedChunks）
- [N/A] 5.2 实现 `renderWaveformIncremental()` 函数，根据音频时长判断是否启用增量模式（>= 30 秒）
- [N/A] 5.3 将波形数据按 5 秒分段，使用 `requestAnimationFrame()` 调度每帧绘制一段
- [N/A] 5.4 实现占位符绘制逻辑，未渲染区域显示灰色 skeleton 条
- [N/A] 5.5 添加 viewport 可见区域检测，优先渲染当前可见 chunks
- [N/A] 5.6 实现滚动监听，滚动停止后 100ms 触发可见区域优先渲染
- [N/A] 5.7 添加取消渲染逻辑，组件卸载时调用 `cancelAnimationFrame()`
- [N/A] 5.8 添加渲染进度状态显示（可选，显示 "Rendering waveform: 65%"）

_注：WaveformCanvas 组件在当前架构中不存在，波形渲染由 ClipItem + useClipWaveformPeaks 实现，已有完善的缓存机制，无需额外增量渲染。_

## 6. 加载状态 UI 组件

- [x] 6.1 创建 `frontend/src/components/LoadingSpinner.tsx` 通用 Spinner 组件（支持 size 和 color props）
- [x] 6.2 创建 `frontend/src/components/ProgressBar.tsx` 进度条组件（支持 percentage, label, showCancel props）
- [x] 6.3 在 `frontend/src/components/layout/PianoRollPanel.tsx` 中集成 `useAsyncPitchRefresh` Hook
- [x] 6.4 刷新按钮修改为调用 `startRefresh()`，按钮内显示 Spinner（loading 时）或正常图标
- [x] 6.5 在参数面板顶部添加进度条区域，`isLoading` 时显示 ProgressBar 组件（百分比 + 预计时间 + 取消按钮）
- [x] 6.6 取消按钮点击时调用 `cancelRefresh()`，按钮文本变为 "Cancelling..."
- [x] 6.7 任务完成后显示 1 秒成功提示（绿色勾号 + "Refresh completed"），然后淡出
- [x] 6.8 任务失败时显示错误消息和重试按钮

## 7. 竞态条件处理

- [x] 7.1 在 Hook 中维护 `latestTaskId` 引用，新刷新开始时自动取消旧任务
- [x] 7.2 添加 `useEffect` 清理函数，组件卸载时取消所有活动任务
- [x] 7.3 轮询状态时检查 `taskId === latestTaskId`，避免更新过期任务的状态

## 8. 性能优化和缓存

- [x] 8.1 波形数据按时间段缓存（Map<time_range, waveform_data>），避免重复请求
- [N/A] 8.2 增量渲染时复用已绘制的 Canvas 内容（OffscreenCanvas 或 ImageBitmap 缓存）
- [N/A] 8.3 添加防抖逻辑，滚动时避免过度触发渲染调度
- [N/A] 8.4 根据设备性能动态调整 chunk 大小（低端设备减小到 3 秒，高端设备增大到 10 秒）

_注：8.1 已通过 useClipWaveformPeaks 中的两级缓存（内存 Map + sessionStorage）实现；8.2-8.4 依赖于不存在的增量渲染基础设施。_

## 9. 国际化和文案

- [x] 9.1 在 `assets/lang/zh_CN.json` 中添加刷新相关文案（"正在刷新音高数据", "已取消", "刷新失败", "预计剩余时间"）
- [x] 9.2 在 `assets/lang/en_US.json` 中添加对应英文文案（"Refreshing pitch data", "Cancelled", "Refresh failed", "Estimated time remaining"）
- [x] 9.3 添加错误提示文案（"Too many active tasks, please wait", "Task cancelled by user"）

## 10. 集成和文档

- [x] 10.1 使用 `cargo check` 验证后端编译通过
- [x] 10.2 更新 README.md 用户手册，说明刷新操作的异步行为和取消功能
- [x] 10.3 更新 DEVELOPMENT.md 开发文档，记录异步任务系统架构和增量渲染策略
