# Spec: stretch_stream 模块化（方案 B）

## CHANGED Requirements

### Requirement: stretch_stream worker 独立模块

stretch_stream worker 的 spawn 逻辑必须封装在独立的 `stretch_stream.rs` 模块中，`snapshot.rs` 不得内联该逻辑。

#### Scenario: 模块接口一致性
- **GIVEN** `stretch_stream.rs` 提供 `spawn_stretch_stream` 函数
- **WHEN** `build_snapshot` 需要为 clip 启动 stretch_stream worker
- **THEN** 调用 `stretch_stream::spawn_stretch_stream(...)` 而非内联 `thread::spawn`

#### Scenario: worker 行为不变
- **GIVEN** 任意需要 stretch 的 clip
- **WHEN** `spawn_stretch_stream` 启动 worker
- **THEN** worker 的 ring buffer 填充行为、seek 重置行为、epoch cancel 行为与重构前完全一致

#### Scenario: snapshot.rs 行数减少
- **GIVEN** 重构完成后
- **WHEN** 查看 `snapshot.rs`
- **THEN** `build_snapshot` 函数不包含 `thread::spawn` 闭包（stretch_stream 部分），行数不超过 700 行
