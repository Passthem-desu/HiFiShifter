# 移除实时流式合成，改为预渲染+播放文件 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 移除 audio_engine 中的实时流式合成架构（base_stream、pitch_stream_onnx、pitch_stream_world），改为预渲染 WAV + play_file 模式。

**Architecture:** play_original 在检测到 pitch edit 激活时，先调用 render_timeline_to_wav 渲染 WAV 文件，再通过 play_file 播放。无 pitch edit 时保持现有 legacy clip mixing（零延迟）。stretch_stream（实时拉伸）暂时保留不动。

**Tech Stack:** Rust (backend), Tauri, cpal audio output

---

## 改造范围总览

### 需要删除的文件
- `audio_engine/base_stream.rs` — 后台 base 混音线程
- `audio_engine/pitch_stream_onnx.rs` — ONNX 实时音高流
- `audio_engine/pitch_stream_world.rs` — WORLD 实时音高流
- `audio_engine/realtime_stats.rs` — 实时渲染统计计数器

### 需要保留的文件（不删除）
- `audio_engine/ring.rs` — StreamRingStereo，stretch_stream 仍依赖
- `audio_engine/stretch_stream.rs` — 实时拉伸流，本次不动
- `streaming_world.rs` — StreamingWorldSynthesizer，world_vocoder 离线合成依赖

### 需要修改的文件
- `audio_engine/mod.rs` — 移除已删除模块的声明
- `audio_engine/types.rs` — 移除 EngineSnapshot 的 base_stream/pitch_stream/pitch_stream_algo 字段
- `audio_engine/snapshot.rs` — 移除 base_stream/pitch_stream spawn 逻辑，简化 build_snapshot
- `audio_engine/mix.rs` — 移除 pitch_stream/base_stream 分支，只保留 legacy mixing
- `audio_engine/engine.rs` — 移除 pitch_stream_priming_info/set_pitch_stream_hard_start_enabled 等方法，清理 realtime_stats
- `commands/playback.rs` — 重写 play_original：检测 pitch edit → 预渲染 → play_file

---

## Task 1: 修改 `audio_engine/types.rs` — 移除 stream 字段

**Files:**
- Modify: `backend/src-tauri/src/audio_engine/types.rs`

**改动说明：**
1. 移除 `use super::ring::StreamRingStereo;` 导入
2. 移除 `use crate::pitch_editing::PitchEditAlgorithm;` 导入
3. 从 `EngineClip` 移除 `stretch_stream` 字段（注意：stretch_stream 保留！这里暂不动）
4. 从 `EngineSnapshot` 移除 `base_stream`、`pitch_stream`、`pitch_stream_algo` 三个字段
5. 更新 `EngineSnapshot::empty()` 方法
6. 移除 `use super::realtime_stats::RealtimeRenderStatsSnapshot;` 和 `AudioEngineStateSnapshot.realtime_stats` 字段

**注意：** `EngineClip.stretch_stream` **保留**，因为 stretch_stream 本次不动。
`StreamRingStereo` 的 import 也要保留（stretch_stream 字段仍用）。
`RealtimeRenderStatsSnapshot` 导入移除后，`AudioEngineStateSnapshot.realtime_stats` 字段类型改为 `Option<String>`（占位，后续可完全移除）或直接删除。

---

## Task 2: 修改 `audio_engine/mod.rs` — 移除已删除模块声明

**Files:**
- Modify: `backend/src-tauri/src/audio_engine/mod.rs`

**改动说明：**
1. 移除 `mod base_stream;`
2. 移除 `#[cfg(feature = "onnx")] mod pitch_stream_onnx;`
3. 移除 `mod pitch_stream_world;`
4. 移除 `mod realtime_stats;`
5. 保留 `mod ring;`、`pub(crate) mod stretch_stream;`、其他模块

---

## Task 3: 删除实时流式文件

**Files:**
- Delete: `backend/src-tauri/src/audio_engine/base_stream.rs`
- Delete: `backend/src-tauri/src/audio_engine/pitch_stream_onnx.rs`
- Delete: `backend/src-tauri/src/audio_engine/pitch_stream_world.rs`
- Delete: `backend/src-tauri/src/audio_engine/realtime_stats.rs`

---

## Task 4: 修改 `audio_engine/snapshot.rs` — 移除 stream spawn 逻辑

**Files:**
- Modify: `backend/src-tauri/src/audio_engine/snapshot.rs`

**改动说明：**

`build_snapshot` 函数目前包含 ~200 行的 base_stream/pitch_stream spawn 逻辑。全部移除。

1. 移除 `use super::base_stream;`
2. 移除 `use super::ring::StreamRingStereo;` （如果仅 stream 使用。注意：stretch_stream 仍需要 StreamRingStereo，检查是否还需要）
3. `build_snapshot` 签名中移除 `position_frames`、`is_playing`、`stretch_stream_epoch`（部分参数 stretch_stream 仍需要，需保留。具体：`position_frames` 和 `is_playing` 和 `stretch_stream_epoch` 和 `clip_stretch_epochs` 仍被 stretch_stream spawn 使用）
4. 移除整个 `// Decide pitch-stream intent early ...` 到 pitch_stream spawn 结束的代码块（约行 416-648）
5. 移除 base_stream spawn 相关代码（约行 431-472）
6. 保留 stretch_stream spawn 相关代码不动
7. `EngineSnapshot` 构造中移除 `base_stream`、`pitch_stream`、`pitch_stream_algo` 字段
8. `build_snapshot_for_file` 中也移除这三个字段

---

## Task 5: 修改 `audio_engine/mix.rs` — 简化混音逻辑

**Files:**
- Modify: `backend/src-tauri/src/audio_engine/mix.rs`

**改动说明：**

1. 移除 `use crate::audio_engine::pitch_stream_onnx;` 导入
2. 移除 `use super::realtime_stats::RealtimeRenderStats;` 导入
3. 移除 `mix_snapshot_clips_pitch_edited_into_scratch` 函数（不再需要）
4. 简化 `mix_into_scratch_stereo`：
   - 移除整个 `pitch_stream` 分支（`if let Some(stream) = snap.pitch_stream.as_ref()`）
   - 移除整个 `base_stream` 分支（`else if let Some(base) = snap.base_stream.as_ref()`）
   - 只保留 legacy mixing 路径：`mix_snapshot_clips_into_scratch`
   - 移除所有 `stats.*` 调用
5. 简化 `render_callback_*` 函数签名，移除 `stats` 参数
6. 简化 `mix_into_scratch_stereo` 签名，移除 `stats` 参数

---

## Task 6: 修改 `audio_engine/engine.rs` — 清理 stream 相关方法和 realtime_stats

**Files:**
- Modify: `backend/src-tauri/src/audio_engine/engine.rs`

**改动说明：**

1. 移除导入：
   - `use super::realtime_stats::RealtimeRenderStats;`
   - `use super::realtime_stats::RealtimeRenderStatsSnapshot;`
   - `use crate::pitch_editing::PitchEditAlgorithm;`

2. 从 `AudioEngine` struct 移除 `realtime_stats` 字段

3. 从 `AudioEngine::clone()` 移除 `realtime_stats` 克隆

4. 从 `AudioEngine::with_app_handle()` 中：
   - 移除 `realtime_stats` 创建
   - 移除 `realtime_stats_thread` 克隆
   - 移除 `realtime_stats_cb` 克隆
   - 移除 render_callback 调用中的 `realtime_stats_cb.as_ref()` 参数

5. 移除方法：
   - `pitch_stream_priming_info()`
   - `set_pitch_stream_hard_start_enabled()`
   - `realtime_render_stats_snapshot()`

6. 从 `snapshot_state()` 移除 `realtime_stats` 字段

7. `EngineWorkerState` 结构体不需要改动（stretch_stream_epoch 等仍在使用）

8. `handle_update_timeline` 中移除注释提到 "base_stream / pitch_stream" 的部分

---

## Task 7: 重写 `commands/playback.rs` — play_original 改为预渲染模式

**Files:**
- Modify: `backend/src-tauri/src/commands/playback.rs`

**改动说明：**

将 `play_original` 从实时流式改为预渲染 + play_file 模式：

```rust
pub(super) fn play_original(state: State<'_, AppState>, start_sec: f64) -> serde_json::Value {
    guard_json_command("play_original", || {
        let timeline = state.timeline.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let bpm = timeline.bpm;
        let playhead_sec = timeline.playhead_sec;
        if !(bpm.is_finite() && bpm > 0.0) {
            return serde_json::json!({"ok": false, "error": "invalid bpm"});
        }
        let start_sec = playhead_sec.max(0.0) + start_sec.max(0.0);

        // 检测是否有活跃的 pitch edit
        let pitch_active = crate::pitch_editing::is_pitch_edit_active(&timeline);
        let pitch_backend_ok = crate::pitch_editing::is_pitch_edit_backend_available(&timeline);
        let need_prerender = pitch_active && pitch_backend_ok;

        if !need_prerender {
            // 无 pitch edit：直接走实时 clip mixing（零延迟）
            state.audio_engine.seek_sec(start_sec);
            state.audio_engine.update_timeline(timeline);
            state.audio_engine.set_playing(true, Some("original"));
            return serde_json::json!({"ok": true, "playing": "original", "start_sec": start_sec});
        }

        // 有 pitch edit：预渲染 WAV 后播放
        let out_path = match new_temp_wav_path("prerender") {
            Ok(p) => p,
            Err(e) => return serde_json::json!({"ok": false, "error": e}),
        };

        // 后台线程渲染，避免阻塞 UI
        if let Some(app) = state.app_handle.get().cloned() {
            let engine = state.audio_engine.clone();
            let state_inner = state.inner().clone(); // AppState 需要 Clone 或 Arc
            std::thread::spawn(move || {
                // 推送渲染开始
                let _ = app.emit("playback_rendering_state", PlaybackRenderingStateEvent {
                    active: true,
                    progress: Some(0.0),
                    target: Some("original".to_string()),
                });

                match render_timeline_to_wav(&state_inner, &out_path, start_sec, None) {
                    Ok(_result) => {
                        // 推送渲染完成
                        let _ = app.emit("playback_rendering_state", PlaybackRenderingStateEvent {
                            active: false,
                            progress: Some(1.0),
                            target: Some("original".to_string()),
                        });
                        // 播放渲染后的 WAV
                        engine.play_file(&out_path, 0.0, "original");
                    }
                    Err(e) => {
                        eprintln!("play_original: prerender failed: {}", e);
                        let _ = app.emit("playback_rendering_state", PlaybackRenderingStateEvent {
                            active: false,
                            progress: None,
                            target: Some("original".to_string()),
                        });
                    }
                }
            });
        }

        serde_json::json!({"ok": true, "playing": "original", "start_sec": start_sec})
    })
}
```

**关键设计点：**
- 无 pitch edit 时直接走 seek + update_timeline + set_playing（零延迟，和现在一样）
- 有 pitch edit 时后台线程渲染 WAV → play_file
- 使用已有的 `PlaybackRenderingStateEvent` 推送渲染进度
- 移除整个 priming 线程逻辑

**注意：** `render_timeline_to_wav` 接收 `&AppState`，但在 spawn 线程中需要 `AppState` 的所有权或引用。需要检查 AppState 是否支持 `Clone`，或者通过 `Arc` 传递。当前 `render_timeline_to_wav` 只使用 `state.timeline`（`Mutex<TimelineState>`），可以直接传递 timeline 的 clone 给 `render_mixdown_wav`。

---

## Task 8: 编译验证

**Step 1:** 运行 `cargo check` 验证编译通过
```
cargo check 2>&1
```

**Step 2:** 修复编译错误（如有）

**Step 3:** 运行 `cargo build`
```
cargo build 2>&1
```

---

## 依赖关系

```
Task 1 (types.rs)
  ↓
Task 2 (mod.rs) + Task 3 (删除文件) — 可并行
  ↓
Task 4 (snapshot.rs) + Task 5 (mix.rs) — 可并行
  ↓
Task 6 (engine.rs)
  ↓
Task 7 (playback.rs)
  ↓
Task 8 (编译验证)
```

## 风险点

1. **stretch_stream 仍依赖 ring.rs 和 StreamRingStereo** — ring.rs 不能删
2. **streaming_world.rs 被 world_vocoder.rs 离线合成使用** — 不能删
3. **AppState 在 spawn 线程中的传递** — 需要确认是否可 Clone 或通过 Arc 包装
4. **render_timeline_to_wav 的采样率** — 当前硬编码 44100，需与 engine 的 sample_rate 一致
5. **预渲染的 start_sec** — play_file 的 offset_sec 应为 0.0（WAV 已从 start_sec 开始渲染）
