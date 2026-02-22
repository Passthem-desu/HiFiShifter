# Development

For now, the developer handbook is maintained in Chinese:

- [DEVELOPMENT_zh.md](DEVELOPMENT_zh.md)

## Recent notes

	- The audio callback reads from the pitch-stream when covered.
	- For WORLD (and most cases), realtime playback must never block: if the pitch-stream hasn't rendered coverage yet, the callback falls back to normal realtime mixing and continues advancing the playhead.
	- For slow ONNX (NSF-HiFiGAN) pitch editing, we default to an A-mode hard-start: output silence + do not advance until a short prebuffer window is ready, to avoid the audible "original -> pitched" transition.
		- Disable ONNX hard-start via `HIFISHIFTER_ONNX_PITCH_STREAM_HARD_START=0`.
		- Tune priming via `HIFISHIFTER_ONNX_STREAM_PRIME_SEC` (default `0.25`) and `HIFISHIFTER_ONNX_STREAM_PRIME_TIMEOUT_MS` (default `4000`).
		- The frontend listens for `playback_rendering_state` and shows a minimal "渲染中..." indicator in the bottom-left status bar while priming.
	- Legacy override: force hard-start for any pitch-stream via `HIFISHIFTER_PITCH_STREAM_HARD_START=1`.
	- If the stream temporarily lags later, we still do best-effort fallback: mix realtime and override the frames that are already covered.

## Pitch / Tension editing

### Frontend loading sync for pitch analysis

Pitch F0 analysis runs in the backend on a background thread. The frontend should show a loading overlay (optionally with progress) until the pitch curve is ready.

- `get_param_frames` returns `analysis_pending` for `param=pitch` to indicate whether analysis is scheduled/inflight.
- Tauri events:
	- `pitch_orig_analysis_started` (root track + analysis key)
	- `pitch_orig_analysis_progress` (root track + `progress` in 0..1)
	- `pitch_orig_updated` (analysis finished; frontend should refresh + stop loading)

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
