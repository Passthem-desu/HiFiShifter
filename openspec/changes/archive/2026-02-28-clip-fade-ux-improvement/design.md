# Design: clip-fade-ux-improvement

## Goals

**Goals:**
- 鼠标指针语义准确，用户能直观感知 fade 区域的操作类型
- 提供 5 种 fade 曲线类型，满足不同音频处理场景
- fade 可控制区与渐变视觉区完全一致，消除交互歧义
- fade 指示器在 hover 时始终可见，提升可发现性
- 波形 preview 状态视觉更清晰，sessionStorage 写入性能更优

**Non-goals:**
- 不修改 fade 长度拖拽的核心逻辑（`useEditDrag.ts`）
- 不将 `fadeInCurve` / `fadeOutCurve` 持久化到后端（本次为前端本地状态）
- 不修改 fade 的音频处理逻辑（Rust 后端）

## Current State

```
paths.ts
  fadeInAreaPath(w, h, steps=24)  → sin(t·π/2) 曲线，固定
  fadeOutAreaPath(w, h, steps=24) → cos(t·π/2) 曲线，固定

ClipItem.tsx
  fade handle div: cursor="ew-resize"，覆盖整个渐变区域
  视觉指示器: 14×14px 小方块，仅在左上角/右上角，opacity-0 默认隐藏

sessionTypes.ts
  ClipInfo: { fadeInBeats, fadeOutBeats }  // 无曲线类型字段

useClipWaveformPeaks.ts
  ssSet(): 每次写入都遍历 sessionStorage 所有 key（O(n) 扫描）
  preview 状态: strokeDasharray="4 3"（虚线）
```

## Design

### 1. 鼠标指针优化

fade handle 的语义是"拖拽调整渐变长度"，应使用 `col-resize`（左右调整宽度）而非 `ew-resize`（双向箭头）。

```tsx
// ClipItem.tsx - fade handle div
// Before:
cursor: "ew-resize"
// After:
cursor: "col-resize"
```

### 2. 多曲线类型

**曲线类型定义：**

```ts
// sessionTypes.ts
export type FadeCurveType = "linear" | "sine" | "exponential" | "logarithmic" | "scurve";

export interface ClipInfo {
  // ...existing fields...
  fadeInCurve: FadeCurveType;   // default: "sine"
  fadeOutCurve: FadeCurveType;  // default: "sine"
}
```

**曲线函数映射（t ∈ [0,1] → gain ∈ [0,1]）：**

| 类型 | 公式 | 特点 |
|------|------|------|
| `linear` | `t` | 线性，最简单 |
| `sine` | `sin(t·π/2)` | 平滑，当前默认 |
| `exponential` | `t²` | 慢起快收，适合淡出 |
| `logarithmic` | `√t` | 快起慢收，适合淡入 |
| `scurve` | `3t²-2t³` | S 形，两端平滑 |

**`paths.ts` 修改：**

```ts
export type FadeCurveType = "linear" | "sine" | "exponential" | "logarithmic" | "scurve";

function fadeCurveGain(t: number, curve: FadeCurveType): number {
    switch (curve) {
        case "linear":      return t;
        case "exponential": return t * t;
        case "logarithmic": return Math.sqrt(t);
        case "scurve":      return 3 * t * t - 2 * t * t * t;
        case "sine":
        default:            return Math.sin((t * Math.PI) / 2);
    }
}

export function fadeInAreaPath(w, h, steps=24, curve: FadeCurveType = "sine"): string
export function fadeOutAreaPath(w, h, steps=24, curve: FadeCurveType = "sine"): string
```

**`areaPathFromMinMaxBand` 中的 fade 增益计算也需同步更新：**

```ts
// ClipItem.tsx - areaPathFromMinMaxBand
// 新增 fadeInCurve / fadeOutCurve 参数
if (safeFadeIn > 1e-9) mul *= fadeCurveGain(clamp(beatAtX / safeFadeIn, 0, 1), fadeInCurve);
if (safeFadeOut > 1e-9) mul *= fadeCurveGain(clamp((safeLenBeats - beatAtX) / safeFadeOut, 0, 1), fadeOutCurve);
```

**曲线选择 UI：** 右键 fade 区域弹出曲线选择菜单（复用现有 ContextMenu 模式），或在 fade handle 上方显示小型曲线选择器。本次采用**右键菜单**方式，最小侵入。

### 3. 可控制区与渐变区一致

当前问题：视觉指示器（小方块）只在角落，但整个渐变区域都可拖拽，用户不知道。

**方案：** 将视觉指示器改为覆盖整个渐变区域的半透明条带，与可交互区域完全重合。

```tsx
// fade in handle 内部视觉层
// Before: 14×14px 小方块在左上角
// After: 全区域半透明条带 + 右边缘竖线（表示可拖拽边界）
<div className="absolute inset-0 rounded-l-sm bg-white/8 border-r border-white/40 
                opacity-0 group-hover:opacity-100 transition-opacity" />
```

fade out 同理，左边缘竖线。

### 4. 提升可见性和可控性

- 指示器默认 `opacity-0` → `opacity-30`（始终微弱可见）
- hover 时 `opacity-100`
- 选中时 `opacity-100` + 边缘线加亮（`border-white/70`）
- 条带宽度与渐变区域完全一致，无需精确点击小方块

### 5. 波形显示和缓存优化

**波形 preview 状态：**
```tsx
// Before: strokeDasharray="4 3"（虚线，视觉噪声）
// After: 无 strokeDasharray，但降低 opacity（0.6）表示"加载中"
const dash = undefined; // 移除虚线
const opacity = peaks?.isPreview ? 0.6 : 1.0;
```

**sessionStorage 写入性能：**
```ts
// Before: 每次 ssSet() 都遍历 sessionStorage 所有 key（O(n)）
// After: 维护一个模块级 Set<string> 记录已写入的 key，O(1) 查找
const ssKeySet = new Set<string>();

function ssSet(key: string, seg: CachedSegment) {
    // 用 ssKeySet 替代遍历 sessionStorage
    if (ssKeySet.size >= SS_CACHE_LIMIT) {
        // 从 ssKeySet 中找最旧的（按 t 排序）
        // ...
    }
    ssKeySet.add(SS_KEY_PREFIX + key);
    sessionStorage.setItem(SS_KEY_PREFIX + key, JSON.stringify(seg));
}
```

## Key Design Decisions

1. **曲线类型存储在前端 Redux state**：`fadeInCurve` / `fadeOutCurve` 作为 `ClipInfo` 的可选字段，默认 `"sine"` 保持向后兼容。后端暂不持久化，刷新后重置为默认值（可在后续迭代中添加持久化）。

2. **曲线选择通过右键菜单**：避免在已经紧凑的 clip header 区域增加更多 UI 元素，右键菜单是最小侵入方案。

3. **fade 指示器改为全区域条带**：与可交互区域完全一致，消除"哪里可以点"的歧义，同时视觉上更清晰地展示渐变范围。

4. **移除 preview 虚线**：虚线在小尺寸 clip 上视觉噪声明显，改用透明度降低来表示"加载中"状态，更简洁。

## Risks / Trade-offs

- `fadeCurveGain` 函数需要同时在 `paths.ts`（SVG 路径）和 `ClipItem.tsx`（波形增益）中使用，需提取到共享位置（`paths.ts` 导出，`ClipItem.tsx` 导入）
- 右键菜单方案需要修改 `ClipContextMenu`，增加曲线选择子菜单，涉及文件略多
- sessionStorage key 集合（`ssKeySet`）在页面刷新后会重建，但这是可接受的（重建成本低）
