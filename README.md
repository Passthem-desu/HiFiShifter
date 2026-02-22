# HifiShifter

[中文](README.md) | [English](README_en.md)

HifiShifter 是一个基于深度学习神经声码器（NSF-HiFiGAN）的图形化人声编辑与合成工具。它允许你加载音频，在钢琴卷帘上直接编辑参数曲线（例如音高、张力），并用预训练声码器实时/增量合成修改后的音频。

## 功能概览

- **多参数编辑**：不仅可编辑音高（Pitch/Note），也支持编辑张力（Tension），并为后续扩展更多参数预留了抽象接口。
- **选区编辑（通用抽象）**：支持框选采样点、高亮显示选中段，并可拖拽整体上下偏移（对当前参数生效）。
- **长音频增量合成**：自动分段（基于静音/片段策略），只对脏片段重合成，保证交互流畅。
- **工程管理**：保存/加载工程（`.hsp`），包含时间线与剪辑信息；支持“最近打开工程”、窗口标题显示工程名与未保存标记（`*`），关闭窗口时未保存会提示。
- **撤销/重做（后端权威）**：在 Tauri/Rust 后端维护 Undo/Redo 栈，前端 `Ctrl+Z / Ctrl+Y` 直接调用后端撤销重做，避免“前端撤销后被后端状态覆盖”。
- **下方参数面板（Pitch/Tension，独立视窗）**：底部参数编辑器拥有独立的 `缩放(pxPerBeat)` 与 `横向滚动(scrollLeft)`（不强制与时间线同步）；顶部提供时间标尺与 BPM 网格；背景显示“选中根轨道（根+子轨）混音输入”的波形预览，便于对齐编辑。
- **根轨 `C`（是否合成）开关**：根轨道可一键开启/关闭合成输出；当 `C` 开启且编辑参数为 Pitch 时，后端会基于“根轨道（根+子轨）混音输入”（与参数面板背景波形一致）**后台生成/更新**该根轨的 `pitch_orig`（用于虚线原始曲线）。底部 Pitch 面板会进入 loading（可显示进度条）并一直持续到音高检测完成后自动结束；当 `C` 关闭时 Pitch 面板仅显示波形并提示开启 `C`。
- **Pitch 曲线对齐时间线**：`pitch_orig` 生成会按剪辑的时间线长度/播放速率进行时间轴对齐（必要时会对音频做 time-stretch 后再跑分析），因此在做 Time Stretch（拉伸/缩短）后，曲线会随时间轴一起缩放并与波形/标尺保持同尺度。
- **Pitch 编辑影响播放/合成/导出（默认 WORLD，可切换 ONNX）**：当 `C` 开启时，底部参数面板绘制的 `pitch_edit` 会在“播放原音（实时引擎）/ 合成并播放 / 导出 WAV”路径中真正作用到最终 mix（默认通过 WORLD vocoder 做变调；也支持切换为 NSF-HiFiGAN ONNX 推理，见下方说明）。
- **Pitch 算法可切换（按根轨道）**：Pitch 面板可为当前根轨道切换分析算法（当前已接入 WORLD DLL；`none` 表示不生成）。
- **播放与导出**：播放原音/合成音；导出 WAV（支持混合或分轨，取决于当前 GUI 功能入口）。
- **实时播放混音**：播放过程中调整音量推子、静音轨道、独奏轨道可即时生效（无需停止重播）。
- **多语言（i18n）与主题**：支持中英文与深色/浅色主题。
- **现代化界面**：参考 DAW 设计的暗色主题界面，提供直观的操作体验。
- **音频编辑功能**：
  - **音频切片**：在播放头位置分割选中的音频剪辑（快捷键：S）
  - **淡入淡出**：为剪辑添加淡入淡出效果，支持自定义淡入淡出时长
  - **伸缩（时间拉伸）**：调整剪辑播放速率（0.1x - 10x），实现时间拉伸与缩短效果
  - **音频裁剪**：精确控制剪辑的起始和结束位置


## 安装

### 1. 克隆仓库

```bash
git clone https://github.com/ARounder-183/HiFiShifter.git
cd HifiShifter
```

### 2. 安装依赖

请确保已安装 Python 3.10+。

```bash
pip install -r requirements.txt
```

## 快速开始

1. **运行程序**

Windows 下可直接运行 `build_and_run.bat`，按提示选择：
- Python（pywebview）模式：构建前端并运行 `run_gui.py`
- Tauri（Rust）模式：安装前端依赖并启动 `cargo tauri dev`

如需在 Tauri/Rust 模式下启用 Pitch 自动分析（WORLD DLL）：
- 先运行 `tools/build_world_windows.cmd` 生成并拷贝 `world.dll` 到 `backend/src-tauri/resources/world/windows/x64/world.dll`。
- 或自行设置环境变量 `HIFISHIFTER_WORLD_DLL` 指向可用的 `world.dll`。

如需在 Tauri/Rust 模式下把 Pitch Edit 的变调算法切换为 **NSF-HiFiGAN ONNX 推理**（实验性，可能更慢）：
- 方式 A（推荐）：在底部参数面板（Pitch）里的 `Algo` 下拉选择 `NSF-HiFiGAN (ONNX)`。
- 方式 B（调试/强制覆盖）：设置 `HIFISHIFTER_PITCH_EDIT_ALGO=nsf_hifigan_onnx`
- 并提供模型路径（二选一）：
  - `HIFISHIFTER_NSF_HIFIGAN_ONNX=...\\pc_nsf_hifigan.onnx`
  - 或 `HIFISHIFTER_NSF_HIFIGAN_MODEL_DIR=...\\pc_nsf_hifigan_44.1k_hop512_128bin_2025.02`
- （可选）`HIFISHIFTER_NSF_HIFIGAN_CONFIG=...\\config.json`（默认取模型目录内的 `config.json`）
- 说明：ONNX Runtime 由 Rust 依赖在 **构建时自动下载并静态链接**，正常情况下无需额外准备 `onnxruntime.dll`。
  - 若处于离线环境，可设置 `ORT_SKIP_DOWNLOAD=1` 并改为使用系统已安装/自编译的 ONNX Runtime（需要自行处理链接配置）。
  - CUDA（NVIDIA GPU，加速推理）：
    - 默认 `HIFISHIFTER_ORT_EP=auto`：会优先尝试 CUDA，失败自动回退到 CPU。
    - 强制 CUDA：`HIFISHIFTER_ORT_EP=cuda`
    - 可选指定显卡：`HIFISHIFTER_ORT_CUDA_DEVICE_ID=0`
    - 若 CUDA 依赖/DLL 不完整或驱动不匹配，`auto` 会回退 CPU；可设置 `HIFISHIFTER_DEBUG_COMMANDS=1` 查看选到的 EP。

示例（PowerShell）：
```powershell
$env:HIFISHIFTER_PITCH_EDIT_ALGO = "nsf_hifigan_onnx"
$env:HIFISHIFTER_NSF_HIFIGAN_MODEL_DIR = "E:\\Code\\HifiShifter\\pc_nsf_hifigan_44.1k_hop512_128bin_2025.02"
```

```bash
python run_gui.py
```

（Tauri 2.0 / Rust 后端版本：在 `tauri2` 分支使用）

```bash
npm --prefix frontend install
cd backend/src-tauri
cargo tauri dev
```

说明（Tauri 2.0 / Rust 后端，当前 MVP）：
- **播放**：使用 Rust 侧的低延迟实时音频引擎（`cpal` 输出流回调中混音），播放启动不再依赖“整段离线渲染”。
  - 当 Pitch Edit 算法切到 **NSF-HiFiGAN ONNX** 时，为了避免“先听到原音再突然变调”的跳变，播放会采用 A 模式：按下播放后可能会先短暂等待预缓冲；左下角状态栏会显示“渲染中...”提示，预缓冲完成后再开始推进播放头并发声。
    - 可选调参（环境变量）：`HIFISHIFTER_ONNX_STREAM_PRIME_SEC`（默认 0.25）、`HIFISHIFTER_ONNX_STREAM_PRIME_TIMEOUT_MS`（默认 4000）。
    - 如需禁用该等待（回退为“尽快开播 + 覆盖到的部分再替换”）：`HIFISHIFTER_ONNX_PITCH_STREAM_HARD_START=0`。
  - ONNX 实时变调会按 `pitch_orig/pitch_edit` 的发声区间做整段推理（unvoiced 原音直通），以减少固定时间窗分片导致的边界噪声；参数可通过下方开发文档中的环境变量调节。
- **音频源格式**：实时播放侧会尝试通过 `symphonia` 解码常见音频格式；离线导出/mixdown 的格式支持范围可能与实时播放不同。
- **波形/时长预览**：导入音频后，后端会提取时长与波形预览用于时间线显示。Tauri/Rust 模式下时间线波形优先使用“按需 peaks（min/max）+ 缓存”的波形绘制方式：缩放放大时会请求更多列数，从而获得更清晰细节；WAV 优先走 `hound`（支持 16/24/32-bit int + 32-bit float），其他格式走 `symphonia` 通用解码兜底。
- **波形缓存（性能）**：后端会把每个音频文件的 base peaks 写入磁盘缓存（类似 REAPER 的 `.reapeaks` 思路），以减少重复计算；可在菜单 `视图` → `清除波形缓存` 主动清理。
- **工程保存/读取**：通过菜单 `文件` → `新建工程 / 打开工程 / 保存 / 另存为 / 最近打开` 管理工程文件（`.hsp`）。
- **未保存提示**：工程有修改但未保存时，窗口标题会显示 `*`，关闭窗口会弹窗询问是否保存。

2. **加载模型**
- 点击 `文件` -> `加载模型`。
- 选择包含 `model.ckpt` 和 `config.json` 的文件夹。
- 默认提供的模型：`pc_nsf_hifigan_44.1k_hop512_128bin_2025.02`。

3. **加载音频**
- 点击 `文件` -> `加载音频`。
- 支持 `.wav` / `.flac` / `.mp3`。

4. **编辑与合成**
- 在顶部栏使用 `编辑:` 下拉框选择要编辑的参数（音高/张力）。
- 底部参数面板也提供参数切换按钮（与顶部下拉框保持同步）。
- **手动刷新**：当波形/参数曲线没有及时更新时，可点击底部参数面板右上角的 `刷新` 强制重新拉取可见窗数据；刷新期间编辑区会显示 `加载中...` 提示。
- **绘制曲线**：左键绘制编辑曲线（实线）；右键恢复到原始曲线（虚线）。
- **选区复制粘贴**：切到 Select 模式后，左键拖拽出竖向时间选区；`Ctrl+C` 复制选区的编辑曲线，`Ctrl+V` 粘贴到选区起点。
- **缩放/滚动（参数面板独立）**：
  - 鼠标滚轮：横向缩放时间轴（以光标为中心）。
  - Ctrl + 鼠标滚轮：纵向缩放参数轴（以光标为中心）。
  - 鼠标中键拖动：平移视图（时间轴）。
  - 横向滚动条：横向滚动。
- 点击 `播放` -> `合成并播放` 听取效果（当根轨 `C` 开启时，会把 Pitch 面板的编辑曲线应用到合成输出）。

## 编辑模式与选区模式

### 编辑模式（Edit）
- **左键**：编辑当前参数的曲线（随参数面板切换）。
- **右键**：把当前参数恢复为“原始曲线”（一期：对 Pitch/Tension 生效）。

### 选区模式（Select）
- **左键拖拽**：生成竖向时间选区（覆盖整个高度）。
- **复制/粘贴**：`Ctrl+C` 复制选区范围内的“编辑曲线”，`Ctrl+V` 从选区起点写入。

## 轴显示（随参数切换）

- 当编辑 **音高** 时：左侧为“钢琴窗”形式的 Pitch 轴（C2 → C8），带半音横线与 C 音名标注，便于按音阶对齐编辑。
- 当编辑 **张力** 等线性参数时：左侧轴切换为数值刻度（0.0 / 0.5 / 1.0），用于线性参数的直观对齐。

该机制已抽象化：后续新增参数时，只需补充参数的「轴类型/映射/格式化」实现即可复用现有 UI。

## 常用快捷键

| 操作                         | 快捷键 / 鼠标                   |
| :--------------------------- | :------------------------------ |
| 平移视图（时间轴）           | 鼠标中键拖动                    |
| 横向缩放（时间轴）           | 鼠标滚轮（以光标为中心）        |
| 纵向缩放（轨道高度，时间轴） | Ctrl + 鼠标滚轮                 |
| 纵向缩放（参数轴，参数面板） | Ctrl + 鼠标滚轮（参数面板内）   |
| 播放/暂停                    | Space（空格）                   |
| 撤销 / 重做                  | Ctrl + Z / Ctrl + Y             |
| 新建工程                     | Ctrl + N                        |
| 打开工程                     | Ctrl + Shift + O                |
| 保存                         | Ctrl + S                        |
| 另存为                       | Ctrl + Shift + S                |
| 切换模式（编辑/选区）        | Tab                             |
| 删除选中剪辑                 | Delete / Backspace              |
| 复制选中剪辑（应用内剪贴板） | Ctrl + C                        |
| 粘贴到播放头位置             | Ctrl + V                        |
| 参数面板复制选区曲线         | Ctrl + C（Select 模式）         |
| 参数面板粘贴到选区起点       | Ctrl + V（Select 模式）         |
| 分割剪辑                     | S（在播放头位置分割选中的剪辑） |

补充：
- 支持将音频文件直接拖拽到时间轴轨道区域进行导入。
- 拖拽落点不在任何轨道上（例如空白行/轨道区域外）时，会自动新建轨道并放置剪辑。
- 左侧轨道列表支持拖拽：上下拖动可重排轨道；拖到另一轨道上并向右偏移可将其设为子轨道（嵌套）。
- 播放过程中点击时间标尺、时间轴空白区域或剪辑（item）会定位光标并停止播放（避免“边播边跳”造成的误判）。
- 拖拽剪辑（移动/跨轨移动）过程中不会改变播放头位置；只有“单击剪辑”才会更新光标/播放头。
- 时间轴有明确的工程时长边界，边界之外不再显示 BPM 网格；当剪辑超出边界时会自动延长工程边界。
- 当工程内没有任何音频时，也允许播放（用于检查时间轴/光标行为）。

## 音频剪辑编辑

在时间线面板选中音频剪辑后，可以在下方的属性面板中进行以下操作：

同时也支持在时间线上直接进行部分编辑（更接近 DAW 的交互）：

- **吸附网格**：剪辑移动/裁剪默认吸附网格；按住 `Shift` 可临时关闭吸附。
- **裁剪/伸缩范围**：拖动剪辑左右边界进行裁剪或延长；当剪辑长度超出源音频可用范围时，超出部分为“空白/静音”（波形预览显示为空白），不再循环重复。
- **伸缩（Time Stretch）**：按住 `Alt` + 鼠标左键拖动剪辑左右边界，可伸缩音频（联动改变播放速率与剪辑长度）。
  - 高质量“保音高”实时伸缩使用 Rubber Band Library（GPL）；Windows 下需要在可执行文件同目录放置 `rubberband.dll`，或设置环境变量 `HIFISHIFTER_RUBBERBAND_DLL` 指向该 DLL。
  - 本仓库提供一键构建脚本：运行 `tools/build_rubberband_windows.cmd`，生成的 DLL 默认在 `backend/src-tauri/third_party/rubberband/source/rubberband-4.0.0/otherbuilds/x64/Release/rubberband.dll`。
  - 若未找到 Rubber Band，则会自动回退到线性方法（会变调）。
- **内部偏移（Slip-Edit）**：按住 `Alt` + 鼠标左键拖动剪辑主体，可左右滑移剪辑的内部内容（等价于修改 Trim In），不改变剪辑在时间线上的位置（不吸附）；偏移会被限制在“源音频时长的 ±1 倍”（若无法得知源时长，则以当前剪辑长度作为限幅基准），允许产生前置/后置空白（静音）。
- **淡入淡出**：拖动剪辑左上角/右上角的手柄调整淡入/淡出时长。
- **淡入淡出对波形的影响**：波形预览会随淡入/淡出实时改变显示幅度，帮助直观对齐听感与视觉。
- **增益（dB）**：拖动剪辑左上角的旋钮（上下拖动）调整增益，剪辑右上角会显示当前 dB。
- **增益联动波形**：调整增益时，波形幅度会同步变大/变小（仅视觉预览）。
- **剪辑静音（M）**：剪辑左上角 `M` 按钮可对该剪辑静音，静音后剪辑整体变灰。
- **框选多选**：在时间线空白处按住鼠标右键拖拽可框选多个剪辑。
- **组移动**：多选后拖拽任意一个剪辑，会带动所有选中剪辑一起移动。
- **跨轨移动**：拖拽剪辑上下移动可切换到其他轨道（仅当所选剪辑都在同一轨道时允许整组跨轨移动）。
- **复制拖动**：按住 `Ctrl` 后拖拽剪辑，会在目标位置创建副本并保持原剪辑不动（复制完成在松手时生效）。
- **胶合**：右键剪辑打开菜单，选择“胶合”（要求同一轨道且至少 2 个剪辑）。
- **切分**：选中剪辑后按 `S` 可在播放头位置切分。

复制/粘贴规则（当前实现）：
- `Ctrl + C` 将选中剪辑复制到应用内剪贴板。
- 同时会 best-effort 写入系统剪贴板（写入失败则忽略，不影响应用内复制）。
- `Ctrl + V` 会把“所选剪辑中最靠左的起点”对齐到播放头位置，其余剪辑保持相对间距；并尽量保证起点不小于 0。
- 粘贴/复制拖动完成后，会自动选中新创建的副本。

- **长度（Len）**：调整剪辑长度
- **增益（Gain）**：调整剪辑音量（0-2倍）
- **播放速率（Rate）**：调整播放速度，实现时间拉伸（0.1x-10x）
- **淡入（Fade In）**：设置淡入时长（以拍为单位）
- **淡出（Fade Out）**：设置淡出时长（以拍为单位）
- **裁剪起点（Trim In）**：调整剪辑的起始位置
- **裁剪终点（Trim Out）**：调整剪辑的结束位置

剪辑上会显示淡入淡出的视觉效果，方便直观地查看音频处理状态。

## 开发者说明（与本次重构相关）

### 前端时间线模块化拆分

为降低单文件复杂度，时间线面板已从“一个超大组件文件”拆分为“编排入口 + 子组件/工具模块”的结构：

- `frontend/src/components/layout/TimelinePanel.tsx`
  - 仍作为对外入口（保持 import 路径稳定），负责状态编排、交互事件与组合渲染。
- `frontend/src/components/layout/timeline/`
  - `TrackList.tsx`：左侧轨道列表（选择/静音/独奏/音量推子/增删轨）。
  - `TimeRuler.tsx`：顶部时间标尺（小节标记 + 播放头显示）。
  - `BackgroundGrid.tsx`：时间轴背景网格与工程边界线。
  - `TimelineScrollArea.tsx`：时间线滚动容器（scrollLeft 同步、Ctrl/Alt 滚轮缩放、pxPerBeat/rowHeight 持久化）。
  - `ClipItem.tsx`：单个剪辑的渲染与交互（裁剪/淡入淡出/增益/静音/波形预览）。
  - `GlueContextMenu.tsx`：剪辑右键菜单（当前仅“胶合”入口）。
  - `constants.ts` / `math.ts` / `grid.ts` / `paths.ts` / `dnd.ts` / `clipWaveform.ts`：常量与纯函数工具（网格、波形/淡入淡出路径、拖拽导入解析等）。

### 音频处理模块化拆分

为提升可读性与调试效率，音频处理逻辑已从单文件拆分为“编排入口 + 子处理模块”结构：

- `hifi_shifter/audio_processor.py`
  - 仍作为对外入口（GUI 主要调用点），负责流程编排与保持 API 稳定。
- `hifi_shifter/audio_processing/`
  - `features.py`：音频加载/特征提取与分段相关逻辑。
  - `hifigan_infer.py`：NSF-HiFiGAN 推理相关逻辑。
  - `tension_fx.py`：张力后处理（post-FX）相关逻辑。
  - `_bootstrap.py`：启动上下文兼容（确保仓库根目录在 `sys.path`，避免 `training/` 等导入失败）。

### 选中高亮与参数扩展抽象

- 选区数据由 `selection_mask` + `selection_param` 管理，避免跨参数串扰。
- 高亮曲线已抽象为通用的 `selected_param_curve_item`：当前参数变化后会自动刷新。

## 已知问题

目前仍存在一些问题，例如导入长音频在部分环境下可能卡死、多轨/高采样率下资源占用较高等。


## 文档

- [开发手册](DEVELOPMENT_zh.md)
- [更新计划](todo.md)

## 致谢

本项目使用了以下开源库的代码或模型结构：
- [SingingVocoders](https://github.com/openvpi/SingingVocoders)
- [HiFi-GAN](https://github.com/jik876/hifi-gan)

## License

MIT License
