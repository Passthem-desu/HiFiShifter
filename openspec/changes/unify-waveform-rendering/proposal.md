## Why

目前钢琴卷帘窗（Piano Roll）和时间轴 Clip 中的波形使用了不同的渲染实现和视觉样式。Piano Roll 使用 Canvas fillRect 绘制蓝色半透明波形，而 Clip 使用 SVG path 绘制白色描边波形。这导致代码重复，视觉不一致，且难以统一维护和主题化。统一波形渲染可以提升代码质量和用户体验的一致性。

## What Changes

- 创建共享的波形渲染工具函数，支持 Canvas 和 SVG 两种渲染方式
- 统一 Piano Roll 和 Clip 的波形视觉样式（颜色、透明度、渲染方式）
- 从 Piano Roll render.ts 和 ClipItem.tsx 中提取波形渲染逻辑
- 保持或改进现有性能（支持自适应采样、大数据集优化）
- 支持主题化配置（颜色、透明度可通过主题系统控制）
- 保持 Clip 的立体声双波形布局和淡入淡出效果

## Capabilities

### New Capabilities
- `shared-waveform-rendering`: 共享的波形渲染工具模块，提供统一的数据处理和渲染接口，支持 Canvas 和 SVG 两种输出格式

### Modified Capabilities
- `piano-roll-ui`: 使用新的共享波形渲染工具替代现有实现
- `timeline-clip-ui`: 使用新的共享波形渲染工具替代现有 SVG path 生成逻辑

## Impact

**受影响的文件**:
- `frontend/src/components/layout/pianoRoll/render.ts` - Piano Roll 波形渲染逻辑需要重构
- `frontend/src/components/layout/timeline/ClipItem.tsx` - Clip 波形 SVG 生成逻辑需要重构
- `frontend/src/utils/` 或 `frontend/src/components/shared/` - 新增共享波形渲染模块

**受影响的功能**:
- Piano Roll 背景波形显示
- 时间轴 Clip 波形预览
- 波形的视觉样式和性能优化

**向后兼容性**: 
- 不影响数据格式和 API 接口
- 纯视觉和代码结构改进，不涉及功能变更
