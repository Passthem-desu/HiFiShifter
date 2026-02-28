## ADDED Requirements

### Requirement: project-file-v2-msgpack
工程文件保存格式从 JSON 升级为 MessagePack，`ProjectFile` 版本号升至 v2。

#### Scenario: 新工程保存为 MessagePack 格式
- **GIVEN** 用户保存工程
- **WHEN** 调用 `save_project_to_path`
- **THEN** 文件内容为 MessagePack 二进制格式，`version` 字段值为 2

#### Scenario: 加载新格式工程文件
- **GIVEN** 文件为 MessagePack 格式的 v2 工程文件
- **WHEN** 调用 `open_project`
- **THEN** 成功解析，timeline 状态与保存时一致

#### Scenario: 向后兼容旧 JSON 格式工程文件
- **GIVEN** 文件为旧版 JSON 格式的 v1 工程文件
- **WHEN** 调用 `open_project`
- **THEN** 成功解析（fallback 到 JSON 解析），timeline 状态正确恢复

#### Scenario: 文件扩展名保持不变
- **GIVEN** 用户保存工程
- **WHEN** 保存完成
- **THEN** 文件扩展名仍为 `.hsp`

---

### Requirement: project-file-media-registry
`ProjectFile` 新增 `media_registry` 字段，记录工程引用的媒体文件信息。

#### Scenario: 保存工程时记录媒体文件信息
- **GIVEN** 工程中有 clip 引用了媒体文件
- **WHEN** 保存工程
- **THEN** `media_registry` 包含每个媒体文件的 `id`、`original_path`、`relative_path` 和 `sha256`

#### Scenario: 旧工程无 media_registry 字段时正常加载
- **GIVEN** 旧工程文件无 `media_registry` 字段
- **WHEN** 加载工程
- **THEN** `media_registry` 反序列化为空数组，不影响工程加载
