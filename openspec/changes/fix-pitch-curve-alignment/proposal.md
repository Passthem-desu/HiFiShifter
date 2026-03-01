## Why

音高曲线在 Piano Roll 面板中显示时存在横向压缩问题，导致曲线无法与时间轴准确对应。这严重影响了用户在编辑音高参数时的精确定位和可视化反馈，使得用户无法准确判断某个时间点对应的音高值。

## What Changes

- 修复音高曲线渲染时的坐标转换逻辑，确保数据点与时间轴严格对应
- 梳理并修正从音频帧到画布像素坐标的完整转换链路
- 验证时间-像素映射关系在缩放和滚动时的正确性
- 确保音高数据的采样率、帧周期与时间轴保持一致

## Capabilities

### New Capabilities

（无新功能）

### Modified Capabilities

- `piano-roll-rendering`: 修复音高曲线的横向缩放和时间轴对齐逻辑

## Impact

**前端组件：**
- `frontend/src/components/layout/PianoRollPanel.tsx` - 主面板组件
- `frontend/src/components/layout/pianoRoll/render.ts` - 渲染函数
- `frontend/src/components/layout/pianoRoll/usePianoRollData.ts` - 数据获取逻辑
- `frontend/src/components/layout/pianoRoll/types.ts` - 类型定义

**后端 API：**
- 可能需要验证 `get_param_frames` 返回的数据格式和帧周期信息

**测试范围：**
- 不同缩放级别下的音高曲线显示
- 滚动时的曲线对齐
- 不同 BPM 和采样率下的渲染
