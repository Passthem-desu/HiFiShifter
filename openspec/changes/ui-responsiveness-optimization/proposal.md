## Why

参数面板刷新按钮和波形初次加载会导致前端长时间无响应甚至卡死，严重影响用户体验。根本原因是音高数据重算和波形 Canvas 渲染在主线程同步执行，阻塞了 UI 交互和动画渲染，用户无法感知进度也无法取消操作。

## What Changes

- 将参数面板刷新触发的音高重算改为异步后台任务，避免阻塞主线程
- 波形绘制改用增量渲染策略（requestAnimationFrame + 分批绘制），大文件分片渲染
- 添加刷新/加载状态指示器（Loading Spinner / Skeleton），明确告知用户操作进行中
- 提供取消机制，允许用户中断长时间的音高重算或波形加载任务
- 优化波形数据传输，使用缓存减少重复计算和网络传输

## Capabilities

### New Capabilities
- `async-pitch-refresh`: 参数面板刷新按钮触发的异步音高重算机制，包括后台任务启动、进度查询、取消命令
- `incremental-waveform-render`: 波形 Canvas 增量渲染策略，支持大文件分批绘制和帧率控制，避免主线程阻塞
- `loading-state-feedback`: 刷新和加载操作的 UI 状态反馈，包括 Loading Spinner、进度百分比、取消按钮

### Modified Capabilities
<!-- 现有 spec 无需修改需求，仅实现层面优化 -->

## Impact

**后端 (Rust)**:
- `backend/src-tauri/src/commands/pitch_refresh.rs`: 新增异步刷新命令，支持任务取消
- `backend/src-tauri/src/pitch_analysis.rs`: 音高重算任务需支持中断检查点
- `backend/src-tauri/src/commands/waveform.rs`: 波形数据查询优化，支持分段请求

**前端 (React)**:
- `frontend/src/components/layout/PianoRollPanel.tsx`: 参数面板刷新按钮改为异步调用，显示加载状态
- `frontend/src/components/WaveformCanvas.tsx`: 波形渲染逻辑重构为增量模式
- `frontend/src/services/coreApi.ts`: 添加取消令牌（AbortController）支持
- `frontend/src/hooks/useAsyncPitchRefresh.ts`: 新建自定义 Hook 管理刷新状态

**用户体验**:
- 点击刷新后 UI 立即响应，显示 Loading 状态而非卡死
- 大文件波形加载流畅，边加载边显示而非一次性绘制卡顿
- 用户可随时取消长时间操作，避免被迫等待或强制关闭应用
