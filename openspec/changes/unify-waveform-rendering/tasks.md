## 1. 创建共享波形渲染工具

- [x] 1.1 创建 `frontend/src/utils/waveformRenderer.ts` 文件
- [x] 1.2 实现 `processWaveformPeaks()` 函数：接收 min/max 数组，返回采样后的处理结果
- [x] 1.3 添加自适应采样逻辑：根据数据点数量调整 stride（>2000: stride=4, >1000: stride=2）
- [x] 1.4 添加时间范围裁剪功能：仅处理可见区域的数据点
- [x] 1.5 添加振幅归一化和缩放逻辑
- [x] 1.6 为 `processWaveformPeaks()` 添加 JSDoc 文档和类型定义

## 2. 实现 Canvas 渲染函数

- [x] 2.1 实现 `renderWaveformCanvas()` 函数：接收 Canvas context、处理后的 peaks 数据、样式配置
- [x] 2.2 实现竖条绘制逻辑：使用 `fillRect()` 绘制每个 peak
- [x] 2.3 添加可配置的颜色支持：fill 和 stroke 参数
- [x] 2.4 实现静音段最小可见高度逻辑（0.75px）
- [x] 2.5 添加性能优化：批量绘制、避免重复状态设置
- [x] 2.6 为 `renderWaveformCanvas()` 添加 JSDoc 文档和类型定义

## 3. 实现 SVG 路径生成函数

- [x] 3.1 实现 `renderWaveformSvg()` 函数：接收 peaks 数据、viewBox 尺寸、样式配置，返回 SVG path `d` 字符串
- [x] 3.2 实现闭合路径生成：正向遍历 max，反向遍历 min，闭合路径
- [x] 3.3 添加立体声双轨道支持：分别生成 top 和 bottom band 的路径
- [x] 3.4 添加 viewBox 坐标映射逻辑
- [x] 3.5 实现静音段最小可见高度逻辑
- [x] 3.6 为 `renderWaveformSvg()` 添加 JSDoc 文档和类型定义

## 4. 迁移 Piano Roll 波形渲染

- [x] 4.1 在 `frontend/src/components/layout/pianoRoll/render.ts` 中导入 `waveformRenderer` 工具
- [x] 4.2 替换现有的波形绘制代码（382-437行）为调用 `processWaveformPeaks()` 和 `renderWaveformCanvas()`
- [x] 4.3 保持现有的垂直居中逻辑（centerY = h * 0.5, amplitude = h * 0.45）
- [x] 4.4 更新颜色为统一样式：fill `rgba(255,255,255,0.2)`, stroke `rgba(255,255,255,0.7)`
- [x] 4.5 移除旧的波形绘制代码和调试日志（console.log）
- [x] 4.6 验证 Piano Roll 波形显示正确，无错位或性能问题

## 5. 迁移 Clip 波形渲染

- [x] 5.1 在 `frontend/src/components/layout/timeline/ClipItem.tsx` 中导入 `waveformRenderer` 工具
- [x] 5.2 替换 `areaPathFromMinMaxBand()` 函数调用为 `renderWaveformSvg()`
- [x] 5.3 保留淡入淡出效果:在调用 `renderWaveformSvg()` 前对 peaks 数据应用 fade gain curve
- [x] 5.4 保留立体声双轨道布局:分别调用 `renderWaveformSvg()` 生成 top 和 bottom 路径
- [x] 5.5 更新 SVG 填充和描边颜色为统一样式
- [x] 5.6 移除旧的 `areaPathFromMinMaxBand()` 函数定义
- [x] 5.7 验证 Clip 波形显示正确,立体声和淡入淡出效果保持正常

## 6. 添加主题系统支持

- [x] 6.1 在主题配置中添加 `waveform.fill` 和 `waveform.stroke` 颜色定义（位置：`frontend/src/theme/waveformColors.ts`）
- [x] 6.2 修改 `renderWaveformCanvas()` 和 `renderWaveformSvg()`：接收可选的主题颜色参数
- [x] 6.3 在 Piano Roll 中从主题读取波形颜色并传递给渲染函数
- [x] 6.4 在 Clip 中从主题读取波形颜色并传递给渲染函数
- [x] 6.5 验证主题切换时波形颜色正确更新

## 7. 性能测试与优化

- [ ] 7.1 测试 Piano Roll 波形渲染性能：拖动和缩放时帧率应保持 ≥60fps
- [ ] 7.2 测试大数据集场景：10000+ 数据点的波形渲染时间应 <16ms
- [ ] 7.3 测试 Clip 波形性能：多个 Clip（>50 个）同时显示时无明显卡顿
- [ ] 7.4 如发现性能问题，添加 `useMemo` 或优化采样逻辑
- [ ] 7.5 验证内存占用：确保处理和渲染过程不产生明显内存泄漏

## 8. 清理与文档

- [x] 8.1 从 Piano Roll 和 Clip 代码中移除所有旧的波形渲染相关函数和注释
- [x] 8.2 移除 Piano Roll 波形相关的调试日志（如 `console.log("[Waveform] Point...")`）
- [x] 8.3 在 `waveformRenderer.ts` 顶部添加模块文档：说明用途、导出函数、使用示例
- [x] 8.4 更新 `DEVELOPMENT.md`：记录波形渲染架构变更和新的工具函数位置
- [ ] 8.5 更新 `README.md`（如需要）：说明波形渲染的视觉统一改进

## 9. 测试与验证

- [ ] 9.1 手动测试：导入音频文件，验证 Piano Roll 和 Clip 波形显示一致且清晰
- [ ] 9.2 边界测试：测试空波形、单声道、立体声、极长/极短音频的波形渲染
- [ ] 9.3 交互测试：拖动 Clip、调整淡入淡出、调整增益，验证波形实时更新
- [ ] 9.4 缩放测试：放大/缩小时间轴和 Piano Roll，验证波形采样和密度正确
- [ ] 9.5 主题测试：切换主题（如果实现），验证波形颜色正确切换
