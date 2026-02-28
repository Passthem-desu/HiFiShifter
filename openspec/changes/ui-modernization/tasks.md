# Tasks: UI Modernization

## 1. 层次 A：视觉打磨

- [x] 1.1 `index.css`：更新深色主题 CSS 变量（带微蓝调色彩系统，高亮色 `#4f8ef7`）
- [x] 1.2 `MenuBar.tsx`：背景色改为 `bg-qt-panel`
- [x] 1.3 `ActionBar.tsx`：背景色改为 `bg-qt-window`（已是，确认无需改动）
- [x] 1.4 `PianoRollPanel.tsx`：Header Bar 背景色改为 `bg-qt-base`；👁/👁‍🗨 emoji 替换为 `EyeOpenIcon`/`EyeClosedIcon`；Refresh 文字按钮替换为 `UpdateIcon` 图标按钮
- [x] 1.5 `TrackList.tsx`：M 按钮替换为 `SpeakerOffIcon`；S 按钮替换为 `StarIcon`；C 按钮替换为 `Pencil1Icon`；所有按钮加 `title` tooltip
- [x] 1.6 `ClipHeader.tsx`：静音按钮 M 替换为 `SpeakerOffIcon`；`text-[10px]` 统一改为 `text-xs`

## 2. 层次 B：布局优化

- [x] 2.1 `TrackList.tsx`：Mute 激活色改为 red；Solo 激活色改为 amber（使用 Radix IconButton color 语义）
- [x] 2.2 `ClipItem.tsx`：三态边框——未选中透明，hover `border-white/30`，选中 `border-white/90`

## 3. 层次 C：风格升级

- [x] 3.1 `sessionTypes.ts`：`TrackInfo` 新增 `color?: string` 字段
- [x] 3.2 后端 `state.rs`：`Track` 新增 `color: String` 字段，`#[serde(default)]`
- [x] 3.3 后端 `add_track`：新建轨道时按轮询顺序分配预设颜色（8色调色板）
- [x] 3.4 `TrackList.tsx`：左侧 accent bar 颜色改为 `track.color ?? "var(--qt-highlight)"`（inline style）
- [x] 3.5 `TrackLane.tsx` + `TimelinePanel.tsx`：新增 `trackColor` prop，通过 props 传递给 `ClipItem`
- [x] 3.6 `ClipItem.tsx`：背景色改为 `color-mix(in oklab, <trackColor> 30%, transparent)`；hover 边框色使用 `border-white/30`
- [x] 3.7 `render.ts`：钢琴键美化——白键改为带微蓝调浅灰色，黑键改为深色+渐变边缘，C 音名标注改为高亮蓝色
