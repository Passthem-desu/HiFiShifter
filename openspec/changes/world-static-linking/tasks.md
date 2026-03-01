## 1. Prepare WORLD Source

- [ ] 1.1 Create directory `backend/src-tauri/third_party/world-static/`
- [ ] 1.2 Clone WORLD repository: `git clone https://github.com/mmorise/World.git backend/src-tauri/third_party/world-static/World`
- [ ] 1.3 Verify all 11 WORLD C++ source files exist in `World/src/` directory (cheaptrick.cpp, dio.cpp, harvest.cpp, etc.)
- [ ] 1.4 Add `backend/src-tauri/third_party/world-static/` to `.gitignore`

## 2. Update Build Configuration

- [ ] 2.1 Add `cc = "1.0"` to `[build-dependencies]` in `backend/src-tauri/Cargo.toml`
- [ ] 2.2 Remove `libloading = "0.8"` from `[dependencies]` in `backend/src-tauri/Cargo.toml`
- [ ] 2.3 Create `backend/src-tauri/build.rs` file with Tauri build call
- [ ] 2.4 Implement `build_world_static()` function in `build.rs` using `cc::Build`
- [ ] 2.5 Configure cc::Build with `.cpp(true)`, `.std("c++11")`, and include path
- [ ] 2.6 Add all 11 WORLD .cpp files using `.file()` calls in build.rs
- [ ] 2.7 Call `.compile("world")` and emit `cargo:rustc-link-lib=static=world`
- [ ] 2.8 Add error handling for missing WORLD sources with clear message

## 3. Refactor world_vocoder.rs FFI Layer

- [ ] 3.1 Remove `use libloading::Library;` import
- [ ] 3.2 Remove `struct WorldVocoderApi` and all function pointer type definitions
- [ ] 3.3 Remove `try_load_library()` function
- [ ] 3.4 Remove `api()` function that returns `&'static WorldVocoderApi`
- [ ] 3.5 Add `extern "C"` block with direct FFI declarations for all WORLD functions
- [ ] 3.6 Declare `Dio`, `InitializeDioOption`, `GetSamplesForDIO`, `StoneMask` in extern block
- [ ] 3.7 Declare `Harvest`, `InitializeHarvestOption`, `GetSamplesForHarvest` in extern block
- [ ] 3.8 Declare `InitializeCheapTrickOption`, `GetFFTSizeForCheapTrick`, `CheapTrick` in extern block
- [ ] 3.9 Declare `InitializeD4COption`, `D4C`, `Synthesis` in extern block
- [ ] 3.10 Update `is_available()` function to always return Ok(true) (no runtime loading check needed)

## 4. Update Public API Functions

- [ ] 4.1 Refactor `compute_f0_with_positions_dio_stonemask()` to call FFI directly without api() wrapper
- [ ] 4.2 Refactor `compute_f0_with_positions_harvest()` to call FFI directly
- [ ] 4.3 Refactor `pitch_shift()` to call FFI directly for CheapTrick, D4C, and Synthesis
- [ ] 4.4 Remove all `.map_err(|e| api_error_message())?` calls for unavailable API
- [ ] 4.5 Verify all unsafe FFI calls maintain proper pointer validity and lifetimes
- [ ] 4.6 Ensure struct layouts (DioOption, HarvestOption, etc.) remain unchanged

## 5. Remove Dead Code

- [ ] 5.1 Remove `world_lock.rs` module (no longer needed for DLL thread safety)
- [ ] 5.2 Remove references to `world_lock::world_dll_mutex()` from other modules
- [ ] 5.3 Remove environment variable logic for `HIFISHIFTER_WORLD_DLL` from world_vocoder.rs
- [ ] 5.4 Update `state.rs` to remove WORLD DLL availability checks if any

## 6. Test Build on All Platforms

- [ ] 6.1 Test `cargo build` on Windows with MSVC toolchain
- [ ] 6.2 Test `cargo build` on macOS with Clang (if available)
- [ ] 6.3 Test `cargo build` on Linux with GCC (if available)
- [ ] 6.4 Verify build completes within 90 seconds for release build
- [ ] 6.5 Verify incremental rebuild time is under 10 seconds with unchanged WORLD sources
- [ ] 6.6 Check that executable runs without world.dll in PATH or executable directory

## 7. Validate Functionality

- [ ] 7.1 Run application and load an audio file
- [ ] 7.2 Trigger pitch analysis (Harvest algorithm) and verify F0 output is generated
- [ ] 7.3 Trigger pitch analysis (Dio algorithm) and verify F0 output is generated
- [ ] 7.4 Perform pitch shift operation and verify audio output is correct
- [ ] 7.5 Compare F0 curve values against DLL version (should be identical)
- [ ] 7.6 Test playback with pitch-edited audio using WORLD vocoder

## 8. Update Documentation

- [ ] 8.1 Update `README.md` to remove `build_world_windows.cmd` manual build instructions
- [ ] 8.2 Add note in README about WORLD source clone requirement
- [ ] 8.3 Update `DEVELOPMENT.md` with new build process (single cargo build step)
- [ ] 8.4 Document WORLD source clone location in development setup section
- [ ] 8.5 Update compiler requirements section (MSVC 2019+, Clang 10+, GCC 9+)
- [ ] 8.6 Remove references to `HIFISHIFTER_WORLD_DLL` environment variable from docs

## 9. Clean Up Legacy Build Infrastructure

- [ ] 9.1 Mark `tools/build_world_windows.cmd` as deprecated (add comment)
- [ ] 9.2 Mark `backend/src-tauri/third_party/world/build_world_dll/CMakeLists.txt` as deprecated
- [ ] 9.3 Update `tools/verify_world_windows.cmd` if it references DLL
- [ ] 9.4 Consider moving old DLL build files to archive folder (optional)
