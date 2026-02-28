# Proposal: Fade Handle Cursor & Interaction Improvement

## Why

当前 timeline clip 的淡入/淡出手柄存在两个明显的体验问题：

1. **光标不直观**：fade_in 手柄使用 `cursor-nwse-resize`（西北-东南对角线），fade_out 使用 `cursor-nesw-resize`（东北-西南对角线）。这两种对角线光标暗示的是"斜向拉伸"操作，而 fade 实际上是水平方向的拖拽，造成视觉语义错误，用户体验差。

2. **可交互区域过小**：手柄命中区仅为 28×28px 的固定小方块，位于 clip 角落外侧。当 fade 区域已经很宽时，用户仍然只能在角落那一小块区域操作，不符合"操作区应覆盖整个 fade 区"的直觉。

## What Changes

- **光标**：将 fade_in 和 fade_out 手柄的光标统一改为 `ew-resize`（左右双向箭头），与实际的水平拖拽操作语义一致。
- **交互区域**：将 fade 手柄的可点击/拖拽区域扩展为整个 fade 遮罩区域（宽度 = `fadeInBeats * pxPerBeat`，高度 = clip body 高度），而不是固定的 28×28px 小方块。原有的视觉指示小方块保留，仅作为视觉提示。

## Requirements

- `fade-handle-cursor`: fade_in 和 fade_out 手柄的光标改为 `ew-resize`
- `fade-handle-hit-area`: fade_in 手柄的命中区宽度等于 `fadeInBeats * pxPerBeat`，fade_out 手柄的命中区宽度等于 `fadeOutBeats * pxPerBeat`，高度均等于 clip body 高度
- `fade-handle-visual-indicator`: 保留原有的视觉小方块（14×14px），位于 fade 区域的顶部角落，作为视觉提示，不影响命中区

## Impact

- 受影响文件：`frontend/src/components/layout/timeline/ClipItem.tsx`
- 无后端改动，无数据结构变更
- 不影响 fade 的拖拽逻辑（`useEditDrag.ts`）
