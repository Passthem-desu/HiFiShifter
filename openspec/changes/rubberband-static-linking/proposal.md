## Why

Similar to the WORLD vocoder migration, Rubber Band Library currently requires manual DLL builds via `tools/build_rubberband_windows.cmd` and runtime dynamic loading with `libloading`. This adds complexity to the build process, requires users to manage DLL paths, and introduces potential runtime failures. Static linking via `cc` crate will provide a single-binary distribution, simplified builds, and improved reliability.

## What Changes

- Migrate Rubber Band Library from DLL dynamic loading to compile-time static linking using `cc` crate
- Clone Rubber Band source to `backend/src-tauri/third_party/rubberband-static/`
- Update `build.rs` to compile Rubber Band C++ sources statically alongside WORLD
- Refactor `backend/src-tauri/src/rubberband.rs` FFI layer to use `extern "C"` declarations instead of `libloading`
- Remove `libloading` dependency from `Cargo.toml` (no longer needed after both WORLD and Rubber Band are static)
- Mark `tools/build_rubberband_windows.cmd` and `tools/verify_rubberband_windows.cmd` as deprecated
- Update documentation to reflect static linking approach

## Capabilities

### New Capabilities
- `rubberband-static-linking`: Compile-time static linking of Rubber Band Library C++ sources via cc crate, eliminating runtime DLL dependencies and manual build scripts

### Modified Capabilities
<!-- No existing capability requirements are changing - this is an internal implementation change -->

## Impact

- **Build System**: `backend/src-tauri/build.rs` (add Rubber Band compilation), `backend/src-tauri/Cargo.toml` (remove libloading)
- **FFI Layer**: `backend/src-tauri/src/rubberband.rs` (replace dynamic loading with static FFI)
- **Legacy Scripts**: `tools/build_rubberband_windows.cmd`, `tools/verify_rubberband_windows.cmd` (mark deprecated)
- **Documentation**: `README.md`, `DEVELOPMENT_zh.md` (remove DLL build instructions, note automatic static compilation)
- **Build Time**: Initial builds will increase by ~2-5 minutes (Rubber Band C++ compilation), incremental builds ~10-20s
- **Binary Size**: Release binary will increase by ~1-2 MB (statically linked Rubber Band)
