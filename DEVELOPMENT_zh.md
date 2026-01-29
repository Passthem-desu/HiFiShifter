# HiFiShifter 开发手册

HiFiShifter 是一个基于深度学习神经声码器（NSF-HiFiGAN）的图形化人声编辑与合成工具。本文档面向开发者，介绍项目结构、关键模块、今天重构引入的抽象，以及常见扩展/调试方式。

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
│   ├── main_window.py            # 主窗口与核心交互逻辑
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

- **UI 交互**（`main_window.py`）
  - 接收鼠标/键盘事件 → 修改当前音轨的参数数组（如 `f0_edited`、`tension_edited`）
  - 对音高编辑：标记受影响分段为 dirty → 触发增量合成
  - 对张力编辑：属于 post-FX 逻辑，通常不需要重跑声码器（依实现而定）

- **音频处理**（`audio_processor.py` + `audio_processing/*`）
  - 加载模型 → 特征提取 → 分段 → 对脏片段推理合成 → 回写音轨缓存

## 2. 关键模块说明

### 2.1 主窗口与交互（`hifi_shifter/main_window.py`）

`MainWindow` 负责：
- 菜单栏/控制栏/编辑区的 UI 组织
- 当前轨道与播放状态管理
- 编辑模式（Edit）与选区模式（Select）交互
- 参数切换（音高/张力）与所有 UI 同步

#### 实时播放（流式混音，推子/静音/独奏播放中生效）

为保证播放时调音量推子、静音、独奏能即时生效，播放链路已从“一次性离线混音 + `sd.play()`”改为 **`sounddevice.OutputStream` 回调式实时混音**。

实现要点：
- **回调线程不触碰 Qt**：音频回调运行在 sounddevice 的音频线程，仅读取 `Track` 的 `volume`/`muted`/`solo` 等状态并生成输出块。
- **最小共享状态**：通过 `self._playback_lock` 保护 `_playback_sample_pos` 等少量共享变量；GUI 用定时器读取采样位置驱动播放光标。
- **独奏优先级**：任意轨道 `solo=True` 时，仅混入独奏轨道；否则混入所有未静音轨道。
- **生效时延**：参数变化会在“下一块音频”生效（通常为几十毫秒量级，取决于设备缓冲）。


#### 参数编辑系统（今日抽象的核心）

- 当前编辑参数：`edit_param`（目前支持 `pitch` / `tension`）
- 顶部栏参数选择与编辑区参数按钮：保持同步（切换参数统一走 `set_edit_param()`）
- 未来新增参数时，建议按“参数抽象接口”补齐：
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
- 它会向 `MainWindow` 询问：
  - 当前轴对应的参数（通常是 `edit_param`）
  - 轴类型：`note`（音名）或 `linear`（数值）
  - 数值 ↔ 绘图区 Y 的映射、以及刻度字符串格式化

同时，`MainWindow` 会在切参时更新：
- 左侧 **竖向标题**（例如“音高 (Note)”/“张力 (Tension)”）
- 左侧刻度显示（音名 vs 数值）

### 2.4 音频处理编排与子模块（`audio_processor.py` / `audio_processing/`）

- `audio_processor.py`：对 GUI 保持稳定的入口与 API（负责调度流程）。
- `audio_processing/`：分离可独立调试的处理阶段：
  - `features.py`：音频加载、特征提取（如 mel/f0）、分段工具
  - `hifigan_infer.py`：NSF-HiFiGAN 模型加载与推理
  - `tension_fx.py`：张力 post-FX（不必重跑声码器即可改变听感的部分）
  - `_bootstrap.py`：确保仓库根目录在 `sys.path`，避免运行上下文不同导致导入失败

## 3. 国际化（i18n）

- 语言文件：`assets/lang/zh_CN.json`、`assets/lang/en_US.json`
- 使用方式：
  - 在代码中使用 `from utils.i18n import i18n`，再通过 `i18n.get("key")` 获取文本
- 本次新增/调整常用键：
  - `label.edit_param`（顶部栏“编辑”标签）
  - `param.pitch` / `param.tension`（参数名）
  - `status.tool.edit` / `status.tool.select`（状态栏提示模板）

> 注意：带参数的模板使用 `str.format`，例如 `i18n.get("status.tool.edit").format("音高")`。

## 4. 调试建议

- **建议断点**：
  - 参数切换：`MainWindow.set_edit_param()`
  - 选区更新：`set_selection()` / `update_selection_highlight()`
  - 合成触发：自动合成/分段 dirty 标记相关逻辑
  - 推理阶段：`audio_processing/hifigan_infer.py` 的推理入口
- **性能关注点**：
  - 特征提取与推理应避免阻塞 UI 主线程（如后续引入线程/任务队列）
  - 长音频导入时的初始特征提取开销较大，建议开发时使用短音频验证交互

## 5. 常见扩展任务（建议路径）

### 5.1 新增一个可编辑参数（推荐流程）

1. **`Track` 增加数据字段**：例如 `xxx_original` / `xxx_edited` / undo 栈等。
2. **`MainWindow` 增加参数实现**：
   - 让 `get_param_array()` / `get_param_curve_y()` 能返回该参数
   - 实现绘制写入与选区拖拽偏移（如 `apply_param_drag_delta()`）
   - 定义轴类型与映射（`get_param_axis_kind()`、`plot_y_to_param_value()`、`param_value_to_plot_y()`、`format_param_axis_value()`、`get_param_axis_label()`）
3. **UI 接入**：
   - 顶部栏与编辑区参数按钮（添加一个按钮/项，并与 `set_edit_param()` 联动）
   - 补齐 i18n 键（`param.xxx`、`label.xxx` 等）

### 5.2 新增一个音频处理阶段

- 优先在 `hifi_shifter/audio_processing/` 下新增模块，并由 `audio_processor.py` 编排调用。
- 若阶段属于“后处理且不依赖声码器推理结果”（类似张力 post-FX），尽量做成可缓存、可快速重算的函数。

## 6. 已知问题

- 播放期间推子/静音/独奏通常会在下一块音频生效（可能有轻微时延）
- 导入超长音频时，初始特征提取可能导致界面短暂无响应
- 多轨/高采样率会显著增加内存占用

