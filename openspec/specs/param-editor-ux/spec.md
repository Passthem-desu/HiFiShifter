## Capability: 参数编辑区 UX 修复

### Context

参数编辑区（PianoRollPanel）用于编辑音高（pitch）和张力（tension）曲线，支持多参数叠加显示。

---

## Requirements

### Requirement: 副参数显示开关默认关闭

**Requirement text:** 每个副参数（非当前 editParam 的参数）有独立的显示开关，默认为关闭状态。

#### Scenario: 初始状态下副参数不显示
- **GIVEN** 参数编辑区处于任意 editParam 模式
- **WHEN** 用户未手动开启副参数显示
- **THEN** canvas 上只显示当前 editParam 的曲线，不显示副参数曲线

#### Scenario: 用户开启副参数显示
- **GIVEN** 参数编辑区处于 pitch 模式
- **WHEN** 用户点击 tension 副参数的显示开关（眼睛图标）
- **THEN** tension 的 edit 曲线以橙色半透明样式叠加显示在 pitch 曲线下方

#### Scenario: 切换 editParam 后副参数开关状态保留
- **GIVEN** 用户在 pitch 模式下开启了 tension 副参数显示
- **WHEN** 用户切换 editParam 为 tension
- **THEN** pitch 副参数的显示开关状态保留（若之前开启则仍开启）

#### Scenario: 副参数不可用时开关不显示
- **GIVEN** 参数编辑区处于 tension 模式
- **WHEN** pitchEnabled 为 false
- **THEN** pitch 副参数的显示开关不显示（因为 pitch 数据不可用）

---

### Requirement: 波形预取边距覆盖 5 倍可见宽度

**Requirement text:** 背景波形的预取范围应覆盖当前可见区域两侧各 2 倍可见宽度，总计 5 倍可见宽度，减少用户移动视图后重新 fetch 的频率。

#### Scenario: 移动 1 倍可见宽度后不重新 fetch
- **GIVEN** 参数编辑区已加载背景波形
- **WHEN** 用户将视图向右移动 1 倍可见宽度
- **THEN** 背景波形不重新发起 fetch 请求（已在预取范围内）

#### Scenario: 移动超过 2 倍可见宽度后重新 fetch
- **GIVEN** 参数编辑区已加载背景波形
- **WHEN** 用户将视图向右移动超过 2 倍可见宽度
- **THEN** 背景波形重新发起 fetch 请求

---

### Requirement: 音频导入后曲线自动显示

**Requirement text:** 音频初次导入后，参数编辑区应在 pitch 分析完成后自动显示曲线，无需用户手动点击刷新按钮。

#### Scenario: 初次导入后曲线自动显示
- **GIVEN** 用户导入了一个新的音频文件
- **WHEN** 后端 pitch 分析完成（pitch_orig_updated 事件触发）
- **THEN** 参数编辑区自动显示 pitch 曲线，无需用户手动刷新

#### Scenario: paramsEpoch 变化时清除旧曲线
- **GIVEN** 参数编辑区正在显示某个曲线
- **WHEN** paramsEpoch 发生变化（undo/redo/导入新音频）
- **THEN** 旧曲线立即清除，重新从后端拉取最新数据
