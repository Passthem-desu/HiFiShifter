# HNSEP 集成到 NSF-HiFiGAN 的气声处理方案

**日期**: 2026-03-09  
**状态**: 已确认设计  
**范围**: 后端 Rust / Tauri、前端 React、缓存与预渲染链路

---

## 背景

当前工程已经具备以下基础能力：

1. `NSF-HiFiGAN (ONNX)` 已作为一条可选的音高合成链路接入到 `ClipProcessor` / `ProcessorChain` 体系。
2. 根轨参数状态 `TrackParamsState` 已支持 `extra_curves` 和 `extra_params`，可承载声码器专属自动化曲线和静态参数。
3. 前端 `PianoRollPanel` 已支持通过 `get_processor_params(algo)` 动态拉取额外自动化参数并渲染编辑入口。
4. 后端已具备两层缓存能力：
   - `SynthClipCache`：面向片段推理结果
   - `RenderedClipCache`：面向整 clip 的预渲染结果

仓库中 `vocal-remover/model/hnsep_240512_vr/hnsep.onnx` 已提供单输入、双输出的分离模型：

- 输入：`waveform`
- 输出：`harmonic`、`noise`
- 采样率：44100 Hz
- `hop_length`: 512

该模型与需求高度匹配：先从原始语音中分离出谐波人声和气声噪声，再仅对谐波部分应用 NSF-HiFiGAN 音高处理，最后把气声作为旁路信号按用户曲线混回输出。

---

## 目标

本次改造目标如下：

1. 在 `NSF-HiFiGAN` 链路中引入可选的 `HNSEP` 前处理。
2. 当气声功能开启时，处理流程变为：
   - 原始 PCM
   - HNSEP 分离为 `harmonic` 与 `noise`
   - `harmonic` 进入 NSF-HiFiGAN 做音高变化
   - `noise` 保持原始时间结构，不参与音高变化
   - 根据前端气声曲线控制 `noise` 音量
   - 与变调后的 `harmonic` 混合输出
3. 当气声功能关闭时，完全绕过 HNSEP，继续使用现有 NSF-HiFiGAN 行为。
4. 将气声控制作为 `root track` 级参数接入现有 `processor params` 体系，而不是新增一套独立数据流。
5. 确保试听、整轨导出、离线渲染、波形更新都复用同一套处理链与缓存语义。

---

## 非目标

本次设计明确不做以下内容：

1. 不把整个 `ProcessorChain` 抽象升级为通用多 stem 图结构。
2. 不提供 clip 级独立气声曲线编辑；本次仅支持 `root track` 级控制。
3. 不将 HNSEP 暴露为单独算法选项；它是 `NSF-HiFiGAN` 的增强模式，不是新的根轨算法。
4. 不在第一阶段实现气声 stem 的单独试听、solo、导出文件分轨。

---

## 总体方案

采用最小侵入方案：把 `HNSEP` 封装为 `NSF-HiFiGAN` 处理器内部的可选前处理，而不是新增一条平行渲染管线。

开启气声后的链路如下：

```text
mono PCM
  -> RubberBandTimeStretchStage
  -> HNSEP 分离
      -> harmonic -> NSF-HiFiGAN pitch shift
      -> noise    -> breath gain curve
  -> harmonic_shifted + noise_scaled
  -> mono output
```

关闭气声后的链路如下：

```text
mono PCM
  -> RubberBandTimeStretchStage
  -> NSF-HiFiGAN pitch shift
  -> mono output
```

这意味着：

1. `SynthPipelineKind` 无需新增枚举值，仍使用 `NsfHifiganOnnx`。
2. `get_processor_params("nsf_hifigan_onnx")` 会新增两个参数描述符：
   - 一个静态开关
   - 一个自动化曲线
3. `does_clip_need_pitch_edit()` 的外层语义可以扩展为“是否需要该声码器额外渲染”，而不再只局限于音高曲线。
4. 整 clip 预渲染缓存需要把气声开关和气声曲线都混入 hash。

---

## 参数与状态设计

### Root Track 参数

`TrackParamsState` 已有：

- `extra_curves: HashMap<String, Vec<f32>>`
- `extra_params: HashMap<String, f64>`

本次直接复用，不新增并行字段。

### 新增的参数标识

在 `NSF-HiFiGAN` 处理器的 `param_descriptors()` 中新增：

1. `breath_enabled`
   - 类型：`StaticEnum`
   - 取值：`Off = 0`, `On = 1`
   - 默认值：`0`
   - 语义：关闭时完全绕过 HNSEP

2. `breath_gain`
   - 类型：`AutomationCurve`
   - 单位：建议为空字符串或 `x`
   - 默认值：`1.0`
   - 建议范围：`0.0 ~ 2.0`
   - 语义：控制气声音量倍率

说明：

1. `breath_enabled` 放在 `extra_params`。
2. `breath_gain` 放在 `extra_curves`。
3. `breath_gain` 缺失时按默认值 `1.0` 处理，而不是 `0.0`，否则开启功能但未编辑曲线时会把气声错误静音。

---

## 后端模块改造

### 1. 新增 HNSEP Runtime 模块

建议新增文件：

- `backend/src-tauri/src/vocoder/hnsep_onnx.rs`

职责：

1. 解析模型路径，支持：
   - 环境变量显式指定
   - 默认回退到 `resources/models/hnsep`
   - 开发环境回退到仓库内模型目录
2. 初始化 ONNX Runtime Session。
3. 提供 `is_available()` 与 `probe_load()`。
4. 提供分离接口：
   - 输入：mono PCM + sample_rate
   - 输出：`harmonic: Vec<f32>`, `noise: Vec<f32>`
5. 统一处理采样率检查：第一阶段只支持 44100 Hz；如果输入不是 44100，则直接返回错误或显式回退。

### 2. 资源打包

需要把 `hnsep.onnx` 和其配置一并纳入 Tauri 资源目录，路径建议为：

- `backend/src-tauri/resources/models/hnsep/hnsep.onnx`
- `backend/src-tauri/resources/models/hnsep/config.yaml`

应用启动时像现有 `NSF-HiFiGAN` 一样自动设置模型目录环境变量。

### 3. NSF-HiFiGAN Stage 增强

`renderer/chain.rs` 中的 `HiFiGanStage` 保持对外名字不变，但内部处理逻辑扩展：

1. 读取 `extra_params["breath_enabled"]`
2. 读取 `extra_curves["breath_gain"]`
3. 若开关关闭：走旧逻辑
4. 若开关开启：
   - 先调用 HNSEP 分离
   - 对 `harmonic` 执行现有 HiFiGAN 推理
   - 对 `noise` 按时间轴采样 `breath_gain`
   - 把两路结果按样本对齐后相加输出

为了避免 ProcessorChain 泛化成多 stem 结构，HNSEP 与混音逻辑都内聚在 `HiFiGanStage` 内部完成。

---

## 缓存设计

### 1. HNSEP 分离缓存

建议新增一层专用缓存，避免在只调整气声曲线时重复执行分离：

- 缓存对象：`clip_id + source interval + playback-related input` 对应的 `harmonic/noise`
- 建议位置：`synth_clip_cache.rs` 或单独 `hnsep_cache.rs`

缓存 key 至少应覆盖：

1. `clip_id`
2. `source_path`
3. `source_start_sec`
4. `source_end_sec`
5. 输入采样率
6. 输入 PCM 的时间拉伸后长度或与其等价的信息
7. `hnsep` 模型标识

注意：

1. `breath_gain` 不应进入 HNSEP 分离缓存 key，因为它只影响后混音。
2. `pitch_edit` 也不应进入 HNSEP 分离缓存 key，因为气声分离发生在音高变化之前。

### 2. 现有整 Clip 渲染缓存

`RenderedClipCache` 继续保留，但其 hash 需要扩展覆盖：

1. `breath_enabled`
2. `breath_gain` 曲线

这样：

1. 只改气声曲线时，整 clip 渲染结果失效，但 HNSEP 分离结果仍可复用。
2. 关闭气声时，直接走无 HNSEP 的旧逻辑，不查 HNSEP 缓存。

### 3. 片段推理缓存

若继续保留 `HiFiGAN` 的 per-segment 推理缓存，则需要确认带 HNSEP 时的缓存语义是否仍成立。建议第一阶段对“开启气声”的 `HiFiGAN` 路径优先使用整 clip 预渲染缓存，避免 per-segment + stem 混合带来的复杂性。

---

## 是否需要渲染的判定

当前系统对 `NSF-HiFiGAN` 的渲染判定主要基于音高曲线是否实际发生变化。本次需要把判定扩展为：

一个 clip 需要额外渲染，当且仅当满足以下任一条件：

1. 存在有效的 pitch edit
2. `breath_enabled == on`

原因：

即使没有音高变化，只要用户开启了气声模式，输出也已经从“原始 PCM”变成“HNSEP 分离后再重混的结果”，因此必须走渲染缓存而不能直接回退源 PCM。

建议将现有 `does_clip_need_pitch_edit()` 演化成更泛化的语义，例如：

- `does_clip_need_processor_render()`

这能避免未来继续叠加额外声码器参数时命名失真。

---

## 前端方案

### 1. 参数面板接入方式

不新增独立的复杂面板组件，而是复用现有 `PianoRollPanel` 的动态参数机制。

实现结果：

1. 当根轨算法选择 `nsf_hifigan_onnx` 时，前端会通过 `get_processor_params()` 拉到：
   - `breath_gain`
2. `breath_gain` 自动作为一个新的参数按钮出现在参数编辑区，与 `pitch` 并列。

### 2. 开关位置

`breath_enabled` 是静态参数，不适合画在曲线区。建议放在 `PianoRollPanel` 顶部算法控制区，紧邻 `algo` 选择或额外的 processor controls 区域，形式可为：

- 开关按钮
- 或 `On / Off` 小型 segmented control

要求：

1. 仅当算法为 `nsf_hifigan_onnx` 时显示。
2. 开关关闭时：
   - 后端完全绕过 HNSEP
   - `breath_gain` 曲线仍保留，不丢数据
3. 开关打开时：
   - `breath_gain` 曲线立即生效
   - 触发相关缓存失效与重新预渲染

### 3. 交互语义

建议的用户语义为：

1. 开关控制“是否启用气声保留模式”。
2. 曲线控制“气声在输出中的音量倍率”。
3. 曲线默认值应表现为自然保留，不应默认削弱。

---

## 错误处理与回退策略

### 1. HNSEP 模型不可用

若 `breath_enabled = on` 但 HNSEP 模型未找到或加载失败：

1. 后端应返回明确错误，标记该处理器能力不可用。
2. 前端应显示与现有 pitch backend unavailable 类似的可理解提示。
3. 不建议静默退回纯 HiFiGAN，因为这会导致用户听到与参数配置不一致的结果。

### 2. 输入采样率不匹配

HNSEP 配置固定为 44100 Hz。若当前链路输入不是 44100：

1. 第一阶段推荐沿用现有 NSF-HiFiGAN 使用场景，只在 44100 Hz 路径启用。
2. 若运行中出现非 44100 输入，则直接报错并中止该 clip 渲染。
3. 后续如需支持其他采样率，再评估在 HNSEP 前后做显式重采样。

### 3. stem 长度不一致

HNSEP 输出 `harmonic` / `noise` 与输入长度若存在轻微误差：

1. 统一以处理链期望输出帧数为准裁切或补零。
2. `harmonic` 与 `noise` 混合前必须先做长度归一。

---

## 实施步骤

建议分四步落地：

### Step 1. 后端 HNSEP Runtime

1. 接入 `hnsep.onnx`
2. 实现模型加载、探测、推理接口
3. 补充资源打包与环境变量路径解析

### Step 2. NSF-HiFiGAN 链路增强

1. 为 `HiFiGanStage` 新增 `breath_enabled` 与 `breath_gain` 参数描述
2. 在 stage 内实现 HNSEP 分离、harmonic 变调、noise 增益、重混
3. 把判定逻辑从“只看 pitch edit”扩展到“看 processor render 是否需要”

### Step 3. 缓存接入

1. 新增 HNSEP 分离缓存
2. 扩展 RenderedClipCache hash 覆盖气声参数
3. 在播放预渲染和离线渲染路径中统一生效

### Step 4. 前端参数入口

1. 在 `PianoRollPanel` 中为 NSF-HiFiGAN 显示气声开关
2. 让 `breath_gain` 通过现有动态参数曲线入口显示和编辑
3. 增加 i18n 文案

---

## 测试计划

### 后端测试

1. `hnsep_onnx` 模型加载探测测试
2. 开关关闭时，输出应与当前 NSF-HiFiGAN 行为一致
3. 开关开启且 `breath_gain = 0` 时，输出应仅包含 harmonic 变调结果
4. 开关开启且 `breath_gain = 1` 时，输出应包含完整气声混回
5. 仅修改 `breath_gain` 时：
   - HNSEP 分离缓存命中
   - 整 clip 渲染缓存失效并重建

### 前端测试

1. 选择 `nsf_hifigan_onnx` 时显示气声开关
2. `breath_gain` 参数按钮可见且可编辑
3. 切换到其他算法时隐藏气声开关与相关参数入口
4. 开关状态与曲线编辑会触发参数写回和波形刷新

### 手工验收

1. 关闭气声开关：声音与当前版本保持一致
2. 开启气声开关：气声明显被保留且不随音高变化产生异常伪影
3. 拉低 `breath_gain` 曲线：对应区段气声变弱
4. 拉高 `breath_gain` 曲线：对应区段气声增强
5. 连续播放、停止、重新播放时缓存行为稳定，无错误复用

---

## 风险与注意点

1. HNSEP 会增加 NSF-HiFiGAN 链路的计算量，必须依赖缓存减少重复推理。
2. 若未来要支持 clip 级气声曲线，本次方案的数据结构无需重做，但缓存 key 需要纳入 clip override。
3. 现有 `HiFiGanRenderer` 偏向 per-segment 推理，带 stem 后其职责会变重；第一阶段应优先确保整 clip 预渲染路径稳定，而不是过早优化实时路径。
4. 由于气声开启时即使没有 pitch edit 也需要处理，播放链路里所有“是否需要合成”的判断都必须复核，不能只看 pitch 曲线。

---

## 结论

本方案将 HNSEP 作为 `NSF-HiFiGAN` 的内部增强模块接入，优先复用现有的：

1. `ProcessorChain`
2. `extra_curves` / `extra_params`
3. `PianoRollPanel` 动态参数 UI
4. `RenderedClipCache` 预渲染缓存体系

这样可以在不引入新算法分支、不重写多 stem 架构的前提下，实现：

1. 谐波部分参与音高处理
2. 气声部分独立保留并可曲线控音量
3. 开关关闭时完全绕过 HNSEP
4. 播放与导出结果一致

这是当前代码基线下风险最低、收益最高、并且后续仍可向 clip 级参数或更通用 stem 架构演进的方案。