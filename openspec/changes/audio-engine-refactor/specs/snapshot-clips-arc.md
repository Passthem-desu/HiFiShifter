# Spec: EngineSnapshot.clips Arc 共享（方案 E）

## CHANGED Requirements

### Requirement: EngineSnapshot.clips 使用 Arc 共享

`EngineSnapshot.clips` 的类型必须为 `Arc<Vec<EngineClip>>`，不得为 `Vec<EngineClip>`。

#### Scenario: snapshot 重建时 clips 为 Arc clone
- **GIVEN** `StretchReady`/`AudioReady`/`ClipPitchReady` 触发 snapshot 重建
- **WHEN** `build_snapshot` 构建新 `EngineSnapshot`
- **THEN** `clips` 字段为 `Arc::new(clips_out)` 而非裸 `Vec`

#### Scenario: 音频回调读取 clips 行为不变
- **GIVEN** `EngineSnapshot.clips` 类型改为 `Arc<Vec<EngineClip>>`
- **WHEN** `mix.rs` 中的混音函数遍历 `snap.clips`
- **THEN** 遍历行为与重构前完全一致（`Arc<Vec>` 可直接 deref 为 `&[EngineClip]`）

#### Scenario: 多个 snapshot 可共享同一 clips Arc
- **GIVEN** 两次连续的 snapshot 重建，clips 内容相同
- **WHEN** 第二次重建时传入旧 clips 的 `Arc` clone
- **THEN** 两个 snapshot 共享同一 `Arc<Vec<EngineClip>>`，不发生深拷贝
