## Why

参数编辑区存在三个 UX 问题：多参数叠加显示时副参数没有独立开关（默认全部显示，视觉噪音大）；背景波形在用户将窗口移出可见区域后再移回时会重新发起 fetch（预取边距不足，LRU 缓存 key 精确匹配导致 miss）；音频初次导入后曲线不显示，需要手动点击刷新按钮才能看到（pitch 分析异步完成后 `pitch_orig_updated` 事件触发的刷新路径在某些情况下不生效）。

## What Changes

- **副参数独立开关**：为每个副参数（pitch/tension）添加独立的显示开关，默认关闭，用户可在参数编辑区 header 中手动开启
- **波形预取边距扩大**：将 `marginSec`（波形预取边距）从 `1 × visibleDurSec` 扩大到 `2 × visibleDurSec`，使预取范围覆盖 5 倍可见宽度，减少移动后重新 fetch 的频率
- **初次导入自动显示曲线**：修复音频导入后曲线不自动显示的问题——在 `pitch_orig_updated` 事件处理路径中，确保即使 `rootTrackId` 刚刚变为有效值也能正确触发刷新；同时在 `paramsEpoch` 变化时清除 `paramView`（强制重新拉取），避免旧数据遮盖新导入的曲线

## Impact

- `frontend/src/components/layout/pianoRoll/usePianoRollData.ts`：扩大波形预取边距；修复初次导入后曲线不显示
- `frontend/src/components/layout/PianoRollPanel.tsx`：新增副参数显示开关状态；传递开关状态给 render
- `frontend/src/components/layout/pianoRoll/render.ts`：根据开关状态决定是否渲染副参数曲线
