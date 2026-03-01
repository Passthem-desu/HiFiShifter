## ADDED Requirements

### Requirement: per-clip pitch 分析并行化
`compute_pitch_curve` 中的逐 clip「解码 + 重采样 + WORLD 分析」阶段 SHALL 使用 Rayon 并行执行，以缩短多 clip 项目的整体分析时长。

#### Scenario: 多 clip 并行分析提速
- **WHEN** 项目包含 ≥2 个有效 clip 且进行 pitch 分析
- **THEN** 各 clip 的解码与 WORLD 分析 SHALL 并发执行，整体耗时 SHALL 不超过串行实现的 `max(单 clip 最大耗时) + 10%` 容限

#### Scenario: 单 clip 项目行为不变
- **WHEN** 项目只有 1 个 clip
- **THEN** 行为与串行版本等价，结果数值相同

#### Scenario: 并行度可由环境变量控制
- **WHEN** 设置 `HIFISHIFTER_PITCH_PARALLEL_CLIPS=N`（N≥1）
- **THEN** Rayon 线程池 SHALL 最多同时处理 N 个 clip，防止低内存设备 OOM

### Requirement: per-clip pitch 缓存
`AppState` SHALL 维护一个 `clip_pitch_cache: Mutex<HashMap<String, Vec<f32>>>`，缓存每个 clip 的 MIDI curve 分析结果，避免内容未变化时重复计算。

#### Scenario: 未变化 clip 跳过计算
- **WHEN** 下一次分析触发时某 clip 的 cache key（文件签名 + trim + playback_rate + frame_period_ms）与缓存命中
- **THEN** 该 clip SHALL 直接使用缓存结果，不再执行 WORLD 分析

#### Scenario: clip 内容变化时缓存失效
- **WHEN** clip 的 source_path 文件被修改（mtime 或 size 变化）、或 trim/playback_rate 被调整
- **THEN** 该 clip 的缓存 key 变化，SHALL 触发重新分析

#### Scenario: 新 clip 不影响其他 clip 缓存
- **WHEN** 在项目中新增一个 clip 并触发 pitch 分析
- **THEN** 已有 clip 的缓存 SHALL 命中并跳过，只对新 clip 执行分析

### Requirement: 分析区段截取限制
对于 clip 在时间线上用到的源音频区段（trim 后），若连续时长超过 `HIFISHIFTER_PITCH_MAX_SEGMENT_SEC`（默认 60s），SHALL 截断到该上限再进行 WORLD 分析，避免超长音频单次调用阻塞。

#### Scenario: 超长音频截断分析
- **WHEN** clip trim 后的源区段时长 > `HIFISHIFTER_PITCH_MAX_SEGMENT_SEC`
- **THEN** 仅取前 `HIFISHIFTER_PITCH_MAX_SEGMENT_SEC` 的音频做 WORLD 分析，剩余超出部分 pitch 填充为 0（unvoiced），总体分析时长 SHALL 在限制内

#### Scenario: 默认上限 60s 覆盖绝大多数人声片段
- **WHEN** 未设置环境变量
- **THEN** 默认上限为 60 秒，适用于绝大多数人声 clip
