## Context

**Current State:**
HifiShifter's Rust backend uses Rubber Band Library for high-quality pitch-preserving time stretching. Currently, Rubber Band is compiled as a DLL using a separate CMake build process (`tools/build_rubberband_windows.cmd`), then loaded at runtime via `libloading` crate. The DLL is searched for via environment variable (`HIFISHIFTER_RUBBERBAND_DLL`), executable directory, or system PATH. If the DLL is not found, the application falls back to degraded audio quality (pitch shifting instead of time stretching).

**Constraints:**
- Must maintain existing Rubber Band C API (rubberband-c.h interface)
- Must support Windows (MSVC), macOS (Clang), and Linux (GCC) toolchains
- Rubber Band is licensed under GPL, which necessitates GPL for the final binary
- Build time increase is acceptable (Rubber Band is larger than WORLD, expect +2-5 minutes initial build)
- Cannot break existing time-stretching functionality, audio quality, or offline rendering

**Stakeholders:**
- Developers: Simplified build process, no manual DLL compilation, consistent with WORLD migration
- End users: Single executable distribution, no missing DLL errors, no degraded audio fallback
- CI/CD: Unified build command, easier cross-platform automation

**Related Work:**
- WORLD vocoder was migrated to static linking in the same manner (world-static-linking change)
- After this migration, `libloading` dependency can be completely removed from the project

## Goals / Non-Goals

**Goals:**
- Eliminate manual CMake/MSVC build step for Rubber Band DLL
- Produce self-contained executable with no external DLL dependencies for Rubber Band
- Maintain identical Rubber Band C API interface and audio processing behavior
- Support all three major platforms (Windows/macOS/Linux) with single build configuration
- Remove `libloading` dependency entirely (no other components need dynamic loading after this change)
- Keep incremental build times reasonable (unchanged Rubber Band sources should not recompile)

**Non-Goals:**
- Modify Rubber Band algorithm implementations or introduce new Rubber Band features
- Optimize Rubber Band performance beyond what static linking naturally provides
- Support dynamic plugin-style Rubber Band replacement at runtime
- Maintain backward compatibility with DLL-based deployment
- Add Rubber Band R3 features or update to newer versions (maintain current stable version)

## Decisions

### Decision 1: Use cc crate for Rubber Band compilation
**Chosen:** Integrate Rubber Band compilation into `build.rs` using `cc::Build`, paralleling WORLD's approach

**Alternatives considered:**
- Keep CMake and invoke via `std::process::Command` → Rejected: Still requires CMake installation, doesn't simplify toolchain
- Use bindgen + pre-compiled static library → Rejected: Requires platform-specific pre-built libraries, complicates cross-compilation
- Integrate Rubber Band as Cargo workspace member with cc build → Rejected: Over-engineering for third-party C++ library

**Rationale:** cc crate is proven to work well with WORLD (similar C++11 codebase), automatically detects correct compiler, handles platform differences including MSVC/Clang/GCC, and integrates seamlessly with cargo's incremental build system.

### Decision 2: Clone fresh Rubber Band sources into dedicated directory
**Chosen:** Clone Rubber Band into `backend/src-tauri/third_party/rubberband-static/` (new location, separate from existing `rubberband/source/`)

**Alternatives considered:**
- Reuse existing `third_party/rubberband/source/rubberband-4.0.0/` → Rejected: Contains CMake build artifacts and DLL-specific configuration, user requested clean separation
- git submodule at repository level → Rejected: Increases repository setup complexity
- Download Rubber Band tarball at build time → Rejected: Requires network access during build, version pinning complexity

**Rationale:** Fresh clone ensures clean state, avoids conflicts with existing DLL infrastructure, mirrors WORLD's approach (consistent pattern), and can be .gitignore'd to keep repository clean.

### Decision 3: Remove libloading entirely, use direct extern "C" declarations
**Chosen:** Replace `libloading::Library` with direct FFI bindings in rubberband.rs AND remove libloading from Cargo.toml

**Alternatives considered:**
- Keep libloading for future extensibility → Rejected: No other components need dynamic loading after Rubber Band migration
- Use feature flag to toggle static vs dynamic → Rejected: Adds complexity, user requested complete replacement

**Rationale:** Static linking eliminates need for runtime symbol resolution. Direct FFI is faster (no pointer indirection), simpler (no error handling for missing symbols), more idiomatic for static libraries, and aligns with WORLD's FFI pattern. Since WORLD was already migrated and Rubber Band is the last DLL dependency, libloading can be completely removed.

### Decision 4: Update is_available() to always return true
**Chosen:** Simplify `is_available()` to unconditionally return `true` since static linking guarantees availability

**Rationale:** With static linking, Rubber Band functions are always present at link time. Runtime availability checks are unnecessary and would only add confusion. This matches WORLD's post-migration behavior.

### Decision 5: Compile Rubber Band C API subset only
**Chosen:** Compile only the source files required for the C API (`rubberband-c.cpp` and dependencies)

**Alternatives considered:**
- Compile entire Rubber Band C++ library including command-line tools → Rejected: Increases build time and binary size unnecessarily
- Create minimal C API wrapper → Rejected: Requires maintaining fork of Rubber Band

**Rationale:** The application only uses the C API (not the C++ class interface). Compiling only necessary sources reduces build time and binary size while maintaining full functionality.

## Architecture

### Build Process Flow
```
cargo build
    │
    ├─> build.rs executes
    │   ├─> Check WORLD sources (existing)
    │   │   └─> Compile WORLD statically
    │   │
    │   ├─> Check Rubber Band sources at third_party/rubberband-static/
    │   │   └─> Error if missing: "Clone Rubber Band repository"
    │   │
    │   ├─> cc::Build::new() for Rubber Band
    │   │   ├─> .cpp(true)
    │   │   ├─> .std("c++11")
    │   │   ├─> .include("third_party/rubberband-static/rubberband/")
    │   │   ├─> .file("*/src/*/*.cpp") (core Rubber Band sources)
    │   │   ├─> .file("*/rubberband-c.cpp") (C API wrapper)
    │   │   ├─> Platform-specific flags:
    │   │   │   - Windows MSVC: /EHsc, /std:c++11
    │   │   │   - macOS/Linux: -std=c++11, -fPIC
    │   │   └─> .compile("rubberband")
    │   │
    │   └─> println!("cargo:rustc-link-lib=static=rubberband")
    │
    └─> rustc links backend binary
        └─> Links libworld.a + librubberband.a + Rust code → backend.exe
```

### FFI Layer Changes
**Before (rubberband.rs):**
```rust
use libloading::Library;

fn try_load_library() -> Result<Library, String> { ... }
fn api() -> Result<&'static RubberBandApi, String> {
    static API: OnceLock<...> = OnceLock::new();
    API.get_or_init(|| {
        let lib = try_load_library()?;
        let rubberband_new = *lib.get(b"rubberband_new\0")?;
        // ... load all symbols
    })
}
pub fn is_available() -> bool { api().is_ok() }
```

**After (rubberband.rs):**
```rust
extern "C" {
    fn rubberband_new(
        sample_rate: u32,
        channels: u32,
        options: i32,
        initial_time_ratio: f64,
        initial_pitch_scale: f64,
    ) -> *mut RubberBandStateOpaque;
    fn rubberband_delete(state: *mut RubberBandStateOpaque);
    fn rubberband_reset(state: *mut RubberBandStateOpaque);
    // ... all other C API functions
}

pub fn is_available() -> bool { true }
```

### Source File Structure
```
backend/src-tauri/third_party/
├── world-static/          (existing, WORLD sources)
│   └── World/
│       └── src/*.cpp
└── rubberband-static/     (new for this change)
    └── rubberband/        (cloned from breakfastquay/rubberband repo)
        ├── rubberband/    (public headers)
        │   └── rubberband-c.h
        ├── src/           (implementation)
        │   ├── rubberband-c.cpp
        │   ├── common/*.cpp
        │   ├── dsp/*.cpp
        │   └── ...
        └── README.md
```

## Risks / Trade-offs

### Risk: Rubber Band compilation time significantly longer than WORLD
**Impact:** Initial `cargo build` time increases by 2-5 minutes (Rubber Band has ~50+ source files vs WORLD's 11)  
**Mitigation:** 
- Document expected build time in README and build.rs comments
- Incremental builds remain fast (cc crate caches unchanged sources)
- Consider enabling parallel compilation with `.flag_if_supported("-j")` if available

### Risk: Rubber Band C++ dependencies may require additional system libraries
**Impact:** Build may fail on some platforms if Rubber Band dependencies (e.g., FFTW, vDSP, or built-in FFT) are not properly configured  
**Mitigation:**
- Use Rubber Band's built-in FFT implementation (no external dependencies)
- Add platform-specific detection in build.rs to link system libraries if needed (e.g., `-framework Accelerate` on macOS)
- Provide clear error messages if required libraries are missing

### Risk: GPL license implications for static linking
**Impact:** Statically linking Rubber Band (GPL) makes the entire HifiShifter binary GPL-licensed  
**Mitigation:**
- This is already accepted (Rubber Band is core functionality, not optional)
- Clearly document GPL licensing in README and LICENSE files
- No mitigation needed beyond proper licensing attribution

### Trade-off: Binary size increase
**Impact:** Release binary size increases by ~1-2 MB (statically linked Rubber Band code)  
**Acceptance rationale:** Acceptable cost for simplified distribution and improved reliability

### Risk: Rubber Band version lock-in
**Impact:** Updating Rubber Band requires re-cloning sources and potentially adjusting build.rs  
**Mitigation:**
- Pin to stable Rubber Band version (current: 3.x/4.x)
- Document update process in DEVELOPMENT.md
- Use git tags or release archives for reproducible builds

## Migration Plan

### Phase 1: Build System Setup (< 1 hour)
1. Clone Rubber Band sources to `backend/src-tauri/third_party/rubberband-static/`
2. Update `.gitignore` to exclude Rubber Band source directory
3. Modify `build.rs` to add Rubber Band compilation step
4. Test Windows/macOS/Linux builds complete successfully

### Phase 2: FFI Refactoring (< 2 hours)
1. Remove `libloading` imports from `rubberband.rs`
2. Replace type aliases with `extern "C"` block declarations
3. Remove `try_load_library()`, `api()`, and `RubberBandApi` struct
4. Simplify `is_available()` to return `true`
5. Update all function calls from `(api.rubberband_new)(...)` to `rubberband_new(...)`
6. Remove environment variable checks and DLL search logic

### Phase 3: Cleanup (< 30 minutes)
1. Remove `libloading` from `Cargo.toml` dependencies
2. Mark `tools/build_rubberband_windows.cmd` as deprecated
3. Mark `tools/verify_rubberband_windows.cmd` as deprecated
4. Update `README.md` to remove DLL build instructions
5. Update `DEVELOPMENT_zh.md` to reflect static linking approach

### Phase 4: Verification (< 1 hour)
1. Run `cargo build --release` and verify no DLL references remain
2. Test time-stretching functionality in realtime and offline modes
3. Verify audio output quality matches previous DLL-based implementation
4. Test on Windows/macOS/Linux if possible

### Rollback Strategy
If static linking causes critical issues:
1. Revert `rubberband.rs` changes (restore libloading code from git history)
2. Re-add `libloading` to `Cargo.toml`
3. Revert `build.rs` Rubber Band compilation block
4. Fallback to manual DLL build process

**Rollback complexity:** Low (all changes are isolated to 3 files: build.rs, rubberband.rs, Cargo.toml)

## Open Questions

- **Q:** Should we compile Rubber Band with FFTW for better performance, or use built-in FFT?  
  **A:** Start with built-in FFT (simpler, no external dependencies). Can reevaluate if performance issues arise.

- **Q:** Should we maintain the old `rubberband/source/rubberband-4.0.0/` directory?  
  **A:** Yes initially, mark as deprecated. Can be deleted in a follow-up cleanup after confirming static linking is stable.

- **Q:** Do we need feature flags to toggle Rubber Band on/off (e.g., for non-GPL builds)?  
  **A:** No for this change. If needed, can be added in a future change as a separate optimization.
