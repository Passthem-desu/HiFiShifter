# Proposal: clip-fade-ux-improvement

## Why

Clip 的渐变（Fade In/Out）功能在交互体验上存在多处不足：

1. **鼠标指针提示不准确**：fade 控制区覆盖整个渐变区域，但鼠标指针始终显示 `ew-resize`，无法区分"拖拽调整渐变长度"与"拖拽移动 clip"两种意图，用户难以感知当前操作类型。
2. **曲线类型单一**：目前 fade in/out 只有正弦曲线（`sin(t·π/2)`），专业 DAW 通常提供线性、对数、指数、S 形等多种曲线，满足不同音频处理场景。
3. **可控制区与渐变区不一致**：fade handle 的可交互区域覆盖了整个渐变区域，但视觉指示器（小方块）仅出现在左上角/右上角，导致用户不清楚哪里可以拖拽，可发现性差。
4. **其他按钮可见性和可控性不足**：fade 区域内的视觉指示器在未选中/未 hover 时完全不可见（`opacity-0`），且尺寸偏小（14×14px），难以精确点击。
5. **波形显示和缓存可优化**：波形在 preview 状态下使用虚线描边，视觉上不够清晰；缓存策略在 sessionStorage 写入时存在性能问题（每次写入都遍历所有 key）。

## What Changes

- `paths.ts`：新增多种 fade 曲线类型（linear、exponential、logarithmic、s-curve），`fadeInAreaPath` / `fadeOutAreaPath` 接受 `curveType` 参数
- `sessionTypes.ts`：`ClipInfo` 新增 `fadeInCurve` / `fadeOutCurve` 字段（可选，默认 `"sine"`）
- `sessionSlice.ts`：`setClipFades` action 支持 `fadeInCurve` / `fadeOutCurve`；从后端数据映射时读取对应字段
- `ClipItem.tsx`：
  - fade handle 的鼠标指针改为 `col-resize`（更准确表达"调整宽度"语义）
  - 视觉指示器改为贯穿整个渐变区域的半透明条带，而非仅右上角小方块
  - 指示器在 hover 时始终可见（不再 `opacity-0`），选中时高亮
- `useClipWaveformPeaks.ts`：优化 sessionStorage 写入时的 key 遍历性能（维护独立计数器，避免每次全量扫描）
- `ClipItem.tsx`（波形）：preview 状态改用半透明实线而非虚线，视觉更清晰

## Impact

- 受影响文件：`paths.ts`、`sessionTypes.ts`、`sessionSlice.ts`、`ClipItem.tsx`、`useClipWaveformPeaks.ts`
- 无 API 变更，`fadeInCurve` / `fadeOutCurve` 为前端本地字段（后端暂不持久化，默认值兜底）
- 不影响现有 fade 长度拖拽逻辑（`useEditDrag.ts` 无需修改）
