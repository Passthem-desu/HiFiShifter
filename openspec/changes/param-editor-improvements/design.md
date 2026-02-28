## Goals

**Goals:**
- 删除 `breath` 参数占位符，保留架构扩展性
- 修正音高曲线 Y 坐标映射，使其对齐琴键中心
- 支持 pitch 和 tension 曲线同时叠加显示

**Non-goals:**
- 实现 breath 参数的实际功能
- 修改后端数据结构
- 修改交互逻辑（绘制/选区/复制粘贴）

---

## Current State

```
ParamName = "pitch" | "tension" | "breath"   ← breath 无实际功能
EditParam = "pitch" | "tension" | "breath"   ← 同上

valueToY("pitch", midi, h):
    // MIDI N 映射到 N 到 N+1 区间的底边（y = valueToY(N)）
    // 曲线画在琴键底部，视觉上偏低半格

usePianoRollData:
    // 只加载 editParam 对应的单条曲线
    paramView: ParamViewSegment | null

render.ts drawPianoRoll:
    // 只渲染 editParam 对应的曲线
```

---

## Design

### 1. 删除 breath 占位符

**受影响文件：**

| 文件 | 修改内容 |
|------|---------|
| `pianoRoll/types.ts` | `ParamName = "pitch" \| "tension"` + 注释说明扩展方式 |
| `features/session/sessionTypes.ts` | `EditParam = "pitch" \| "tension"` + 注释 |
| `components/layout/ActionBar.tsx` | 删除 `<Select.Item value="breath">` |
| `pianoRoll/usePianoRollInteractions.ts` | 删除 `editParam !== "breath"` 的特判分支 |
| `features/session/sessionSlice.ts` | 删除 `breath: AutomationPoint[]` 字段及初始值 |

**扩展性保留方式：** 在 `types.ts` 中添加注释，说明新增参数只需：
1. 在 `ParamName` 联合类型中添加字面量
2. 在 `PARAM_AXIS_CONFIGS`（见下文）中添加对应配置
3. 后端实现对应的 `get_param_frames` 分支

---

### 2. 音高线居中对齐

**问题根因：**

```
// 当前 valueToY("pitch", midi, h)
// MIDI 值 N 对应 y = (1 - t) * H，其中 t = (N - min) / span
// 这把 N 映射到 N 和 N+1 之间的分界线（底边）
// 视觉上曲线在 C4 键的底部，而非中心

// 期望：MIDI 值 N 的曲线应画在 N 键的中心
// 即 y_center(N) = (y_bottom(N) + y_bottom(N+1)) / 2
//               = valueToY(N + 0.5, h)
```

**修改方案：** 在 `drawCurveTimed` 调用时，对 pitch 参数的 `valueToY` 加 0.5 偏移：

```
// render.ts 中 drawCurveTimed 内部
const y = valueToY(param, param === "pitch" ? values[i] + 0.5 : values[i], h);
```

或者更干净地，在 `render.ts` 中引入 `curveValueToY` 包装函数，pitch 时自动加 0.5：

```typescript
function curveValueToY(
    param: ParamName,
    v: number,
    h: number,
    valueToY: (p: ParamName, v: number, h: number) => number
): number {
    return valueToY(param, param === "pitch" ? v + 0.5 : v, h);
}
```

`drawCurveTimed` 接收此包装函数替代原始 `valueToY`，轴渲染（钢琴键）不受影响。

---

### 3. 多参数同时显示

#### 3.1 数据层：usePianoRollData 扩展

`usePianoRollData` 当前只加载 `editParam` 对应的单条曲线。需要同时加载 pitch 和 tension：

```
// 新增返回值
{
    paramView: ParamViewSegment | null,        // 主参数（editParam）
    secondaryParamView: ParamViewSegment | null // 副参数（另一个）
}
```

**加载策略：**
- 主参数（`editParam`）：完整加载，包含 orig + edit，支持 live 编辑覆盖
- 副参数（另一个）：只加载 edit 曲线用于显示，不参与交互
- 副参数使用独立的 fetch 请求，不影响主参数的刷新逻辑
- 副参数的 `pitchEnabled` 检查：若 editParam 为 tension，pitch 作为副参数时仍需检查 pitchEnabled

#### 3.2 渲染层：render.ts 扩展

`drawPianoRoll` 新增 `secondaryParamView` 参数，在主曲线之前绘制副曲线（层级更低）：

```
渲染顺序（从底到顶）：
1. 背景波形
2. 选区高亮
3. 水平网格线（pitch 模式）
4. 副参数曲线（半透明，细线）← 新增
5. 主参数 orig 曲线（虚线）
6. 主参数 edit 曲线（实线）
7. 播放头
```

**副参数曲线样式：**
- pitch 副曲线：`rgba(100, 200, 255, 0.45)`，lineWidth 1.5，实线
- tension 副曲线：`rgba(255, 180, 60, 0.45)`，lineWidth 1.5，实线
- 副参数只显示 edit 曲线，不显示 orig 虚线

**副参数轴：**
- 当 editParam 为 pitch 时，左轴显示钢琴键（不变）；右侧不额外显示 tension 轴（避免视觉混乱）
- 当 editParam 为 tension 时，左轴显示 tension 刻度（不变）；pitch 副曲线使用 pitch 的 valueToY 映射，但不显示钢琴键轴

#### 3.3 PianoRollPanel 调整

- 将 `secondaryParamView` 传入 `drawPianoRoll`
- `usePianoRollData` 返回 `secondaryParamView`，Panel 直接透传给 render

---

## Risks / Trade-offs

| 风险 | 说明 | 缓解 |
|------|------|------|
| 副参数 fetch 增加请求数 | 每次刷新多一个 API 请求 | 副参数使用相同的 debounce 和缓存策略 |
| pitch 副曲线在 tension 视图下坐标系不同 | pitch 值域 36-96，tension 视图 0-1，直接叠加会错位 | 副参数使用自己的 valueToY（pitch 用 pitchView，tension 用 tensionView） |
| 删除 breath 后 sessionSlice 中的 automation 数据 | `breath: AutomationPoint[]` 字段被删除 | 同步删除初始值和相关 reducer |
