# Tasks: UI Revert & Fixes

## 1. 配色改进：棕灰基础 + 现代化调整

- [x] 1.1 修改 `frontend/src/index.css`：将 `.qt-theme.dark` 中所有 CSS 变量改为棕灰改进版（`--qt-window: #353535`、`--qt-base: #2d2d2d`、`--qt-panel: #2a2a2a`、`--qt-surface: #404040`、`--qt-text: #d0d0d0`、`--qt-text-muted: #909090`、`--qt-highlight: #3b82f6`、`--qt-button: #3d3d3d`、`--qt-button-hover: #484848`、`--qt-border: #505050`、`--qt-scrollbar-thumb: #555555`、`--qt-scrollbar-thumb-hover: #707070`、`--qt-graph-bg: #252525`、`--qt-graph-grid-strong: #303030`、`--qt-graph-grid-weak: #2a2a2a`）
- [x] 1.2 修改 `frontend/src/components/layout/pianoRoll/render.ts`：将钢琴键白键颜色从 `#d8dce8` 改回 `#e8e8e8`，黑键从 `#1a1d26` 改回 `#1a1a1a`，C 音标注颜色从 `#4f8ef7` 改回 `#3b82f6`（与 highlight 保持一致），分隔线颜色从蓝调改回中性灰调

## 2. TrackList M/S/C 按钮恢复字母

- [x] 2.1 修改 `frontend/src/components/layout/timeline/TrackList.tsx`：将 Mute 的 `<IconButton><SpeakerOffIcon /></IconButton>` 改为显示字母 `M` 的紧凑按钮，激活色保持红色
- [x] 2.2 将 Solo 的 `<IconButton><StarIcon /></IconButton>` 改为显示字母 `S` 的紧凑按钮，激活色保持琥珀色
- [x] 2.3 将 Compose 的 `<IconButton><Pencil1Icon /></IconButton>` 改为显示字母 `C` 的紧凑按钮，激活色保持蓝色
- [x] 2.4 清理 `TrackList.tsx` 顶部不再使用的图标导入（`SpeakerOffIcon`、`StarIcon`、`Pencil1Icon`）

## 3. 音高网格线居中对齐

- [x] 3.1 修改 `frontend/src/components/layout/pianoRoll/render.ts`：在水平 pitch 网格线绘制循环中，将 `valueToY("pitch", midi, h)` 改为 `valueToY("pitch", midi + 0.5, h)`，使线条落在每个半音格中心

## 4. ActionBar 工具面板简化

- [x] 4.1 修改 `frontend/src/components/layout/ActionBar.tsx`：将工具模式区域的 `<Text>{t("tool_mode")}:</Text> + <Select>` 替换为两个紧凑 `<IconButton>`（select 用 `CursorArrowIcon`，draw 用 `Pencil1Icon`），激活态 `variant="solid"`
- [x] 4.2 将编辑参数区域的 `<Text>{t("edit_param")}:</Text> + <Select>` 替换为三个紧凑文字按钮（显示 `P`/`T`/`B`），激活态高亮，并移除 `PitchStatusBadge` 前的 `ml-1` 间距调整
