# Design: UI Revert & Fixes

## Context / Current State

上一轮 `ui-modernization` 改动引入了以下问题：

1. **TrackList M/S/C 按钮**：改为 `SpeakerOffIcon`/`StarIcon`/`Pencil1Icon` 图标，辨识度不如字母直观
2. **整体配色**：`--qt-window` 改为 `#22252e`（蓝灰），`--qt-highlight` 改为 `#4f8ef7`（亮蓝），与原棕灰风格不符。需在原棕灰基础上做现代化改进，而非完全回退
3. **音高面板网格线**：`render.ts` 中水平线绘制在 `midi` 整数边界（`y = valueToY("pitch", midi, h)`），而非琴键中心（`midi + 0.5`）
4. **ActionBar 工具面板**：工具模式/编辑参数仍使用 `<Text>` 标签 + `<Select>` 的冗长布局，未简化为紧凑图标按钮组

## Goals

- 恢复 M/S/C 字母按钮，保持简洁直观
- 在原棕灰色系基础上改进配色：保留棕灰色调，适度提升层次感和现代感
- 修正音高网格线对齐至琴键中心
- 简化 ActionBar 工具面板为图标按钮组（IconButton）

## Design Decisions

### 1. TrackList M/S/C 按钮恢复字母

将三个 `<IconButton>` 改回使用 `<Text>` 内容的紧凑按钮，样式保持 `variant="ghost"` / `variant="solid"`，激活色不变（M=red, S=amber, C=blue）。移除 `SpeakerOffIcon`、`StarIcon`、`Pencil1Icon` 的导入（如无其他使用则删除）。

```tsx
// 恢复后
<button className={`...muted ? 'text-red-400' : ''`} onClick={...}>M</button>
<button className={`...solo ? 'text-amber-400' : ''`} onClick={...}>S</button>
<button className={`...composeEnabled ? 'text-blue-400' : ''`} onClick={...}>C</button>
```

### 2. 配色改进：棕灰基础 + 现代化调整

**设计原则**：保留原棕灰色调（`#353535` 系列），在此基础上：
- 增加层次感（各层背景色差异更明显）
- 文字对比度更好（`#cccccc` → `#d0d0d0`）
- 高亮色保留蓝色但降低饱和度，更沉稳
- 边框色更清晰

| 变量 | 当前（蓝灰，需改） | 目标（棕灰改进版） | 说明 |
|------|-----------------|-----------------|------|
| `--qt-window` | `#22252e` | `#353535` | 恢复棕灰主色 |
| `--qt-base` | `#1e2128` | `#2d2d2d` | 内容区稍深 |
| `--qt-panel` | `#191c23` | `#2a2a2a` | 最深层，增加层次 |
| `--qt-surface` | `#2a2d38` | `#404040` | 表面层稍亮 |
| `--qt-text` | `#d4d8e8` | `#d0d0d0` | 保持高对比度 |
| `--qt-text-muted` | `#8890a8` | `#909090` | 次要文字 |
| `--qt-highlight` | `#4f8ef7` | `#3b82f6` | 蓝色降饱和，更沉稳 |
| `--qt-button` | `#2a2d38` | `#3d3d3d` | 按钮背景 |
| `--qt-button-hover` | `#333748` | `#484848` | hover 态 |
| `--qt-border` | `#353a4a` | `#505050` | 边框更清晰 |
| `--qt-scrollbar-thumb` | `#3a3f52` | `#555555` | 滚动条 |
| `--qt-scrollbar-thumb-hover` | `#4f5570` | `#707070` | 滚动条 hover |
| `--qt-graph-bg` | `#161920` | `#252525` | 图形区背景 |
| `--qt-graph-grid-strong` | `#252830` | `#303030` | 强网格线 |
| `--qt-graph-grid-weak` | `#1e2028` | `#2a2a2a` | 弱网格线 |

同时更新钢琴键颜色（render.ts）：白键从 `#d8dce8` 改回 `#e8e8e8`，黑键从 `#1a1d26` 改回 `#1a1a1a`，C 音标注从 `#4f8ef7` 改回 `#3b82f6`（与 highlight 保持一致）。

### 3. 音高网格线居中对齐

当前代码在 `midi` 整数边界绘制线，视觉上线在琴键顶部而非中间。修正方式：将 `valueToY("pitch", midi, h)` 改为 `valueToY("pitch", midi + 0.5, h)`，使线条落在每个半音格的中心。

```ts
// 修复前
const y = valueToY("pitch", midi, h);
// 修复后
const y = valueToY("pitch", midi + 0.5, h);
```

### 4. ActionBar 工具面板简化

将 `tool_mode` 和 `edit_param` 的 `<Text> + <Select>` 组合改为紧凑的图标/文字切换按钮组（`ToggleGroup` 或 `SegmentedControl` 风格），减少水平占用空间：

- **工具模式**：`select` 用 `CursorArrowIcon`，`draw` 用 `Pencil1Icon`，两个 `IconButton` 并排，激活态 `variant="solid"`
- **编辑参数**：`pitch`/`tension`/`breath` 三个紧凑文字按钮（`size="1"`），激活态高亮，无需前置 `<Text>` 标签

## Risks / Trade-offs

- 字母按钮在极小行高时可能截断，但当前 rowHeight 足够（≥48px）
- 棕灰体系中 `--qt-panel` 比 `--qt-window` 更暗（`#2a2a2a` < `#353535`），层级方向与蓝灰体系相反，需确认 MenuBar 视觉层级仍合理
- `--qt-highlight` 从 `#4f8ef7` 改为 `#3b82f6`（Tailwind blue-500），饱和度略低，在棕灰背景上更协调
