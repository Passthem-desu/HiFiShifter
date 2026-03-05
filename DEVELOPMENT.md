# HiFiShifter Development Documentation

> Version: 2026-03 · Copyright © ARounder · License: GPL v2

---

## Table of Contents

* [1. Project Overview](https://www.google.com/search?q=%231-project-overview)
* [2. Tech Stack](https://www.google.com/search?q=%232-tech-stack)
* [3. Directory Structure](https://www.google.com/search?q=%233-directory-structure)
* [4. Backend Architecture](https://www.google.com/search?q=%234-backend-architecture)
* [5. Frontend Architecture](https://www.google.com/search?q=%235-frontend-architecture)
* [6. IPC API Documentation](https://www.google.com/search?q=%236-ipc-api-documentation)
* [7. Build System](https://www.google.com/search?q=%237-build-system)
* [8. Environment Variables Reference](https://www.google.com/search?q=%238-environment-variables-reference)
* [9. Pitch Analysis Pipeline](https://www.google.com/search?q=%239-pitch-analysis-pipeline)
* [10. Renderer System](https://www.google.com/search?q=%2310-renderer-system)
* [11. Audio Engine](https://www.google.com/search?q=%2311-audio-engine)
* [12. Project File Format](https://www.google.com/search?q=%2312-project-file-format)

---

## 1. Project Overview

HiFiShifter is a desktop audio pitch editor based on **Tauri 2**, designed for vocal synthesis and tuning scenarios. Core capabilities include:

* Multi-track timeline editing (CRUD, drag-and-drop, splitting, gluing of tracks/clips).
* Real-time pitch (F0) analysis and visualization (based on WORLD Harvest/Dio).
* Manual pitch curve editing (draw / select modes).
* Dual-renderer pitch synthesis (WORLD Vocoder / NSF-HiFiGAN ONNX).
* Real-time playback and mixing (cpal audio engine, supports Time Stretch).
* Waveform visualization (Canvas + SVG dual-mode).
* File browser panel (sidebar drag-and-drop import).
* Internationalization (Chinese / English).
* Project file saving/loading (MessagePack + JSON compatible).

---

## 2. Tech Stack

### Backend (Rust)

| Component | Technology | Version |
| --- | --- | --- |
| App Framework | Tauri 2 | 2.x |
| Audio I/O | cpal | 0.15 |
| Audio Decoding | symphonia | 0.5 |
| WAV Encoding | hound | 3.x |
| Pitch Analysis | WORLD (Statically Linked) | — |
| Time Stretching | Rubber Band Library (Statically Linked) | v4.0.0 |
| ONNX Inference | ort (optional feature) | 2.0.0-rc.11 |
| Serialization | serde + serde_json + rmp-serde | — |
| Parallel Computing | rayon | 1.7 |
| Caching | lru | 0.12 |
| Hashing | blake3 | 1.x |
| UUID | uuid v4 | 1.x |

### Frontend (TypeScript / React)

| Component | Technology | Version |
| --- | --- | --- |
| UI Framework | React | 19.x |
| State Management | Redux Toolkit | 2.x |
| UI Component Library | Radix UI Themes | 3.x |
| CSS Solution | Tailwind CSS | 3.4 |
| Build Tool | Vite | 7.x |
| Type System | TypeScript | 5.9 |
| IPC Communication | @tauri-apps/api | 2.x |

### Third-party C/C++ Libraries (Statically Linked)

| Library | Usage | License | Location |
| --- | --- | --- | --- |
| [WORLD](https://github.com/mmorise/World) | F0 Analysis + Vocoder Synthesis | Modified BSD | `third_party/world-static/World/` |
| [Rubber Band](https://github.com/breakfastquay/rubberband) | High-quality Time Stretch/Pitch Shift | GPL v2 | `third_party/rubberband-static/rubberband/` |

---

## 3. Directory Structure

```
HiFiShifter/
├── backend/                          # Tauri Backend
│   └── src-tauri/
│       ├── Cargo.toml                # Rust dependencies and feature config
│       ├── build.rs                  # Build script (Static compilation of WORLD/Rubber Band)
│       ├── tauri.conf.json           # Tauri configuration
│       ├── src/
│       │   ├── main.rs              # Entry point
│       │   ├── lib.rs               # Tauri Builder registration (commands, plugins, setup)
│       │   ├── state.rs             # Global AppState (Track/Clip/Timeline)
│       │   ├── models.rs            # Shared data transfer structures
│       │   ├── commands.rs          # Tauri command facade
│       │   ├── commands/            # Command implementations by domain
│       │   │   ├── core.rs          #   Core (ping/runtime/transport/undo)
│       │   │   ├── project.rs       #   Project operations (new/open/save)
│       │   │   ├── timeline.rs      #   Timeline (CRUD for tracks/clips)
│       │   │   ├── playback.rs      #   Playback control
│       │   │   ├── params.rs        #   Parameter curve read/write
│       │   │   ├── waveform.rs      #   Waveform peak querying
│       │   │   ├── synth.rs         #   Synthesis (model loading/processing/synthesis)
│       │   │   ├── dialogs.rs       #   System dialogs
│       │   │   ├── file_browser.rs  #   File browser
│       │   │   ├── pitch_cache.rs   #   Pitch cache management
│       │   │   ├── pitch_progress.rs#   Analysis progress querying
│       │   │   ├── onnx_status.rs   #   ONNX status querying
│       │   │   └── debug.rs         #   Debug commands
│       │   ├── audio_engine/        # Real-time audio engine
│       │   │   ├── mod.rs           #   Module entry
│       │   │   ├── engine.rs        #   AudioEngine core (cpal callback)
│       │   │   ├── snapshot.rs      #   Playback snapshot (track/clip mapping)
│       │   │   ├── mix.rs           #   Multi-track mixing
│       │   │   ├── io.rs            #   Audio I/O (decoder)
│       │   │   ├── ring.rs          #   Ring buffer
│       │   │   ├── stretch_stream.rs#   Pitch Stream
│       │   │   ├── resource_manager.rs # Resource management
│       │   │   ├── types.rs         #   Type definitions
│       │   │   └── util.rs          #   Utility functions
│       │   ├── renderer/            # Renderer plugin system
│       │   │   ├── mod.rs           #   Registry + Factory
│       │   │   ├── traits.rs        #   Renderer trait definition
│       │   │   ├── world.rs         #   WORLD Vocoder renderer
│       │   │   ├── hifigan.rs       #   NSF-HiFiGAN ONNX renderer
│       │   │   └── utils.rs         #   MIDI curve alignment tools
│       │   ├── pitch_analysis.rs    # Pitch analysis pipeline
│       │   ├── pitch_config.rs      # Analysis config (VAD/Chunking/Crossfade)
│       │   ├── pitch_clip.rs        # Clip-level pitch processing
│       │   ├── pitch_editing.rs     # Pitch editing core logic
│       │   ├── pitch_progress.rs    # Progress tracker
│       │   ├── clip_pitch_cache.rs  # LRU pitch cache
│       │   ├── clip_rendering_state.rs # Clip rendering state
│       │   ├── synth_clip_cache.rs  # Synthesis cache
│       │   ├── project.rs           # Project file serialization
│       │   ├── audio_utils.rs       # Audio utility functions
│       │   ├── waveform.rs          # Waveform processing
│       │   ├── waveform_disk_cache.rs # Waveform disk cache
│       │   ├── mixdown.rs           # Mixdown export
│       │   ├── nsf_hifigan_onnx.rs  # ONNX inference implementation
│       │   ├── nsf_hifigan_onnx_stub.rs # Stub module when ONNX is disabled
│       │   ├── world.rs             # WORLD FFI bindings
│       │   ├── world_lock.rs        # WORLD thread safety
│       │   ├── world_vocoder.rs     # WORLD vocoder wrapper
│       │   ├── streaming_world.rs   # Streaming WORLD processing
│       │   ├── rubberband.rs        # Rubber Band FFI bindings
│       │   └── time_stretch.rs      # Time stretch interface
│       ├── third_party/
│       │   ├── world-static/World/  # WORLD source (static compilation)
│       │   └── rubberband-static/rubberband/ # Rubber Band source (static compilation)
│       └── tests/                   # Integration tests
│
├── frontend/                         # React Frontend
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── index.html
│   └── src/
│       ├── main.tsx                 # React entry
│       ├── App.tsx                  # Root component (layout, shortcuts, playback polling)
│       ├── App.css                  # Global styles
│       ├── index.css                # Tailwind entry
│       ├── app/
│       │   ├── store.ts             # Redux Store config
│       │   └── hooks.ts             # useAppDispatch / useAppSelector
│       ├── components/
│       │   ├── LoadingSpinner.tsx    # Generic loading indicator
│       │   ├── ProgressBar.tsx      # Progress bar component
│       │   ├── PitchAnalysisProgressBar.tsx # Pitch analysis progress bar
│       │   └── layout/
│       │       ├── MenuBar.tsx      # Top menu bar
│       │       ├── ActionBar.tsx    # Action toolbar
│       │       ├── TimelinePanel.tsx # Timeline panel (main edit area)
│       │       ├── PianoRollPanel.tsx # Piano roll panel (pitch editing)
│       │       ├── FileBrowserPanel.tsx # File browser panel
│       │       ├── PitchStatusBadge.tsx # Pitch status badge
│       │       ├── timeline/        # Timeline sub-components
│       │       │   ├── TimeRuler.tsx        # Time ruler
│       │       │   ├── TrackList.tsx         # Track list
│       │       │   ├── TrackLane.tsx         # Track lane
│       │       │   ├── BackgroundGrid.tsx    # Background grid
│       │       │   ├── TimelineScrollArea.tsx # Scroll container
│       │       │   ├── ClipItem.tsx          # Clip rendering
│       │       │   ├── ClipContextMenu.tsx   # Clip context menu
│       │       │   ├── GlueContextMenu.tsx   # Glue menu
│       │       │   ├── clip/                 # Clip sub-components
│       │       │   │   ├── ClipEdgeHandles.tsx # Trim handles
│       │       │   │   ├── ClipHeader.tsx      # Clip header
│       │       │   │   └── useClipWaveformPeaks.ts # Waveform peak hook
│       │       │   ├── hooks/                # Timeline interaction hooks
│       │       │   │   ├── useClipDrag.ts    # Clip dragging
│       │       │   │   ├── useEditDrag.ts    # Edit dragging
│       │       │   │   ├── useSlipDrag.ts    # Slip editing
│       │       │   │   └── useKeyboardShortcuts.ts # Shortcuts
│       │       │   └── (constants/math/grid/paths/dnd/clipWaveform).ts
│       │       └── pianoRoll/       # Piano roll sub-module
│       │           ├── render.ts             # Canvas rendering
│       │           ├── usePianoRollData.ts   # Data hook
│       │           ├── usePianoRollInteractions.ts # Interaction hook
│       │           ├── useLiveParamEditing.ts # Live parameter editing
│       │           ├── useClipsPeaksForPianoRoll.ts # Waveform data
│       │           ├── types.ts / constants.ts / utils.ts
│       │           └── peaksCache.ts
│       ├── features/
│       │   ├── session/             # Core session state (Redux Slice)
│       │   │   ├── sessionSlice.ts  # Redux Slice (tracks/clips/UI state)
│       │   │   ├── sessionTypes.ts  # TypeScript type definitions
│       │   │   ├── trackUtils.ts    # Track utilities
│       │   │   └── thunks/          # Async Thunks
│       │   │       ├── transportThunks.ts  # Playback/Transport
│       │   │       ├── timelineThunks.ts   # Timeline operations
│       │   │       ├── projectThunks.ts    # Project operations
│       │   │       ├── importThunks.ts     # Audio import
│       │   │       ├── audioThunks.ts      # Audio processing
│       │   │       ├── modelThunks.ts      # Model loading
│       │   │       ├── trackThunks.ts      # Track operations
│       │   │       └── runtimeThunks.ts    # Runtime status
│       │   └── fileBrowser/
│       │       ├── fileBrowserSlice.ts # File browser state
│       │       └── audioPreview.ts     # Audio preview
│       ├── services/
│       │   ├── invoke.ts            # IPC wrapper layer
│       │   ├── webviewApi.ts        # WebView API wrapper
│       │   └── api/                 # API modules by domain
│       │       ├── index.ts         # Exports summary
│       │       ├── core.ts          # Core API
│       │       ├── project.ts       # Project API
│       │       ├── timeline.ts      # Timeline API
│       │       ├── params.ts        # Params API
│       │       ├── waveform.ts      # Waveform API
│       │       └── fileBrowser.ts   # File browser API
│       ├── contexts/
│       │   ├── PitchAnalysisContext.tsx  # Pitch analysis context
│       │   └── PianoRollStatusContext.tsx # Piano roll status context
│       ├── hooks/
│       │   ├── useAsyncPitchRefresh.ts  # Async pitch refresh hook
│       │   └── useClipPitchDataListener.ts # Pitch data listener
│       ├── i18n/
│       │   ├── I18nProvider.tsx     # i18n Provider
│       │   └── messages.ts          # Translation texts
│       ├── theme/
│       │   ├── AppThemeProvider.tsx  # Theme Provider (Dark/Light)
│       │   └── waveformColors.ts    # Waveform color config
│       ├── types/
│       │   └── api.ts               # Backend interface types
│       └── utils/
│           └── waveformRenderer.ts  # Unified waveform rendering tool
│
├── assets/                           # Static assets
│   ├── icon.png                     # App icon
│   └── lang/                        # Language files
├── docs/                             # Supplementary docs
├── pc_nsf_hifigan_44.1k_hop512_128bin_2025.02/  # ONNX model files
├── README.md                         # User README
├── DEVELOPMENT.md                    # English dev doc
├── DEVELOPMENT_zh.md                 # Chinese dev doc
├── USER_MANUAL_zh.md                 # Chinese user manual
├── LICENSE                           # GPL v2 License
└── rust-toolchain.toml               # Rust toolchain config

```

---

## 4. Backend Architecture

### 4.1 Overall Architecture

The backend uses the **Tauri 2** framework. All business logic is implemented in Rust, and the frontend calls backend commands via `invoke` IPC.

```
┌─────────────────────────────────────────────────────┐
│                   Frontend (React)                  │
│    invoke("command_name", { args })                  │
└──────────────────────┬──────────────────────────────┘
                       │ IPC (Tauri invoke)
┌──────────────────────▼──────────────────────────────┐
│              commands.rs (Command Facade)           │
│  #[tauri::command] → forward to commands/*.rs       │
├─────────────────────────────────────────────────────┤
│              state.rs (Global AppState)             │
│  Mutex<TimelineState> / AudioEngine / Various Caches│
├─────────────────────────────────────────────────────┤
│                  Business Logic Layer               │
│  pitch_analysis / pitch_editing / renderer / mixdown│
├─────────────────────────────────────────────────────┤
│                  FFI / Third-party Layer            │
│  world.rs (WORLD) / rubberband.rs / nsf_hifigan_onnx│
└─────────────────────────────────────────────────────┘

```

### 4.2 Command System

All frontend-callable commands are registered in `commands.rs` using the `#[tauri::command]` macro, with specific implementations split into the `commands/` subdirectory by domain.

**Conventions**:

* `#[tauri::command]` only appears in `commands.rs` (facade layer).
* Sub-module functions use `pub(super)` / `pub(crate)` visibility.
* Naming convention: `#[tauri::command(rename_all = "camelCase")]`.

**Command Groups**:

| Module | File | Responsibility |
| --- | --- | --- |
| core | `commands/core.rs` | ping, runtime info, transport control, undo/redo |
| project | `commands/project.rs` | Create/Open/Save project |
| timeline | `commands/timeline.rs` | CRUD for tracks/clips, audio import |
| playback | `commands/playback.rs` | Play/Stop/Status querying |
| params | `commands/params.rs` | Param curves (pitch/tension) read/write |
| waveform | `commands/waveform.rs` | Waveform peak segment querying |
| synth | `commands/synth.rs` | Model loading, audio processing, synthesis |
| dialogs | `commands/dialogs.rs` | System file dialogs |
| file_browser | `commands/file_browser.rs` | Directory listing, audio file info |
| pitch_cache | `commands/pitch_cache.rs` | Pitch cache management |
| pitch_progress | `commands/pitch_progress.rs` | Analysis progress querying |
| onnx_status | `commands/onnx_status.rs` | ONNX availability querying |
| debug | `commands/debug.rs` | Debug statistics |

### 4.3 Global State (AppState)

`AppState` in `state.rs` is the core state container, injected via `tauri::manage()`. All commands access it through `State<'_, AppState>`.

```rust
pub struct AppState {
    // Timeline state (tracks, clips, selections, etc.)
    pub timeline: Mutex<TimelineState>,
    // Undo/Redo history stacks
    pub undo_stack: Mutex<Vec<TimelineState>>,
    pub redo_stack: Mutex<Vec<TimelineState>>,
    // Project metadata
    pub project: Mutex<ProjectState>,
    // Real-time audio engine
    pub audio_engine: AudioEngine,
    // Pitch cache (LRU)
    pub clip_pitch_cache: Mutex<ClipPitchCache>,
    // Waveform cache directory
    pub waveform_cache_dir: Mutex<PathBuf>,
    // Pitch analysis progress
    pub pitch_progress: Mutex<Option<PitchProgressState>>,
    // Tauri app handle
    pub app_handle: OnceLock<tauri::AppHandle>,
    // ...
}

```

#### Key Data Structures

**Track**:

```rust
pub struct Track {
    pub id: String,           // UUID
    pub name: String,
    pub parent_id: Option<String>,  // Parent track (supports nesting)
    pub order: i32,
    pub muted: bool,
    pub solo: bool,
    pub volume: f32,          // 0.0 ~ 1.0
    pub compose_enabled: bool,
    pub pitch_analysis_algo: PitchAnalysisAlgo,  // WorldDll / NsfHifiganOnnx / None
    pub color: String,        // hex color
}

```

**Clip**:

```rust
pub struct Clip {
    pub id: String,            // UUID
    pub track_id: String,      // Associated track
    pub name: String,
    pub start_sec: f64,        // Timeline start position
    pub length_sec: f64,       // Visible length
    pub source_path: Option<String>,  // Audio source file
    pub duration_sec: Option<f64>,    // Source file total duration
    pub duration_frames: Option<u64>, // Source file frame count
    pub source_sample_rate: Option<u32>,
    pub gain: f32,             // Gain
    pub muted: bool,
    pub trim_start_sec: f64,   // Trimming start
    pub trim_end_sec: f64,     // Trimming end
    pub playback_rate: f32,    // Playback rate (Time Stretch)
    pub fade_in_sec: f64,      // Fade in duration
    pub fade_out_sec: f64,     // Fade out duration
}

```

**TrackParamsState**:

```rust
pub struct TrackParamsState {
    pub frame_period_ms: f64,     // Analysis frame period (default 5ms)
    pub pitch_orig: Vec<f32>,     // Original pitch curve (MIDI values)
    pub pitch_edit: Vec<f32>,     // Edited pitch curve
    pub pitch_edit_user_modified: bool,
    pub tension_orig: Vec<f32>,   // Tension curve
    pub tension_edit: Vec<f32>,
}

```

### 4.4 Audio Engine

The audio engine is located in the `audio_engine/` module and is responsible for real-time playback and mixing.

```
AudioEngine
├── engine.rs        # cpal audio callback + playback state machine
├── snapshot.rs      # Playback snapshot (frozen timeline state for callback)
├── mix.rs           # Multi-track mixing logic
├── io.rs            # Audio I/O (symphonia decoding)
├── ring.rs          # Lock-free ring buffer (callback → main thread comms)
├── stretch_stream.rs # Pitch editing stream (Pitch Stream)
├── resource_manager.rs # Decoder resource management
├── types.rs         # Type definitions
└── util.rs          # Utility functions

```

**Workflow**:

1. Playback starts → `engine.rs` creates a snapshot (`snapshot.rs`), freezing the current track/clip states.
2. cpal audio callback loop:
* Finds all clips overlapping the current playback position.
* For each clip: Decodes audio → Applies Time Stretch (if needed) → Applies Pitch Editing (if needed).
* Multi-track mixing (`mix.rs`) → Output to audio device.


3. Pitch Stream (`stretch_stream.rs`):
* If `compose_enabled` is on for the track, use renderers (WORLD/HiFiGAN) to process audio.
* WORLD Renderer: Real-time rendering, low latency.
* ONNX Renderer: Optional hard-start mode (pre-buffering before playback).



### 4.5 Renderer System

The renderer uses a **Trait plugin architecture** (similar to OpenUTAU's IRenderer), located in the `renderer/` module.

```rust
pub trait Renderer: Send + Sync {
    fn id(&self) -> &str;
    fn display_name(&self) -> &str;
    fn kind(&self) -> SynthPipelineKind;
    fn is_available(&self) -> bool;
    fn render(&self, ctx: &RenderContext<'_>) -> Result<Vec<f32>, String>;
    fn capabilities(&self) -> RendererCapabilities;
}

```

**Registered Renderers**:

| Renderer | ID | Features |
| --- | --- | --- |
| WORLD Vocoder | `world_vocoder` | Real-time, low latency, CPU-based |
| NSF-HiFiGAN ONNX | `nsf_hifigan_onnx` | High quality, requires ONNX Runtime, CUDA support |

Selection logic: Use `get_renderer(SynthPipelineKind)` to get the corresponding renderer instance (static dispatch, zero heap allocation).

### 4.6 FFI Bindings

| Module | Binding Method | Description |
| --- | --- | --- |
| `world.rs` | C FFI (Static Link) | WORLD Vocoder: Dio/Harvest F0 analysis, CheapTrick spectral envelope, D4C aperiodicity, Synthesis |
| `streaming_world.rs` | Based on `world.rs` | Streaming WORLD processing (chunked analysis + synthesis) |
| `world_vocoder.rs` | Based on `world.rs` | High-level WORLD Vocoder wrapper (Analysis → Editing → Synthesis pipeline) |
| `rubberband.rs` | C FFI (Static Link) | Rubber Band Time Stretch/Pitch Shift (R2 + R3 engines) |
| `nsf_hifigan_onnx.rs` | `ort` crate (ONNX Runtime) | NSF-HiFiGAN neural network inference |

---

## 5. Frontend Architecture

### 5.1 Overall Structure

The frontend is built with **React 19 + Redux Toolkit + Radix UI + Tailwind CSS**, bundled via Vite.

```
App.tsx (Root Component)
├── MenuBar         # Top menu (File/Edit/View/Track/Help)
├── ActionBar       # Action toolbar (Model loading/Analysis/Synthesis/Playback control)
├── Main Edit Area (Flex)
│   ├── FileBrowserPanel  # Left sidebar (Toggleable)
│   ├── TimelinePanel     # Timeline (Track list + Clip editing)
│   └── PianoRollPanel    # Piano roll (Pitch/Tension curve editing)
└── StatusBar       # Bottom status bar (Status info + Render indicators)

```

### 5.2 State Management

Uses **Redux Toolkit** for global state management.

#### Redux Store Structure

```typescript
{
  session: {           // Core session state (sessionSlice.ts)
    status: string,
    error: string | null,
    runtime: {         // Backend runtime info
      device: string,
      modelLoaded: boolean,
      audioLoaded: boolean,
      hasSynthesized: boolean,
      isPlaying: boolean,
      playbackTarget: string | null,
    },
    timeline: {        // Timeline state (Backend authority)
      tracks: TrackInfo[],
      clips: ClipInfo[],
      selectedTrackId: string | null,
      selectedClipId: string | null,
      bpm: number,
      playheadSec: number,
      projectSec: number,
    },
    project: {         // Project metadata
      name: string,
      path: string | null,
      dirty: boolean,
      recent: string[],
    },
    // UI State
    toolMode: "draw" | "select",
    editParam: "pitch" | "tension",
    gridSize: "1/4" | "1/8" | "1/16" | "1/32",
    fadeCurves: { in: FadeCurveType, out: FadeCurveType },
    pianoRollOpen: boolean,
    // ...
  },
  fileBrowser: {       // File browser state (fileBrowserSlice.ts)
    visible: boolean,
    currentDir: string,
    entries: FileEntry[],
    // ...
  }
}

```

#### Thunks Groups

Async operations implemented via `createAsyncThunk`, split into the `thunks/` directory by domain:

| File | Responsibility |
| --- | --- |
| `transportThunks.ts` | Playback control (play/stop/seek), status polling |
| `timelineThunks.ts` | Track/Clip operations (CRUD, drag, split, glue) |
| `projectThunks.ts` | Project operations (new/open/save/undo/redo) |
| `importThunks.ts` | Audio file import (dialog/DND/path/base64) |
| `audioThunks.ts` | Audio processing (analysis/pitch-shift/synth/export) |
| `modelThunks.ts` | Model loading |
| `trackThunks.ts` | Track state settings, clip deletion |
| `runtimeThunks.ts` | Runtime status refresh, cache clearing |

### 5.3 IPC Invocation Layer

The frontend uses `services/invoke.ts` to wrap IPC calls, compatible with two backends:

* **Tauri Mode**: `window.__TAURI__.core.invoke(cmd, namedArgs)`
* **pywebview Mode**: `window.pywebview.api[method](...positionalArgs)` (legacy Python backend support)

The `buildTauriArgs()` function handles converting positional arguments into Tauri's named argument format.

#### API Modules

The API layer is split by domain and exported together:

```typescript
// services/api/index.ts
export { coreApi }        // Core: ping, runtime, playback, model, ONNX
export { projectApi }     // Project: new/open/save
export { timelineApi }    // Timeline: track/clip operations
export { paramsApi }      // Params: pitch/tension curve read/write
export { waveformApi }    // Waveform: peak segment querying
export { fileBrowserApi } // File Browser: directory list/audio info

```

### 5.4 Component Hierarchy

#### TimelinePanel

The most complex component, split into sub-components and hooks:

```
TimelinePanel.tsx (Entry, state orchestration + event handling)
├── TrackList.tsx          # Left track list (select/mute/solo/vol/CRUD)
├── TimeRuler.tsx          # Top time ruler (bar markers + playhead)
├── BackgroundGrid.tsx     # Timeline background grid
├── TimelineScrollArea.tsx # Scroll container (Ctrl/Alt wheel zoom, persistence)
├── TrackLane.tsx          # Track lane (clip arrangement area)
├── ClipItem.tsx           # Single clip rendering (waveform/fade/gain/mute)
│   ├── ClipHeader.tsx     #   Clip header (name, color badge)
│   ├── ClipEdgeHandles.tsx #   Trim/Fade handles
│   └── useClipWaveformPeaks.ts  # Waveform peak data hook
├── ClipContextMenu.tsx    # Clip context menu
├── GlueContextMenu.tsx    # Glue menu
├── hooks/
│   ├── useClipDrag.ts     # Clip dragging logic
│   ├── useEditDrag.ts     # Edit dragging (trim/fade handles)
│   ├── useSlipDrag.ts     # Slip editing
│   └── useKeyboardShortcuts.ts  # Keyboard shortcuts
└── Utility Modules
    ├── constants.ts       # Constants (row height, min width, etc.)
    ├── math.ts            # Math tools (time ↔ pixels conversion)
    ├── grid.ts            # Grid snapping
    ├── paths.ts           # SVG path generation (fade curves)
    ├── dnd.ts             # DND import parsing
    └── clipWaveform.ts    # Waveform rendering utilities

```

#### PianoRollPanel

Responsible for visualization and editing of pitch/tension curves:

```
PianoRollPanel.tsx (Entry)
├── pianoRoll/render.ts              # Canvas rendering (drawPianoRoll)
├── pianoRoll/usePianoRollData.ts    # Data fetching hook (getParamFrames)
├── pianoRoll/usePianoRollInteractions.ts  # Interaction hook (draw/select/drag)
├── pianoRoll/useLiveParamEditing.ts # Live param editing hook
├── pianoRoll/useClipsPeaksForPianoRoll.ts # Waveform data hook
└── pianoRoll/peaksCache.ts          # Peaks cache

```

**Editing Modes**:

* **Draw Mode**: Mouse drawing/dragging to modify pitch curves.
* **Select Mode**: Marquee selection → move/scale curves within selection.
* Supported params: `pitch` (MIDI values), `tension`.

---

## 6. IPC API Documentation

All frontend-backend communication is done via Tauri `invoke`. Frontend calls `invoke("commandName", { ...args })`, and backend registers the corresponding `#[tauri::command]` in `commands.rs`.

### 6.1 Core Commands

| Command | Args | Returns | Description |
| --- | --- | --- | --- |
| `ping` | None | `{ ok, message }` | Health check |
| `get_runtime_info` | None | `RuntimeInfoPayload` | Get backend runtime info |
| `get_timeline_state` | None | `TimelineStatePayload` | Get full timeline state |
| `set_transport` | `playheadSec?, bpm?` | `{ ok, playhead_sec, bpm }` | Set playhead/BPM |
| `undo_timeline` | None | `TimelineStatePayload` | Undo operation |
| `redo_timeline` | None | `TimelineStatePayload` | Redo operation |

### 6.2 Project Commands

| Command | Args | Returns | Description |
| --- | --- | --- | --- |
| `close_window` | None | `{ ok }` | Close window (triggers save check) |
| `get_project_meta` | None | `ProjectMetaPayload` | Get project metadata |
| `new_project` | None | `TimelineStatePayload` | New project |
| `open_project_dialog` | None | `{ ok, canceled?, path? }` | Popup open dialog |
| `open_project` | `projectPath` | `TimelineStatePayload` | Open specific project |
| `save_project` | None | `{ ok }` | Save project |
| `save_project_as` | None | `{ ok }` | Save as |

### 6.3 Timeline Commands

#### Track Operations

| Command | Args | Returns | Description |
| --- | --- | --- | --- |
| `add_track` | `name?, parentTrackId?, index?` | `TimelineStatePayload` | Add track |
| `remove_track` | `trackId` | `TimelineStatePayload` | Remove track |
| `move_track` | `trackId, targetIndex, parentTrackId?` | `TimelineStatePayload` | Move track |
| `set_track_state` | `trackId, muted?, solo?, volume?, composeEnabled?, pitchAnalysisAlgo?, color?` | `TimelineStatePayload` | Set track state |
| `select_track` | `trackId` | `TimelineStatePayload` | Select track |

#### Clip Operations

| Command | Args | Returns | Description |
| --- | --- | --- | --- |
| `add_clip` | `trackId?, name?, startSec?, lengthSec?, sourcePath?` | `TimelineStatePayload` | Add clip |
| `remove_clip` | `clipId` | `TimelineStatePayload` | Remove clip |
| `move_clip` | `clipId, startSec, trackId?` | `TimelineStatePayload` | Move clip |
| `set_clip_state` | `clipId, name?, ..., playbackRate?, fadeInSec?, fadeOutSec?, color?` | `TimelineStatePayload` | Set clip state |
| `split_clip` | `clipId, splitSec` | `TimelineStatePayload` | Split clip at position |
| `glue_clips` | `clipIds` | `TimelineStatePayload` | Glue multiple clips |

### 6.4 Param Curve Commands

| Command | Args | Returns | Description |
| --- | --- | --- | --- |
| `get_param_frames` | `trackId, param, startFrame, frameCount, stride?` | `ParamFramesPayload` | Get param frame data |
| `set_param_frames` | `trackId, param, startFrame, values, checkpoint?` | `{ ok }` | Write edited frames |

---

## 7. Build System

### 7.1 Build Flow

The project uses Tauri 2's standard build flow with extra stages in `build.rs`:

1. `build_frontend()`: Automatically runs `npm run build` if `frontend/dist` is missing.
2. `tauri_build::build()`: Standard Tauri build.
3. `build_world_static()`: Compiles WORLD source via `cc` crate.
4. `build_rubberband_static()`: Compiles Rubber Band source via `cc` crate.

### 7.2 Cargo Features

| Feature | Default | Description |
| --- | --- | --- |
| `onnx` | ✅ Enabled | Enables ONNX inference (`ort` + `ndarray`) |

To build without ONNX: `cargo build --no-default-features`

---

## 8. Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `HIFISHIFTER_PITCH_ANALYSIS_SR` | `16000` | WORLD analysis sample rate |
| `HIFISHIFTER_VAD_RMS_THRESHOLD` | `0.02` | VAD silence threshold (~−34 dBFS) |
| `HIFISHIFTER_ORT_EP` | `auto` | Execution Provider: `auto` / `cuda` / `cpu` |
| `HIFISHIFTER_ONNX_STREAM_PRIME_SEC` | `0.25` | Pre-buffering duration for ONNX stream |

---

## 9. Pitch Analysis Pipeline

### 9.1 VAD Optimization

Analysis speed is significantly improved (40-70% typical) by skipping silent regions using an RMS VAD system.

### 9.2 Parallel Incremental Analysis (v3)

Achieves **3-9x** speedup through parallel processing and LRU caching.

* **Rayon**: Parallelizes analysis across clips.
* **LRU Cache**: Caches results using a Blake3 hash of file metadata and clip parameters.
* **Position Independence**: Dragging a clip does not invalidate its cache.

---

## 10. Renderer System

### 10.1 WORLD Vocoder

* **ID**: `world_vocoder`
* **Capabilities**: Low latency, CPU-only, supports real-time.
* **Flow**: PCM → WORLD Analysis → Modify F0 → WORLD Synthesis.

### 10.2 NSF-HiFiGAN ONNX

* **ID**: `nsf_hifigan_onnx`
* **Capabilities**: High quality, supports CUDA, requires pre-buffering.
* **Flow**: PCM → Mel extraction → ONNX Inference → Waveform.

---

## 11. Audio Engine

* **Pitch Stream**: Uses `stretch_stream.rs` for real-time synthesis when `compose_enabled` is on.
* **Hard-start Mode**: For ONNX renderers, outputs silence until the pre-buffer window is ready to ensure smooth playback.

---

## 12. Project File Format

* **Format**: MessagePack (primary) + JSON (fallback).
* **Extension**: `.hshp` (recommended) or `.json`.
* **Path Handling**: `source_path` is converted to a relative path (relative to project file) on save and resolved to absolute on load.

---

## Appendix: Key Design Decisions

| Decision | Selection | Reason |
| --- | --- | --- |
| Linking | Static WORLD + Rubber Band | Single file distribution, no runtime dependencies. |
| Authority | Backend Authority | Avoids state desync; Undo/Redo implemented in Rust. |
| IPC | Tauri invoke | Simple and reliable; returns full timeline snapshots. |
| Caching | Position-independent LRU | Moving clips doesn't trigger re-analysis. |
| UI | React + Redux Toolkit | Mature state management for complex UI. |