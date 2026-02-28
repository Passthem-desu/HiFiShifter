# Spec: UI Modernization

## Capability: 视觉层次与色彩系统

### ADDED Requirements

#### Requirement: Bar 层次感

> MenuBar、ActionBar、PianoRollPanel Header 通过背景色差异建立视觉层级

##### Scenario: 深色主题下 Bar 层级可见
- **GIVEN** 用户使用深色主题
- **WHEN** 查看 MenuBar / ActionBar / PianoRollPanel Header
- **THEN** 三个 Bar 的背景色应有可见差异（MenuBar 最深，ActionBar 居中，PianoRollPanel Header 稍浅）

#### Requirement: 现代深色色彩系统

> 深色主题使用带微蓝调的现代深色，高亮色更柔和

##### Scenario: 高亮色更新
- **GIVEN** 用户使用深色主题
- **WHEN** 查看选中状态、按钮激活状态等高亮元素
- **THEN** 高亮色应为 `#4f8ef7`（柔和蓝），而非原来的 `#2a82da`

---

## Capability: 图标系统统一

### ADDED Requirements

#### Requirement: 消除 emoji 图标

> 所有 emoji 图标替换为 Radix Icons

##### Scenario: 副参数开关图标
- **GIVEN** PianoRollPanel Header 中有副参数开关按钮
- **WHEN** 副参数开关处于关闭状态
- **THEN** 显示 `EyeClosedIcon`（Radix Icons）
- **WHEN** 副参数开关处于开启状态
- **THEN** 显示 `EyeOpenIcon`（Radix Icons）

##### Scenario: Refresh 按钮图标化
- **GIVEN** PianoRollPanel Header 中有 Refresh 按钮
- **WHEN** 查看 Refresh 按钮
- **THEN** 显示 `ReloadIcon`（Radix Icons），不显示文字

#### Requirement: 消除字母标签按钮

> TrackList 和 ClipHeader 中的 M/S/C 字母按钮替换为图标按钮

##### Scenario: TrackList Mute 按钮
- **GIVEN** TrackList 中有轨道
- **WHEN** 查看 Mute 按钮（未激活）
- **THEN** 显示 `SpeakerLoudIcon`
- **WHEN** 查看 Mute 按钮（已激活）
- **THEN** 显示 `SpeakerOffIcon`，背景色为 amber（琥珀色）

##### Scenario: TrackList Solo 按钮
- **GIVEN** TrackList 中有轨道
- **WHEN** 查看 Solo 按钮（未激活）
- **THEN** 显示 `StarIcon`
- **WHEN** 查看 Solo 按钮（已激活）
- **THEN** 显示 `StarFilledIcon`，背景色为 blue（蓝色）

##### Scenario: TrackList Compose 按钮
- **GIVEN** TrackList 中有根轨道
- **WHEN** 查看 Compose 按钮
- **THEN** 显示 `MixerHorizontalIcon`

##### Scenario: ClipHeader 静音按钮
- **GIVEN** ClipHeader 中有静音按钮
- **WHEN** 查看静音按钮
- **THEN** 显示 `SpeakerOffIcon` / `SpeakerLoudIcon`，不显示字母 M

##### Scenario: ClipHeader 增益把手
- **GIVEN** ClipHeader 中有增益拖拽把手
- **WHEN** 查看增益把手
- **THEN** 显示 `DragHandleDots2Icon`，cursor 为 `ns-resize`

---

## Capability: ClipItem 三态边框

### ADDED Requirements

#### Requirement: 选中状态清晰区分

> ClipItem 的未选中/hover/选中三态边框有明显视觉差异

##### Scenario: 未选中状态
- **GIVEN** ClipItem 未被选中
- **WHEN** 查看 ClipItem 边框
- **THEN** 边框为 `border-white/20`（低透明度白色）

##### Scenario: Hover 状态
- **GIVEN** ClipItem 未被选中，鼠标悬停
- **WHEN** 查看 ClipItem 边框
- **THEN** 边框为 `border-white/40`

##### Scenario: 选中状态
- **GIVEN** ClipItem 被选中
- **WHEN** 查看 ClipItem 边框
- **THEN** 边框为 `border-white/80`，并有微弱的 box-shadow 光晕

---

## Capability: 轨道颜色系统

### ADDED Requirements

#### Requirement: 轨道独立颜色

> 每个轨道有独立颜色，在 TrackList 和 ClipItem 中体现

##### Scenario: 新建轨道分配颜色
- **GIVEN** 用户新建轨道
- **WHEN** 轨道创建完成
- **THEN** 轨道自动分配预设颜色之一（按轮询顺序）

##### Scenario: TrackList accent bar 颜色
- **GIVEN** 轨道有 color 字段
- **WHEN** 查看 TrackList 左侧 accent bar
- **THEN** accent bar 颜色为 `track.color`

##### Scenario: ClipItem 背景色跟随轨道色
- **GIVEN** 轨道有 color 字段
- **WHEN** 查看该轨道上的 ClipItem
- **THEN** ClipItem 背景色为 `track.color` 的 20% 透明度版本

#### Requirement: 颜色持久化

> 轨道颜色随项目保存/加载持久化

##### Scenario: 项目保存后重新加载
- **GIVEN** 轨道有自定义颜色
- **WHEN** 保存项目后重新打开
- **THEN** 轨道颜色与保存前一致

---

## Capability: 字体大小统一

### ADDED Requirements

#### Requirement: 消除硬编码 text-[10px]

> 所有 `text-[10px]` 替换为设计系统中的 `text-xs`（0.7rem）

##### Scenario: ClipHeader 文字可读性
- **GIVEN** ClipHeader 中有 Clip 名称和增益数值
- **WHEN** 查看这些文字
- **THEN** 字体大小为 `text-xs`（0.7rem = 11.2px），不使用硬编码 `text-[10px]`
