# PyQt -> React Migration Plan (Stage 2)

This file tracks remaining parity work to fully replace the original PyQt GUI.

## Completed in Stage 1

- New `pywebview + React + TypeScript + Redux + Tailwind + Radix` app scaffold.
- Python backend API bridge in `hifi_shifter/web_api.py`.
- Core actions wired:
  - model load
  - audio processing
  - pitch shift
  - synthesize
  - export wav
  - play original / synthesized / stop
- New launcher keeps legacy fallback:
  - `python run_gui.py` (webview)
  - `python run_gui.py --legacy-pyqt`

## Remaining for Full Parity

### Layout & Visualization

- Rebuild timeline lane + track block visualization with drag offset.
- Rebuild piano-roll style editor with overlays:
  - waveform
  - original F0
  - edited F0
  - selected-region highlight
  - tension curve
- Implement responsive splitter equivalent for timeline/editor area.

### Editing Interactions

- Draw mode for pitch/tension (left/right click behavior).
- Select mode:
  - box select
  - drag selected points
  - axis-constrained transform
- Undo/redo stacks for pitch + tension.

### Track Management

- Multi-track support (vocal + bgm).
- Mute / Solo / Volume controls.
- Track type conversion and deletion.
- Copy/Paste pitch between tracks.

### Playback

- Timeline cursor sync and seek.
- Streamed mixdown playback with live fader updates.
- Space toggle and transport controls parity.

### Project IO

- Open/save project format parity.
- Dirty flag and close-confirm flow.
- VocalShifter project import flow.

### UX & i18n

- Language switching (`zh_CN` / `en_US`) parity.
- Theme parity (`dark` / `light`) with persisted config.
- Status/progress feedback parity.
