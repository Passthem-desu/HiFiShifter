## Why

参数编辑区存在三个需要改进的问题：`breath` 参数类型占位符散落在前端类型定义中但无实际功能，增加维护负担；音高曲线的 Y 坐标映射到琴键边界而非琴键中心，导致视觉上音高线与对应琴键位置不对齐；当前只能单参数查看，无法同时对比 pitch 和 tension 曲线。

## What Changes

- **删除 `breath` 占位符**：从 `ParamName`、`EditParam` 等类型中移除 `breath`，保留架构扩展性（通过注释说明如何添加新参数）
- **音高线居中对齐**：将 pitch 曲线的 `valueToY` 映射从琴键底边改为琴键中心（MIDI 值 N 对应 N 到 N+1 区间的中点）
- **多参数同时显示**：在参数编辑区同时渲染 pitch 和 tension 两条曲线，pitch 使用主轴（左侧钢琴键轴），tension 使用副轴（右侧独立刻度轴），两者叠加显示在同一 canvas 上

## Impact

- `frontend/src/components/layout/pianoRoll/types.ts`：移除 `breath`
- `frontend/src/features/session/sessionTypes.ts`：移除 `breath` from `EditParam`
- `frontend/src/components/layout/pianoRoll/render.ts`：修改 `valueToY` pitch 映射逻辑；新增双参数渲染支持
- `frontend/src/components/layout/PianoRollPanel.tsx`：传入双参数数据；调整轴渲染逻辑
- `frontend/src/components/layout/pianoRoll/usePianoRollData.ts`：支持同时加载 pitch 和 tension 数据
