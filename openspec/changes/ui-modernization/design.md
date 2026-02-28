# Design: UI Modernization

## Overview

将 HiFiShifter 的 UI 从 Qt 仿真灰色风格升级为现代创意工具风格（简洁 + 有个性），分三个层次按序实施：A（视觉打磨）→ B（布局优化）→ C（风格升级）。

## Goals

**Goals:**
- 建立清晰的视觉层次（Bar 层级、控件状态三态）
- 统一图标系统（全部使用 Radix Icons，消除 emoji 和字母标签）
- 修正控件语义（Mute/Solo 激活色传递正确含义）
- 支持轨道独立颜色，提升 Clip 辨识度
- 整体色彩向现代深色 DAW 靠拢（带微蓝调，高亮色更柔和）

**Non-goals:**
- 不改变任何功能逻辑
- 不引入新的第三方 UI 库
- 不修改 Light 主题（Light 主题使用 Radix 变量，已较现代）

## Architecture

### 层次 A：视觉打磨（低风险，高收益）

#### A1. 替换 emoji 图标为 Radix Icons

| 位置 | 当前 | 替换为 |
|------|------|--------|
| PianoRollPanel Header 副参数开关 | `👁` / `👁‍🗨` emoji | `<EyeOpenIcon>` / `<EyeClosedIcon>` |
| PianoRollPanel Header Refresh 按钮 | 文字 "Refresh" | `<ReloadIcon>` |
| TrackList Mute 按钮 | 字母 `M` | `<SpeakerOffIcon>` / `<SpeakerLoudIcon>` |
| TrackList Solo 按钮 | 字母 `S` | `<StarFilledIcon>` / `<StarIcon>` |
| TrackList Compose 按钮 | 字母 `C` | `<MixerHorizontalIcon>` |
| ClipHeader 增益把手 | 圆形 div | `<DragHandleDots2Icon>` |
| ClipHeader 静音按钮 | 字母 `M` | `<SpeakerOffIcon>` / `<SpeakerLoudIcon>` |

#### A2. Bar 层次感

通过背景色差异建立视觉层级（深→浅 = 底层→顶层）：

```
MenuBar:                bg-qt-panel  (#1e2128)  ← 最深
ActionBar:              bg-qt-window (#252830)  ← 中间
PianoRollPanel Header:  bg-qt-base   (#2a2d35)  ← 稍浅
内容区:                 bg-qt-graph-bg (#1a1d24) ← 最深（图形区）
```

#### A3. 统一字体大小

- ClipHeader 名称、增益数值：`text-[10px]` → `text-xs`（0.7rem）
- TrackList M/S/C 按钮：`text-[10px]` → 改为图标后不再需要字体

#### A4. 高亮色微调

```css
/* 当前 */
--qt-highlight: #2a82da  /* 纯蓝，饱和度偏高 */

/* 新值：稍微偏亮，带一点紫调，更现代 */
--qt-highlight: #4f8ef7
```

### 层次 B：布局优化（中等改动）

#### B1. TrackList 按钮语义修正

激活状态颜色修正，传递正确语义：

| 按钮 | 当前激活色 | 新激活色 | 语义 |
|------|-----------|---------|------|
| Mute | `bg-qt-danger-bg`（红） | `bg-amber-600`（琥珀） | "静音中"，非"危险" |
| Solo | `bg-qt-warning-bg`（橙） | `bg-blue-600`（蓝） | "聚焦"，非"警告" |
| Compose | `bg-qt-highlight`（蓝） | 保持 `bg-qt-highlight` | 无变化 |

#### B2. ClipItem 三态边框

```
未选中：border-white/20
hover：  border-white/40
选中：   border-white/80 + box-shadow: 0 0 0 1px rgba(255,255,255,0.15)
```

### 层次 C：风格升级（大改动）

#### C1. 色彩系统升级

将深色主题从纯 Qt 灰色系迁移到带微蓝调的现代深色：

```css
/* 新的深色主题 CSS 变量 */
--qt-window:  #252830   /* 带蓝调的深灰，主 Bar 背景 */
--qt-base:    #2a2d35   /* 稍浅，PianoRoll Header */
--qt-panel:   #1e2128   /* 最深，MenuBar */
--qt-surface: #2f3340   /* 控件表面 */
--qt-graph-bg: #1a1d24  /* 图形区背景 */
--qt-graph-grid-strong: #252830
--qt-graph-grid-weak:   #20232a
--qt-border:  #3a3d4a   /* 分隔线，带蓝调 */
--qt-button:  #2a2d35
--qt-button-hover: #353848
--qt-text:    #d4d8e8   /* 主文字，带微蓝调 */
--qt-text-muted: #8890a8
--qt-highlight: #4f8ef7  /* 高亮色，柔和蓝 */
--qt-scrollbar-thumb: #3a3d4a
--qt-scrollbar-thumb-hover: #4a4f60
```

#### C2. 轨道颜色系统

**数据层：**
- `TrackInfo` 新增 `color?: string` 字段（可选，默认 undefined）
- 后端 `TrackState` 新增 `color: Option<String>`
- `addTrack` 时按轮询顺序分配预设颜色：`["#4f8ef7", "#a78bfa", "#34d399", "#fbbf24", "#f87171", "#38bdf8"]`

**视觉层：**
- TrackList 左侧 accent bar：使用 `track.color ?? "var(--qt-highlight)"`
- ClipItem 背景色：使用 `track.color` 的 20% 透明度版本（通过 `color-mix` 实现）
- ClipItem 边框选中色：使用 `track.color` 的 60% 透明度版本

**颜色传递路径：**
```
TrackInfo.color
  → TrackList accent bar (直接使用)
  → ClipItem (通过 Timeline 组件 props 传递 trackColorMap)
```

#### C3. PianoRollPanel 钢琴键美化（Canvas 渲染）

在 `render.ts` 的 `drawAxis` 函数中：
- 白键：左侧 1px 亮线（`rgba(255,255,255,0.15)`），右侧渐变到稍暗
- 黑键：顶部 1px 高光（`rgba(255,255,255,0.2)`）
- C 音名标注：字体从 `9px` 升级到 `10px`，颜色从 `#888` 改为 `#aab`（带微蓝调）

## Key Design Decisions

1. **不改变 Light 主题**：Light 主题已使用 Radix 变量，视觉效果较好，本次只升级 Dark 主题
2. **轨道颜色存储在后端**：保证项目保存/加载时颜色持久化，前端只读取
3. **ClipInfo.color 字段保留但降级**：ClipInfo 已有 `color` 字段（`"blue" | "violet" | "emerald" | "amber"`），但实际渲染中改为跟随 TrackInfo.color，ClipInfo.color 暂时不再用于渲染（保留字段兼容性）
4. **图标按钮保留 tooltip**：所有图标按钮必须有 `title` 属性，保证可发现性
5. **按序实施 A→B→C**：每个层次独立可测试，C 层次依赖 A/B 完成

## Risks / Trade-offs

- **后端改动（C2）**：TrackState 新增字段需要同步修改 Rust 后端，涉及序列化/反序列化，需要确保旧项目文件兼容（`Option<String>` 默认 None）
- **Canvas 渲染（C3）**：钢琴键美化在 Canvas 中实现，需要测试不同 DPI 下的渲染效果
- **颜色传递路径（C2）**：Timeline 组件需要新增 `trackColorMap` prop，涉及多层 props 传递，可考虑通过 Redux state 传递以减少 prop drilling
