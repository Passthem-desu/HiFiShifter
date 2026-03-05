# 音高合成和播放链路改造实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现音高合成和播放链路的改造，支持播放时遇到未合成完的clip暂停，合成好后自动继续播放

**Architecture:** 采用混合策略，播放开始前先渲染播放头位置之后的前N个clip（预热），播放启动后继续后台渲染后续clip。播放头追上渲染进度时暂停播放位置推进并输出静音，等clip合成完后自动恢复。

**Tech Stack:** Rust (Tauri), React, TypeScript, Audio Engine

---

## 当前架构分析

### 后端音频链路
- `playback.rs`: 播放命令入口，触发后台渲染线程
- `audio_engine/mix.rs`: 音频回调，按优先级读取：rendered_pcm → stretch_stream → 源PCM
- `synth_clip_cache.rs`: 合成clip缓存管理
- 当前问题：所有clip必须全部合成完才播放，无法实现增量播放

### 前端播放控制
- 使用 `playback_rendering_state` 事件监听渲染状态
- 需要改造为支持clip级别的渲染状态跟踪

## 改造方案

### 核心变更
1. **删除fallback到源PCM机制** - 当clip需要pitch edit但未合成时，输出静音而非源PCM
2. **增量渲染机制** - 按时间线顺序渲染clip，第一个clip就绪即开始播放
3. **动态暂停/恢复** - 音频回调中检测未合成clip，暂停位置推进，合成完成后自动恢复

### 技术实现
- 新增clip级别的渲染状态跟踪
- 改造音频回调的clip采样逻辑
- 优化后台渲染线程的调度策略

## 任务分解

### Task 1: 分析当前音频回调逻辑

**Files:**
- Read: `backend/src-tauri/src/audio_engine/mix.rs`
- Read: `backend/src-tauri/src/commands/playback.rs`

**Step 1: 理解当前clip采样逻辑**
分析 `sample_clip_pcm` 函数的优先级逻辑，特别是当 `rendered_pcm` 为 `None` 时的fallback行为。

**Step 2: 理解后台渲染流程**
分析 `play_original` 命令中的后台渲染线程如何按顺序渲染所有clip。

### Task 2: 设计clip状态跟踪机制

**Files:**
- Modify: `backend/src-tauri/src/synth_clip_cache.rs`
- Create: `backend/src-tauri/src/clip_rendering_state.rs`

**Step 1: 定义clip渲染状态枚举**
```rust
pub enum ClipRenderingState {
    Pending,    // 等待渲染
    Rendering,  // 正在渲染
    Ready,      // 渲染完成
    Failed,     // 渲染失败
}
```

**Step 2: 扩展合成缓存状态跟踪**
在 `SynthClipCache` 中添加clip渲染状态跟踪功能。

### Task 3: 改造后台渲染线程

**Files:**
- Modify: `backend/src-tauri/src/commands/playback.rs`

**Step 1: 实现增量渲染逻辑**
改造后台渲染线程，支持按时间线顺序渲染clip，第一个clip就绪即触发播放。

**Step 2: 添加clip级别状态事件**
新增clip级别的渲染状态事件，供前端显示进度。

### Task 4: 改造音频回调逻辑

**Files:**
- Modify: `backend/src-tauri/src/audio_engine/mix.rs`

**Step 1: 删除源PCM fallback**
当clip需要pitch edit但 `rendered_pcm` 为 `None` 时，输出静音而非源PCM。

**Step 2: 实现动态暂停机制**
在音频回调中检测未合成clip，暂停播放位置推进，输出静音等待合成完成。

### Task 5: 前端播放控制改造

**Files:**
- Modify: `frontend/src/components/layout/pianoRoll/useClipsPeaksForPianoRoll.ts`
- Modify: `frontend/src/components/layout/timeline/TrackLane.tsx`

**Step 1: 支持clip级别渲染状态显示**
改造前端UI，支持显示每个clip的渲染状态（等待/渲染中/就绪）。

**Step 2: 优化播放控制逻辑**
改造播放控制逻辑，支持动态暂停/恢复行为。

### Task 6: 集成测试和验证

**Files:**
- Create: `backend/src-tauri/tests/playback_incremental.rs`
- Create: `frontend/src/tests/playback_integration.test.ts`

**Step 1: 编写后端测试**
测试增量渲染和动态暂停机制的正确性。

**Step 2: 编写前端集成测试**
测试前端播放控制与后端渲染状态的同步。

## 风险与缓解

### 技术风险
1. **音频卡顿**: 频繁暂停/恢复可能导致用户体验不佳
   - 缓解: 优化预热策略，减少暂停频率

2. **状态同步复杂性**: clip状态跟踪可能引入竞态条件
   - 缓解: 使用原子操作和适当的锁策略

### 用户体验风险
1. **静音等待时间**: 用户可能对静音等待感到困惑
   - 缓解: 提供清晰的UI状态提示

## 验收标准

1. ✅ 播放时遇到未合成clip自动暂停，合成完成后自动恢复
2. ✅ 删除fallback到源PCM机制，只使用合成音频
3. ✅ 支持clip级别的渲染状态跟踪和显示
4. ✅ 播放不需要等到所有clip都合成好才开始
5. ✅ 保持音频质量和性能稳定

## 实施顺序建议

按以下顺序实施以确保系统稳定性：
1. Task 1-2: 分析和设计阶段
2. Task 4: 先改造音频回调逻辑（风险较小）
3. Task 3: 然后改造后台渲染线程
4. Task 5: 最后改造前端UI
5. Task 6: 集成测试验证

这个计划提供了从分析到实施的完整路径，每个任务都是独立的且可验证的。