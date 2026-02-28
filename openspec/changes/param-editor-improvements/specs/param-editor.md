## Capability: 参数编辑区视觉与数据改进

### Context

参数编辑区（PianoRollPanel）用于编辑音高（pitch）和张力（tension）曲线。

---

## CHANGED Requirements

### Requirement: ParamName 类型不包含 breath

**Requirement text:** `ParamName` 和 `EditParam` 联合类型只包含 `"pitch"` 和 `"tension"`，不包含 `"breath"`。

#### Scenario: 类型定义不含 breath
- **GIVEN** 开发者查看 `pianoRoll/types.ts` 和 `sessionTypes.ts`
- **WHEN** 检查 `ParamName` 和 `EditParam` 类型
- **THEN** 两者均为 `"pitch" | "tension"`，不含 `"breath"`

#### Scenario: ActionBar 不显示 breath 选项
- **GIVEN** 用户打开 ActionBar 的参数选择下拉框
- **WHEN** 查看可选参数列表
- **THEN** 列表中只有 pitch 和 tension，没有 breath

#### Scenario: 扩展性注释存在
- **GIVEN** 开发者查看 `pianoRoll/types.ts`
- **WHEN** 需要添加新参数
- **THEN** 文件中有注释说明如何扩展 `ParamName` 类型

---

### Requirement: 音高曲线对齐琴键中心

**Requirement text:** 在 pitch 模式下，MIDI 值 N 的曲线点应绘制在第 N 个琴键的垂直中心位置，而非琴键的底边。

#### Scenario: C4 音高线位于 C4 键中心
- **GIVEN** 参数编辑区处于 pitch 模式
- **WHEN** 音频的音高为 C4（MIDI 60）
- **THEN** 曲线线条绘制在 C4 琴键的垂直中心，视觉上与琴键对齐

#### Scenario: 轴渲染不受影响
- **GIVEN** 参数编辑区处于 pitch 模式
- **WHEN** 查看左侧钢琴键轴
- **THEN** 钢琴键的绘制位置不变，C 音名标注仍在琴键内部

---

### Requirement: pitch 和 tension 曲线同时显示

**Requirement text:** 参数编辑区同时渲染 pitch 和 tension 两条曲线，副参数曲线以半透明样式叠加显示。

#### Scenario: pitch 模式下同时显示 tension 副曲线
- **GIVEN** 参数编辑区处于 pitch 模式（editParam = "pitch"）
- **WHEN** tension 数据可用
- **THEN** tension 的 edit 曲线以橙色半透明样式（`rgba(255, 180, 60, 0.45)`）叠加显示在 pitch 曲线下方

#### Scenario: tension 模式下同时显示 pitch 副曲线
- **GIVEN** 参数编辑区处于 tension 模式（editParam = "tension"）
- **WHEN** pitch 数据可用且 pitchEnabled 为 true
- **THEN** pitch 的 edit 曲线以蓝色半透明样式（`rgba(100, 200, 255, 0.45)`）叠加显示在 tension 曲线下方

#### Scenario: 副参数曲线不显示 orig 虚线
- **GIVEN** 参数编辑区同时显示两条曲线
- **WHEN** 查看副参数曲线
- **THEN** 副参数只显示 edit 曲线（实线），不显示 orig 虚线

#### Scenario: 副参数不可交互
- **GIVEN** 参数编辑区同时显示两条曲线
- **WHEN** 用户在 canvas 上绘制
- **THEN** 只有主参数（editParam）的曲线被修改，副参数曲线不受影响

#### Scenario: pitch 不可用时不显示 pitch 副曲线
- **GIVEN** 参数编辑区处于 tension 模式
- **WHEN** pitchEnabled 为 false（未开启 compose 或 algo 为 none）
- **THEN** 不显示 pitch 副曲线
