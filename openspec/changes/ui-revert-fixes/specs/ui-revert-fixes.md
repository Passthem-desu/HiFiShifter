## CHANGED Requirements

### Requirement: TrackList M/S/C 按钮恢复字母标签

将 Mute/Solo/Compose 三个控制按钮从 Radix 图标恢复为字母标签（`M`/`S`/`C`）。

#### Scenario: Mute 按钮显示字母 M
- **GIVEN** TrackList 中存在一条轨道
- **WHEN** 渲染轨道控制区
- **THEN** Mute 按钮显示文字 `M`，未激活时为灰色，激活时为红色高亮

#### Scenario: Solo 按钮显示字母 S
- **GIVEN** TrackList 中存在一条轨道
- **WHEN** 渲染轨道控制区
- **THEN** Solo 按钮显示文字 `S`，未激活时为灰色，激活时为琥珀色高亮

#### Scenario: Compose 按钮显示字母 C
- **GIVEN** TrackList 中存在一条根轨道（非子轨道）
- **WHEN** 渲染轨道控制区
- **THEN** Compose 按钮显示文字 `C`，未激活时为灰色，激活时为蓝色高亮

---

### Requirement: 整体配色回退至棕灰色系

`index.css` 中 `.qt-theme.dark` 的 CSS 变量恢复为原棕灰色系。

#### Scenario: 深色主题使用棕灰背景色
- **GIVEN** 应用处于深色主题
- **WHEN** 渲染任意面板
- **THEN** 主窗口背景色为 `#353535`，面板背景色为 `#3a3a3a`，高亮色为 `#2a82da`

---

### Requirement: 音高网格线居中对齐琴键

`render.ts` 中水平网格线绘制在每个半音格的中心位置。

#### Scenario: 网格线位于琴键中心
- **GIVEN** 音高面板处于 pitch 编辑模式
- **WHEN** 绘制水平网格线
- **THEN** 每条线的 Y 坐标对应 `midi + 0.5` 的位置（半音格中心），而非 `midi` 整数边界

---

### Requirement: ActionBar 工具面板简化为图标按钮组

工具模式和编辑参数选择器改为紧凑的图标/文字切换按钮组。

#### Scenario: 工具模式切换按钮
- **GIVEN** ActionBar 已渲染
- **WHEN** 查看工具模式区域
- **THEN** 显示两个紧凑 IconButton（select 用光标图标，draw 用铅笔图标），当前激活模式按钮为 solid 样式，无需前置文字标签

#### Scenario: 编辑参数切换按钮
- **GIVEN** ActionBar 已渲染
- **WHEN** 查看编辑参数区域
- **THEN** 显示三个紧凑文字按钮（P/T/B 或 pitch/tension/breath 缩写），当前激活参数按钮高亮，无需前置文字标签
