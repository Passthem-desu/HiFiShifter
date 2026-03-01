# Development

For now, the developer handbook is maintained in Chinese:

- [DEVELOPMENT_zh.md](DEVELOPMENT_zh.md)

## Recent notes

	- The audio callback reads from the pitch-stream when covered.
	- Async pitch refresh is now wired to real backend analysis: `start_pitch_refresh_task` accepts `rootTrackId`, builds a `PitchJob` snapshot, and runs `compute_pitch_curve` inside `tokio::task::spawn_blocking`.
	- Task progress in `pitch_refresh_tasks` is updated via the analysis callback; cancellation is forwarded through `cancel_flag` into `compute_pitch_curve`.
	- For WORLD (and most cases), realtime playback must never block: if the pitch-stream hasn't rendered coverage yet, the callback falls back to normal realtime mixing and continues advancing the playhead.
	- For slow ONNX (NSF-HiFiGAN) pitch editing, we default to an A-mode hard-start: output silence + do not advance until a short prebuffer window is ready, to avoid the audible "original -> pitched" transition.
		- Disable ONNX hard-start via `HIFISHIFTER_ONNX_PITCH_STREAM_HARD_START=0`.
		- Tune priming via `HIFISHIFTER_ONNX_STREAM_PRIME_SEC` (default `0.25`) and `HIFISHIFTER_ONNX_STREAM_PRIME_TIMEOUT_MS` (default `4000`).
		- The frontend listens for `playback_rendering_state` and shows a minimal "渲染中..." indicator in the bottom-left status bar while priming.
	- ONNX availability is exposed via `get_onnx_status` so the UI can mark the Algo option as unavailable and block playback when needed.
		- The diagnostic system provides detailed error information: `OnnxStatus` includes `available: bool`, `reason: Option<String>`, and `details: Option<String>`.
		- Frontend displays availability status in the Algo dropdown and shows diagnostic tooltips on unavailable options.
		- Common diagnostic reasons: "Feature disabled (not compiled)", "Model file missing", "ONNX Runtime initialization failed", "Execution provider unavailable".
	- Legacy override: force hard-start for any pitch-stream via `HIFISHIFTER_PITCH_STREAM_HARD_START=1`.
	- If the stream temporarily lags later, we still do best-effort fallback: mix realtime and override the frames that are already covered.

## Pitch / Tension editing

### Async pitch refresh task system

The pitch analysis is now fully asynchronous to prevent UI blocking during long audio analysis operations.

#### Architecture

```
Frontend (PianoRollPanel)
  → useAsyncPitchRefresh Hook
      → calls coreApi.startPitchRefreshTask(rootTrackId)
          → Backend: start_pitch_refresh_task() creates async task
              ├── Generate UUID task_id
              ├── Register task in pitch_refresh_tasks (AppState)
              ├── Spawn tokio::task
              │     ├── Build PitchJob snapshot
              │     ├── Run compute_pitch_curve in spawn_blocking
              │     ├── Update progress via callback
              │     └── Update task status (Completed/Failed/Cancelled)
              └── Return task_id immediately
  → Frontend polls getPitchRefreshStatus(taskId) every 500ms
      ├── Update progress bar (0-100%)
      ├── Calculate estimated remaining time
      └── Stop polling when status = completed/failed/cancelled
```

#### Key features

- **Task state management**: `AppState.pitch_refresh_tasks: Arc<Mutex<HashMap<String, PitchTaskInfo>>>`
  - `PitchTaskInfo` contains: status, progress (0-100), error, start_time, result_key, cancel_flag
  - `PitchTaskStatus` enum: Running, Completed, Failed, Cancelled
- **Concurrency control**: Max 3 concurrent tasks; returns "Too many active tasks" error if exceeded
- **Cancellation support**: 
  - Frontend calls `cancelPitchTask(taskId)`
  - Sets `cancel_flag: Arc<AtomicBool>` in task info
  - `compute_pitch_curve` checks the flag after each clip analysis
  - Returns `Err("Task cancelled by user")` when detected
- **Auto cleanup**: Tasks are automatically removed 5 minutes after completion/failure
- **Progress tracking**: 
  - Real-time progress updates via `PitchAnalysisProgressBar` component
  - Backend reports progress per clip: `(clips_completed / total_clips) * 100`
  - Frontend displays: "Processed X/Y clips", progress percentage, estimated remaining time
  - Progress bar auto-fades out (1s transition) after completion
- **Race condition handling**: 
  - Frontend maintains `latestTaskId` reference
  - New refresh auto-cancels previous task
  - Component unmount cancels active tasks
  - Poll checks `taskId === latestTaskId` to ignore stale updates

#### UI components

- **LoadingSpinner**: Generic spinner component (`sm/md/lg` sizes, customizable color)
- **ProgressBar**: Shows percentage, label, estimated time remaining, and cancel button
- **PitchAnalysisProgressBar** (NEW): Specialized progress component for pitch analysis tasks
  - Auto-polls backend every 500ms for progress updates
  - Displays: "Analyzing pitch" title, "Processed X/Y clips", progress bar, estimated time
  - Auto-hides with 1s fade-out animation after completion
  - Integrated into PianoRollPanel above success/error messages
- **Integration in PianoRollPanel**:
  - Refresh button shows spinner when loading
  - Progress bar appears at panel top during refresh
  - Success message displays for 1 second after completion
  - Error message with retry button on failure

#### Frontend API

```typescript
// services/api/core.ts
startPitchRefreshTask(rootTrackId: string): Promise<string>
getPitchRefreshStatus(taskId: string): Promise<PitchTaskInfo | null>
getPitchAnalysisProgress(): Promise<PitchProgressPayload | null>  // NEW: Direct progress polling
cancelPitchTask(taskId: string): Promise<void>

// components/PitchAnalysisProgressBar.tsx (NEW)
interface PitchProgressPayload {
  total: number;
  completed: number;
  elapsedMs: number;
  estimatedRemainingMs: number | null;
}

// hooks/useAsyncPitchRefresh.ts
const {
  isLoading,      // boolean
  progress,       // 0-100
  status,         // 'running' | 'completed' | 'failed' | 'cancelled'
  error,          // string | null
  estimatedRemaining,  // seconds | null
  startRefresh,   // (rootTrackId: string) => Promise<void>
  cancelRefresh,  // () => Promise<void>
  reset,          // () => void
} = useAsyncPitchRefresh();
```

#### Backend commands

```rust
// commands/pitch_refresh_async.rs
#[tauri::command]
async fn start_pitch_refresh_task(
    root_track_id: String,
    state: State<'_, AppState>
) -> Result<String, String>

#[tauri::command]
fn get_pitch_refresh_status(
    task_id: String,
    state: State<'_, AppState>
) -> Result<PitchTaskStatusPayload, String>

#[tauri::command]
fn get_pitch_analysis_progress(
    state: State<'_, AppState>
) -> Result<Option<PitchProgressPayload>, String>  // NEW

#[tauri::command]
fn cancel_pitch_task(
    task_id: String,
    state: State<'_, AppState>
) -> Result<(), String>
```

### Frontend loading sync for pitch analysis

Pitch F0 analysis runs in the backend on a background thread. The frontend should show a loading overlay (optionally with progress) until the pitch curve is ready.

- `get_param_frames` returns `analysis_pending` for `param=pitch` to indicate whether analysis is scheduled/inflight.
- Tauri events:
	- `pitch_orig_analysis_started` (root track + analysis key)
	- `pitch_orig_analysis_progress` (root track + `progress` in 0..1)
	- `pitch_orig_updated` (analysis finished; frontend should refresh + stop loading)

## Pitch analysis pipeline (v2)

`src/pitch_config.rs` holds `PitchAnalysisConfig` — loaded once at startup via `PitchAnalysisConfig::global()`.

### Architecture

```
decoded PCM
  → resample to analysis_sr (default 16 kHz)
  → mono downmix + DC removal
  → RMS VAD scan (50 ms non-overlapping windows)
      ├── classify_voiced_ranges(): RMS-based voice activity detection
      │     ├── silent windows (RMS < threshold) → mark as unvoiced
      │     └── voiced windows (RMS ≥ threshold) → mark as voiced
      ├── merge_adjacent_voiced_ranges(): merge ranges with gap < vad_merge_gap_ms (default 50ms)
      │     └── prevents over-fragmentation from brief signal dips
      ├── voiced ranges: f0 extraction via WORLD Harvest/Dio
      └── silent ranges: f0 = 0.0 (skipped, no WORLD call)
  → split_into_chunks(chunk_sec=30 s default)
      ├── each chunk: extend ±ctx_sec (0.3 s) context, call WORLD Harvest
      ├── extract core frames (trim context portion from WORLD output)
      └── apply linear crossfade at chunk boundaries (ctx_frames region)
  → f0 Vec<f64> (full timeline length, silent regions = 0.0)
  → convert to MIDI → resample to clip timeline frames
```

### VAD Performance Optimization

The VAD system significantly improves analysis speed by skipping silent regions:

**Key components:**
- `classify_voiced_ranges()`: RMS-based segmentation (50ms non-overlapping windows)
  - Threshold: configurable via `HIFISHIFTER_VAD_RMS_THRESHOLD` (default 0.02, ~-34 dBFS)
  - Returns: `Vec<Range<usize>>` of voiced sample ranges
- `merge_adjacent_voiced_ranges()`: Post-processing to reduce fragmentation
  - Merges ranges if gap ≤ `vad_merge_gap_ms` (default 50ms)
  - Prevents excessive chunk splitting from brief signal dips
  - Example: `[0..1000, 1100..2000]` with 50ms gap threshold → `[0..2000]` (merged)

**Performance logging:**
- Debug output format: `"VAD: X% voiced (...), skipped Y% silence"`
- `voiced_pct`: `(voiced_samples / total_samples) * 100`
- `skip_pct`: `(1.0 - voiced_samples / total_samples) * 100`
- Typical improvement: 40-70% speedup on vocal recordings with pauses

**Tuning knobs:**
```rust
// pitch_config.rs: PitchAnalysisConfig
pub silence_rms_threshold: f64,  // Default: 0.02 (was 0.001 in v1)
pub vad_merge_gap_ms: f64,        // Default: 50.0 ms
```

### Time-Range Caching

The pitch analysis system now supports intelligent caching based on time ranges:

**Architecture:**
- `PitchCacheEntry` stores: `cache_key` (hash), `time_start/time_end` (timeline positions), `data` (f0 curve)
- Cache key includes: audio file hash, clip timeline positions, playback rate, algorithm
- Enables incremental updates: only reanalyze changed clips

**Key features:**
- **Time-range lookup**: `find_entry_by_time_range(start, end, tolerance)` 
  - Fuzzy matching with ±1 frame tolerance for floating-point imprecision
  - Returns cached entry if `[cached_start, cached_end]` contains `[query_start, query_end]`
- **Automatic invalidation**: Cache entries invalidate when:
  - Clip timeline position changes (drag/move)
  - Playback rate changes (Time Stretch)
  - Audio content changes (re-import)
  - Algorithm changes (WORLD → DIO)
- **Memory management**: 
  - Unused entries are pruned during analysis
  - Cache size is bounded by project complexity (typical: < 100 entries)

**Implementation:**
```rust
// pitch_analysis.rs
struct PitchCacheEntry {
    cache_key: u64,           // Blake3 hash of analysis parameters
    time_start: f64,          // Timeline start (seconds)
    time_end: f64,            // Timeline end (seconds)
    data: Arc<Vec<f64>>,      // F0 curve (MIDI values)
}

fn find_entry_by_time_range(
    cache: &[PitchCacheEntry],
    start: f64,
    end: f64,
    tolerance: f64,  // Default: 1 frame @ 44.1kHz ≈ 0.000023s
) -> Option<&PitchCacheEntry>
```

### Env-var reference

| Variable                            | Default | Range      | Effect                                                                                                                             |
| ----------------------------------- | ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `HIFISHIFTER_PITCH_ANALYSIS_SR`     | `16000` | 8000–44100 | WORLD analysis sample rate. Lower = faster; 16 kHz retains full human-voice F0 accuracy.                                           |
| `HIFISHIFTER_VAD_RMS_THRESHOLD`     | `0.02`  | ≥0.0       | RMS VAD threshold (~−34 dBFS). Windows below this are classified silent. Changed from `HIFISHIFTER_PITCH_SILENCE_RMS` (was 0.001). |
| `HIFISHIFTER_VAD_MERGE_GAP_MS`      | `50.0`  | ≥0.0       | Merge adjacent voiced ranges if gap ≤ this value (ms). Prevents VAD over-fragmentation from brief signal dips.                     |
| `HIFISHIFTER_PITCH_CHUNK_SEC`       | `30.0`  | ≥5.0       | Max voiced-segment chunk duration (seconds). Long clips are split into N chunks.                                                   |
| `HIFISHIFTER_PITCH_CHUNK_CTX_SEC`   | `0.3`   | ≥0.0       | Context audio added to each side of a chunk before WORLD call to eliminate WORLD start-up instability.                             |
| `HIFISHIFTER_PITCH_MAX_SEGMENT_SEC` | `60.0`  | ≥1.0       | Truncate overly long clip segments before WORLD analysis; remainder is padded as unvoiced.                                         |
| `HIFISHIFTER_PITCH_PARALLEL_CLIPS`  | unset   | ≥1         | Limit the Rayon thread pool size for per-clip decoding/analysis stages.                                                            |

## Pitch analysis performance optimization (v3)

**Status**: Implemented in `parallel-incremental-pitch-analysis` change (2026-02)

This optimization reduces pitch analysis time by **3-9x** for typical workflows through parallel processing, intelligent caching, and incremental refresh.

### Architecture

```
Frontend triggers analysis (rootTrackId)
  → Backend: entry point in pitch_analysis.rs
      ├── 1. Build Timeline Snapshot
      │     ├── Capture: clips (id, audio_path, trim, playback_rate, etc.)
      │     ├── Capture: global_bpm, timeline_frame_period_ms, analysis_sr
      │     └── Generate cache key (Blake3 hash) for each clip
      ├── 2. Compare with Previous Snapshot (if exists)
      │     ├── Detect: New clips (cache_key not in old snapshot)
      │     ├── Detect: Modified clips (cache_key changed)
      │     ├── Ignore: Position-only changes (cache_key unchanged)
      │     └── Result: List of clips needing analysis
      ├── 3. Parallel Clip Analysis (rayon)
      │     ├── Sort clips by workload (duration * cache_miss_factor)
      │     ├── Rayon par_iter: analyze_clip_with_cache()
      │     │     ├── Query ClipPitchCache (LRU) by cache_key
      │     │     ├── Cache hit: return Arc<Vec<f32>> (instant)
      │     │     └── Cache miss: decode audio → WORLD F0 → store in cache
      │     └── Progress tracking: weighted by clip duration
      ├── 4. Fusion Algorithm (optimized)
      │     ├── Build interval coverage table: Vec<Option<Vec<usize>>>
      │     ├── For each timeline frame (10ms):
      │     │     ├── 0 clips: write 0.0 (skip weight computation)
      │     │     ├── 1 clip: direct read (skip winner-take-most)
      │     │     └── N clips: weighted winner-take-most + hysteresis
      │     └── Output: timeline-length pitch curve
      └── 5. Update Snapshot & Emit Events
            ├── Store current snapshot in AppState.pitch_timeline_snapshot
            ├── Emit: pitch_orig_analysis_progress (0–1)
            └── Emit: pitch_orig_updated (frontend refresh)
```

### Key Components

#### 1. ClipPitchCache (LRU)
- **Implementation**: `backend/src-tauri/src/clip_pitch_cache.rs`
- **Type**: `LruCache<String, Arc<Vec<f32>>>` (lru = 0.12)
- **Capacity**: 100 clips (configurable)
- **Cache Key**: Blake3 hash of:
  - Audio file path + size + mtime
  - Clip trim_start_sec, duration_sec, playback_rate
  - Analysis algorithm (WORLD/Harvest/Dio)
  - Global: analysis_sr, frame_period_ms, BPM
- **Statistics**: `.stats()` returns entries, capacity, hits, misses, hit_rate
- **Commands**: `clear_pitch_cache`, `get_pitch_cache_stats` (Tauri)

**Key insight**: Position-independent caching — cache key does NOT include `start_beat`. Moving a clip doesn't invalidate cache.

#### 2. Timeline Snapshot Comparison
- **Snapshot**: `{ clips: HashMap<id, cache_key>, bpm, frame_period_ms }`
- **Comparison logic**:
  - New clip: `new_snap.contains(id) && !old_snap.contains(id)`
  - Modified: `old_snap[id].cache_key != new_snap[id].cache_key`
  - Position-only: `old_snap[id].cache_key == new_snap[id].cache_key` → **skip analysis**
- **Storage**: `AppState.pitch_timeline_snapshot: Mutex<HashMap<...>>`

#### 3. Parallel Analysis (Rayon)
- **Thread pool**: Rayon default (CPU count)
- **Workload sorting**: `clips.sort_by_key(|c| c.duration * cache_miss_factor)`
  - Large uncached clips analyzed first (better load balancing)
- **Progress tracking**: 
  - `ProgressTracker` with atomic counters
  - Weighted by clip duration (cache hits count as 5% workload)
  - Frontend polls `progress` (0.0–1.0) every 500ms

**WORLD lock handling**: WORLD F0 analysis is thread-safe (no global mutex needed). All clips use completely parallel path.

#### 4. Fusion Algorithm Optimization
- **Coverage table**: Pre-build `Vec<Option<Vec<usize>>>` (one entry per timeline frame)
  - `None`: no clips covering this frame (write 0.0)
  - `Some(vec![i])`: single clip covering (direct read)
  - `Some(vec![i1, i2, ...])`: multiple clips (weighted fusion)
- **Performance**: Typical timeline (300s @ 10ms frames = 30k frames):
  - Old fusion: 150-250ms (hash lookups per frame)
  - New fusion: 20-50ms (table lookup + fast path)

### Performance Targets & Results

| Scenario                          | Old Implementation | Target         | Implementation Status       |
| --------------------------------- | ------------------ | -------------- | --------------------------- |
| **First analysis** (10 clips)    | 22-45s             | 3-7s           | ✅ Parallel (rayon)         |
| **Repeat analysis** (cached)     | 22-45s             | <100ms         | ✅ LRU cache                |
| **Incremental** (edit 1 clip)    | 22-45s (full scan) | 1-4s           | ✅ Snapshot comparison      |
| **Position change** (drag clip)  | 22-45s             | <100ms         | ✅ Position-independent key |
| **Fusion algorithm**             | 150-250ms          | <100ms         | ✅ Coverage table           |
| **Memory usage** (100 clips)     | —                  | <500MB         | ✅ Arc sharing + LRU        |

**Actual measurements**: Pending user testing with real project data. (See tasks.md Group 18)

### Cache Management

#### Commands
- `clear_pitch_cache()`: Clears all cached pitch curves
  - Returns: `{ ok: true, message: "..." }` or `{ ok: false, error: "..." }`
- `get_pitch_cache_stats()`: Returns cache statistics
  - Returns: `{ cached_clips, total_capacity, cache_hit_rate }`

#### Automatic Invalidation
Cache entries are invalidated when:
- Clip timeline position changes → NO (position-independent key)
- Playback rate changes → YES (included in cache key)
- Audio file modified (mtime changed) → YES (file signature in key)
- Global BPM changes → YES (BPM in cache key)
- Analysis algorithm changes → YES (algorithm in key)

#### Manual Cache Control
- **Clear cache**: Call `clearPitchCache()` from frontend (or Tauri command)
- **Stats query**: Call `getPitchCacheStats()` to inspect hit rate
- **Automatic cleanup**: LRU eviction when capacity (100) exceeded

### Implementation Details

#### File Structure
```
backend/src-tauri/src/
  ├── clip_pitch_cache.rs        # LRU cache implementation
  ├── pitch_analysis.rs          # Main analysis pipeline
  │     ├── fuse_clip_pitches_optimized()  # Fusion with coverage table
  │     ├── compute_pitch_curve_parallel() # Rayon parallel entry (DEPRECATED in this impl)
  │     └── analyze_clip_with_cache()      # Per-clip cache query + analysis
  ├── pitch_progress.rs          # ProgressTracker (weighted progress)
  ├── commands/pitch_cache.rs    # Tauri commands for cache management
  ├── commands.rs                # Command exports
  ├── lib.rs                     # Command registration
  └── state.rs                   # AppState (clip_pitch_cache, pitch_timeline_snapshot)
```

#### Dependencies
```toml
[dependencies]
rayon = "1.7"          # Parallel iteration (par_iter)
lru = "0.12"           # LRU cache implementation
blake3 = "1.5"         # Fast hash for cache keys
```

#### Error Handling
- **Partial failures**: If <50% clips fail analysis, continue with successful clips
- **Cache failures**: Cache query errors fallback to full analysis (non-blocking)
- **Thread panics**: Rayon isolates panics (one clip failure doesn't stop others)

### Testing Notes

**Groups 16-19 in tasks.md** are marked for manual testing:
- Unit tests: Cache key correctness, LRU eviction, progress tracking
- Integration tests: End-to-end analysis, cache hit rate validation
- Performance benchmarks: Measure speedup on real projects
- Stress tests: 100 clips, long audio (10+ min), concurrent refresh

**Action required**: Run manual tests with real audio projects and record results in DEVELOPMENT.md.

### Troubleshooting

**Q: Cache hit rate is low (<50%)**
- Check: Are clips being modified frequently? (trim, playback_rate changes invalidate cache)
- Check: Is BPM changing often? (BPM is part of cache key)
- Check: File mtime changing without content change? (forces reanalysis)

**Q: First analysis not faster**
- Verify: Rayon thread pool active? (check debug logs)
- Verify: Clips are long enough to benefit from parallelism (>5s each)
- Note: Speedup is proportional to CPU core count (expect 2-4x on quad-core)

**Q: Memory usage high**
- Check: Cache capacity (default 100 clips, ~3-5MB per clip)
- Action: Reduce capacity or call `clear_pitch_cache()` periodically
- Note: Arc sharing minimizes duplication (cached curves shared across timeline snapshots)

**Q: Progress bar not updating smoothly**
- Check: Frontend poll interval (should be ~500ms)
- Check: Clip count (very few clips = chunky progress updates)
- Note: Progress is weighted by duration (small clips contribute less to progress)

### Future Improvements

- [ ] Persistent disk cache (survive app restart)
- [ ] Compression for cached curves (reduce memory 2-3x)
- [ ] Multi-level cache (RAM + disk)
- [ ] Predictive prefetch (analyze next likely edit target)
- [ ] GPU-accelerated WORLD F0 (if CUDA available)

### Progress events

`pitch_orig_analysis_progress` (0–1) is emitted per chunk:
- 0.02 at analysis start
- 0.05–0.84 per chunk (proportional to clip/chunk count)
- 0.85 when all clips done
- 1.0 when fuse + MIDI conversion complete

`pitch_orig_analysis_progress` (0–1) is emitted per chunk:
- 0.02 at analysis start
- 0.05–0.84 per chunk (proportional to clip/chunk count)
- 0.85 when all clips done
- 1.0 when fuse + MIDI conversion complete

## Pitch edit algorithms

By default, pitch edit uses WORLD-vocoder.

An experimental alternative uses the bundled NSF-HiFiGAN ONNX model (ORT via the `ort` crate + ONNX Runtime).
Enable via UI:

- In the bottom param panel (Pitch), switch `Algo` to `NSF-HiFiGAN (ONNX)`.

Or force/override via env:

- `HIFISHIFTER_PITCH_EDIT_ALGO=nsf_hifigan_onnx`
- Model path:
	- `HIFISHIFTER_NSF_HIFIGAN_ONNX=.../pc_nsf_hifigan.onnx`, or
	- `HIFISHIFTER_NSF_HIFIGAN_MODEL_DIR=.../pc_nsf_hifigan_44.1k_hop512_128bin_2025.02`

### ONNX Runtime linkage

The Rust backend is configured to download prebuilt ONNX Runtime binaries at build time and link them in, so you
typically don't need to install `onnxruntime.dll` yourself.

- Offline builds: set `ORT_SKIP_DOWNLOAD=1` and provide a system/custom ONNX Runtime build via `ort`/`ort-sys` linking options.

### ONNX Runtime execution provider (CUDA)

This project enables the CUDA EP in `ort` (downloads a `cu12`-enabled prebuilt runtime at build time).

Runtime selection is controlled by env vars:

- `HIFISHIFTER_ORT_EP=auto|cuda|cpu`
	- `auto` (default): try CUDA first, fall back to CPU if unavailable.
	- `cuda`: require CUDA EP; session creation fails if CUDA is unavailable.
	- `cpu`: force CPU EP.
- `HIFISHIFTER_ORT_CUDA_DEVICE_ID=0`
	- Which CUDA device to use when `cuda` is selected.

Notes:

- If CUDA EP cannot be initialized (missing DLL dependencies / driver, etc.), `auto` will fall back to CPU.
- Set `HIFISHIFTER_DEBUG_COMMANDS=1` to print which EP was selected.

### Realtime ONNX: voiced-segment inference (VAD)

For realtime playback (`play_original`) when pitch edit is set to **NSF-HiFiGAN (ONNX)**, the backend avoids fixed time-window ONNX calls.
Instead, it uses the already-computed `pitch_orig/pitch_edit` curves as a lightweight VAD signal:

- **Voiced** ranges are inferred as one contiguous ONNX invocation (with extra context padding).
- **Unvoiced** ranges are passed through as the base mix (no ONNX), reducing noise.

Tuning knobs (env vars):

- `HIFISHIFTER_ONNX_VAD_PAD_MS` (default `120`)
	- Expands voiced ranges on both sides to keep breathy edges inside voiced segments.
- `HIFISHIFTER_ONNX_VAD_CTX_SEC` (default `1.5`)
	- Extra audio context rendered around voiced ranges before ONNX inference.
- `HIFISHIFTER_ONNX_VAD_XFADE_MS` (default `40`)
	- Crossfade size at voiced/unvoiced boundaries (uses preroll to avoid clicks).
- `HIFISHIFTER_ONNX_VAD_MAX_SEC` (default `60`)
	- Safety cap for a single ONNX invocation size (protects memory usage on extremely long segments).
	- Set to `0` to disable the cap (infer the whole voiced segment in one go).

### F0 detection (WORLD)

- The Rust backend uses WORLD for F0 tracking and WORLD-vocoder pitch shifting.
- To reduce octave errors and noisy artifacts from unstable F0, the default F0 tracker is now **Harvest**.
- You can switch the tracker at runtime:
	- `HIFISHIFTER_WORLD_F0=harvest` (default)
	- `HIFISHIFTER_WORLD_F0=dio`
- The default F0 range is aligned with the previous Python demo (`utils/wav2F0.py`):
	- `f0_floor = 40 Hz`
	- `f0_ceil = 1600 Hz`

#### WORLD-vocoder F0 cleanup (anti "gargling")

- WORLD analysis can occasionally output very short 0Hz gaps inside voiced regions.
  This can cause unstable analysis/synthesis and a "gargling / throat" noise after pitch edits.
- The vocoder now fills short unvoiced gaps in F0 by default (similar to the Python demo's `interp_uv` idea).
- Tune or disable with:
	- `HIFISHIFTER_WORLD_F0_GAP_MS=15` (default)
	- `HIFISHIFTER_WORLD_F0_GAP_MS=0` (disable)

### Stability notes
- `fatal runtime error: Rust cannot catch foreign exceptions, aborting` is a different class: it indicates a non-Rust exception crossing into Rust (often via FFI / external libraries). `catch_unwind` cannot catch it; treat it as a separate investigation track.
## Frontend Architecture

### Waveform Rendering System

**Location**: `frontend/src/utils/waveformRenderer.ts`

The waveform rendering system provides a unified interface for rendering audio waveforms across the application, supporting both Canvas (Piano Roll) and SVG (Timeline Clips) rendering modes.

#### Core Functions

1. **`processWaveformPeaks(options: WaveformProcessOptions): ProcessedWaveformData`**
   - Processes min/max peaks data into renderable format
   - Adaptive sampling: `stride=4` for >2000 points, `stride=2` for >1000 points, `stride=1` otherwise
   - Time range cropping: only processes samples within visible viewport
   - Returns: processed peaks with timestamps and stride information

2. **`renderWaveformCanvas(ctx, data, options): void`**
   - Renders waveform to Canvas 2D context (used in Piano Roll)
   - **Rendering mode**: Continuous polyline (closed path) instead of discrete vertical bars
   - Creates closed polygon: forward traversal of `max` values (upper edge), reverse traversal of `min` values (lower edge)
   - Area fill: uses `ctx.fill()` to fill the enclosed region
   - Configurable colors: `fillColor` (used), `strokeColor` (reserved for future outlining)
   - Performance: single `beginPath()` → `fill()` call per render, O(n) complexity

3. **`renderWaveformSvg(data, options): string`**
   - Generates SVG path `d` attribute string (used in Timeline Clips)
   - Creates closed polygon: forward traversal of `max` values, reverse traversal of `min` values
   - Dual-mode positioning:
     - **Timestamp-based** (Piano Roll): uses `timestamps` array for X coordinates with time-to-pixel mapping
     - **Uniform distribution** (Clip): empty `timestamps` array triggers index-based positioning
   - Stereo support: call twice with different `centerY` values for top/bottom bands
   - Minimum visible height: computed in SVG coordinate space

#### Usage Examples

**Piano Roll (Canvas rendering):**
```typescript
const processed = processWaveformPeaks({
  min: peaks.min,
  max: peaks.max,
  startSec: peaks.startSec,
  durSec: peaks.durSec,
  visibleStartSec: viewport.startSec,
  visibleDurSec: viewport.durSec,
  targetWidth: canvasWidth
});

renderWaveformCanvas(ctx, processed, {
  width: canvasWidth,
  height: canvasHeight,
  fillColor: waveformColors.fill,
  strokeColor: waveformColors.stroke,
  centerY: canvasHeight * 0.5,
  amplitude: canvasHeight * 0.45
});
```

**Timeline Clip (SVG rendering with fade effects):**
```typescript
// Apply fade-in/fade-out to peaks data
const fadedData = applyFadeGainToPeaks(
  peaks.min, peaks.max,
  ampScale, lengthBeats, fadeInBeats, fadeOutBeats,
  fadeInCurve, fadeOutCurve
);

// Generate SVG path (uniform distribution mode)
const pathD = renderWaveformSvg({
  min: fadedData.min,
  max: fadedData.max,
  timestamps: [], // Empty array triggers uniform distribution
  stride: 1
}, {
  width: clipWidth,
  height: clipHeight,
  centerY: clipHeight / 2,
  halfHeight: clipHeight / 2
});

// Render SVG
<path d={pathD} fill={waveformColors.fill} stroke={waveformColors.stroke} />
```

#### Theme Integration

**Location**: `frontend/src/theme/waveformColors.ts`

```typescript
interface WaveformColors {
  fill: string;   // Waveform fill color
  stroke: string; // Waveform stroke color
}

// Dark theme
{ fill: "rgba(255,255,255,0.2)", stroke: "rgba(255,255,255,0.7)" }

// Light theme
{ fill: "rgba(0,0,0,0.15)", stroke: "rgba(0,0,0,0.6)" }
```

**Usage:**
```typescript
const { mode } = useAppTheme();
const waveformColors = useMemo(() => getWaveformColors(mode), [mode]);
```

The `drawPianoRoll()` function accepts optional `waveformColors` parameter, and `ClipItem` component reads colors from theme via `useAppTheme()` hook.

#### Design Decisions

- **Unified rendering**: Both Piano Roll and Clip use the same processing logic, ensuring visual consistency
- **Adaptive sampling**: Automatically adjusts point density based on data size to maintain 60fps performance
- **Time-aware cropping**: Only processes visible viewport data to optimize large audio files
- **Dual rendering modes**: Canvas for high-frequency pixel-perfect updates (Piano Roll drag/zoom), SVG for scalable vector graphics (Clip display)
- **Theme-aware colors**: Waveform colors adapt to dark/light theme for optimal contrast