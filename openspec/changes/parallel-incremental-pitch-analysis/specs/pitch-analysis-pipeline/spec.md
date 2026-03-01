## ADDED Requirements

### Requirement: Unified analysis pipeline
系统必须(SHALL)为WORLD和NSF-HiFiGAN ONNX两种算法提供统一的音高分析管道。

#### Scenario: Common cache layer
- **WHEN** 使用WORLD或ONNX算法分析clip
- **THEN** 两种算法必须共享同一缓存系统，缓存键包含算法类型标识

#### Scenario: Common parallelization framework
- **WHEN** 执行批量音高分析
- **THEN** WORLD和ONNX算法必须使用相同的并行化框架和线程池

#### Scenario: Algorithm-specific cache keys
- **WHEN** 生成缓存键
- **THEN** 缓存键必须包含算法标识（例如"world_dll"或"nsf_hifigan_onnx"），确保不同算法的结果分离

### Requirement: Pipeline stages
系统必须(SHALL)将音高分析流程拆分为明确的阶段：缓存查询、音频预处理、F0分析、后处理、融合。

#### Scenario: Cache query stage
- **WHEN** 开始分析一个clip
- **THEN** 系统必须首先查询缓存，命中则跳过后续阶段

#### Scenario: Audio preprocessing stage
- **WHEN** 缓存未命中
- **THEN** 系统必须执行音频解码、重采样到44100Hz、单声道转换和DC去除

#### Scenario: F0 analysis stage
- **WHEN** 音频预处理完成
- **THEN** 系统必须调用WORLD或ONNX算法提取F0曲线（Hz）

#### Scenario: Postprocessing stage
- **WHEN** F0分析完成
- **THEN** 系统必须将F0曲线转换为MIDI音高值，并重采样到timeline帧率

#### Scenario: Fusion stage
- **WHEN** 所有clips分析完成
- **THEN** 系统必须执行winner-take-most融合算法，生成最终的root track音高曲线

### Requirement: Stage-level error handling
系统必须(SHALL)在每个阶段捕获错误，提供清晰的错误信息。

#### Scenario: Cache query error fallback
- **WHEN** 缓存查询阶段发生错误
- **THEN** 系统必须记录警告日志，继续执行音频预处理阶段

#### Scenario: Preprocessing error propagation
- **WHEN** 音频解码或重采样失败
- **THEN** 系统必须跳过该clip的后续阶段，标记为失败，并在任务结果中报告

#### Scenario: F0 analysis error retry
- **WHEN** WORLD或ONNX分析失败
- **THEN** 系统必须尝试备用算法（例如WORLD Harvest失败后尝试Dio），或标记该clip为失败

### Requirement: Progress reporting per stage
系统必须(SHALL)在每个阶段更新进度，提供细粒度的反馈。

#### Scenario: Cache query contributes minimal progress
- **WHEN** 从缓存读取clip结果
- **THEN** 该clip在整体进度中贡献极小的权重（例如1%的音频分析时间）

#### Scenario: F0 analysis contributes major progress
- **WHEN** 执行WORLD或ONNX F0分析
- **THEN** 该阶段必须占该clip总进度的80-90%，因为它是最耗时的步骤

#### Scenario: Fusion stage contributes final progress
- **WHEN** 执行融合算法
- **THEN** 该阶段必须贡献整体进度的最后5-10%，对应所有clips的合并时间

### Requirement: Algorithm selection per track
系统必须(SHALL)支持根据track配置选择不同的分析算法。

#### Scenario: WORLD algorithm for compose tracks
- **WHEN** track的pitch_analysis_algo设置为WorldDll
- **THEN** 系统必须使用WORLD Harvest或Dio算法分析该track的clips

#### Scenario: ONNX algorithm for high-speed tracks
- **WHEN** track的pitch_analysis_algo设置为NsfHifiganOnnx
- **THEN** 系统必须使用NSF-HiFiGAN ONNX算法分析该track的clips

#### Scenario: Mixed algorithms in one timeline
- **WHEN** timeline包含多个tracks，使用不同的分析算法
- **THEN** 系统必须正确隔离不同算法的执行，确保它们的结果可以在融合阶段合并

### Requirement: Backward compatibility
系统必须(SHALL)保持与现有分析结果格式的兼容性。

#### Scenario: Output format unchanged
- **WHEN** 新管道完成分析
- **THEN** 输出的MIDI音高曲线格式必须与旧版本相同（Vec<f32>，0.0表示无音高）

#### Scenario: Timeline state structure unchanged
- **WHEN** 将分析结果写入timeline state
- **THEN** pitch_orig和pitch_edit字段的数据结构必须与现有代码兼容
