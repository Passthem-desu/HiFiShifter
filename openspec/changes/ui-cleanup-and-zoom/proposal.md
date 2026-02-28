# Proposal: UI Cleanup and Zoom Improvements

## Why

ActionBar 中残留了多个仅用于开发测试的按钮（播放原音、加载模型、分析音频、合成），这些按钮不应出现在正式 UI 中，会造成界面混乱。同时，轨道面板和参数面板的横向初始缩放值偏小（50px/beat），导致内容显示过于密集；横向最大放大值（640px/beat）也不够大，限制了精细编辑的可能性。此外，参数面板使用 Ctrl+滚轮纵向缩放时，缩放中心固定在视口中心而非鼠标位置，操作体验不直观。

## What Changes

- **移除测试按钮**：从 `ActionBar` 中删除"播放原音"、"加载模型"、"分析音频"、"合成"四个按钮及其相关导入
- **提高初始缩放值**：将轨道面板和参数面板共用的 `DEFAULT_PX_PER_BEAT` 从 50 提升至 120，使内容默认以更合适的密度展示
- **扩大横向最大放大值**：将 `MAX_PX_PER_BEAT` 从 640 提升至 2000，支持更精细的时间轴编辑
- **参数面板纵向缩放以鼠标为中心**：修改 `usePianoRollInteractions.ts` 中 Ctrl+滚轮 的纵向缩放逻辑，使缩放中心锚定在鼠标当前位置（已有 `valueAtPointer` 和 `t` 变量，需修正 center 计算公式）

## Impact

- `frontend/src/components/layout/ActionBar.tsx`：删除 4 个测试按钮及相关 import
- `frontend/src/components/layout/timeline/constants.ts`：修改 `DEFAULT_PX_PER_BEAT`、`MAX_PX_PER_BEAT`
- `frontend/src/components/layout/pianoRoll/usePianoRollInteractions.ts`：修正 Ctrl+滚轮 纵向缩放的 center 计算
