## 1. 移除 ActionBar 测试按钮

- [x] 1.1 删除 `ActionBar.tsx` Transport 区域中的"播放原音"按钮（`playOriginal`）
- [x] 1.2 删除 `ActionBar.tsx` Actions 区域整块（加载模型、分析音频、合成三个按钮及其 `<Separator>`）
- [x] 1.3 清理 `ActionBar.tsx` 顶部不再使用的 import：`loadModel`、`playOriginal`、`processAudio`、`synthesizeAudio`、`importAudioFromDialog`、`LightningBoltIcon`、`MagnifyingGlassIcon`

## 2. 调整缩放常量

- [x] 2.1 修改 `frontend/src/components/layout/timeline/constants.ts`：将 `DEFAULT_PX_PER_BEAT` 从 `50` 改为 `120`
- [x] 2.2 修改 `frontend/src/components/layout/timeline/constants.ts`：将 `MAX_PX_PER_BEAT` 从 `640` 改为 `2000`

## 3. 修正参数面板纵向缩放锚点

- [x] 3.1 修改 `frontend/src/components/layout/pianoRoll/usePianoRollInteractions.ts`：在 Ctrl+滚轮 纵向缩放逻辑中，将 pitch 和 tension/breath 两处的 center 计算从 `valueAtPointer - (t - 0.5) * nextSpan` 改为 `valueAtPointer - (0.5 - t) * nextSpan`，使缩放中心锚定在鼠标位置
