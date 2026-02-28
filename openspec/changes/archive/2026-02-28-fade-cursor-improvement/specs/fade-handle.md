## ADDED Requirements

### Requirement: fade-handle-cursor
fade_in 和 fade_out 手柄的鼠标光标应为水平双向箭头，与实际拖拽方向一致。

#### Scenario: 悬停在 fade_in 手柄上
- **GIVEN** clip 有 fadeInBeats > 0
- **WHEN** 鼠标悬停在 fade_in 手柄区域
- **THEN** 光标显示为 `ew-resize`（水平双向箭头）

#### Scenario: 悬停在 fade_out 手柄上
- **GIVEN** clip 有 fadeOutBeats > 0
- **WHEN** 鼠标悬停在 fade_out 手柄区域
- **THEN** 光标显示为 `ew-resize`（水平双向箭头）

---

### Requirement: fade-handle-hit-area
fade 手柄的可交互区域应覆盖整个 fade 遮罩区域。

#### Scenario: fade_in 手柄命中区覆盖整个淡入区域
- **GIVEN** clip 有 fadeInBeats > 0，对应像素宽度为 W
- **WHEN** 用户在 clip body 左侧宽度 W 范围内的任意位置按下鼠标
- **THEN** 触发 fade_in 拖拽操作

#### Scenario: fade_out 手柄命中区覆盖整个淡出区域
- **GIVEN** clip 有 fadeOutBeats > 0，对应像素宽度为 W
- **WHEN** 用户在 clip body 右侧宽度 W 范围内的任意位置按下鼠标
- **THEN** 触发 fade_out 拖拽操作

#### Scenario: fade = 0 时无命中区
- **GIVEN** clip 的 fadeInBeats = 0（或 fadeOutBeats = 0）
- **WHEN** 用户点击 clip body 对应角落
- **THEN** 不触发 fade 拖拽，事件正常传递给下层（clip 选中等）

---

### Requirement: fade-handle-visual-indicator
保留视觉小方块作为"可拖拽"的视觉提示。

#### Scenario: 选中状态下显示视觉指示器
- **GIVEN** clip 处于选中状态，且 fadeInBeats > 0
- **WHEN** 渲染 clip
- **THEN** fade_in 区域左上角显示 14×14px 的半透明白色小方块

#### Scenario: 未选中状态下 hover 显示视觉指示器
- **GIVEN** clip 未选中，且 fadeInBeats > 0
- **WHEN** 鼠标悬停在 clip 上
- **THEN** fade_in 区域左上角的视觉小方块淡入显示（opacity-0 → opacity-90）
