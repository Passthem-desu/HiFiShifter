# Development

For now, the developer handbook is maintained in Chinese:

- [DEVELOPMENT_zh.md](DEVELOPMENT_zh.md)

## Recent notes

	- The audio callback reads from the pitch-stream when covered.
	- At the start of playback (or right after a seek/reset), if the pitch-stream hasn't rendered the first window yet, the callback outputs silence and does not advance the playhead until the stream catches up (to avoid hearing unprocessed audio before it switches to pitched audio).
	- If the stream temporarily lags later, we still do best-effort fallback: mix realtime and override the frames that are already covered.

## Pitch / Tension editing

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
