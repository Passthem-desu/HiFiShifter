## 1. Prepare Rubber Band Source

- [x] 1.1 Create directory `backend/src-tauri/third_party/rubberband-static/`
- [x] 1.2 Clone Rubber Band repository: `git clone https://github.com/breakfastquay/rubberband.git backend/src-tauri/third_party/rubberband-static/rubberband` (or download specific release version tarball)
- [x] 1.3 Verify Rubber Band C++ source files exist in `rubberband/src/` directory (rubberband-c.cpp, common/*.cpp, dsp/*.cpp, etc.)
- [x] 1.4 Verify C API header `rubberband/rubberband/rubberband-c.h` exists
- [x] 1.5 Add `backend/src-tauri/third_party/rubberband-static/` to `.gitignore`

## 2. Update Build Configuration

- [x] 2.1 Open `backend/src-tauri/build.rs` (already has WORLD compilation)
- [x] 2.2 Implement `build_rubberband_static()` function using `cc::Build`
- [x] 2.3 Configure cc::Build with `.cpp(true)`, `.std("c++11")`, and include paths
- [x] 2.4 Add Rubber Band source files using `.file()` calls (rubberband-c.cpp and core implementation files)
- [x] 2.5 Add platform-specific compiler flags (Windows: /EHsc, Unix: -fPIC)
- [x] 2.6 Call `.compile("rubberband")` and emit `cargo:rustc-link-lib=static=rubberband`
- [x] 2.7 Add error handling for missing Rubber Band sources with clear clone instructions
- [x] 2.8 Remove `libloading = "0.8"` from `[dependencies]` in `backend/src-tauri/Cargo.toml` (no longer needed)
- [x] 2.9 Call `build_rubberband_static()` from main build.rs function

## 3. Refactor rubberband.rs FFI Layer

- [ ] 3.1 Remove `use libloading::Library;` import and std::sync::OnceLock
- [ ] 3.2 Remove all function pointer type definitions (RubberbandNew, RubberbandDelete, etc.)
- [ ] 3.3 Remove `struct RubberBandApi` that holds Library and function pointers
- [ ] 3.4 Remove `try_load_library()` function and all DLL search path logic
- [ ] 3.5 Remove `api()` function that returns `Result<&'static RubberBandApi, String>`
- [ ] 3.6 Add `extern "C"` block with direct FFI declarations for all Rubber Band C API functions
- [ ] 3.7 Declare `rubberband_new` in extern block matching C function signature
- [ ] 3.8 Declare `rubberband_delete`, `rubberband_reset`, `rubberband_set_time_ratio`, `rubberband_set_pitch_scale` in extern block
- [ ] 3.9 Declare `rubberband_set_expected_input_duration`, `rubberband_set_max_process_size` in extern block
- [ ] 3.10 Declare `rubberband_study`, `rubberband_process`, `rubberband_available`, `rubberband_retrieve`, `rubberband_calculate_stretch` in extern block
- [ ] 3.11 Update `is_available()` function to always return `true` (static linking guarantees availability)

## 4. Update Public API Functions

- [ ] 4.1 Refactor `RubberBandRealtimeStretcher::new()` to call `rubberband_new()` directly without api() wrapper
- [ ] 4.2 Remove `let api = api()?;` and error handling for unavailable API
- [ ] 4.3 Update function call from `(api.rubberband_new)(...)` to `rubberband_new(...)`
- [ ] 4.4 Refactor all `RubberBandRealtimeStretcher` methods to call extern FFI functions directly
- [ ] 4.5 Update `set_time_ratio()`, `set_pitch_scale()`, `reset()`, `feed()`, `retrieve()`, `available()`, `calculate_stretch()` to use direct FFI
- [ ] 4.6 Remove `Drop::drop()` api() call, use `rubberband_delete()` directly
- [ ] 4.7 Verify all unsafe FFI calls maintain proper pointer validity and lifetimes
- [ ] 4.8 Ensure RubberBandState pointer remains valid across calls

## 5. Remove Dead Code and Environment Variables

- [ ] 5.1 Remove `HIFISHIFTER_RUBBERBAND_DLL` environment variable checks from rubberband.rs
- [ ] 5.2 Remove DLL search logic (executable directory, PATH search)- [ ] 5.3 Search codebase for other references to rubberband DLL and remove them
- [ ] 5.4 Verify no other modules depend on `api()` function or RubberBandApi struct

## 6. Test Build on All Platforms

- [ ] 6.1 Test `cargo build --release` on Windows with MSVC toolchain
- [ ] 6.2 Verify build completes successfully (expect 2-5 minute increase for Rubber Band compilation)
- [ ] 6.3 Test `cargo build` on macOS with Clang (if available)
- [ ] 6.4 Test `cargo build` on Linux with GCC (if available)
- [ ] 6.5 Verify incremental rebuild time is reasonable (~10-20s with unchanged Rubber Band sources)
- [ ] 6.6 Check that executable runs without rubberband.dll in PATH or executable directory
- [ ] 6.7 Verify no linker warnings or errors related to Rubber Band symbols

## 7. Validate Functionality

- [ ] 7.1 Run application and load an audio file
- [ ] 7.2 Trigger time-stretching operation in realtime playback mode
- [ ] 7.3 Verify stretched audio plays correctly with preserved pitch
- [ ] 7.4 Test offline rendering with time stretch (playback_rate != 1.0)
- [ ] 7.5 Compare audio output quality against previous DLL version (should be identical)
- [ ] 7.6 Test edge cases: very slow stretch (0.5x), fast stretch (2.0x), pitch shift + time stretch
- [ ] 7.7 Verify no degraded fallback occurs (no "变调" fallback message in logs)

## 8. Update Documentation

- [ ] 8.1 Update `README.md` to remove `build_rubberband_windows.cmd` manual build instructions
- [ ] 8.2 Add note in README about Rubber Band source clone requirement alongside WORLD
- [ ] 8.3 Update expected build time in README (mention +2-5 minutes for Rubber Band)
- [ ] 8.4 Update `DEVELOPMENT_zh.md` to reflect Rubber Band static linking approach
- [ ] 8.5 Remove references to `HIFISHIFTER_RUBBERBAND_DLL` environment variable from all documentation
- [ ] 8.6 Update "算法说明" section to mention static linking since v2026.03
- [ ] 8.7 Add build.rs documentation comments for Rubber Band compilation similar to WORLD

## 9. Clean Up Legacy Build Infrastructure

- [ ] 9.1 Mark `tools/build_rubberband_windows.cmd` as deprecated (add deprecation notice comment)
- [ ] 9.2 Mark `tools/verify_rubberband_windows.cmd` as deprecated if it exists
- [ ] 9.3 Update DEVELOPMENT_zh.md to note that old build scripts are no longer needed
- [ ] 9.4 Consider archiving old `third_party/rubberband/source/` directory (optional cleanup for future)
- [ ] 9.5 Verify no CI/CD scripts reference the old build_rubberband_windows.cmd script
