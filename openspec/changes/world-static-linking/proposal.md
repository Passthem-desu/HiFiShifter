## Why

The current WORLD vocoder integration requires manual DLL compilation via CMake and MSVC toolchain before running the main Rust build. This creates friction in development, complicates CI/CD, increases distribution complexity (need to bundle world.dll), and introduces runtime dependency risks (missing DLL at launch). Migrating to cc crate static linking will unify the build process into a single `cargo build` command, eliminate external DLL dependencies, and simplify cross-platform support.

## What Changes

- Replace `libloading` dynamic library loading with direct FFI bindings to statically-linked WORLD
- Add `cc` crate build script (`build.rs`) to compile WORLD C++ sources at build time
- Refactor `world_vocoder.rs` to use direct `extern "C"` declarations instead of runtime symbol resolution
- Remove dependency on manual `tools/build_world_windows.cmd` script and CMake infrastructure
- Clone fresh WORLD source repository into build directory (not reusing existing third_party)
- Update Cargo.toml to add `cc` as build dependency and remove `libloading` dependency
- Maintain identical public API surface (no breaking changes to callers of world_vocoder module)

## Capabilities

### New Capabilities
- `world-static-build`: Build system integration for compiling WORLD C++ library statically via cc crate during cargo build

### Modified Capabilities
<!-- No existing capability requirements are changing - this is purely an implementation detail change. The world_vocoder public API remains unchanged. -->

## Impact

**Files Modified:**
- `backend/src-tauri/Cargo.toml` - Add cc build dependency, remove libloading
- `backend/src-tauri/build.rs` - Add WORLD compilation logic
- `backend/src-tauri/src/world_vocoder.rs` - Replace libloading with direct FFI

**Files Removed (from critical path):**
- `tools/build_world_windows.cmd` - No longer required for builds (can be retained as reference)
- `backend/src-tauri/third_party/world/build_world_dll/CMakeLists.txt` - No longer used

**Build Process:**
- First-time build time increases by ~30-60 seconds (one-time WORLD compilation)  
- Incremental builds unaffected (~5 seconds if WORLD sources unchanged)
- Removes requirement for CMake, MSVC vcvars64, and manual DLL build step

**Runtime:**
- Eliminates world.dll runtime dependency
- Reduces distribution package complexity (single executable)
- Removes HIFISHIFTER_WORLD_DLL environment variable lookup logic

**Cross-platform:**
- Simplifies macOS/Linux builds (cc crate handles toolchain differences)
- Reduces platform-specific build documentation
