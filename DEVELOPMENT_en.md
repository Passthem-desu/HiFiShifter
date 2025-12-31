# HiFiShifter Development Manual

HiFiShifter is a GUI-based vocal editing and synthesis tool built on neural vocoders (NSF-HiFiGAN). This document provides developers with an updated architecture overview, module notes, and practical extension/debugging guidance (including the recent GUI refactor).

## 0. Quick Dev Start

- **Python**: recommended 3.10+
- **Install deps**:

```bash
pip install -r requirements.txt
```

- **Run GUI (recommended from repo root)**:

```bash
python run_gui.py
```

> Note: Some inference/training-related code lives at the repo top level (e.g. `training/`). Running from the repo root is recommended. The audio submodules also include launch-context compatibility via `hifi_shifter/audio_processing/_bootstrap.py`.

## 1. Project Overview

### 1.1 Directory Structure (updated)

```text
HiFiShifter/
├── assets/
│   └── lang/                    # Language packs (zh_CN.json, en_US.json)
├── configs/                     # Model configs (.yaml)
├── hifi_shifter/
│   ├── audio_processor.py        # Orchestrator (public entry used by GUI)
│   ├── audio_processing/         # Submodules (readable, debuggable stages)
│   │   ├── features.py           # Audio loading / features / segmentation
│   │   ├── hifigan_infer.py      # NSF-HiFiGAN inference
│   │   ├── tension_fx.py         # Tension post-FX
│   │   └── _bootstrap.py         # Launch-context sys.path helper
│   ├── gui/                      # GUI package (split by responsibility)
│   │   ├── window.py             # `HifiShifterGUI` main window (composes mixins)
│   │   ├── layout.py             # Main layout & widgets
│   │   ├── menu.py               # Menu/theme/language
│   │   ├── editor.py             # Editing/selection/interactions
│   │   ├── plotting.py           # Plot items + refresh
│   │   ├── params.py             # Parameter abstraction + axis semantics
│   │   ├── project_io.py         # Open/save + dirty prompts
│   │   ├── tracks.py             # Track import & management
│   │   ├── synthesis.py          # Incremental synthesis scheduling
│   │   ├── mixdown.py            # Mixdown + post-FX
│   │   ├── playback.py           # Real-time playback (OutputStream)
│   │   ├── exporter.py           # WAV export
│   │   ├── background.py         # Background jobs/threads
│   │   └── vocalshifter.py       # VocalShifter import
│   ├── main_window.py            # Compatibility shim (re-exports `HifiShifterGUI`)
│   ├── timeline.py               # Timeline panel (UI layer)
│   ├── track.py                  # Track model & caches/undo
│   ├── widgets.py                # Custom PyQtGraph widgets (axis/grid/ViewBox)
│   ├── theme.py                  # Themes & QSS
│   └── ...
├── models/                       # Model structures
├── modules/                      # NN building blocks
├── training/                     # Some top-level training/inference dependencies
├── utils/
│   ├── i18n.py                    # i18n manager (`i18n.get(key)`)
│   └── ...
├── run_gui.py                    # Entry point
└── ...
```

### 1.2 High-level Data Flow

- **UI** (`hifi_shifter/gui/`; compatibility import via `hifi_shifter/main_window.py`)
  - Handles mouse/keyboard → updates the active track’s parameter arrays (e.g. `f0_edited`, `tension_edited`)
  - Pitch edits mark impacted segments as dirty → triggers incremental re-synthesis
  - Tension edits are treated as post-FX (typically no vocoder re-run, depending on implementation)

- **Audio pipeline** (`audio_processor.py` + `audio_processing/*`)
  - Load model → feature extraction → segmentation → infer dirty segments → update track caches

## 2. Key Modules

### 2.1 GUI main window & interaction (`hifi_shifter/gui/`)

Historically, much of the GUI logic lived in a single large file (`hifi_shifter/main_window.py`), which made it hard to read and modify. The GUI is now split into a dedicated package `hifi_shifter/gui/` by responsibility.

- **Main GUI class**: `HifiShifterGUI` lives in `gui/window.py` and composes multiple “mixin” modules.
- **Compatibility**: `hifi_shifter/main_window.py` is now a compatibility shim that re-exports `HifiShifterGUI` to avoid breaking import paths.

Responsibility map (high level):
- UI composition: menus/top controls/editor/timeline (`gui/menu.py`, `gui/layout.py`)
- Project I/O: open/save/dirty prompts (`gui/project_io.py`)
- Tracks/import: loading audio, managing tracks (`gui/tracks.py` + parts of `timeline.py`)
- Editing interactions: edit/select modes, selection, drag, undo/redo (`gui/editor.py`)
- Parameter system: parameter abstraction + axis semantics (`gui/params.py`)
- Plot refresh: curve items + highlight rendering (`gui/plotting.py`)
- Synthesis/jobs: dirty segments, incremental synthesis, background threads (`gui/synthesis.py`, `gui/background.py`)
- Playback/mixdown: real-time callback, mixdown + post-FX (`gui/playback.py`, `gui/mixdown.py`)
- Export: WAV export (`gui/exporter.py`)

#### Real-time playback (streamed mixing; fader/mute/solo apply during playback)

To make volume faders, mute, and solo changes take effect while playing, the playback path was changed from “offline mix once + `sd.play()`” to **callback-based mixing via `sounddevice.OutputStream`** (implemented mainly in `gui/playback.py` / `gui/mixdown.py`).

Key points:
- **No Qt calls in the audio callback**: the callback runs on the sounddevice audio thread and only reads track states (`volume`/`muted`/`solo`) to generate each output block.
- **Minimal shared state**: `self._playback_lock` protects a small shared state like `_playback_sample_pos`; the GUI timer reads sample position to drive the play cursor.
- **Solo priority**: if any track is soloed, only solo tracks are mixed; otherwise all non-muted tracks are mixed.
- **Latency**: changes apply on the next audio block (typically tens of milliseconds, device/buffer dependent).

#### Parameter editing system (parameter abstraction + axis semantics)

- Active parameter: `edit_param` (currently `pitch` / `tension`)
- Top-bar combo and in-editor buttons are kept in sync via `set_edit_param()`
- Parameter abstraction + axis semantics mainly live in `gui/params.py`; interaction writing/dragging is in `gui/editor.py`; plot refresh is in `gui/plotting.py`.

To add a new parameter, implement the “parameter abstraction interface”:
- **Data access**: get/set the parameter array on `Track`
- **Rendering**: map parameter value → plot Y (especially for non-pitch params)
- **Editing**: brush writing + selection-drag offset behavior
- **Axis semantics**: axis kind (`note` vs `linear`) + value formatting

### 2.2 Selection system & generic highlight

Key state:
- `selection_mask`: boolean array for selected samples
- `selection_param`: binds the selection to a parameter to avoid cross-parameter interference

Highlight rendering:
- A dedicated curve item (`selected_param_curve_item`) draws only selected points.
- Non-selected points are set to `NaN` and rendered with `connect="finite"` so only selected segments are visible.

### 2.3 Axis system: ticks and axis title change with parameter

- `widgets.py` `PianoRollAxis` no longer hardcodes Pitch/Tension behavior.
- It queries the GUI main class (`HifiShifterGUI`) for:
  - active axis parameter (usually `edit_param`)
  - axis kind: `note` (note names) or `linear` (numeric)
  - value ↔ plot-Y mapping and string formatting

Additionally, the GUI main class updates:
- the left vertical **axis label** (e.g. “Pitch (Note)” vs “Tension”)
- the tick style (note names vs numeric)

### 2.4 Audio pipeline orchestrator + submodules

- `audio_processor.py`: public entry used by the GUI; orchestrates the pipeline and keeps a stable API.
- `audio_processing/`: split processing stages:
  - `features.py`: audio loading, feature extraction (mel/f0), segmentation helpers
  - `hifigan_infer.py`: NSF-HiFiGAN model loading/inference
  - `tension_fx.py`: tension post-processing utilities
  - `_bootstrap.py`: ensures repo root is on `sys.path` to avoid import errors in different launch contexts

## 3. Internationalization (i18n)

- Language files: `assets/lang/zh_CN.json`, `assets/lang/en_US.json`
- Usage:
  - `from utils.i18n import i18n` then `i18n.get("key")`
- Common keys used in the GUI:
  - `label.edit_param` (top-bar “Edit” label)
  - `param.pitch` / `param.tension` (parameter names)
  - `status.tool.edit` / `status.tool.select` (status bar templates)

> Templates use `str.format`, e.g. `i18n.get("status.tool.edit").format("Pitch")`.

## 4. Debugging Tips

- **Good breakpoints**:
  - Parameter switching: `HifiShifterGUI.set_edit_param()` (typically implemented via the `gui/params.py` mixin)
  - Selection updates: `set_selection()` / `update_selection_highlight()` (mainly in `gui/editor.py` / `gui/plotting.py`)
  - Dirty segment marking + auto synthesis trigger (`gui/synthesis.py`)
  - Inference entry: `audio_processing/hifigan_infer.py`
- **Performance watch-outs**:
  - Avoid blocking the UI thread with heavy feature extraction/inference (consider threading/task queue if you extend it)
  - Prefer short audio clips for UI iteration; long audio imports can be expensive

## 5. Common Extension Tasks

### 5.1 Add a new editable parameter (recommended steps)

1. **Extend `Track`**: add `xxx_original` / `xxx_edited` and undo/redo stacks if needed.
2. **Implement parameter abstraction + axis semantics**: start in `hifi_shifter/gui/params.py` (access/mapping/formatting).
3. **Implement interactions + rendering**:
   - brush writing / selection drag: usually in `hifi_shifter/gui/editor.py`
   - curve refresh / highlight: usually in `hifi_shifter/gui/plotting.py`
4. **Wire the UI**:
   - add to top combo / editor buttons and route switching through `set_edit_param()`
   - add i18n keys (`param.xxx`, `label.xxx`, etc.)

### 5.2 Add a new audio processing stage

- Prefer adding a new module under `hifi_shifter/audio_processing/` and orchestrating it from `audio_processor.py`.
- For “post-FX” style processing (like tension), design it to be cacheable and fast to recompute.

## 6. Known Issues

- Fader/mute/solo changes during playback apply on the next audio block (small latency may be noticeable)
- Very long audio imports can freeze due to initial feature extraction
- Multi-track / high sample rate content increases memory usage significantly
