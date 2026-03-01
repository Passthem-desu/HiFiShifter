## 1. 诊断和验证准备

- [x] 1.1 在后端 state.rs 中确认 frame_period_ms() 的实现逻辑和数值正确性
- [x] 1.2 在前端 render.ts 的 drawCurveTimed 中添加详细的坐标转换调试日志
- [x] 1.3 在 render.ts 中添加时间轴参考线绘制功能（通过 localStorage 标志启用）
- [x] 1.4 测试当前实现，记录具体的"横向压缩"表现（缩放比例、偏移方向）

## 2. 提取统一的坐标转换函数

- [x] 2.1 在 pianoRoll/utils.ts 中创建 framesToTime(frame, framePeriodMs) 工具函数
- [x] 2.2 在 pianoRoll/utils.ts 中创建 timeToFrame(timeSec, framePeriodMs) 工具函数
- [ ] 2.3 添加转换函数的单元测试（边界情况、精度验证）
- [x] 2.4 在 usePianoRollData.ts 的数据请求计算中使用 timeToFrame 函数替换现有计算
- [x] 2.5 在 usePianoRollData.ts 的 paramCoversVisible 判断中使用 framesToTime 函数替换现有计算
- [x] 2.6 在 render.ts 的 drawCurveTimed 中使用 framesToTime 函数替换现有计算

## 3. 修复时间范围量化问题

- [x] 3.1 分析 quantStepSec = 0.02 对坐标精度的影响（通过日志对比量化前后的时间值）
- [x] 3.2 评估缓存命中率权衡：是否可以减小量化步长到 5ms 或移除量化
- [x] 3.3 修改 computeVisibleRequest 中的时间范围计算，确保 startFrame 基于未量化的 visibleStartSec 计算
- [x] 3.4 保持数据请求的覆盖范围量化（用于缓存），但坐标计算使用精确值

## 4. 验证和对齐波形

- [ ] 4.1 在 render.ts 的波形绘制逻辑中添加时间计算日志，确认波形的时间轴转换公式
- [ ] 4.2 对比波形和音高曲线的时间轴转换逻辑，确保使用相同的 visibleStartSec 和 visibleDurSec
- [ ] 4.3 使用已知测试音频（如 1 秒钟的单音）验证波形和音高曲线的对齐
- [ ] 4.4 在调试模式下绘制波形特征点（突变处）的垂直参考线

## 5. 处理 stride 参数

- [ ] 5.1 确认后端 params.rs 中 stride 参数的实现与前端假设一致
- [ ] 5.2 验证 drawCurveTimed 中的帧号计算 `frame = startFrame + i * stride` 与后端返回的数据对应关系
- [ ] 5.3 添加 stride 参数的边界测试（stride = 1, 2, 4）

## 6. 添加调试可视化

- [ ] 6.1 在 render.ts 中添加绘制时间标记的函数（renderTimeMarkers）
- [ ] 6.2 在每秒和每拍位置绘制垂直虚线参考线
- [ ] 6.3 在参考线旁边添加时间标签（秒数、拍数）
- [ ] 6.4 添加一个 UI 开关或 localStorage 标志来启用/禁用调试可视化
- [ ] 6.5 确保调试绘制不影响正常渲染性能（使用条件编译或运行时检查）

## 7. 多场景测试

- [ ] 7.1 测试不同 BPM（60, 120, 180）下的音高曲线对齐
- [ ] 7.2 测试不同音频采样率（44.1kHz, 48kHz）下的对齐
- [ ] 7.3 测试不同缩放级别（pxPerBeat: 10, 50, 200）下的对齐
- [ ] 7.4 测试滚动到音频起始位置（scrollLeft = 0）的对齐
- [ ] 7.5 测试滚动到音频结束位置的对齐
- [ ] 7.6 测试长音频文件（>5 分钟）的全程对齐

## 8. 代码清理和文档

- [ ] 8.1 移除或条件化调试日志（保留关键的错误日志）
- [ ] 8.2 清理注释掉的旧代码
- [ ] 8.3 更新 pianoRoll/types.ts 的类型注释，说明 framePeriodMs 的语义
- [ ] 8.4 更新 README.md 中关于 Piano Roll 渲染的用户说明
- [ ] 8.5 更新 DEVELOPMENT.md 中关于坐标转换的开发文档

## 9. 性能验证

- [ ] 9.1 使用 performance.now() 测量 drawPianoRoll 的渲染时间
- [ ] 9.2 确认修复后的渲染时间与修复前相差在 10% 以内
- [ ] 9.3 测试大量数据点（>10000 点）的渲染性能
- [ ] 9.4 优化发现的性能瓶颈（如有）
