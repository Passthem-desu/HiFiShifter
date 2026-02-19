# HiFiShifter 开发手册

HiFiShifter 是一个基于深度学习神经声码器（NSF-HiFiGAN）的图形化人声编辑与合成工具。本文档面向开发者，介绍项目结构、关键模块、近期 GUI 重构引入的划分方式，以及常见扩展/调试建议。

## 0. 快速开发启动

- **Python**：建议 Python 3.10+
- **安装依赖**：

```bash
pip install -r requirements.txt
```

- **启动 GUI（推荐从仓库根目录启动）**：

```bash
python run_gui.py
```

> 说明：部分推理/训练相关代码位于仓库根目录（如 `training/`），因此推荐始终在仓库根目录运行；同时，音频处理子模块中也做了启动上下文兼容（见 `hifi_shifter/audio_processing/_bootstrap.py`）。

## 1. 项目概览

### 1.1 目录结构（更新版）

```text
HiFiShifter/
├── assets/
│   └── lang/                    # 语言包（zh_CN.json, en_US.json）
├── configs/                     # 模型配置文件（.yaml）
├── hifi_shifter/
│   ├── audio_processor.py        # 音频处理编排入口（GUI 调用的“对外 API”）
│   ├── audio_processing/         # 子处理模块（更易读、更易调试）
│   │   ├── features.py           # 音频加载/特征提取/分段
│   │   ├── hifigan_infer.py      # NSF-HiFiGAN 推理
│   │   ├── tension_fx.py         # 张力后处理（post-FX）
│   │   └── _bootstrap.py         # 启动上下文兼容（sys.path 注入）
│   ├── gui/                      # GUI 子包（按职责拆分）
│   │   ├── window.py             # `HifiShifterGUI` 主窗口（组合各 mixins）
│   │   ├── layout.py             # 主布局与控件搭建
│   │   ├── menu.py               # 菜单栏/主题/语言
│   │   ├── editor.py             # 编辑/选区/交互
│   │   ├── plotting.py           # 曲线绘制与刷新
│   │   ├── params.py             # 参数抽象与轴语义
│   │   ├── project_io.py         # 工程打开/保存/dirty 提示
│   │   ├── tracks.py             # 轨道/导入与管理
│   │   ├── synthesis.py          # 增量合成调度
│   │   ├── mixdown.py            # 混音与轨道取音频
│   │   ├── playback.py           # 实时播放（OutputStream）
│   │   ├── exporter.py           # 导出 WAV
│   │   ├── background.py         # 后台任务/线程封装
│   │   └── vocalshifter.py       # VocalShifter 导入
│   ├── main_window.py            # 兼容入口（re-export `HifiShifterGUI`）
│   ├── timeline.py               # 时间轴面板、多轨管理（UI 层）
│   ├── track.py                  # 音轨数据结构与缓存/撤销
│   ├── widgets.py                # 自定义 PyQtGraph 组件（轴/网格/ViewBox 等）
│   ├── theme.py                  # 主题与 QSS
│   └── ...
├── models/                       # 模型结构定义
├── modules/                      # 神经网络基础模块
├── training/                     # 训练/推理依赖的部分实现（顶层包）
├── utils/
│   ├── i18n.py                    # i18n 管理器（`i18n.get(key)`）
│   └── ...
├── run_gui.py                    # 程序入口
└── ...
```

### 1.2 核心数据流（高层）

- **UI 交互**（`hifi_shifter/gui/`；兼容入口为 `hifi_shifter/main_window.py`）
  - 接收鼠标/键盘事件 → 修改当前音轨的参数数组（如 `f0_edited`、`tension_edited`）
  - 对音高编辑：标记受影响分段为 dirty → 触发增量合成
  - 对张力编辑：属于 post-FX 逻辑，通常不需要重跑声码器（依实现而定）

- **音频处理**（`audio_processor.py` + `audio_processing/*`）
  - 加载模型 → 特征提取 → 分段 → 对脏片段推理合成 → 回写音轨缓存

## 2. 关键模块说明

## 近期改动（pywebview 前端时间轴/播放）

### 拖拽导入（Drag & Drop Import）

- 前端时间轴轨道区域支持拖拽导入本地音频文件。
- 路径解析策略：优先使用 `dataTransfer.files[0].path`（pywebview 环境常见），若不可用则尝试 `text/uri-list` 解析 `file:///...`，最后尝试 `text/plain`。
- 当拖拽落点不在任何轨道上时，后端 `import_audio_item(audio_path, track_id=None, start_beat=...)` 会创建新轨道并放置 item。
- 当 WebView 无法提供本地路径时，前端会走 bytes/base64 兜底导入（`import_audio_bytes(file_name, base64_data, ...)`），后端会保留原始 `file_name` 用于剪辑显示名（避免 temp 文件名污染 UI）。

### 无音频也可播放（Virtual Playback）

- 后端新增“虚拟播放”模式：当当前时间点之后无可播放音频片段时，不报错，改为启动一个静默的播放时钟（不调用声卡输出），让前端播放头依然能推进。

### 播放中跳转（Seek While Playing）

- 后端 `set_transport(playhead_beat=...)` 在检测到正在播放时，会重启播放到新的 playhead 位置（对齐 DAW 的点击跳播行为）。
- 前端在 `seekPlayhead.fulfilled` 且 `isPlaying` 时更新 `playbackAnchorBeat`，保证 `position_sec`（从 0 计时）到 beat 的换算正确。

### 工程边界与网格裁剪

- 时间轴 BPM 网格绘制被限制在工程内容宽度（`projectBeats`）内；边界外保持纯底色。
- 在工程末尾绘制明显边界线，提示工程时长终点。

### 2.1 GUI 主窗口与交互（`hifi_shifter/gui/`）

历史上 GUI 大量逻辑集中在 `hifi_shifter/main_window.py`，阅读和维护成本较高。当前已按职责拆分到 `hifi_shifter/gui/` 子包中：

- **主窗口类**：`HifiShifterGUI` 位于 `gui/window.py`，负责把各个职责模块（mixins）组合成一个可运行的主窗口。
- **兼容性**：`hifi_shifter/main_window.py` 现在仅作为兼容入口，re-export `HifiShifterGUI`，避免外部导入路径变更。

`HifiShifterGUI` 的职责概览：
- UI 组装：菜单/顶部控制栏/编辑区/时间轴（对应 `gui/menu.py`、`gui/layout.py`）
- 工程 IO：打开/保存/dirty 标记与退出提示（`gui/project_io.py`）
- 轨道与导入：音频载入、轨道创建/选择/状态维护（`gui/tracks.py`，以及部分 `timeline.py`）
- 编辑交互：Edit/Select 模式、选区、拖拽、撤销重做（`gui/editor.py`）
- 参数系统：参数抽象、轴语义、切参联动（`gui/params.py`）
- 绘图刷新：曲线项维护与高亮渲染（`gui/plotting.py`）
- 合成/任务：dirty segments、增量合成调度、后台线程（`gui/synthesis.py`、`gui/background.py`）
- 播放与混音：实时播放回调、轨道混音与 post-FX（`gui/playback.py`、`gui/mixdown.py`）
- 导出：导出 WAV（`gui/exporter.py`）

#### 实时播放（流式混音，推子/静音/独奏播放中生效）

为保证播放时调音量推子、静音、独奏能即时生效，播放链路已从“一次性离线混音 + `sd.play()`”改为 **`sounddevice.OutputStream` 回调式实时混音**（实现集中在 `gui/playback.py`/`gui/mixdown.py`）。

实现要点：
- **回调线程不触碰 Qt**：音频回调运行在 sounddevice 的音频线程，仅读取 `Track` 的 `volume`/`muted`/`solo` 等状态并生成输出块。
- **最小共享状态**：通过 `self._playback_lock` 保护 `_playback_sample_pos` 等少量共享变量；GUI 用定时器读取采样位置驱动播放光标。
- **独奏优先级**：任意轨道 `solo=True` 时，仅混入独奏轨道；否则混入所有未静音轨道。
- **生效时延**：参数变化会在“下一块音频”生效（通常为几十毫秒量级，取决于设备缓冲）。

#### 参数编辑系统（参数抽象 + 轴语义）

- 当前编辑参数：`edit_param`（目前支持 `pitch` / `tension`）
- 顶部栏参数选择与编辑区参数按钮：保持同步（切换参数统一走 `set_edit_param()`）
- 参数抽象与轴语义主要位于 `gui/params.py`；交互写入/选区拖拽等位于 `gui/editor.py`；曲线绘制刷新位于 `gui/plotting.py`。

未来新增参数时，建议按“参数抽象接口”补齐：
- **数据访问**：取/写参数数组（例如从 `Track` 取 `xxx_edited`）
- **曲线渲染**：将参数数值映射到绘图区 Y 值（尤其是非音高参数）
- **拖拽/绘制**：实现该参数的笔刷编辑与选区拖拽偏移
- **轴语义**：定义该参数的轴类型（音名 `note` 或数值 `linear`）与格式化

### 2.2 选区系统与选中高亮（通用化）

选区相关关键状态：
- `selection_mask`：bool 数组，标记当前选中的采样点
- `selection_param`：记录该选区属于哪个参数，避免切参后误用

高亮实现策略：
- 使用独立曲线项（`selected_param_curve_item`）渲染“仅选中部分”的曲线
- 通过把未选中点置为 `NaN` 并设置 `connect="finite"`，只绘制连续的选中段

### 2.3 轴系统：刻度与左侧标题随参数切换

- `widgets.py` 的 `PianoRollAxis` 不再硬编码“音高/张力模式”。
- 它会向 GUI 主类（`HifiShifterGUI`）询问：
  - 当前轴对应的参数（通常是 `edit_param`）
  - 轴类型：`note`（音名）或 `linear`（数值）
  - 数值 ↔ 绘图区 Y 的映射、以及刻度字符串格式化

同时，GUI 主类会在切参时更新：
- 左侧 **竖向标题**（例如“音高 (Note)”/“张力 (Tension)”）
- 左侧刻度显示（音名 vs 数值）

### 2.4 音频处理编排与子模块（`audio_processor.py` / `audio_processing/`）

- `audio_processor.py`：对 GUI 保持稳定的入口与 API（负责调度流程）。
- `audio_processing/`：分离可独立调试的处理阶段：
  - `features.py`：音频加载、特征提取（如 mel/f0）、分段工具
  - `hifigan_infer.py`：NSF-HiFiGAN 模型加载与推理
  - `tension_fx.py`：张力 post-FX（不必重跑声码器即可改变听感的部分）
  - `_bootstrap.py`：确保仓库根目录在 `sys.path`，避免运行上下文不同导致导入失败
### 前端界面架构（pywebview + React）

为实现更现代化的用户界面，项目采用了混合架构：
- **后端**：Python 处理所有业务逻辑（音频处理、模型推理、状态管理）
- **前端**：React + TypeScript + Tailwind CSS 负责 UI 渲染和交互
- **通信**：通过 pywebview 的 JS API 进行前后端通信

#### 前端项目结构

```text
frontend/
├── src/
│   ├── components/
│   │   ├── editor/          # 编辑器相关组件
│   │   │   ├── TimelinePanel.tsx   # 时间线面板（轨道、剪辑）
│   │   │   └── PianoRollPanel.tsx  # 钢琴卷帘（参数编辑）
│   │   └── layout/          # 布局组件
│   │       ├── MenuBar.tsx      # 菜单栏
│   │       └── ActionBar.tsx    # 操作栏
│   ├── features/
│   │   └── session/         # Redux 状态管理
│   │       └── sessionSlice.ts  # 会话状态切片
│   ├── services/
│   │   └── webviewApi.ts    # Python API 调用封装
│   └── types/
│       └── api.ts           # API 类型定义
└── ...
```

#### 音频编辑功能实现

项目实现了类似 Reaper 的音频编辑功能：

1. **音频切片（Split Clip）**
   - **实现位置**：`web_api.py::split_clip()` + `sessionSlice.ts::splitClipRemote`
   - **功能**：在播放头位置分割选中的音频剪辑为两个独立剪辑
   - **快捷键**：S 键（在选中剪辑时按下）
   - **实现细节**：
     - 在指定位置创建新剪辑
     - 自动调整原剪辑和新剪辑的长度和裁剪参数
     - 保留原剪辑的所有属性（增益、静音状态等）

2. **淡入淡出（Fade In/Out）**
   - **数据结构**：`ClipState.fade_in_beats` / `ClipState.fade_out_beats`
   - **UI 控制**：
     - 剪辑属性面板中的 Fade In/Out 输入框
     - 时间线剪辑左上角/右上角手柄直接拖拽（MVP）
   - **视觉效果**：剪辑上显示淡入/淡出斜线，直观展示范围
   - **实现细节**：
     - 使用 SVG 绘制淡入淡出覆盖层
     - 淡入淡出长度限制为不超过剪辑长度
     - 支持即时预览淡入淡出效果

3. **时间拉伸（Playback Rate）**
   - **数据结构**：`ClipState.playback_rate`（范围 0.25 - 4.0）
   - **UI 控制**：剪辑属性面板中的 Rate 输入框
   - **功能**：调整剪辑播放速度，实现时间拉伸和缩短效果
   - **应用场景**：变速播放、匹配节奏、创意效果

4. **音频裁剪（Trim）**
   - **数据结构**：`ClipState.trim_start_beat` / `ClipState.trim_end_beat`
   - **UI 控制**：
     - 剪辑属性面板中的 Trim In/Out 输入框
     - 时间线剪辑左右边界拖拽（MVP）
   - **功能**：精确控制剪辑的起始和结束位置，不改变源文件
   - **实现细节**：
     - 裁剪参数以拍（beat）为单位
     - 支持独立调整起点和终点

5. **剪辑静音（Clip Mute）**
  - **数据结构**：`ClipState.muted`
  - **UI 控制**：时间线剪辑左上角 `M` 按钮
  - **行为**：
    - `muted=true` 时剪辑整体变灰（仅 UI 表现）
    - 混音/播放时会跳过该剪辑（后端 `_mix_project_audio` 会过滤 `clip.muted`）

6. **多选组移动（Group Move）**
  - **UI 控制**：右键框选多个剪辑后，拖拽任意一个选中剪辑
  - **行为**：所有选中剪辑按同一时间偏移一起移动（并做边界约束，避免移动到负时间）

7. **轨道纵向缩放（Track Vertical Zoom）**
  - **UI 控制**：时间线区域 `Alt + 鼠标滚轮`
  - **行为**：调整轨道 lane 高度（影响左侧轨道列表与右侧时间线轨道区域），并持久化到 localStorage
     - 剪辑拖拽调整大小时自动更新裁剪参数
     - 若能获得源音频时长（`duration_sec`），拖拽会自动 clamp，避免超过源范围

5. **多选与胶合（Glue）**
   - **实现位置**：`web_api.py::glue_clips()` + `sessionSlice.ts::glueClipsRemote`
   - **交互**：
     - 在时间线空白处按住鼠标右键拖拽可框选多个剪辑
     - 右键剪辑弹出菜单执行“胶合”（要求同轨且至少 2 个剪辑）

#### 界面优化

- **现代化 DAW 风格**：参考现代 DAW 软件（如 Reaper、Ableton Live）的设计语言
- **暗色主题**：使用深色背景和高对比度配色，减少视觉疲劳
- **视觉层次**：通过阴影、渐变、边框等元素增强界面层次感
- **交互反馈**：
  - 剪辑悬停/选中状态有明显的视觉反馈
  - 淡入淡出效果在剪辑上直观显示
  - 平滑的动画过渡效果
## 3. 国际化（i18n）

- 语言文件：`assets/lang/zh_CN.json`、`assets/lang/en_US.json`
- 使用方式：
  - 在代码中使用 `from utils.i18n import i18n`，再通过 `i18n.get("key")` 获取文本
- 常用键：
  - `label.edit_param`（顶部栏“编辑”标签）
  - `param.pitch` / `param.tension`（参数名）
  - `status.tool.edit` / `status.tool.select`（状态栏提示模板）

> 注意：带参数的模板使用 `str.format`，例如 `i18n.get("status.tool.edit").format("音高")`。

## 4. 调试建议

- **建议断点**：
  - 参数切换：`HifiShifterGUI.set_edit_param()`（实现通常位于 `gui/params.py` 相关 mixin）
  - 选区更新：`set_selection()` / `update_selection_highlight()`（主要在 `gui/editor.py` / `gui/plotting.py`）
  - 合成触发：dirty 标记与自动合成调度（`gui/synthesis.py`）
  - 推理阶段：`audio_processing/hifigan_infer.py` 的推理入口
- **性能关注点**：
  - 特征提取与推理应避免阻塞 UI 主线程（如后续引入线程/任务队列）
  - 长音频导入时的初始特征提取开销较大，建议开发时使用短音频验证交互

## 5. 常见扩展任务（建议路径）

### 5.1 新增一个可编辑参数（推荐流程）

1. **`Track` 增加数据字段**：例如 `xxx_original` / `xxx_edited` / undo 栈等。
2. **补齐参数抽象与轴语义**：优先在 `hifi_shifter/gui/params.py` 中加入该参数的访问、映射、格式化等实现。
3. **补齐交互与渲染**：
   - 交互写入/选区拖拽偏移：通常在 `hifi_shifter/gui/editor.py`
   - 曲线绘制与刷新：通常在 `hifi_shifter/gui/plotting.py`
4. **UI 接入**：
   - 顶部栏与编辑区参数按钮（添加按钮/项，并与 `set_edit_param()` 联动）
   - 补齐 i18n 键（`param.xxx`、`label.xxx` 等）

### 5.2 新增一个音频处理阶段

- 优先在 `hifi_shifter/audio_processing/` 下新增模块，并由 `audio_processor.py` 编排调用。
- 若阶段属于“后处理且不依赖声码器推理结果”（类似张力 post-FX），尽量做成可缓存、可快速重算的函数。

## 6. 已知问题

- 播放期间推子/静音/独奏通常会在下一块音频生效（可能有轻微时延）
- 导入超长音频时，初始特征提取可能导致界面短暂无响应
- 多轨/高采样率会显著增加内存占用
