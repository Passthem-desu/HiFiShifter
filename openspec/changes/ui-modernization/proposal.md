# Proposal: UI Modernization

## Why

HiFiShifter 的当前 UI 沿用了 Qt 仿真风格（纯灰色系、字母标签按钮、emoji 图标），视觉层次平淡、控件语义不清晰，与现代创意工具的审美存在明显差距。用户在使用过程中面临以下问题：

- 多个 Bar（MenuBar / ActionBar / PianoRollPanel Header）背景色相同，视觉层次感缺失
- TrackList 和 ClipHeader 中的 M/S/C 字母按钮语义不直观，激活状态颜色（红/橙）传递"警告"而非"功能激活"
- emoji 图标（👁/👁‍🗨）跨平台渲染不一致，与 Radix Icons 风格不搭
- 整体色彩系统偏"工具灰"，缺乏现代创意工具的个性感
- ClipItem 选中/未选中/hover 三态边框区分不够清晰
- 轨道颜色系统（ClipInfo.color 已有 4 色）未在 TrackList 侧边栏中体现

## What Changes

- **色彩系统升级**：将深色主题从纯 Qt 灰色系迁移到带微蓝调的现代深色，高亮色从 `#2a82da` 调整为更柔和的 `#4f8ef7`，同时新增 `--qt-accent` 作为强调色
- **Bar 层次感**：MenuBar 使用最深背景（`--qt-panel`），ActionBar 使用中间层（`--qt-window`），PianoRollPanel Header 使用 `--qt-base`，通过背景色差异建立视觉层级
- **图标系统替换**：用 Radix Icons 替换所有 emoji 图标和字母标签按钮（M→SpeakerOffIcon，S→StarIcon，C→MixerHorizontalIcon，👁→EyeOpenIcon/EyeClosedIcon，Refresh→ReloadIcon）
- **TrackList 按钮语义修正**：Mute 激活色改为 amber（"静音中"），Solo 激活色改为 blue（"聚焦"），Compose 激活色保持 highlight
- **ClipItem 三态边框**：未选中 `border-white/20`，hover `border-white/40`，选中 `border-white/80 + ring`
- **轨道颜色系统**：TrackInfo 新增 `color` 字段，TrackList 侧边栏左侧 accent bar 使用轨道颜色，ClipItem 背景色跟随轨道颜色
- **ClipHeader 字体升级**：`text-[10px]` 统一改为 `text-xs`（0.7rem），增益把手改为 `DragHandleDots2Icon`

## Impact

- `frontend/src/index.css`：CSS 变量更新
- `frontend/src/components/layout/MenuBar.tsx`：背景色调整
- `frontend/src/components/layout/ActionBar.tsx`：背景色调整，Refresh 按钮图标化
- `frontend/src/components/layout/PianoRollPanel.tsx`：Header 背景色，👁 emoji 替换为 EyeOpenIcon/EyeClosedIcon，Refresh 替换为 ReloadIcon
- `frontend/src/components/layout/timeline/TrackList.tsx`：M/S/C 按钮图标化，激活色修正，accent bar 颜色跟随轨道色
- `frontend/src/components/layout/timeline/ClipItem.tsx`：三态边框，背景色跟随轨道色
- `frontend/src/components/layout/timeline/clip/ClipHeader.tsx`：字体升级，增益把手图标化
- `frontend/src/features/session/sessionTypes.ts`：TrackInfo 新增 `color` 字段
- `backend/src-tauri/src/`：TrackState 新增 color 字段，addTrack 时分配默认颜色
