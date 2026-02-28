## ADDED Requirements

### Requirement: mel-projection-matrix-multiply
`mel_from_audio_fast()` 中的 Mel 投影 SHALL 使用矩阵乘法（`ndarray::Array2::dot`）替代手写双重循环，利用 SIMD 自动向量化加速计算。

#### Scenario: Mel 投影结果与原实现数值一致
- **WHEN** 对相同音频输入分别调用矩阵乘法版本和原手写循环版本
- **THEN** 输出 mel 矩阵的每个元素误差 < 1e-5（浮点精度范围内）

#### Scenario: mel_fb 以 Array2 形式预计算
- **WHEN** `NsfHifiganOnnx::load()` 被调用
- **THEN** `mel_fb` 以 `Array2<f32>`（shape: `[n_mels, n_freqs]`）形式存储，不再是 `Vec<Vec<f32>>`

#### Scenario: 每帧 mag 累积为矩阵后一次性投影
- **WHEN** `mel_from_audio_fast()` 处理 n_frames 帧音频
- **THEN** 所有帧的幅度谱累积为 `Array2<f32>`（shape: `[n_freqs, n_frames]`），通过一次 `dot()` 完成全部 Mel 投影

#### Scenario: 空音频输入不 panic
- **WHEN** 输入音频长度为 0 或小于 win_size
- **THEN** 返回全零 mel 矩阵，不 panic，行为与原实现一致
