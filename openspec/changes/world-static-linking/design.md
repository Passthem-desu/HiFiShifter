## Context

**Current State:**
HifiShifter's Rust backend uses WORLD vocoder for pitch analysis and manipulation. Currently, WORLD is compiled as a DLL using a separate CMake build process (`tools/build_world_windows.cmd`), then loaded at runtime via `libloading` crate. The DLL is searched for via environment variable (`HIFISHIFTER_WORLD_DLL`), executable directory, or system PATH.

**Constraints:**
- Must maintain existing WORLD API (Dio, Harvest, CheapTrick, D4C, Synthesis functions)
- Must support Windows (MSVC), macOS (Clang), and Linux (GCC) toolchains
- Build time should remain reasonable (< 90 seconds for full release build)
- Cannot break existing pitch analysis functionality or accuracy

**Stakeholders:**
- Developers: Simplified build process, no manual DLL compilation
- End users: Single executable distribution, no missing DLL errors
- CI/CD: Unified build command, easier cross-platform automation

## Goals / Non-Goals

**Goals:**
- Eliminate manual CMake/MSVC build step for WORLD DLL
- Produce self-contained executable with no external DLL dependencies
- Maintain identical WORLD FFI interface and behavior
- Support all three major platforms (Windows/macOS/Linux) with single build configuration
- Keep incremental build times fast (unchanged WORLD sources should not recompile)

**Non-Goals:**
- Modify WORLD algorithm implementations or introduce new WORLD features
- Optimize WORLD performance beyond what static linking naturally provides
- Support dynamic plugin-style WORLD replacement at runtime
- Maintain backward compatibility with DLL-based deployment

## Decisions

### Decision 1: Use cc crate for WORLD compilation
**Chosen:** Integrate WORLD compilation into `build.rs` using `cc::Build`  
**Alternatives considered:**
- Keep CMake and invoke via `std::process::Command` → Rejected: Still requires CMake installation, doesn't simplify toolchain
- Use bindgen + pre-compiled static library → Rejected: Requires platform-specific pre-built libraries, complicates cross-compilation
- Submodule WORLD and use cargo-sys crate pattern → Rejected: Over-engineering for this use case

**Rationale:** cc crate is idiomatic Rust approach, automatically detects correct compiler, handles platform differences, and integrates seamlessly with cargo's incremental build system.

### Decision 2: Clone fresh WORLD sources into build directory
**Chosen:** Clone WORLD into `backend/src-tauri/third_party/world-static/World` (new location)  
**Alternatives considered:**
- Reuse existing `third_party/world/source/World` → Rejected: May contain DLL build artifacts, user requested clean separation
- git submodule at repository level → Rejected: Increases repository setup complexity
- Download WORLD tarball at build time → Rejected: Requires network access during build

**Rationale:** Fresh clone ensures clean state, avoids conflicts with existing DLL infrastructure, and can be .gitignore'd to keep repository clean.

### Decision 3: Remove libloading, use direct extern "C" declarations
**Chosen:** Replace `libloading::Library` with direct FFI bindings  
**Rationale:** Static linking eliminates need for runtime symbol resolution. Direct FFI is faster (no pointer indirection), simpler (no error handling for missing symbols), and more idiomatic for static libraries.

### Decision 4: Use feature flags for migration period
**Chosen:** Default to static linking, remove DLL code path entirely  
**Alternatives considered:**
- Dual-mode with feature flags (world-static/world-dll) → Rejected: User requested complete replacement (方案A), not gradual migration
- Keep DLL fallback for optional runtime override → Rejected: Adds maintenance burden, conflicts with "simplification" goal

**Rationale:** Clean break simplifies code, removes dead code paths, and aligns with user's explicit request for complete replacement.

## Architecture

### Build Process Flow
```
cargo build
    │
    ├─> build.rs executes
    │   ├─> Check WORLD sources at third_party/world-static/World/src/
    │   │   └─> Error if missing: "Clone https://github.com/mmorise/World.git"
    │   │
    │   ├─> cc::Build::new()
    │   │   ├─> .cpp(true)
    │   │   ├─> .std("c++11")
    │   │   ├─> .include("third_party/world-static/World/src")
    │   │   ├─> .file("*/cheaptrick.cpp")
    │   │   ├─> .file("*/dio.cpp")
    │   │   ├─> ... (all 11 WORLD .cpp files)
    │   │   └─> .compile("world")
    │   │       └─> Outputs: libworld.a (Unix) or world.lib (Windows)
    │   │
    │   └─> println!("cargo:rustc-link-lib=static=world")
    │
    └─> rustc links backend with libworld.a
        └─> Output: backend.exe (self-contained)
```

### FFI Layer Refactoring
```rust
// OLD (world_vocoder.rs with libloading):
static API: OnceLock<Result<WorldVocoderApi, String>> = OnceLock::new();
struct WorldVocoderApi {
    _lib: Library,
    dio: DioFn,  // function pointer from dlsym
    harvest: HarvestFn,
    // ...
}

// NEW (world_vocoder.rs with direct FFI):
extern "C" {
    fn Dio(x: *const f64, ...);
    fn Harvest(x: *const f64, ...);
    fn InitializeDioOption(option: *mut DioOption);
    // ... all WORLD functions
}

pub fn harvest_f0(...) -> Result<...> {
    unsafe {
        let mut option = std::mem::zeroed();
        InitializeHarvestOption(&mut option);
        Harvest(x.as_ptr(), ...);
    }
    // ... rest unchanged
}
```

### Module Changes
```
backend/src-tauri/
├── Cargo.toml
│   ├── [dependencies]
│   │   └── - libloading = "0.8"  (REMOVED)
│   └── [build-dependencies]
│       └── + cc = "1.0"           (ADDED)
│
├── build.rs
│   └── + fn build_world_static() { cc::Build... }  (NEW)
│
├── src/
│   └── world_vocoder.rs
│       ├── - use libloading::Library;
│       ├── - struct WorldVocoderApi { ... }
│       ├── - fn try_load_library() { ... }
│       └── + extern "C" { fn Dio(...); ... }
│
└── third_party/
    └── world-static/          (NEW DIRECTORY)
        └── World/             (git clone target, .gitignore'd)
            └── src/
                ├── dio.cpp
                ├── harvest.cpp
                └── ... (11 files)
```

## Risks / Trade-offs

**[Risk]** Build time increases by 30-60 seconds on first build  
→ **Mitigation:** Incremental builds unaffected (~5s). CI caching of target/ directory amortizes cost. Trade-off accepted for simplified developer experience.

**[Risk]** WORLD compilation errors on exotic platforms/toolchains  
→ **Mitigation:** cc crate has wide platform support. Test on Windows (MSVC), macOS (Clang), Linux (GCC) before merging. WORLD is pure C++11 with no platform-specific code.

**[Risk]** Increased binary size (~200-500 KB)  
→ **Mitigation:** Acceptable for desktop application context. Static linking enables better optimization (LTO) which may offset size increase.

**[Risk]** Loss of runtime WORLD replacement capability  
→ **Mitigation:** Acknowledged trade-off. Users cannot override WORLD with custom DLL. Accepted per user's explicit choice of 方案A (complete replacement).

**[Risk]** WORLD sources not present in third_party/world-static/  
→ **Mitigation:** build.rs will emit clear error with clone instructions. Document in README.md setup section.

**[Risk]** C++ compiler not available in build environment  
→ **Mitigation:** cc crate provides clear errors. Document compiler requirements (MSVC on Windows, Xcode tools on macOS, build-essential on Linux).

## Migration Plan

### Pre-merge Steps
1. Clone WORLD sources: `git clone https://github.com/mmorise/World.git backend/src-tauri/third_party/world-static/World`
2. Add `third_party/world-static/` to `.gitignore`
3. Test build on all three platforms (Windows/macOS/Linux)
4. Verify pitch analysis produces identical F0 curves as DLL version (regression test)

### Deployment Steps
1. Merge changes to main branch
2. Update README.md: Remove `build_world_windows.cmd` instructions, add cc build note
3. Update DEVELOPMENT.md: Document WORLD source clone requirement
4. CI/CD: Ensure WORLD sources are cloned in build pipeline

### Rollback Strategy
If critical issues discovered post-merge:
1. Revert commits: `git revert <commit-range>`
2. Or branch protection: Keep DLL build script in `tools/` as reference
3. Timeframe: 48 hours for validation, then DLL infrastructure can be removed

### Validation Criteria
- ✅ `cargo build` succeeds on Windows (MSVC)
- ✅ `cargo build` succeeds on macOS (Clang)
- ✅ `cargo build` succeeds on Linux (GCC)
- ✅ Pitch analysis produces byte-identical F0 output vs DLL version
- ✅ Build time under 90 seconds (release build)
- ✅ Executable runs without world.dll in PATH

## Open Questions

1. **WORLD source clone automation:** Should we add a setup script to automate WORLD clone? Or rely on manual step in documentation?  
   → *Recommendation:* Manual for now (keeps build.rs simple), consider automation if developers report friction.

2. **Compiler version pinning:** Should we specify minimum C++ compiler versions?  
   → *Recommendation:* Document tested versions (MSVC 2019+, Clang 10+, GCC 9+), but don't enforce. cc crate will error on C++11 support absence.

3. **LTO (Link-Time Optimization):** Should we enable LTO between Rust and C++?  
   → *Recommendation:* Leave disabled initially (complicates build), measure if performance is insufficient.

4. **Pre-built binaries for releases:** Should CI produce binaries with WORLD pre-linked for end-users?  
   → *Out of scope:* This is distribution question, not build system change. Defer to separate release engineering work.
