## Why

ONNX HiFiGAN 合成器当前处于不可用状态，阻碍用户使用高质量音高编辑功能。同时，音高检测在多 clip 重叠场景下出现异常，检测时间过长，且缺少进度反馈导致用户体验极差，用户无法判断程序是否卡死。

## What Changes

- 诊断并修复 ONNX Runtime 加载失败的根本原因（模型路径、依赖项、执行提供器配置）
- 优化音高检测算法，正确处理重叠 clip 的边界情况，避免重复计算
- 提升音高分析性能，减少检测时长（缓存优化、并行化改进）
- 添加前端实时进度条，展示当前检测进度（已处理 clip 数/总数、预计剩余时间）
- 改进错误报告，当 ONNX 不可用时给出清晰的诊断信息和修复建议

## Capabilities

### New Capabilities
- `pitch-progress-ui`: 音高检测进度报告机制和前端进度条 UI，包括后端进度事件推送、前端轮询或事件监听、进度百分比和预计时间计算
- `pitch-overlap-handling`: 多 clip 重叠时的音高检测边界处理，避免重复分析相同音频区域
- `onnx-diagnostics`: ONNX 可用性诊断和错误报告，包括模型加载状态检查、执行提供器验证、清晰的用户错误提示

### Modified Capabilities
<!-- 暂无需修改现有 spec 的需求变更 -->

## Impact

**后端 (Rust)**:
- `backend/src-tauri/src/nsf_hifigan_onnx.rs`: ONNX 加载错误诊断
- `backend/src-tauri/src/pitch_analysis.rs`: 重叠检测优化、性能改进
- `backend/src-tauri/src/commands/`: 新增进度查询或事件推送命令
- `backend/src-tauri/src/audio_engine/`: 可能影响播放时的音高缓存逻辑

**前端 (React)**:
- `frontend/src/components/`: 新增进度条组件
- `frontend/src/services/`: 添加进度查询 API 调用
- `frontend/src/features/piano-roll/`: 集成进度显示到参数编辑面板

**用户体验**:
- ONNX 功能恢复可用，高质量合成重新启用
- 音高检测速度显著提升，减少等待时长
- 进度反馈消除"假死"感知，提升信心
