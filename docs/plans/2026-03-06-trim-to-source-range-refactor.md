# Trim → Source Range 重构实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 `trimStartSec`/`trimEndSec`（"裁掉了多少"的相对量）重构为 `sourceStartSec`/`sourceEndSec`（源文件有效区间的绝对起止时间），使前后端语义更清晰。

**Architecture:** 纯字段重命名 + 语义转换。后端内部所有原先基于 "从 durationSec 反算" 的逻辑改为直接使用绝对区间。前端 trim 拖动逻辑从增减裁剪量改为移动区间边界。

**Tech Stack:** TypeScript (React/Redux) + Rust (Tauri)

---

## 语义对照表

| 旧字段 | 新字段 | 关系 |
|---|---|---|
| `trimStartSec` | `sourceStartSec` | `sourceStartSec = trimStartSec` |
| `trimEndSec` | `sourceEndSec` | `sourceEndSec = durationSec - trimEndSec` |

新字段初始值：`sourceStartSec = 0`, `sourceEndSec = durationSec`（使用整个源文件）。

反算关系（用于理解/过渡）：
- `trimStartSec = sourceStartSec`
- `trimEndSec = durationSec - sourceEndSec`

---

## Task 1: 后端数据模型 — `state.rs`

**Files:**
- Modify: `backend/src-tauri/src/state.rs`

**变更：**
1. `Clip` 结构体：`trim_start_sec: f64` → `source_start_sec: f64`，`trim_end_sec: f64` → `source_end_sec: f64`
2. `ClipStatePatch` 结构体：`trim_start_sec: Option<f64>` → `source_start_sec: Option<f64>`，`trim_end_sec: Option<f64>` → `source_end_sec: Option<f64>`
3. `Clip` 的 serde 反序列化：添加 `#[serde(alias = "trim_start_sec")]` 和 `#[serde(alias = "trim_end_sec")]` 支持旧项目文件加载
4. `add_clip()`：初始值 `source_start_sec: 0.0`, `source_end_sec: 0.0`（0.0 表示使用到源文件末尾）
5. `patch_clip_state()`：更新字段引用
6. `split_clip()`：更新 right clip 的 `source_start_sec` 计算逻辑
7. `to_payload()`：更新字段映射
8. `set_clip_state()`：更新参数名

**关键语义变化：**

`split_clip()` 中：
```rust
// 旧：right.trim_start_sec = trim_start_sec + left_len * rate
// 新：right.source_start_sec = source_start_sec + left_len * rate
// （语义相同，只是字段名变了）
```

`patch_clip_state()` 中：
```rust
// 旧：c.trim_end_sec = v.max(0.0)
// 新：c.source_end_sec = v.max(0.0)
// （source_end_sec 允许 0.0 表示"使用到源文件末尾"）
```

---

## Task 2: 后端 API 模型 — `models.rs`

**Files:**
- Modify: `backend/src-tauri/src/models.rs`

**变更：**
1. `TimelineClip` 结构体：`trim_start_sec` → `source_start_sec`，`trim_end_sec` → `source_end_sec`

---

## Task 3: 后端命令层 — `commands.rs` + `commands/timeline.rs`

**Files:**
- Modify: `backend/src-tauri/src/commands.rs`
- Modify: `backend/src-tauri/src/commands/timeline.rs`

**变更：**
1. `set_clip_state` 命令参数：`trim_start_sec` → `source_start_sec`，`trim_end_sec` → `source_end_sec`
2. 转发到 `timeline::set_clip_state` 的参数名同步更新

---

## Task 4: 后端音频引擎 — `snapshot.rs`

**Files:**
- Modify: `backend/src-tauri/src/audio_engine/snapshot.rs`

**变更：**
1. `source_bounds_frames()` 函数参数改名 + 语义转换：

```rust
// 旧：trim_start_sec（裁掉了多少） + trim_end_sec（末尾裁掉了多少）
// 新：source_start_sec（起点） + source_end_sec（终点）

// 旧逻辑：end_limit_sec = total_sec - trim_end_sec
// 新逻辑：end_limit_sec = source_end_sec（如果 > 0）或 total_sec（如果 == 0）
```

2. `clip_source_bounds_frames()`：引用字段名变更
3. `make_stretch_key()`：参数名变更
4. `schedule_stretch_jobs()`：引用 `clip.source_start_sec` / `clip.source_end_sec`
5. `build_snapshot()`：引用字段名变更，`local_src_offset_frames` 计算中 `clip.trim_start_sec < 0` → `clip.source_start_sec < 0`

---

## Task 5: 后端音频引擎 — `types.rs` + `engine.rs`

**Files:**
- Modify: `backend/src-tauri/src/audio_engine/types.rs`
- Modify: `backend/src-tauri/src/audio_engine/engine.rs`

**变更（types.rs）：**
1. `StretchJob`：`trim_start_sec` → `source_start_sec`，`trim_end_sec` → `source_end_sec`

**变更（engine.rs）：**
1. `clip_stretch_params_changed()`：引用字段名变更
2. `clip_pitch_params_changed()`：引用字段名变更
3. `compute_pitch_curve_start_sec()`：`clip.trim_start_sec` → `clip.source_start_sec`
4. `emit_clip_pitch_data_for_clip()`：`clip.trim_start_sec`/`clip.trim_end_sec` → `clip.source_start_sec`/`clip.source_end_sec`
5. `handle_update_timeline()` 中所有 trim 比较逻辑：字段名变更

---

## Task 6: 后端 — `commands/playback.rs` + `mixdown.rs`

**Files:**
- Modify: `backend/src-tauri/src/commands/playback.rs`
- Modify: `backend/src-tauri/src/mixdown.rs`

**变更：**
所有 `clip.trim_start_sec` → `clip.source_start_sec`，`clip.trim_end_sec` → `clip.source_end_sec`。

关键语义变化（`source_bounds_frames` 调用处的 `trim_end` 反算）：
```rust
// 旧：src_end_limit_sec = (total_sec - trim_end_sec).max(trim_start_sec)
// 新：src_end_limit_sec = if source_end_sec > 0.0 { source_end_sec } else { total_sec }
//     src_end_limit_sec = src_end_limit_sec.max(source_start_sec)
```

---

## Task 7: 后端 — `pitch_clip.rs`

**Files:**
- Modify: `backend/src-tauri/src/pitch_clip.rs`

**变更：**
1. `trim_and_resample_midi()`：参数 `trim_start_sec`/`trim_end_sec` → `source_start_sec`/`source_end_sec`，内部逻辑转换：
```rust
// 旧：src_end_frame = total_midi_len - trim_end_in_frames
// 新：src_end_frame = (source_end_sec * 1000.0 / fp).round()（如果 source_end_sec > 0）
```
2. `build_clip_pitch_key()`：引用字段名变更
3. `compute_clip_pitch_midi()`：字段名变更

---

## Task 8: 后端 — `clip_pitch_cache.rs`

**Files:**
- Modify: `backend/src-tauri/src/clip_pitch_cache.rs`

**变更：**
1. `ClipCacheKey`：`trim_start_sec` → `source_start_sec`，`trim_end_sec` → `source_end_sec`
2. `generate_clip_cache_key()`：字段名变更
3. 测试用例：字段名变更

---

## Task 9: 后端 — `pitch_analysis.rs`

**Files:**
- Modify: `backend/src-tauri/src/pitch_analysis.rs`

**变更：**
全部 `clip.trim_start_sec` → `clip.source_start_sec`，`clip.trim_end_sec` → `clip.source_end_sec`。
涉及 41 处引用，包括：
1. `build_root_pitch_key()` 中的 hash 计算
2. `ClipCacheKey` 构造
3. 源裁剪逻辑：`src_end_limit_sec = total_sec - trim_end_sec` → `src_end_limit_sec = source_end_sec`（需要处理 source_end_sec == 0 的情况）
4. `assemble_pitch_orig_from_cache()` 中的 pre_silence 计算
5. 测试用例中的 Clip 初始化

---

## Task 10: 前端数据模型 — `sessionTypes.ts`

**Files:**
- Modify: `frontend/src/features/session/sessionTypes.ts`

**变更：**
1. `ClipInfo`：`trimStartSec: number` → `sourceStartSec: number`，`trimEndSec: number` → `sourceEndSec: number`

---

## Task 11: 前端 Redux — `sessionSlice.ts`

**Files:**
- Modify: `frontend/src/features/session/sessionSlice.ts`

**变更：**
1. `mergeTimelineClip()`（~行 309-310）：`clip.trim_start_sec` → `clip.source_start_sec`，`clip.trim_end_sec` → `clip.source_end_sec`；前端字段名 `trimStartSec` → `sourceStartSec`，`trimEndSec` → `sourceEndSec`
2. `setClipTrim` reducer 改名为 `setClipSourceRange`：参数从 `trimStartSec/trimEndSec` → `sourceStartSec/sourceEndSec`
3. 所有 clip 初始化处（~行 457-458, 818-819）：`trimStartSec: 0` → `sourceStartSec: 0`，`trimEndSec: 0` → `sourceEndSec: 0`（0 表示使用到源文件末尾）
4. export 改名：`setClipTrim` → `setClipSourceRange`

---

## Task 12: 前端 API + Thunks — `timeline.ts` + `timelineThunks.ts`

**Files:**
- Modify: `frontend/src/services/api/timeline.ts`
- Modify: `frontend/src/features/session/thunks/timelineThunks.ts`

**变更：**
1. `timeline.ts` 中 `setClipState` 的参数：`trimStartSec` → `sourceStartSec`，`trimEndSec` → `sourceEndSec`
2. `timelineThunks.ts` 中 `setClipStateRemote` 的 payload 类型同步
3. `createClipsRemote` 中传给 `webApi.setClipState` 的参数同步

---

## Task 13: 前端拖动 — `useEditDrag.ts`

**Files:**
- Modify: `frontend/src/components/layout/timeline/hooks/useEditDrag.ts`

**变更：**
1. `EditDragState`：`baseTrimStartSec` → `baseSourceStartSec`，`basetrimEndSec` → `baseSourceEndSec`
2. `startEditDrag()`：初始化时从 `clip.sourceStartSec`/`clip.sourceEndSec` 读取
3. `trim_left` 逻辑：`setClipTrim` → `setClipSourceRange`，参数名变更
4. `trim_right` 逻辑：

```typescript
// 旧：nextTrimEnd = basetrimEndSec - usedDeltaTimeline * rate
// 新：nextSourceEnd = baseSourceEndSec + usedDeltaTimeline * rate
// （右边界向右拉 = sourceEndSec 增大）
```

5. `end()` 中 `setClipStateRemote` 调用：参数名变更

---

## Task 14: 前端拖动 — `useSlipDrag.ts`

**Files:**
- Modify: `frontend/src/components/layout/timeline/hooks/useSlipDrag.ts`

**变更：**
1. `SlipDragState.initialById`：`trimStartSec` → `sourceStartSec`，`trimEndSec` → `sourceEndSec`
2. `startSlipDrag()` 初始化：从 `clip.sourceStartSec`/`clip.sourceEndSec` 读取
3. `onMove()`：`dispatch(setClipSourceRange(...))`
4. `end()`：`setClipStateRemote` 参数名变更

---

## Task 15: 前端渲染 — `clipWaveform.ts` + `ClipItem.tsx`

**Files:**
- Modify: `frontend/src/components/layout/timeline/clipWaveform.ts`
- Modify: `frontend/src/components/layout/timeline/ClipItem.tsx`

**变更：**
1. `clipWaveform.ts` 中 `sliceWaveformSamples()`：

```typescript
// 旧: Pick<ClipInfo, "trimStartSec" | "trimEndSec" | ...>
// 新: Pick<ClipInfo, "sourceStartSec" | "sourceEndSec" | ...>

// 旧: trimStart = clip.trimStartSec, trimEnd = clip.trimEndSec
// 旧: startSec = trimStart, maxEndSec = durationSec - trimEnd
// 新: startSec = clip.sourceStartSec, maxEndSec = clip.sourceEndSec (如果 > 0) 或 durationSec
```

2. `ClipItem.tsx`：所有 `clip.trimStartSec` → `clip.sourceStartSec`，`clip.trimEndSec` → `clip.sourceEndSec`
   - `sourceAvailSec` 计算：`durationSec - trimStart - trimEnd` → `sourceEndSec - max(0, sourceStartSec)`（需处理 sourceEndSec == 0）
   - `clipForWaveform` memo：字段名变更
   - 波形偏移量计算：`-(trimStart / rate) * pxPerSec` → `-(max(0, sourceStartSec) / rate) * pxPerSec`

---

## Task 16: 前端渲染 — `useClipWaveformPeaks.ts` + `useClipsPeaksForPianoRoll.ts` + `render.ts`

**Files:**
- Modify: `frontend/src/components/layout/timeline/clip/useClipWaveformPeaks.ts`
- Modify: `frontend/src/components/layout/pianoRoll/useClipsPeaksForPianoRoll.ts`
- Modify: `frontend/src/components/layout/pianoRoll/render.ts`

**变更：**
所有 `clip.trimStartSec` → `clip.sourceStartSec`，`clip.trimEndSec` → `clip.sourceEndSec`

---

## Task 17: 前端其他 — `useClipDrag.ts` + `useKeyboardShortcuts.ts`

**Files:**
- Modify: `frontend/src/components/layout/timeline/hooks/useClipDrag.ts`
- Modify: `frontend/src/components/layout/timeline/hooks/useKeyboardShortcuts.ts`

**变更：**
所有 `clip.trimStartSec` → `clip.sourceStartSec`，`clip.trimEndSec` → `clip.sourceEndSec`

---

## Task 18: 编译验证

**Steps:**
1. 运行 `cargo build` 验证后端编译
2. 运行 `npm run build` 验证前端编译
3. 修复所有编译错误

---

## 执行顺序建议

按 Task 编号顺序执行，后端先行（Task 1-9），然后前端（Task 10-17），最后编译验证（Task 18）。

后端内部可以用 Subagent-Driven 方式并行处理多个文件。前端变更之间有少量依赖（类型定义 → 使用处），但大部分可以并行。
