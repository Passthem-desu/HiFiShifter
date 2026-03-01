## ADDED Requirements

### Requirement: ONNX 不可用时阻止播放并报错
当 NSF-HiFiGAN ONNX feature 未编译、模型路径未配置或运行时初始化失败时，播放管线 SHALL 阻止播放并返回错误信息，不得静默回退到 WORLD。

#### Scenario: feature 未编译时切换 ONNX 算法阻止播放
- **WHEN** 用户在 Algo 下拉框选择 `NSF-HiFiGAN (ONNX)` 且后端编译时未开启 `onnx` feature
- **THEN** 播放 SHALL 返回 `ok=false` 且包含错误信息，播放不会启动

#### Scenario: 模型路径未配置时阻止播放
- **WHEN** `onnx` feature 已编译但环境变量未指向有效模型文件
- **THEN** `is_available()` 返回 `false`，播放 SHALL 返回错误信息，不会启动

#### Scenario: hard-start 超时停止播放
- **WHEN** ONNX 推理在 `HIFISHIFTER_ONNX_STREAM_PRIME_TIMEOUT_MS` 内未完成 prime
- **THEN** 播放 SHOULD 停止并返回错误状态，不得自动回退到其他声码器

### Requirement: ONNX 可用性查询 command
后端 SHALL 提供 `get_onnx_status` Tauri command，返回编译期和运行时两层 ONNX 可用性信息。

#### Scenario: 返回完整状态对象
- **WHEN** 前端调用 `invoke("get_onnx_status")`
- **THEN** 响应 SHALL 包含字段：`compiled: bool`（`onnx` feature 是否编译）、`model_available: bool`（模型文件是否可加载）、`ep_choice: String`（当前 EP：`cpu`/`cuda`/`auto`）

#### Scenario: onnx feature 未编译时 compiled=false
- **WHEN** 后端以无 `onnx` feature 编译
- **THEN** `get_onnx_status` 返回 `compiled: false, model_available: false`

### Requirement: 前端 Algo 选择器显示 ONNX 可用状态
前端参数面板的 Algo 下拉框 SHALL 在组件 mount 时查询 `get_onnx_status`，当 `model_available: false` 时在 ONNX 选项旁显示 `(unavailable)` 标签。

#### Scenario: ONNX 不可用时显示提示
- **WHEN** `get_onnx_status` 返回 `model_available: false`
- **THEN** Algo 下拉框中的 `NSF-HiFiGAN (ONNX)` 选项 SHALL 附带 `(unavailable)` 文字标记，选项仍可选但显示警告颜色

#### Scenario: ONNX 可用时正常显示
- **WHEN** `get_onnx_status` 返回 `model_available: true`
- **THEN** Algo 下拉框 SHALL 正常显示所有选项，无额外警告标记
