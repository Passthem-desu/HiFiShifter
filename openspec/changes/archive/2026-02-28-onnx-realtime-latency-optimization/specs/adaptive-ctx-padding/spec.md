## ADDED Requirements

### Requirement: adaptive-ctx-padding-by-voiced-duration
实时推理路径中，当用户未手动设置 `HIFISHIFTER_ONNX_VAD_CTX_SEC` 时，`ctx_sec` SHALL 根据当前 voiced 段时长动态计算，以减少短 voiced 段的无效推理帧数。

#### Scenario: voiced 段 < 0.5s 时使用 0.5s ctx
- **WHEN** voiced 段时长 < 0.5s 且未设置 `HIFISHIFTER_ONNX_VAD_CTX_SEC`
- **THEN** `ctx_sec` = 0.5，实际推理范围为 voiced_duration + 1.0s

#### Scenario: voiced 段 0.5s-2.0s 时使用 1.0s ctx
- **WHEN** voiced 段时长在 [0.5s, 2.0s) 之间且未设置 `HIFISHIFTER_ONNX_VAD_CTX_SEC`
- **THEN** `ctx_sec` = 1.0，实际推理范围为 voiced_duration + 2.0s

#### Scenario: voiced 段 ≥ 2.0s 时使用 1.5s ctx（保持原默认）
- **WHEN** voiced 段时长 ≥ 2.0s 且未设置 `HIFISHIFTER_ONNX_VAD_CTX_SEC`
- **THEN** `ctx_sec` = 1.5，与原默认值一致

#### Scenario: 手动设置环境变量时不覆盖
- **WHEN** 用户设置了 `HIFISHIFTER_ONNX_VAD_CTX_SEC=2.0`
- **THEN** `ctx_sec` 始终为 2.0，不受 voiced 段时长影响
