# Design: Audio Engine Refactor (A–E)

## Current State

```
audio_engine/
  engine.rs      (634 行) — AudioEngine 公共 API + Worker 循环（含内联命令处理）
  snapshot.rs    (860 行) — build_snapshot + stretch_stream worker（内联 ~150 行）+ 辅助函数
  mix.rs         (629 行) — PCM 采样混音（含 ~160 行重复代码）
  base_stream.rs          — base_stream worker（已独立）
  pitch_stream_onnx.rs    — ONNX pitch_stream worker（已独立）
  ring.rs                 — StreamRingStereo
  types.rs                — EngineClip / EngineSnapshot / EngineCommand 等
```

## Goals

**Goals:**
- 消除 `mix.rs` 中约 160 行的重复 PCM 采样逻辑（方案 A）
- 将 `snapshot.rs` 中内联的 stretch_stream worker 提取为独立模块（方案 B）
- 将 `engine.rs` Worker 循环中的命令处理逻辑提取为独立函数（方案 C）
- 细化 `stretch_stream_epoch` 为 per-clip 粒度，减少不必要的 worker 重建（方案 D）
- 将 `EngineSnapshot.clips` 改为 `Arc<Vec<EngineClip>>` 减少重建时的内存分配（方案 E）

**Non-Goals:**
- 不改变任何对外 API（Tauri commands 不变）
- 不改变音频输出行为（方案 A/B/C/E 为纯重构）
- 不引入新的音频处理算法

---

## 方案 A：提取 `sample_clip_frame` 消除 mix.rs 代码重复

### 问题

`mix_snapshot_clips_into_scratch` 和 `mix_snapshot_clips_pitch_edited_into_scratch` 中的 PCM 采样逻辑（约 80 行）完全相同，包括：
- stretch_stream ring 读取（fast path）
- 线性插值采样（fallback path）
- repeat/loop 处理
- src_pos 边界检查

两者的唯一区别：前者在采样时直接乘以 gain，后者先采样到临时 `seg` buffer，再统一应用 gain 和 pitch edit。

### 设计

提取内联函数 `sample_clip_pcm`（不 pub，仅 mix.rs 内部使用）：

```rust
/// 采样 clip 在 local 帧处的原始 PCM（不含 gain/fade）。
/// 返回 None 表示该帧应静音（越界、leading silence 等）。
#[inline]
fn sample_clip_pcm(clip: &EngineClip, local: u64, local_adj: f64) -> Option<(f32, f32)> {
    let src_pcm = clip.src.pcm.as_slice();
    let src_frames = clip.src.frames as u64;
    let loop_len = clip.src_end_frame.saturating_sub(clip.src_start_frame) as f64;

    // Fast path: stretch_stream ring 已覆盖该帧
    if let Some(stream) = clip.stretch_stream.as_ref() {
        if let Some((sl, sr)) = stream.read_frame(local) {
            return Some((sl, sr));
        }
    }

    // Fallback: 线性插值采样
    let src_pos = if clip.repeat {
        if loop_len <= 1.0 { return None; }
        let within = (local_adj * clip.playback_rate).rem_euclid(loop_len);
        (clip.src_start_frame as f64) + within
    } else {
        (clip.src_start_frame as f64) + local_adj * clip.playback_rate
    };

    if !clip.repeat && src_pos + 1.0 >= clip.src_end_frame as f64 { return None; }

    let i0 = src_pos.floor().max(0.0) as u64;
    if i0 >= src_frames { return None; }
    let mut i1 = i0.saturating_add(1);
    if clip.repeat {
        if i1 >= clip.src_end_frame { i1 = clip.src_start_frame; }
    } else if i1 >= src_frames {
        return None;
    }

    let frac = (src_pos - i0 as f64) as f32;
    let i0u = i0 as usize;
    let i1u = i1 as usize;
    let l = src_pcm[i0u * 2] + (src_pcm[i1u * 2] - src_pcm[i0u * 2]) * frac;
    let r = src_pcm[i0u * 2 + 1] + (src_pcm[i1u * 2 + 1] - src_pcm[i0u * 2 + 1]) * frac;
    Some((l, r))
}
```

改造后：
- `mix_snapshot_clips_into_scratch`：调用 `sample_clip_pcm`，直接乘 gain 写入 scratch
- `mix_snapshot_clips_pitch_edited_into_scratch`：调用 `sample_clip_pcm`，写入 `seg`，再统一 pitch edit + gain

---

## 方案 B：stretch_stream worker 提取为 `stretch_stream.rs`

### 问题

`snapshot.rs` 的 `build_snapshot` 函数（约 400 行）内联了 stretch_stream worker 的完整逻辑（约 150 行 `thread::spawn` 闭包），与已独立的 `base_stream.rs` 和 `pitch_stream_onnx.rs` 模式不一致。

### 设计

新建 `audio_engine/stretch_stream.rs`，提取 `spawn_stretch_stream` 函数：

```rust
pub(crate) fn spawn_stretch_stream(
    ring: Arc<StreamRingStereo>,
    src: ResampledStereo,
    src_start: u64,
    src_end: u64,
    playback_rate: f64,
    start_frame: u64,       // clip 在 timeline 上的起始帧（用于 local 计算）
    length_frames: u64,
    repeat: bool,
    silence_frames: u64,
    out_rate: u32,
    position_frames: Arc<AtomicU64>,
    is_playing: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
    my_epoch: u64,
) { ... }
```

`build_snapshot` 中对应位置改为：

```rust
stretch_stream::spawn_stretch_stream(
    ring.clone(),
    src_render.clone(),
    src_start, src_end,
    playback_rate_render,
    start_frame, length_frames, repeat, silence_frames as u64,
    out_rate,
    position_frames.clone(),
    is_playing.clone(),
    stretch_stream_epoch.clone(),
    my_epoch,
);
stretch_stream = Some(ring);
```

`snapshot.rs` 中新增 `mod stretch_stream;` 引用，`build_snapshot` 函数从 ~400 行缩减到 ~250 行。

---

## 方案 C：engine.rs 命令处理函数化

### 问题

`engine.rs` Worker 循环的 `match rx.recv()` 分支（约 200 行）将所有命令处理逻辑内联，导致函数体过长，难以独立阅读和测试。

### 设计

引入 `EngineContext` 结构体，持有 Worker 线程的所有可变状态：

```rust
struct EngineContext<'a> {
    sr: u32,
    is_playing: &'a Arc<AtomicBool>,
    target: &'a Arc<Mutex<Option<String>>>,
    base_frames: &'a Arc<AtomicU64>,
    position_frames: &'a Arc<AtomicU64>,
    duration_frames: &'a Arc<AtomicU64>,
    snapshot: &'a Arc<ArcSwap<EngineSnapshot>>,
    cache: &'a Arc<Mutex<HashMap<(PathBuf, u32), ResampledStereo>>>,
    stretch_cache: &'a Arc<Mutex<HashMap<StretchKey, ResampledStereo>>>,
    stretch_inflight: &'a Arc<Mutex<HashSet<StretchKey>>>,
    stretch_tx: &'a mpsc::Sender<StretchJob>,
    stretch_stream_epoch: &'a Arc<AtomicU64>,
    resources: &'a ResourceManager,
    tx: &'a mpsc::Sender<EngineCommand>,
    last_timeline: &'a mut Option<TimelineState>,
    last_play_file: &'a mut Option<(PathBuf, f64, String)>,
}
```

提取各命令处理函数（均为 `engine.rs` 内部私有函数）：

```rust
fn handle_update_timeline(ctx: &mut EngineContext, tl: TimelineState) { ... }
fn handle_stretch_ready(ctx: &mut EngineContext, key: StretchKey) { ... }
fn handle_clip_pitch_ready(ctx: &mut EngineContext, clip_id: String) { ... }
fn handle_audio_ready(ctx: &mut EngineContext, key: Option<AudioKey>) { ... }
fn handle_play_file(ctx: &mut EngineContext, path: PathBuf, offset_sec: f64, target: String) { ... }
fn handle_seek_sec(ctx: &mut EngineContext, sec: f64) { ... }
fn handle_set_playing(ctx: &mut EngineContext, playing: bool, target: Option<String>) { ... }
fn handle_stop(ctx: &mut EngineContext) { ... }
```

Worker 循环简化为：

```rust
loop {
    match rx.recv() {
        Ok(EngineCommand::Shutdown) | Err(_) => break,
        Ok(cmd) => {
            let mut ctx = EngineContext { ... };
            match cmd {
                EngineCommand::UpdateTimeline(tl) => handle_update_timeline(&mut ctx, tl),
                EngineCommand::StretchReady { key } => handle_stretch_ready(&mut ctx, key),
                // ...
            }
        }
    }
}
```

---

## 方案 D：per-clip epoch 细化

### 问题

当前 `stretch_stream_epoch` 是全局单一 `AtomicU64`，任何 `UpdateTimeline` 都会 `fetch_add(1)` 导致所有 clip 的 stretch_stream worker 退出并重建。即使只有一个 clip 的参数变化，其他 clip 的 worker 也会被打断。

### 设计

在 `EngineSnapshot` 中为每个 clip 维护独立的 epoch：

```rust
// types.rs
pub(crate) struct EngineClip {
    // ... 现有字段 ...
    pub stretch_stream_epoch: u64,  // 新增：该 clip 的 stretch worker epoch
}
```

在 `engine.rs` 中维护 per-clip epoch map：

```rust
// engine.rs Worker 状态
let mut clip_stretch_epochs: HashMap<String, Arc<AtomicU64>> = HashMap::new();
```

`build_snapshot` 签名扩展：

```rust
pub(crate) fn build_snapshot(
    timeline: &TimelineState,
    out_rate: u32,
    cache: ...,
    stretch_cache: ...,
    position_frames: ...,
    is_playing: ...,
    stretch_stream_epoch: &Arc<AtomicU64>,           // 全局 epoch（base/pitch stream 用）
    clip_stretch_epochs: &mut HashMap<String, Arc<AtomicU64>>,  // 新增
) -> EngineSnapshot
```

`handle_update_timeline` 中的 cancel 逻辑：

```rust
fn handle_update_timeline(ctx: &mut EngineContext, tl: TimelineState) {
    // 只对参数变化的 clip 递增其 epoch
    if let Some(old_tl) = ctx.last_timeline.as_ref() {
        for clip in &tl.clips {
            let changed = old_tl.clips.iter().find(|c| c.id == clip.id)
                .map(|old| clip_stretch_params_changed(old, clip))
                .unwrap_or(true);
            if changed {
                ctx.clip_stretch_epochs
                    .entry(clip.id.clone())
                    .or_insert_with(|| Arc::new(AtomicU64::new(1)))
                    .fetch_add(1, Ordering::Relaxed);
            }
        }
        // 清理已删除 clip 的 epoch
        ctx.clip_stretch_epochs.retain(|id, _| tl.clips.iter().any(|c| &c.id == id));
    }
    // 全局 epoch 仍然递增（用于 base_stream / pitch_stream）
    ctx.stretch_stream_epoch.fetch_add(1, Ordering::Relaxed);
    // ...
}

fn clip_stretch_params_changed(old: &Clip, new: &Clip) -> bool {
    (old.playback_rate - new.playback_rate).abs() > 1e-6
        || (old.trim_start_beat - new.trim_start_beat).abs() > 1e-6
        || (old.trim_end_beat - new.trim_end_beat).abs() > 1e-6
}
```

`spawn_stretch_stream` 接收 per-clip epoch 而非全局 epoch：

```rust
pub(crate) fn spawn_stretch_stream(
    ...
    epoch: Arc<AtomicU64>,   // per-clip epoch
    my_epoch: u64,
) { ... }
```

---

## 方案 E：EngineSnapshot.clips 改为 Arc 共享

### 问题

`build_snapshot` 在 `StretchReady`/`AudioReady`/`ClipPitchReady` 触发时重建 snapshot，每次都深拷贝整个 `clips_out: Vec<EngineClip>`（含 `Arc<ResampledStereo>` 的 clone），即使 clips 列表本身没有变化。

### 设计

修改 `types.rs`：

```rust
pub(crate) struct EngineSnapshot {
    pub bpm: f64,
    pub sample_rate: u32,
    pub duration_frames: u64,
    pub clips: Arc<Vec<EngineClip>>,   // Vec → Arc<Vec>
    pub base_stream: Option<Arc<StreamRingStereo>>,
    pub pitch_stream: Option<Arc<StreamRingStereo>>,
    pub pitch_stream_algo: Option<PitchEditAlgorithm>,
}
```

`build_snapshot` 返回时：

```rust
EngineSnapshot {
    clips: Arc::new(clips_out),
    ...
}
```

当 `StretchReady`/`AudioReady` 触发重建且 clips 未变化时，可复用旧 snapshot 的 clips：

```rust
fn handle_stretch_ready(ctx: &mut EngineContext, key: StretchKey) {
    ctx.stretch_stream_epoch.fetch_add(1, Ordering::Relaxed);
    if let Some(tl) = ctx.last_timeline.as_ref() {
        let old_snap = ctx.snapshot.load();
        let snap = build_snapshot_with_clips_hint(
            tl, sr, cache, stretch_cache, pos, playing, epoch,
            Some(old_snap.clips.clone()),  // 传入旧 clips 作为 hint
        );
        ctx.snapshot.store(Arc::new(snap));
    }
}
```

`build_snapshot` 内部：当 `clips_hint` 与新构建的 clips 内容一致时，直接复用 `Arc`，避免重新分配。

---

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `audio_engine/mix.rs` | 修改 | 方案 A：提取 `sample_clip_pcm` |
| `audio_engine/stretch_stream.rs` | **新建** | 方案 B：stretch_stream worker |
| `audio_engine/snapshot.rs` | 修改 | 方案 B：调用 `stretch_stream::spawn_stretch_stream` |
| `audio_engine/engine.rs` | 修改 | 方案 C：提取命令处理函数；方案 D：per-clip epoch |
| `audio_engine/types.rs` | 修改 | 方案 D：`EngineClip.stretch_stream_epoch`；方案 E：`clips: Arc<Vec<EngineClip>>` |
| `audio_engine/mod.rs` | 修改 | 方案 B：`pub(crate) mod stretch_stream;` |

---

## Risks / Trade-offs

- **方案 D 的正确性风险**：per-clip epoch 需要确保 `clip_stretch_epochs` map 与 timeline clips 保持同步（新增/删除 clip 时正确初始化/清理）。需要回归测试 seek、clip 增删、参数拖动等场景。
- **方案 C 的借用检查**：`EngineContext` 持有多个 `&mut` 引用，Rust 借用检查器可能要求拆分结构体或使用 `RefCell`。实现时需注意。
- **方案 E 的 clips_hint 一致性判断**：判断 clips 是否"未变化"需要比较 clip 内容，可能引入额外开销。简单实现可以跳过 hint 优化，仅将类型改为 `Arc<Vec<EngineClip>>`，减少 clone 开销（`Arc::clone` vs `Vec::clone`）。
- **方案 A/B/C/E 为纯重构**：不改变音频输出，风险极低。
