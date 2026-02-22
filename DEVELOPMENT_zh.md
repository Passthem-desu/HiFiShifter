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

### 0.1 Tauri 2.0（Rust 后端，迁移分支 tauri2）启动

> 说明：当前仓库仍保留 Python/pywebview 运行体系；`tauri2` 分支用于逐步迁移到 **Tauri 2.0 + Rust**。

- **依赖**：Rust toolchain + Node.js（用于复用 `frontend/` 的 Vite dev server）
- **安装前端依赖**：

```bash
npm --prefix frontend install
```

- **启动 Tauri（会自动执行 `frontend` 的 dev server）**：
 - **启动 Tauri（默认：会自动执行 `frontend` 的 dev server）**：

```bash
cd backend/src-tauri
cargo tauri dev
```

#### 可选：调试时使用 build 后的前端（更接近 release 性能）

如果你在 `npm run dev`（Vite HMR）下感觉界面卡顿/闪烁明显，可以用“dist-dev 配置”让 Tauri 直接加载 `frontend/dist`：

```bash
cd backend/src-tauri
cargo tauri dev --config tauri.conf.dist-dev.json
```

说明：
- 该模式会在启动前执行一次 `npm --prefix ../frontend run build`，然后用静态资源运行（无 HMR）。
- 适合做交互/性能调试与还原 release 行为；若要频繁改 UI，仍建议用默认 dev server。

- **前端与后端的调用桥**：前端统一通过 `frontend/src/services/webviewApi.ts` 调用后端。
  - 在 pywebview 模式下走 `window.pywebview.api.*`（位置参数）。
  - 在 Tauri 2 模式下走 `window.__TAURI__.core.invoke`（named args），并在该文件内做“位置参数 → named args”的映射。
  - **注意命名规则**：前端这里使用 camelCase keys（如 `audioPath` / `trackId` / `startBeat` / `playheadBeat`），后端对应的 `#[tauri::command]` 需要启用 `rename_all = "camelCase"`（否则会出现“命令似乎没触发/无反应”的反序列化失败）。

#### 工程（Project）与撤销重做（Undo/Redo）的权威归属

为避免“前端撤销了，但后续点击/刷新又被后端旧状态覆盖”，Tauri/Rust 模式下的时间线状态以 **后端为权威**：

- **Undo/Redo**：由后端维护撤销/重做栈；前端的 `Ctrl+Z / Ctrl+Y` 与菜单 `Edit → Undo/Redo` 直接调用 `undo_timeline / redo_timeline`，并用返回的 timeline payload 回灌前端状态。
- **Project Meta**：后端维护 `project.name/path/dirty/recent`，并随 `get_timeline_state` 等命令返回（payload.project）。前端会把它保存在 Redux `session.project` 中，用于渲染“最近工程列表”等 UI。
- **未保存退出提示**：后端在窗口 `CloseRequested` 事件里检测 `dirty`，弹窗询问保存/不保存/取消；选择保存会执行保存逻辑后关闭窗口。

相关代码：
- 后端命令与工程 IO：`backend/src-tauri/src/commands.rs`
- 关闭窗口拦截：`backend/src-tauri/src/lib.rs`
- 前端桥接：`frontend/src/services/webviewApi.ts`
- 前端状态与快捷键/菜单：`frontend/src/features/session/sessionSlice.ts`、`frontend/src/App.tsx`、`frontend/src/components/layout/MenuBar.tsx`

#### Rust 后端音频链路（当前 tauri2 分支）

- **低延迟实时播放引擎**：`backend/src-tauri/src/audio_engine/`
  - 基于 `cpal` 常驻输出流，在音频回调里按当前 timeline snapshot 做实时混音输出。
  - timeline 变更（导入、移动剪辑、推子/静音/独奏等）会在 commands 内同步推送到引擎（`update_timeline(...)`），让播放中状态即时生效。
  - 解码侧使用 `symphonia`（实时播放的格式支持范围取决于 Cargo features）。
  - **模块拆分（便于替换算法/定位崩溃）**：
    - `audio_engine/engine.rs`：CPAL 输出流 + 命令循环 + stretch worker 编排（对外暴露 `AudioEngine`）。
    - `audio_engine/snapshot.rs`：从 `TimelineState` 构建 `EngineSnapshot`（含 pitch-stream 预渲染与 stretch-stream worker）。
    - `audio_engine/mix.rs`：音频回调混音（优先读 ring buffer，缺口回退实时混音）。
    - `audio_engine/io.rs`：解码 / 重采样 / PCM cache。
    - `audio_engine/ring.rs`：无锁 `StreamRingStereo`。
    - `audio_engine/types.rs`：引擎内部数据结构与命令枚举。
  - **稳定性/崩溃排查提示**：
    - `panic in a function that cannot unwind`：属于 Rust panic 跨越不可 unwind 的边界（常见于 WebView2 COM 回调等）导致 abort；当前策略是减少 `unwrap/expect`（尤其是 poisoned mutex），并对高风险入口加 `catch_unwind`。
    - `Rust cannot catch foreign exceptions, aborting`：属于“外部异常（非 Rust panic）”跨 FFI/边界进入 Rust；`catch_unwind` 无法捕获，需从 DLL/FFI 调用链单独定位。
      - 实际踩坑（已修复）：WORLD vocoder 的 `D4C` FFI 绑定曾经少传 `fft_size` 参数（Rust 函数签名与 C 头文件不一致），会造成调用栈错位与内存破坏，最终表现为 `0xc0000409 (STATUS_STACK_BUFFER_OVERRUN)`。
        - 修复位置：`backend/src-tauri/src/world_vocoder.rs`
      - 额外稳健性策略：实时播放的 pitch-stream（WORLD 预渲染）默认绕开 RubberBand offline 伸缩，改用更稳的线性方案（可能牺牲伸缩音质，但优先保证“不闪退可用”）。
    - 隔离开关：设置 `HIFISHIFTER_REALTIME_PITCH_STREAM=0` 可禁用实时 pitch-stream（回退到纯实时混音路径），用于快速判断是否与 WORLD 预渲染链路相关。
- **导入音频的时长/波形预览**：`backend/src-tauri/src/audio_utils.rs`
  - 用于时间线 UI 的时长与波形预览（`waveform_preview`）生成。
  - WAV 优先走 `hound`（支持 16/24/32-bit int + 32-bit float），非 WAV 或特殊 WAV 走 `symphonia` 兜底。
  - 注意：24-bit PCM WAV 在 `hound` 中以 `i32`（范围约为 $[-2^{23}, 2^{23})$）提供；归一化必须除以 $2^{23}$，不能直接除以 `i32::MAX`，否则会被缩小约 256 倍，表现为“波形几乎看不见/播放几乎无声”。
- **按需波形 peaks（线状 DAW 波形，缩放越大越清晰）**：
  - 后端会对音频按固定 hop（当前 256 帧）计算并缓存 base min/max peaks：`backend/src-tauri/src/waveform.rs`、`backend/src-tauri/src/state.rs`。
  - **磁盘缓存（性能）**：base peaks 会写入磁盘缓存目录（优先使用系统 App Cache 目录，其次 fallback 到临时目录），避免每次启动/重复打开都重新扫描整段音频。
    - 清理方式：前端菜单 `视图 → 清除波形缓存`（调用后端命令 `clear_waveform_cache`，同时清空内存与磁盘）。
  - 前端按剪辑当前像素宽度请求 `columns` 列的聚合峰值（min/max），并用 SVG **单条中心线**（以 `(min+max)/2` 近似）stroke 绘制：`frontend/src/components/layout/timeline/ClipItem.tsx`。
  - 命令：`get_waveform_peaks_segment(sourcePath, startSec, durationSec, columns)`（`columns` 会被 clamp 到 16..8192）。
  - 语义对齐：前端会用 `trimStartBeat/trimEndBeat/lengthBeats + bpm + durationSec` 推导 source 区间；当剪辑超出源音频可用范围（或 `trimStartBeat < 0` 产生前置空白）时，越界部分用 0（空白/静音）填充，不再对峰值序列做循环重复拼接。

#### 参数曲线（Pitch/Tension，一期 MVP）

目标：让“底部参数面板”的所有编辑状态 **进入后端 TimelineState**，从而天然获得：
- 工程保存/加载（`.hsp`）
- Undo/Redo（后端权威 checkpoint）

核心设计（后端权威）：
- `Track` 增加：
  - `compose_enabled: bool`：根轨是否参与合成输出（一期先落地状态与保存/撤销闭环）。
  - `pitch_analysis_algo: PitchAnalysisAlgo`：Pitch 分析/生成策略（`world_dll / none`）。
- `TimelineState` 增加：
  - `params_by_root_track: BTreeMap<String, TrackParamsState>`：按“根轨道 id”存储参数曲线。
  - 曲线以固定帧周期存储：当前 `frame_period_ms = 5ms`（沿用同一时间基准）。

Pitch/F0（`pitch_orig`）生成逻辑（后端）：
- 实现文件：`backend/src-tauri/src/world.rs`（WORLD DLL 动态加载） + `backend/src-tauri/src/pitch_analysis.rs`（把音频映射到时间线帧并写入 `pitch_orig`）。
- 触发时机：
  - 当前端请求 `get_param_frames(..., param="pitch", ...)` 时，后端会基于当前时间线/音频文件签名计算一个 key；key 变化才会**调度一个后台任务**重算并更新 `params_by_root_track[root].pitch_orig`（本次请求会先返回当前缓存值，避免阻塞 UI）。

F0 检测算法（WORLD）：
- Rust 后端在两处会做 F0 追踪：
  - `pitch_orig`（供 UI 显示与计算 `pitch_edit - pitch_orig`）
  - WORLD-vocoder 实际变调时的内部分析（`backend/src-tauri/src/world_vocoder.rs`）
- 为降低 DIO 在部分人声上的八度误检/抖动导致的噪声与杂音，默认 F0 tracker 改为 **Harvest**。
  - 可通过环境变量切换：`HIFISHIFTER_WORLD_F0=harvest`（默认）/ `HIFISHIFTER_WORLD_F0=dio`
  - 实现会做自动回退：首选算法失败时会尝试另一种。
- 默认 F0 范围对齐旧 Python demo（`utils/wav2F0.py`）：`f0_floor=40Hz`、`f0_ceil=1600Hz`。
- 预处理仅做最小化（去 DC、必要时缩放并夹紧到 [-1,1]），不包含“限速/低通”类处理。

WORLD-vocoder 内部 F0 清理（缓解“咯痰感/气泡噪声”）：
- 实际上 WORLD 的 F0 在部分素材上会出现“有声段里偶发几个很短的 0Hz 空洞”。
  这会让 CheapTrick/D4C 的分析与后续 Synthesis 变得不稳定，听感上容易出现“咯痰/气泡/咕噜”一样的噪声。
- 当前在 vocoder 合成前，会默认对 F0 做一次轻量清理：
  - 对 NaN/Inf 做归零
  - 对很短的 0Hz 空洞做线性插值补齐（仅限左右都是 voiced 的情况）
- 可通过环境变量调参/禁用：
  - `HIFISHIFTER_WORLD_F0_GAP_MS=15`（默认，最多补齐约 15ms 的空洞）
  - `HIFISHIFTER_WORLD_F0_GAP_MS=0`（禁用）

为什么“改音高后噪声会变大”（即使 F0 检测差不多）：
- WORLD-vocoder 是“分析-再合成”的声码器链路（CheapTrick + D4C + Synthesis）。
- 即使 F0 追踪很稳定，声码器对 **清辅音/气声/噪声成分（本质上无基频）** 的重建也容易引入“砂/噪声/金属感”。
- 这类噪声往往发生在 s/f/h/sh 等无声段或过渡段，看起来像“只要开了变调就整段变脏”。

当前采取的策略（不做限速/低通）：
- 在 WORLD-vocoder 输出阶段做 voiced/unvoiced 融合：
  - 有声(voiced)帧：使用 vocoder 的变调输出
  - 无声(unvoiced)帧：直接保留原始波形（直通）
  - 边界做很短的淡入淡出（约 10ms）避免点击
- 实现位置：`backend/src-tauri/src/world_vocoder.rs`
  - Pitch 分析执行需同时满足：根轨 `compose_enabled=true` 且 `pitch_analysis_algo!=none`；否则不会调度后台任务，前端也会仅显示波形并提示开启 `C`。
  - key 会包含：bpm、framePeriod、该根轨下所有 clip 的 `sourcePath/startBeat/lengthBeats/trimStart/trimEnd/playbackRate`，以及源文件的 `mtime/size`（用于检测音频文件被替换）。
  - 后台任务去重：同一 `(rootTrackId, key)` 只会同时在跑一个（`AppState.pitch_inflight`）。
  - 后台任务完成后会发出 Tauri 事件 `pitch_orig_updated`（payload 含 `rootTrackId`），前端参数面板监听后触发一次可见窗重拉取。
- WORLD 算法当前采用 `Dio + StoneMask`（输出 Hz，再转换为 MIDI Note number 存入 `pitch_orig`）。
- 分析输入与背景波形一致（Root Mix）：
  - `pitch_orig` 的分析对象是“选中根轨道（根+子轨）的混音输入”（root subtree mixdown），与参数面板背景波形使用同一条 mixdown 数据源。
  - 这条 root mix 会忽略 mute/solo（作为编辑对齐参考，避免因为静音/独奏导致波形或曲线消失），但会保留音量推子的影响。
  - 由于 mixdown 已经在**时间线时间域**里完成了 trim/拉伸等处理，`pitch_analysis.rs` 直接以时间线 `frame_period_ms` 运行 WORLD，并将输出曲线重采样到工程目标帧数，保证曲线与波形/标尺同尺度。
- 解码支持：Pitch 分析与“轨道混音波形 peaks”均使用通用解码（WAV 优先 hound，否则 Symphonia），支持 mp3/m4a/ogg/flac/wav 等常见格式。

前端获取策略（可见窗分段 + stride 降采样）：
- UI 不会一次性拉全曲线，而是按“当前可见时间窗”拉取片段。
- `stride` 用于缩放很小时的降采样（例如 1 列像素对应多帧）：后端按 stride 抽样返回等长数组，前端直接画线。

参数面板视窗（独立滚动/缩放）：
- 参数面板自身维护 `scrollLeft` 与 `pxPerBeat`（不强制与时间线同步）。
- 参数值轴（纵向）同样是独立视窗：参数面板内部维护 `ValueViewport(center/span)`，用于实现 **Ctrl + 滚轮纵向缩放（以光标为中心）**。
- 参数面板支持 **鼠标中键拖动** 平移时间轴（等价于拖动横向滚动条）。
- 刷新与 loading：参数面板会按“可见窗”自动分段请求波形/曲线；无论是自动刷新还是头部 `刷新` 按钮触发，请求期间都会覆盖一层半透明 loading。
  - 代码位置：`frontend/src/components/layout/pianoRoll/usePianoRollData.ts` 暴露 `refreshNow()` 与 `isLoading`（手动刷新仍保留 `isRefreshing` 用于按钮禁用），由 `frontend/src/components/layout/PianoRollPanel.tsx` 负责 UI 展示。
- 顶部时间标尺与 BPM 网格复用时间线模块的组件（`frontend/src/components/layout/timeline/TimeRuler.tsx`、`BackgroundGrid.tsx`），保证视觉/刻度风格一致，但视窗状态彼此独立。
- 实现细节：为了让 **绘图区 Canvas / 时间标尺 / 背景网格** 在滚动时严格锁定，参数面板会在 scroll handler 内做一部分 **imperative（ref）同步**；因此在“滚轮缩放改变 `pxPerBeat`”的路径上需要同步更新 `pxPerBeatRef.current`，避免出现“缩放越大偏移越明显”的错位。
- DOM 结构注意：参数面板滚动容器内部使用“spacer（只用于提供 scrollWidth） + sticky overlay（网格+Canvas）”。**spacer 不能设置为 `height: 100%`**，否则会把 overlay 顶到可视区之外（且容器 `overflow-y-hidden` 时表现为“完全不显示”）。
- 绘制触发注意：`invalidate()` 若用 `useCallback([])` 固定回调，`draw()` 需要只读取 refs（如 `paramViewRef/wavePeaksRef/editParamRef`），避免捕获旧闭包导致“曲线/波形不更新”。
- 播放头同步注意：时间标尺是 React 渲染，但底部图表是 Canvas 渲染；当 `playheadBeat` 因“点击定位/播放推进”发生变化时，需要显式触发一次 `invalidate()`，否则会出现“标尺在动但底下光标不动/延迟很大”。
- Pitch 轴为 C2 → C8 的“钢琴窗”形式，叠加半音横线与 C 音名标注；张力等线性参数则显示数值刻度。

相关后端命令（均在 `backend/src-tauri/src/commands.rs`，并以 `rename_all = "camelCase"` 暴露给前端）：
- `get_param_frames(rootTrackId, param, startFrame, frameCount, stride)`
  - 返回 `orig/edit` 两条曲线片段（对应“虚线原始曲线 / 实线编辑曲线”）。
  - 对于 `pitch`：当用户尚未编辑时，后端会让 `edit` 默认继承 `orig`，保证 UI 主实线显示“识别音高线”。
- `set_param_frames(rootTrackId, param, startFrame, values, checkpoint)`
  - 写入编辑曲线（通常 pointer-up 时 `checkpoint=true`）。
- `restore_param_frames(rootTrackId, param, startFrame, frameCount, checkpoint)`
  - 把编辑曲线恢复为原始曲线（右键恢复）。

曲线“实时编辑”的渲染策略（前端）：
- 交互上要求“拖动时曲线立即跟手变化”，同时又要保证后端 Undo 只有一步。
- 实现方式是在 `PianoRollPanel.tsx` 内维护 `liveEditOverrideRef`：
  - pointer-move 期间只更新本地覆盖层并立刻重绘（实时反馈）。
  - pointer-up 时再一次性调用 `set_param_frames/restore_param_frames` 且 `checkpoint=true`（权威落盘 + 单步撤销）。

底部面板背景波形（根轨混音输入）：
- 命令：`get_root_mix_waveform_peaks_segment(rootTrackId, startSec, durationSec, columns)`
  - 后端会对“根轨+子轨”子树过滤 timeline，并在可见时间窗做一次轻量 mixdown 渲染，直接生成 peaks（min/max）返回。
  - 用途：底部参数编辑时作为“对齐参考”，不依赖某个单 clip 的 source。

性能策略（降低滚动/缩放卡顿）：
- 后端：UI 用的 root-mix peaks 请求优先走更快的 stretch 路径（线性重采样）以降低 CPU 开销；导出/高质量渲染仍保持高质量算法。
- 前端：对 peaks/param frames 拉取做可见窗量化与去抖（减少滚动时请求抖动），并对 root-mix peaks 做 LRU 缓存命中（快速回显）。

#### Pitch 编辑如何影响最终音频（Tauri/Rust 路线，v1）

结论：**Pitch 面板绘制的 `pitch_edit` 不再只是“显示/存储曲线”，而是会在离线渲染（`synthesize` / 导出 WAV）路径中真正改变最终 mix 的音高**。

设计选择（v1）：
- **算法要求**：变调基于 **WORLD vocoder**（不是 Rubber Band）。
- **应用位置**：在 `mixdown` 完成“时间线域混音（含 trim / time-stretch / gain/fade）”之后，做一次 **post-process**：按时间变化的半音偏移曲线对整段 mix 变调。
- **偏移定义**：逐时间帧的偏移量为 `semitones(t) = pitch_edit(t) - pitch_orig(t)`（两者均为 MIDI note number）。
- **启用条件**：只有当选中根轨（root track）`compose_enabled=true` 时才会应用；否则保持原始 mix（与 Pitch 面板的 `C` gating 对齐）。

代码位置：
- 入口：`backend/src-tauri/src/mixdown.rs`（渲染完成后调用 pitch-edit）
- Pitch 曲线读取/偏移计算：`backend/src-tauri/src/pitch_editing.rs`
- WORLD vocoder 绑定与分块处理：`backend/src-tauri/src/world_vocoder.rs`

#### Pitch Edit 算法：NSF-HiFiGAN（ONNX，实验）

除了默认的 WORLD-vocoder 变调外，后端还支持一个 **NSF-HiFiGAN ONNX 推理** 的实验性实现：

- 实现文件：`backend/src-tauri/src/nsf_hifigan_onnx.rs`
- 运行库：`ort` crate + ONNX Runtime（构建时下载并捆绑；可选 CUDA EP）
- ONNX 模型接口对齐旧 Python demo：输入张量名 `mel` 与 `f0`
  - `mel`：shape `(1, num_mels, T)`，并在进入模型前做 `ln(max(mel, 1e-9))` 动态范围压缩
  - `f0`：shape `(1, T)`，单位 Hz（由 MIDI 转换：$f0 = 440\cdot 2^{(m-69)/12}$，0/无效视为 unvoiced）

启用方式：

- 方式 A（推荐）：在底部参数面板（Pitch）里的 `Algo` 下拉选择 `NSF-HiFiGAN (ONNX)`。
- 方式 B（调试/强制覆盖，默认不启用）：

- `HIFISHIFTER_PITCH_EDIT_ALGO=nsf_hifigan_onnx`
- 模型路径（二选一）：
  - `HIFISHIFTER_NSF_HIFIGAN_ONNX=...\\pc_nsf_hifigan.onnx`
  - 或 `HIFISHIFTER_NSF_HIFIGAN_MODEL_DIR=...\\pc_nsf_hifigan_44.1k_hop512_128bin_2025.02`
- （可选）`HIFISHIFTER_NSF_HIFIGAN_CONFIG=...\\config.json`

实现要点：

- mel 特征提取在 Rust 内复刻 `utils/wav2mel.py` 的关键行为：reflect padding + Hann + STFT magnitude + mel filterbank（Slaney）+ `ln` 压缩。
- `f0` 不再依赖 Python/parselmouth：直接复用后端已有的 `pitch_orig/pitch_edit`（MIDI 曲线），按模型 hop（来自 `config.json` 的 `hop_size`）在绝对时间上采样并转换为 Hz。
- 若引擎采样率不是 44100，会在推理前/后做一次线性重采样（为了和模型 `sampling_rate` 对齐）。

限制/注意：

- 该路径目前主要用于离线渲染/导出验证；在实时播放回调里使用会有较高的 CPU 开销风险。
- 时间变化的 pitch 曲线会改变 `f0`，但 `mel` 仍来自原始音频片段；在大幅度/剧烈变化的变调下可能仍会产生伪影（这属于 mel 与 f0 条件不完全一致的典型问题）。

性能/内存注意（为什么要分块）：
- WORLD 的 `CheapTrick/D4C` 会生成 2D 矩阵（`spectrogram` / `aperiodicity`），若对整首歌一次性处理，内存会随时长线性增长，可能达到数百 MB 甚至更多。
- 因此 `world_vocoder.rs` 采用 **chunked** 策略（默认约 6s 一块 + 100ms overlap，并做淡入淡出 crossfade），在可接受的 CPU 开销下显著降低峰值内存占用。

当前限制（v1）：
- 处理以 **mono** 作为输入/输出（对 stereo mix 会折叠为 mono 并写回所有声道），因此暂时会损失立体声像。
- 实时播放（`play_original`）已接入（best-effort，低延迟优先）：
  - `backend/src-tauri/src/audio_engine/snapshot.rs` 在检测到“Pitch Edit 启用且后端可用（WORLD DLL / NSF-HiFiGAN ONNX）”时，会启动一个后台 worker 以前向窗口渲染并把输出写入一个 `StreamRingStereo`（绝对时间线帧）。
    - WORLD：直接调用 `mixdown`（内部应用 pitch-edit）并写入 ring。
    - ONNX：使用 `backend/src-tauri/src/audio_engine/pitch_stream_onnx.rs`，按发声段（VAD）整段推理（unvoiced 原音直通），避免固定时间窗分片的边界噪声。
  - 音频回调优先从该 ring buffer 读取；当刚开始播放/刚 seek 时，ring 可能尚未覆盖当前窗口：
    - **默认（WORLD/大多数场景）**：回调永不阻塞，直接走实时混音并推进 playhead；当 ring 覆盖到的帧可用时，再用已覆盖部分覆盖输出（保证不卡死，但起始可能短暂听到“原声 → 变调”的过渡）。
    - **ONNX（NSF-HiFiGAN）A 模式**：为避免“先原声后变调”的跳变，ONNX pitch-stream 默认启用 hard-start：起始窗口未覆盖时输出静音且不推进 playhead，直到预缓冲完成再开播。前端会监听 `playback_rendering_state` 并在**左下角状态栏**显示“渲染中...”提示。
      - 关闭该等待（回退为默认 best-effort）：`HIFISHIFTER_ONNX_PITCH_STREAM_HARD_START=0`
      - 调参：`HIFISHIFTER_ONNX_STREAM_PRIME_SEC`（默认 0.25）、`HIFISHIFTER_ONNX_STREAM_PRIME_TIMEOUT_MS`（默认 4000）
  - ONNX 发声段分割与推理调参（环境变量，实时播放路径）：
    - `HIFISHIFTER_ONNX_VAD_PAD_MS`（默认 120）：把 voiced 区间两端扩展，尽量把气声/边缘纳入 voiced。
    - `HIFISHIFTER_ONNX_VAD_CTX_SEC`（默认 1.5）：voiced 推理时额外渲染的上下文长度。
    - `HIFISHIFTER_ONNX_VAD_XFADE_MS`（默认 40）：voiced/unvoiced 边界 crossfade 长度。
    - `HIFISHIFTER_ONNX_VAD_MAX_SEC`（默认 60）：单次 ONNX 推理的安全上限（防止超长段导致峰值内存过高）。设置为 `0` 可关闭该上限（允许对超长 voiced 段一次性整段推理）。

补充：参数曲线写入的输入清洗（用于定位前端输入异常导致的噪声）
- `set_param_frames`（`backend/src-tauri/src/commands.rs`）在写入时会对 values 做轻量清洗：
  - `pitch`：非有限值（NaN/Inf）置 0；保留 0 作为“unset”；其余 clamp 到 MIDI [1, 127]。
  - `tension`：非有限值置 0；clamp 到 [-100, 100]。
- 当 `HIFISHIFTER_DEBUG_COMMANDS=1` 时，会输出每次写入的统计（non_finite/clamped/min/max/max_delta），用于判断是否存在异常输入或急剧跳变。

代码位置：
- 状态与序列化：`backend/src-tauri/src/state.rs`
- 命令层：`backend/src-tauri/src/commands.rs`
- 混音渲染复用：`backend/src-tauri/src/mixdown.rs`
- 前端桥接：`frontend/src/services/webviewApi.ts`
- 前端 UI：`frontend/src/components/layout/PianoRollPanel.tsx`

#### 伸缩（Time Stretch）

交互（前端时间线）：
- **Alt + 鼠标左键拖动左右边界**：进入“伸缩”模式（不同于裁剪）。
  - 右边界：固定左边界，改变 `lengthBeats`，并联动 `playbackRate`。
  - 左边界：固定右边界，改变 `startBeat + lengthBeats`，并联动 `playbackRate`。

联动公式（保持“源内容消耗量”不变）：
$$
rate_{new} = clamp(rate_{base} \cdot \frac{len_{base}}{len_{new}},\ 0.1,\ 10.0)
$$

算法说明：
- 当前高质量“保音高”伸缩优先使用 **Rubber Band Library（GPL）**。
  - 通过 C API（`rubberband-c.h`）在运行时 **动态加载** `rubberband.dll`（见 `backend/src-tauri/src/rubberband.rs`），避免在 Windows 上引入复杂的 link-time 构建链。
  - DLL 搜索顺序：环境变量 `HIFISHIFTER_RUBBERBAND_DLL` → 当前可执行文件同目录 → 系统 `PATH`。
  - Windows 构建 DLL：运行 `tools/build_rubberband_windows.cmd`，输出在 `backend/src-tauri/third_party/rubberband/source/rubberband-4.0.0/otherbuilds/x64/Release/rubberband.dll`。
  - 如果未找到 DLL 或符号加载失败，实时播放会继续使用旧的 `playbackRate` 取样插值路径（会变调），离线渲染则会回退到线性 time-stretch（同样会变调）。

- （计划接入）Pitch/F0 分析预计使用 **WORLD**（mmorise/WORLD，BSD 3-Clause）。
  - 源码位置：`backend/src-tauri/third_party/world/source/World`
  - Windows 构建 DLL：运行 `tools/build_world_windows.cmd`
    - 可通过环境变量 `HIFISHIFTER_MSVC_TOOLSET` 选择工具集（默认 `v145`），构建目录会按工具集隔离：`backend/src-tauri/third_party/world/build_world_dll/_build_<toolset>/...`
    - 构建输出（默认）：`backend/src-tauri/third_party/world/build_world_dll/_build_v145/bin/Release/world.dll`
    - 同时会拷贝到：`backend/src-tauri/resources/world/windows/x64/world.dll`
  - DLL 搜索顺序（`backend/src-tauri/src/world.rs`）：环境变量 `HIFISHIFTER_WORLD_DLL` → 当前可执行文件同目录 → 系统 `PATH`
  - 导出符号校验：运行 `tools/verify_world_windows.cmd`（检查 `Harvest/Dio` 等导出符号）
- **实时播放引擎策略**：为了保证音频回调稳定、避免在回调里做有状态/高开销处理，实时引擎在构建 timeline snapshot 时会对 `playbackRate != 1` 的剪辑预生成“伸缩后的 PCM（保音高）”（见 `backend/src-tauri/src/audio_engine/engine.rs` + `audio_engine/snapshot.rs`）。播放回调只做索引混音。

- **实时播放引擎策略（低延迟版，当前实现）**：为了避免“伸缩后第一次播放要等很久”，实时引擎不再在 `update_timeline(...)` 的命令线程里同步执行 Rubber Band 的离线伸缩。
  - 在收到 `UpdateTimeline` 时：只做**快速 snapshot 构建**（用于立即响应播放/seek），同时把需要的伸缩任务投递到后台 worker。
  - 后台 worker 完成后：写入 `stretch_cache`，并向引擎发送 `StretchReady` 触发一次 snapshot rebuild，从而把对应 clip 的音源替换为“保音高”的伸缩 buffer。
  - 这样可以把“按下 Play → 出声”的延迟从“等 Rubber Band 跑完”降低到“立即出声（可用性优先）”。

##### 伸缩后播放延迟的完整降延迟方案（设计 + 落地路径）

问题根因（Tauri/Rust）：
- Rubber Band 伸缩属于 CPU 重任务，若在引擎命令线程同步执行，会阻塞 `SetPlaying/Seek/Stop` 等指令处理，导致明显“按下播放没反应/延迟很高”。

阶段 1（已落地）：异步预计算 + 结果缓存（避免阻塞播放启动）
- **后台 worker**：对每个 `playback_rate != 1` 的 clip，按 `(path, sr, bpm, trimStart, trimEnd, playbackRate)` 生成稳定 key，异步计算“伸缩后的 PCM（保音高）”。
- **缓存**：`stretch_cache: HashMap<StretchKey, ResampledStereo>`，同 key 命中直接复用。
- **去重**：`stretch_inflight: HashSet<StretchKey>`，避免重复入队。
- **触发时机**：在 `UpdateTimeline` 时尽早投递（用户松手提交伸缩后就开始算），不等待计算完成。
- **播放体验**：播放/seek 立即响应；伸缩 clip 的“保音高音源”会在后台算完后自动切换。

阶段 2（已落地）：Streaming Stretcher（尽量做到“首音就保音高”）
- 目标：把“第一次听到伸缩 clip 的保音高音频”延迟压到 1–2 个音频 block 的量级（体感上接近即时）。
- 落地实现（Tauri/Rust）：
  - `backend/src-tauri/src/rubberband.rs`：新增 `RubberBandRealtimeStretcher`，使用 C API 的 realtime 模式（`RubberBandOptionProcessRealTime`）做 `process/retrieve` 流式伸缩。
  - `backend/src-tauri/src/audio_engine/`：
    - `StreamRingStereo`：固定容量（当前约 2 秒）的无锁环形缓冲（用 `AtomicU32` 存 f32 bits，回调可安全读取）。
    - `EngineClip.stretch_stream`：当 `playbackRate != 1` 且 `stretch_cache` 未命中时，为该 clip 启动一个后台 streaming worker，持续往 ring buffer 写入“保音高”的伸缩输出。
    - 音频回调优先读 `stretch_stream`；若 ring 还没填满对应帧，则临时回退到旧的 `src + playbackRate` 插值路径（可立即出声，但会短暂变调），等 ring 填充后自动切回保音高。
- 取消/生命周期：
  - 当 `UpdateTimeline` 或 `StretchReady` 触发 snapshot rebuild 时，会 bump `stretch_stream_epoch` 让旧 worker 自行退出，避免泄漏与错误复用。
  - `SeekSec`/`Stop`/`SetPlaying` 不会重建 snapshot，因此 worker 不会被强制取消，而是通过检测 playhead 跳变在内部 reset（适配 seek）。

阶段 3（可选）：编辑期的“预热与预测”
- 在拖拽过程中仅做 UI 预览（不算 Rubber Band），在松手提交时立即开始后台计算。
- 若用户在拖拽后通常会立刻点播放，可在 pointer-up 提交后优先把该 clip 放到队列头（降低体感延迟）。
- 仍保留 **Elastique Soloist** 作为商业 SDK 的未来占位（当前仓库不包含其库/头文件）。
- **离线渲染/导出**：`backend/src-tauri/src/mixdown.rs` 仍用于将 timeline 渲染成 WAV（导出或某些合成缓存路径会复用）。
- **commands 对应关系**（均在 `backend/src-tauri/src/commands.rs`）：
  - `play_original`：将当前 timeline 推送给实时引擎并从 `playhead_beat` 对应位置开始播放。
  - `play_synthesized`：当需要时仍会生成合成音频文件，但播放由实时引擎负责（可从 offset 位置开始）。
  - `stop_audio` / `set_transport`：驱动实时引擎停止/跳转。

- **调试日志（推荐）**：设置环境变量 `HIFISHIFTER_DEBUG_COMMANDS=1` 后，后端会输出关键命令调用、导入时长/波形预览提取结果，以及实时播放侧的解码失败原因（用于定位“无声/无波形/seek 体感不对”等问题）。

> 说明：部分推理/训练相关代码位于仓库根目录（如 `training/`），因此推荐始终在仓库根目录运行；同时，音频处理子模块中也做了启动上下文兼容（见 `hifi_shifter/audio_processing/_bootstrap.py`）。

## 1. 项目概览

### 1.1 目录结构（更新版）

```text
HiFiShifter/
├── backend/                     # Rust 后端与桌面壳（Tauri 2.0，迁移中）
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
- 在 Tauri 2.0（Rust 后端）模式下：
  - 通常无法从 `DataTransfer` 直接拿到本地路径，因此前端以 Tauri 的 `onDragDropEvent` 事件为准：
    - `paths[]` 作为真实文件路径来源。
    - `enter/over` 阶段用于显示 ghost（`dropPreview`）。
    - `drop` 阶段直接触发导入。
  - **注意**：在 Windows + Tauri 的“外部文件拖拽”场景中，DOM 的 `dragover/drop` 事件可能根本不触发（或 `DataTransfer` 为空），因此不能只依赖 DOM 事件；DOM 监听仅作为兜底。
  - **调试**：若拖拽无反应，可在 DevTools Console 执行 `localStorage.setItem("hifishifter.debugDnd","1")` 后刷新页面，再拖拽一次；会打印 `[dnd] ...` 用于确认 Tauri 事件是否进入前端。
  - **语义区分**：`trackId` 省略（未传）表示导入到当前选中轨道；显式传 `trackId: null` 表示“新建轨道并放置剪辑”。
- 当 WebView 无法提供本地路径时，前端会走 bytes/base64 兜底导入（`import_audio_bytes(file_name, base64_data, ...)`），后端会保留原始 `file_name` 用于剪辑显示名（避免 temp 文件名污染 UI）。

### 无音频也可播放（Virtual Playback）

- 后端新增“虚拟播放”模式：当当前时间点之后无可播放音频片段时，不报错，改为启动一个静默的播放时钟（不调用声卡输出），让前端播放头依然能推进。

### 播放中跳转（Seek While Playing）

- **当前交互语义（推荐）**：用户点击时间线/标尺定位光标时，前端会先 `stop_audio` 再 `set_transport(playhead_beat=...)`，即“定位会停止播放”。
  - 目的：避免伸缩/重构 snapshot 等重任务期间出现“边播边跳”的体感卡顿与误判。
- **后端能力（保留）**：后端仍支持在播放状态下处理 `set_transport(playhead_beat=...)`（未来可按 DAW 习惯实现点击跳播继续播放）。
- **额外同步**：当用户“点击时间标尺定位”后立刻点播放，可能出现异步时序导致后端仍使用旧 `playhead_beat` 起播；因此在 `playOriginal/playSynthesized` 前应先调用一次 `set_transport(playhead_beat=anchorBeat)` 做强同步。

#### 播放位置时钟语义（Tauri/Rust）

- 后端 `get_playback_state` 返回的播放位置采用**绝对时钟**：`absolute_sec = base_sec + position_sec`。
  - 时间线播放（original）：`base_sec = 0`，`position_sec` 直接表示从工程起点开始的秒数。
  - 文件播放（synthesized/file）：`position_sec` 是从本次播放开始的经过时间，`base_sec` 是起播时对应的工程秒数。
- 前端播放头应使用 `absolute_sec * bpm / 60` 直接换算为 beat；不要再叠加 `playbackAnchorBeat`，否则会出现播放头与实际播放位置的秒级偏移。

### 低延迟播放（分块混音 + OutputStream）

- 旧实现为：点击播放时一次性离线混音整段音频（从 playhead 到工程末尾）再 `sd.play()`。
- 新实现为：启动播放时构建“混音计划”（clip 的起止、裁剪、淡入淡出、增益、轨道 mute/solo 等），播放阶段用 `sounddevice.OutputStream` 回调按块（block）实时混音输出。
- 目标：在 clip 数量较多时，显著降低“点击播放 → 听到声音”的启动延迟，并避免一次性创建巨大的 mix 缓冲。
- 代码位置：后端 pywebview API 的播放实现集中在 `hifi_shifter/web_api.py`（`play_original` / `play_synthesized`）。

### 工程边界与网格裁剪

- 时间轴 BPM 网格绘制被限制在工程内容宽度（`projectBeats`）内；边界外保持纯底色。
- 在工程末尾绘制明显边界线，提示工程时长终点。
- 当导入/新增/移动/拉伸剪辑导致 `clip.startBeat + clip.lengthBeats` 超出当前 `projectBeats` 时，后端会自动将 `project_beats` 扩展到能够容纳该剪辑的末端（只增不减）。

### 时间线剪辑交互（DAW 风格）

\- **吸附网格（Snap）**：时间线中剪辑的移动/裁剪默认吸附网格；按住 `Shift` 可临时关闭吸附（自由移动）。
- **点击 vs 拖拽（Seek 语义）**：为避免“长按拖动剪辑时光标乱跳”，剪辑的 `seek` 只在“按下抬起且未移动（click）”时触发；拖拽移动/跨轨移动过程中不会更新播放头。
\- **Slip-Edit（内部偏移）**：按住 `Alt` + 鼠标左键拖动剪辑主体，可调整剪辑内部偏移（前端表现为修改 `trimStartBeat`），不改变剪辑在时间线上的位置（不吸附）。
\- **淡入淡出对波形的影响**：前端波形预览会把 fade-in/out 作为幅度乘子应用到波形上，使“渐变”对视觉预览也可见。
- **越界静音（No Repeat）**：当剪辑长度超出源音频可用范围时：
  - 实时播放与离线导出都会把超出部分视为静音（输出 0），不再做循环回绕或“拉伸填满”。
  - 前端波形预览与 peaks 渲染对越界部分显示为空白（用 0 填充），不再显示 Repeat 竖线标记。
  - Slip-Edit 允许 `trimStartBeat < 0` 表达“前置空白”，并对偏移做限幅（默认不超过源音频时长的 ±1 倍；无源时长信息时回退到剪辑长度）。
- **删除**：`Delete / Backspace` 删除选中剪辑。
- **跨轨移动（Clip Drag Track Move）**：拖拽剪辑时会根据指针的 `clientY` 命中轨道行（`trackIdFromClientY`）来更新 `trackId`，从而实现“拖到新轨道”。为避免拖拽过程中 clip 发生 re-parent（React 重新挂载）导致 pointer capture 丢失，pointer capture 应绑定在滚动容器（scroll area）而不是 clip DOM。
- **复制/粘贴/复制拖动**：
  - `Ctrl + C`：复制选中剪辑到应用内剪贴板（当前不接入系统剪贴板）。
  - `Ctrl + V`：粘贴到播放头位置（以“最左剪辑的 startBeat”对齐播放头，其余剪辑保持相对间距）。
  - `Ctrl + 拖动剪辑`：松手时在目标位置创建副本，同时原剪辑回到拖动前位置。

补充：
- **横向缩放上限**：时间轴横向缩放由 `pxPerBeat` 控制，最大值由 `frontend/src/components/layout/timeline/constants.ts` 的 `MAX_PX_PER_BEAT` 限制（当前已提高以支持更深的放大）。

补充：
- `Ctrl + C` 会 best-effort 尝试写入系统剪贴板（失败则忽略）。
- 粘贴/复制拖动完成后，前端会自动选中新创建的副本（便于继续编辑）。

实现要点：
- 复制/粘贴与 Ctrl 拖动复制依赖 `createClipsRemote` thunk（[frontend/src/features/session/sessionSlice.ts](frontend/src/features/session/sessionSlice.ts)）：
  - 后端 `add_clip` 不直接返回新 `clipId`，因此前端会先执行 `add_clip`，再通过“前后 state 差分”找出新建的 id，然后用 `set_clip_state` 将模板属性（trim、gain、fade、rate 等）完整回写。

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
│   │   ├── editor/              # 编辑器相关组件
│   │   │   └── PianoRollPanel.tsx  # 钢琴卷帘（参数编辑）
│   │   └── layout/              # 布局组件
│   │       ├── TimelinePanel.tsx    # 时间线编排入口（状态/交互/组合渲染）
│   │       ├── timeline/            # 时间线子模块（组件/工具，降低单文件复杂度）
│   │       │   ├── TrackList.tsx    # 左侧轨道列表
│   │       │   ├── TimeRuler.tsx    # 顶部时间标尺
│   │       │   ├── BackgroundGrid.tsx # 网格与工程边界
│   │       │   ├── TimelineScrollArea.tsx # 滚动容器（scroll/缩放/持久化）
│   │       │   ├── ClipItem.tsx     # 单个剪辑渲染与交互
│   │       │   ├── GlueContextMenu.tsx # 右键菜单（胶合）
│   │       │   ├── constants.ts     # 常量
│   │       │   ├── math.ts          # clamp/db 等数学工具
│   │       │   ├── grid.ts          # 网格步进
│   │       │   ├── paths.ts         # 波形/淡入淡出 SVG path
│   │       │   ├── dnd.ts           # 拖拽导入解析
│   │       │   └── clipWaveform.ts  # 波形切片
│   │       ├── MenuBar.tsx          # 菜单栏
│   │       └── ActionBar.tsx        # 操作栏
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
  - **UI 控制**：时间线区域 `Ctrl + 鼠标滚轮`
  - **行为**：调整轨道 lane 高度（影响左侧轨道列表与右侧时间线轨道区域），并持久化到 localStorage
     - 剪辑拖拽调整大小时自动更新裁剪参数
     - 若能获得源音频时长（`duration_sec`），拖拽会自动 clamp，避免超过源范围

8. **轨道拖拽重排与嵌套（Track Reorder / Nesting）**
  - **交互**：在左侧轨道列表按住并拖拽轨道条目
    - 上下拖动：在同级（同 `parent_id`）内重排
    - 拖到另一轨道条目上并向右偏移：将其设为该轨道的子轨道（嵌套），插入到子轨道列表末尾
  - **实现位置**：
    - 前端：`frontend/src/components/layout/timeline/TrackList.tsx`（pointer-based drag + deadzone）
    - 前端到后端：`sessionSlice.ts::moveTrackRemote` → `webviewApi.ts::moveTrack`
    - 后端：`backend/src-tauri/src/commands.rs::move_track` → `backend/src-tauri/src/state.rs::TimelineState::move_track`
  - **数据结构**：后端 track payload 会包含 `parent_id`、`depth`、`child_track_ids`，前端用 `depth` 做缩进渲染
  - **约束**：前端在计算 drop 目标时做简单的“防环”检查（避免把父轨拖进自己的子树）

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
