## Goals

**Goals:**
- 为副参数叠加显示添加独立的 per-param 开关，默认关闭
- 扩大波形预取边距，减少移动后重新 fetch 的频率
- 修复音频初次导入后曲线不自动显示的问题

**Non-goals:**
- 修改副参数的交互逻辑（副参数仍然只读）
- 修改后端数据结构

---

## Current State

```
// usePianoRollData.ts
const marginSec = visibleDurSec;  // 预取 1 倍，总覆盖 3 倍可见宽度
// 移动超过 1 倍可见宽度后，waveCoversVisible = false，触发重新 fetch

// 初次导入问题：
// importAudio → applyTimelineState → paramsEpoch++ → forceParamFetchToken++
// → refreshVisible() → getParamFrames()
// 但 pitch 分析是异步的，此时 getParamFrames 返回 analysis_pending=true, edit=[]
// pitch_orig_updated 事件到达时，若 pitchEnabled 为 true 且 rootTrackId 有效，
// 会触发 setForceParamFetchToken + setRefreshToken
// 问题：pitch_orig_updated 的 listener 在 useEffect([editParam, pitchEnabled, rootTrackId]) 中注册
// 若 rootTrackId 在 listener 注册后才变为有效值，listener 会重新注册，
// 但若 pitch_orig_updated 事件在 listener 重新注册前就已经触发，则会被错过
```

---

## Design

### 1. 副参数独立开关

**状态设计：**

```typescript
// PianoRollPanel.tsx 中新增
const [secondaryParamVisible, setSecondaryParamVisible] = useState<
    Partial<Record<ParamName, boolean>>
>({});

// 获取副参数的显示状态
function isSecondaryVisible(param: ParamName): boolean {
    return secondaryParamVisible[param] ?? false;  // 默认关闭
}
```

**UI 设计（Header Bar）：**

```
当前 editParam = "pitch" 时：
┌─────────────────────────────────────────────────────────────────┐
│ Parameter Editor  [Pitch][Tension]  [Badge][刷新]  [Algo▼]      │
│                   ↑ 当前 editParam  ↑ 点击切换副参数显示         │
└─────────────────────────────────────────────────────────────────┘
```

**实现方案：** 参数切换按钮组（`[Pitch][Tension]`）改为双功能按钮：
- 点击当前 editParam 对应的按钮：无操作（已选中）
- 点击另一个参数的按钮：
  - 若当前 editParam 不是该参数：切换 editParam（原有行为）
  - 若当前 editParam 是该参数：不切换，但这个按钮不会被点击（因为已选中）

**更清晰的方案**：在每个非当前参数的按钮旁边加一个小眼睛图标（👁），点击切换副参数显示。或者直接在按钮上用视觉区分：

```
editParam = "pitch" 时：
[● Pitch]  [○ Tension 👁]   ← 点击 Tension 按钮主体切换 editParam，点击 👁 切换副参数显示

更简单方案：
[● Pitch]  [Tension]        ← 点击切换 editParam（原有行为）
                              副参数开关通过 Header 右侧的小图标控制
```

**最终选择**：在 Header 中为每个非当前 editParam 的参数添加一个独立的小切换按钮（眼睛图标），点击切换该参数的副参数显示状态。位置在参数切换按钮组右侧，Algo 选择器左侧。

**传递给 render：**

```typescript
// drawPianoRoll 新增参数
secondaryParamView: ParamViewSegment | null;
showSecondaryParam: boolean;  // 由 isSecondaryVisible(secondaryParam) 决定
```

---

### 2. 波形预取边距扩大

**修改位置：** `usePianoRollData.ts` 的 `computeVisibleRequest` 函数

```typescript
// 当前
const marginSec = visibleDurSec;  // 预取 1 倍边距，总覆盖 3 倍可见宽度

// 修改为
const marginSec = visibleDurSec * 2;  // 预取 2 倍边距，总覆盖 5 倍可见宽度
```

**效果：** 用户需要移动超过 2 倍可见宽度才会触发重新 fetch，覆盖绝大多数正常使用场景。

**代价：** 每次 fetch 的数据量增加（covCols 会相应增大），但 `covCols` 已经被 clamp 到 2048，不会无限增长。

---

### 3. 初次导入后曲线不显示

**根因分析：**

```
时序问题：
T0: 用户导入音频
T1: importAudio.fulfilled → applyTimelineState → paramsEpoch++ → rootTrackId 变为有效值
T2: usePianoRollData 的 useEffect([paramsEpoch]) 触发 → setForceParamFetchToken++
T3: useEffect([..., forceParamFetchToken]) 触发 → refreshVisible()
T4: getParamFrames() 返回 { analysis_pending: true, edit: [] }
    → setParamView({ edit: [] })  ← 空数组，曲线不显示
T5: pitch_orig_updated 事件到达（分析完成）
    → 若 listener 已注册：setForceParamFetchToken++ → refreshVisible() → 曲线显示 ✓
    → 若 listener 未注册（rootTrackId 刚变为有效，listener 还在重新注册中）：事件被错过 ✗
```

**修复方案：**

**方案 A（推荐）**：在 `paramsEpoch` 变化时，清除 `paramView`（设为 null），强制下次 fetch 不走 `paramCoversVisible` 的缓存命中路径：

```typescript
useEffect(() => {
    if (!rootTrackId) return;
    setParamView(null);  // 新增：清除旧数据，避免旧曲线遮盖
    setForceParamFetchToken((x) => x + 1);
}, [paramsEpoch, rootTrackId]);
```

**方案 B**：在 `pitch_orig_updated` 的 listener 注册完成后，立即检查一次是否有待刷新的数据（补偿错过的事件）：

```typescript
// 在 setup() 完成后
if (!disposed && pitchAnalysisPending === false) {
    // 分析可能已经完成但事件被错过，触发一次刷新
    setForceParamFetchToken((x) => x + 1);
}
```

**选择方案 A**：更简单，且能同时解决 undo/redo 后旧曲线短暂显示的问题。

---

## Risks / Trade-offs

| 风险 | 说明 | 缓解 |
|------|------|------|
| 波形预取增大请求数据量 | covCols 增大，但已 clamp 到 2048 | 可接受，LRU 缓存会命中后续请求 |
| 方案 A 清除 paramView 导致短暂空白 | paramsEpoch 变化时曲线会短暂消失再出现 | 可接受，比"不显示需要手动刷新"体验更好 |
| 副参数开关状态不持久化 | 切换 editParam 后副参数开关状态保留，但刷新页面后重置 | 可接受，默认关闭是合理的初始状态 |
