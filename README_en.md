# HifiShifter

[中文](README.md) | [English](README_en.md)

HifiShifter is a GUI-based vocal editing and synthesis tool built on neural vocoders (NSF-HiFiGAN). You can load audio, edit parameter curves (e.g., Pitch, Tension) directly on a piano-roll style editor, and synthesize the modified result in real time (with long-audio incremental optimizations).

## Feature Overview

- **Multi-parameter editing**: Edit not only Pitch (Note) but also Tension, with an abstraction layer ready for future parameters.
- **Selection editing (generic)**: Box-select sample points, show selection highlights, and drag the whole selection vertically (applies to the current parameter).
- **Long-audio incremental synthesis**: Automatically segments long audio and only re-synthesizes dirty segments for responsive editing.
- **Project management**: Save/load projects (`.hsp`) including paths and edit data.
- **Playback & export**: Play original/synth audio and export WAV (mixed or separated depending on GUI entry).
- **Real-time playback mixing**: Volume faders, mute, and solo changes take effect during playback (no restart needed).
- **i18n & theme**: Chinese/English UI plus Dark/Light themes.


## Installation

### 1. Clone Repository

```bash
git clone https://github.com/ARounder-183/HiFiShifter.git
cd HifiShifter
```

### 2. Install Dependencies

Ensure Python 3.10+ is installed.

```bash
pip install -r requirements.txt
```

## Quick Start

1. **Run the app**

```bash
python run_gui.py
```

2. **Load a model**
- Click `File` -> `Load Model`.
- Select a folder containing `model.ckpt` and `config.json`.
- Default provided model: `pc_nsf_hifigan_44.1k_hop512_128bin_2025.02`.

3. **Load audio**
- Click `File` -> `Load Audio`.
- Supports `.wav` / `.flac` / `.mp3`.

4. **Edit & synthesize**
- Use the top bar `Edit:` combo to select the parameter to edit (Pitch/Tension).
- The in-editor parameter buttons are synced with the top combo.
- Click `Playback` -> `Synthesize & Play` to audition.

## Edit Mode vs Select Mode

### Edit Mode
- **Left click**: Edit the curve of the current parameter.
- **Right click**: Erase/restore the current parameter (exact behavior depends on the parameter; Pitch typically returns to original/empty, Tension typically returns to default/zero).

### Select Mode
- **Left-drag**: Box-select sample points for the current parameter.
- **Selection highlight**: Selected points are highlighted with a dedicated curve item (works for all parameters, not only Pitch).
- **Drag selection vertically**: Apply a uniform offset to selected points (current parameter only).

## Axis Behavior (changes with parameter)

- For **Pitch**: the left Y axis shows note-name ticks (Note semantics like C4, D#4) and the axis title updates accordingly.
- For **Tension** and other linear parameters: the left Y axis switches to numeric (linear) ticks and a matching axis title.

This is implemented as an abstraction so adding new parameters only requires adding their axis kind/mapping/formatting.

## Shortcuts

| Action | Shortcut / Mouse |
| :-- | :-- |
| **Pan view** | Middle mouse drag |
| **Zoom time (X)** | Ctrl + wheel |
| **Zoom parameter (Y)** | Alt + wheel |
| **Edit current parameter** | Left click |
| **Erase/restore current parameter** | Right click |
| **Play/Pause** | Space |
| **Undo** | Ctrl + Z |
| **Redo** | Ctrl + Y |
| **Toggle mode (Edit/Select)** | Tab |

## Developer Notes (relevant to today’s refactor)

### Modularized audio pipeline

Audio processing has been refactored from a monolithic module into an orchestrator + submodules for readability and easier debugging:

- `hifi_shifter/audio_processor.py`
  - Still the public entry used by the GUI; it orchestrates the flow and keeps the API stable.
- `hifi_shifter/audio_processing/`
  - `features.py`: audio loading / feature extraction / segmentation utilities.
  - `hifigan_infer.py`: NSF-HiFiGAN inference.
  - `tension_fx.py`: tension post-FX.
  - `_bootstrap.py`: startup-context compatibility (keeps repo root on `sys.path` to avoid missing `training/` imports).

### Generic selection highlight & parameter extensibility

- Selection is tracked with `selection_mask` + `selection_param` to avoid cross-parameter interference.
- Highlight is rendered via a generic `selected_param_curve_item` that updates when the active parameter changes.

## Known Issues

There are still known issues, e.g. importing long audio can freeze in some environments, and multi-track / high sample rate content can consume significant resources.


## Documentation

- [Development Manual](DEVELOPMENT_en.md)
- [Roadmap](todo.md)

## Acknowledgements

This project uses code or model structures from:
- [SingingVocoders](https://github.com/openvpi/SingingVocoders)
- [HiFi-GAN](https://github.com/jik876/hifi-gan)

## License

MIT License
