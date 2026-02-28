## ADDED Requirements

### Requirement: export-format-quality-preset
新增 `ExportFormat` 和 `QualityPreset`，导出时使用最高质量预设。

#### Scenario: 最终导出使用 32-bit float WAV
- **GIVEN** 用户触发"导出"操作
- **WHEN** 调用导出命令
- **THEN** 输出文件为 32-bit float WAV（`Wav32f`），`QualityPreset::Export`

#### Scenario: 实时预览保持 16-bit WAV
- **GIVEN** 播放引擎触发实时 mixdown
- **WHEN** 调用 `render_mixdown_wav` 且 `quality_preset = Realtime`
- **THEN** 输出文件为 16-bit int WAV（`Wav16`），与原行为一致

#### Scenario: 24-bit WAV 导出
- **GIVEN** 用户选择 24-bit 导出格式
- **WHEN** 调用导出命令，`export_format = Wav24`
- **THEN** 输出文件为 24-bit int WAV

#### Scenario: MixdownOptions 默认值向后兼容
- **GIVEN** 现有代码构造 `MixdownOptions` 时未指定新字段
- **WHEN** 编译
- **THEN** `export_format` 默认为 `Wav16`，`quality_preset` 默认为 `Realtime`，行为与原来一致
