# Tasks: Fade Handle Cursor & Interaction Improvement

## 1. 修改 fade_in 手柄

- [x] 1.1 将 fade_in 手柄 div 的宽度改为动态值 `Math.min(width, fadeIn * pxPerBeat)`，高度改为 `100%`，位置改为 `absolute left-0 top-0`（移除 `-translate-x-1 -translate-y-1`）
- [x] 1.2 将 fade_in 手柄的光标从 `cursor-nwse-resize` 改为 `cursor-ew-resize`
- [x] 1.3 将 fade_in 视觉指示器小方块的位置从 `left-[6px] top-[6px]` 调整为 `left-[4px] top-[4px]`，保持 14×14px 尺寸不变

## 2. 修改 fade_out 手柄

- [x] 2.1 将 fade_out 手柄 div 的宽度改为动态值 `Math.min(width, fadeOut * pxPerBeat)`，高度改为 `100%`，位置改为 `absolute right-0 top-0`（移除 `translate-x-1 -translate-y-1`）
- [x] 2.2 将 fade_out 手柄的光标从 `cursor-nesw-resize` 改为 `cursor-ew-resize`
- [x] 2.3 将 fade_out 视觉指示器小方块的位置从 `right-[6px] top-[6px]` 调整为 `right-[4px] top-[4px]`，保持 14×14px 尺寸不变
