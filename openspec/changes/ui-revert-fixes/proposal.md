# Proposal: UI Revert & Fixes

## Why

上一轮 UI 美化（`ui-modernization`）引入了若干视觉回退问题：M/S/C 按钮改为图标后辨识度下降、整体配色偏蓝灰与原有棕灰风格不符、音高面板音符线未对齐琴键中心、工具栏按钮未完成简化。需要针对性修复，恢复可用性并补全遗漏项。

## What Changes

- `TrackList.tsx`：M/S/C 三个控制按钮恢复为字母标签（`M` / `S` / `C`），移除 Radix 图标依赖
- `index.css`：整体配色在原棕灰色系基础上改进（保留 `#353535` 棕灰基调，提升层次感和对比度，高亮色改为更沉稳的 `#3b82f6`）
- `render.ts`（PianoRoll）：修正音符网格线的 Y 轴偏移，使线条居中对齐对应琴键
- `ActionBar.tsx`：补全工具面板按钮的简化/图标化改造（上一轮遗漏）

## Impact

- `frontend/src/components/layout/timeline/TrackList.tsx`
- `frontend/src/index.css`
- `frontend/src/components/layout/pianoRoll/render.ts`
- `frontend/src/components/layout/ActionBar.tsx`
