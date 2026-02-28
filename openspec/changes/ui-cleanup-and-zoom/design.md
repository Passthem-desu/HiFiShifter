# Design: UI Cleanup and Zoom Improvements

## Goals

**Goals:**
- 清理 ActionBar 中仅用于测试的按钮，使 UI 更简洁
- 提升轨道面板和参数面板的默认横向缩放值，改善初始视觉体验
- 扩大横向最大放大倍数，支持精细编辑
- 修正参数面板 Ctrl+滚轮 纵向缩放的锚点，使其以鼠标位置为中心

**Non-goals:**
- 不删除 `playOriginal`、`loadModel`、`synthesizeAudio` 等 thunk/API 逻辑（仅移除 UI 入口）
- 不修改纵向缩放的范围限制（`clampViewport` 逻辑保持不变）

## Current State

- `ActionBar.tsx` 中有 4 个测试按钮：播放原音（`playOriginal`）、加载模型（`loadModel`）、分析音频（`processAudio`/`importAudioFromDialog`）、合成（`synthesizeAudio`）
- `timeline/constants.ts`：`DEFAULT_PX_PER_BEAT = 50`，`MAX_PX_PER_BEAT = 640`
- `usePianoRollInteractions.ts` Ctrl+滚轮 纵向缩放：
  ```ts
  const next = clampViewport("pitch", {
      span: nextSpan,
      center: valueAtPointer - (t - 0.5) * nextSpan,
  });
  ```
  当前公式 `valueAtPointer - (t - 0.5) * nextSpan` 并不能保证鼠标下的值不变，缩放中心会漂移

## Key Design Decisions

### 1. 移除测试按钮

直接从 `ActionBar.tsx` 中删除以下内容：
- Transport 区域中的"播放原音"按钮（保留停止和播放合成按钮）
- Actions 区域整块（加载模型、分析音频、合成三个按钮）
- 对应的 import：`loadModel`、`playOriginal`、`processAudio`、`synthesizeAudio`、`importAudioFromDialog`、`LightningBoltIcon`、`MagnifyingGlassIcon`

### 2. 调整缩放常量

修改 `frontend/src/components/layout/timeline/constants.ts`：

| 常量 | 旧值 | 新值 | 说明 |
|------|------|------|------|
| `DEFAULT_PX_PER_BEAT` | 50 | 120 | 初始缩放更合适，内容不过于密集 |
| `MAX_PX_PER_BEAT` | 640 | 2000 | 支持更精细的时间轴编辑 |

> 注意：`TimelinePanel.tsx` 和 `usePianoRollInteractions.ts` 都通过 import 使用这两个常量，修改常量文件即可同时生效于两个面板。

### 3. 修正参数面板纵向缩放锚点

**问题分析**：缩放时要保持鼠标下的值不变，需满足：
```
valueAtPointer = center_new + (t - 0.5) * span_new
=> center_new = valueAtPointer - (t - 0.5) * span_new
```

当前代码已经是这个公式，但 `t` 的计算方式是 `yToViewportT(y, h)`，返回的是 `y/h`（0=顶部，1=底部），而 viewport 的 center 对应 `t=0.5`。

实际上公式本身是正确的，但需要验证 `yToViewportT` 的实现。查看 `usePianoRollData.ts` 中的定义：
- `yToViewportT(y, h)` 返回 `y / h`（归一化 y，0=顶，1=底）
- `yToValue(param, y, h)` 将 y 转换为实际值，center 对应 `y = h/2`

当前公式 `center = valueAtPointer - (t - 0.5) * nextSpan` 中：
- `t = y/h`，`t - 0.5 = (y - h/2) / h`
- `valueAtPointer = center_old + (0.5 - t) * span_old`（值轴：y 越大值越小）

值轴方向：y 增大 → 值减小，即 `value = center + (0.5 - t) * span`。

因此正确的锚点公式应为：
```ts
center_new = valueAtPointer - (0.5 - t) * nextSpan
```

即将 `(t - 0.5)` 改为 `(0.5 - t)`，使缩放中心真正锚定在鼠标位置。

## Risks / Trade-offs

- `DEFAULT_PX_PER_BEAT` 改为 120 后，localStorage 中已有旧值的用户不受影响（读取时优先使用 localStorage 存储值）；新用户或清除缓存后会使用新默认值
- 移除测试按钮后，开发调试需要通过其他方式触发这些操作（如直接调用 Redux action 或后端 API）
