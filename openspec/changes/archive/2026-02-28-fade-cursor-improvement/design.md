# Design: Fade Handle Cursor & Interaction Improvement

## Current State

`ClipItem.tsx` 中 fade 手柄的实现：

```
fade_in 手柄：
  - 命中区：28×28px 固定方块，位于 clip body 左上角外侧（-translate-x-1 -translate-y-1）
  - 光标：cursor-nwse-resize（西北-东南对角线）
  - 视觉：14×14px 小方块（left-[6px] top-[6px]）

fade_out 手柄：
  - 命中区：28×28px 固定方块，位于 clip body 右上角外侧（translate-x-1 -translate-y-1）
  - 光标：cursor-nesw-resize（东北-西南对角线）
  - 视觉：14×14px 小方块（right-[6px] top-[6px]）
```

fade 遮罩 SVG 在 `pointer-events-none` 的 div 内，不参与交互。

## Goals

**Goals:**
- 光标语义与操作方向一致（水平拖拽 → `ew-resize`）
- 命中区覆盖整个 fade 遮罩区域，降低操作难度

**Non-goals:**
- 不修改 fade 拖拽逻辑（`useEditDrag.ts`）
- 不修改 fade 视觉样式（SVG 路径、颜色）
- 不修改后端数据结构

## Approach

### 方案：将手柄 div 改为覆盖整个 fade 区域

**fade_in 手柄**：
- 宽度：`Math.min(width, fadeIn * pxPerBeat)` px（与 fade SVG 宽度一致）
- 高度：`100%`（覆盖整个 clip body 高度）
- 位置：`absolute left-0 top-0`
- 光标：`cursor-ew-resize`
- z-index：保持 `z-[80]`（高于波形）
- 视觉指示器：保留 14×14px 小方块，固定在 `left-[4px] top-[4px]`

**fade_out 手柄**：
- 宽度：`Math.min(width, fadeOut * pxPerBeat)` px
- 高度：`100%`
- 位置：`absolute right-0 top-0`
- 光标：`cursor-ew-resize`
- z-index：保持 `z-[80]`
- 视觉指示器：保留 14×14px 小方块，固定在 `right-[4px] top-[4px]`

**当 fade = 0 时**：
- 手柄宽度为 0，不可见也不可交互，行为与现在一致

**style 属性**（动态宽度需用 inline style）：
```tsx
style={{ width: Math.min(width, fadeIn * pxPerBeat) }}
```

## Key Design Decisions

1. **为什么用 `ew-resize` 而不是 `col-resize`**：`ew-resize` 是标准的水平双向箭头，语义最清晰；`col-resize` 通常用于列宽调整，语义偏向"分隔线"。

2. **为什么保留视觉小方块**：小方块作为"这里可以拖拽"的视觉提示，去掉后用户可能不知道 fade 区域可以拖拽。

3. **为什么不把 SVG 改为 pointer-events-auto**：SVG 的 `pointer-events-none` 是为了让点击穿透到波形，改为可交互会影响波形的选中操作。用独立的透明 div 覆盖是更干净的方案。

## Risks / Trade-offs

- **z-index 冲突**：fade 手柄 div（z-80）覆盖了整个 fade 区域，可能遮挡该区域内的波形点击。但由于 fade 区域本身就是"淡入淡出"的过渡区，用户在此区域的主要操作就是调整 fade，遮挡波形点击是可接受的 trade-off。
- **fade = 0 时无命中区**：当 fade 为 0 时手柄宽度为 0，用户无法通过拖拽来"从零开始"增加 fade。这与现有行为一致（现有手柄也在角落，fade=0 时也很难操作），不在本次改动范围内。
