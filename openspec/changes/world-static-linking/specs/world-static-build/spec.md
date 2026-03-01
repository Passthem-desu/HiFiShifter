## ADDED Requirements

### Requirement: WORLD C++ source compilation via cc crate
The build system SHALL compile all WORLD C++ source files statically during `cargo build` using the `cc` crate without requiring manual pre-build steps or CMake.

#### Scenario: First-time cargo build
- **WHEN** developer runs `cargo build` on a clean checkout
- **THEN** build.rs automatically compiles all WORLD C++ sources and links them statically into the binary

#### Scenario: Incremental build with unchanged WORLD sources
- **WHEN** developer modifies Rust code but not WORLD sources
- **THEN** cargo reuses the previously compiled WORLD object files without recompilation

#### Scenario: Cross-platform build
- **WHEN** developer builds on Windows, macOS, or Linux
- **THEN** cc crate automatically detects and uses the appropriate C++ compiler toolchain

### Requirement: Fresh WORLD source checkout
The build system SHALL clone or use a fresh copy of WORLD sources independent of any existing third_party directory to ensure clean build state.

#### Scenario: Build with existing third_party/world directory
- **WHEN** existing third_party/world directory contains DLL build artifacts
- **THEN** build.rs SHALL NOT use or be affected by existing DLL build files

#### Scenario: WORLD source availability
- **WHEN** WORLD source repository is not present in build directory
- **THEN** build.rs SHALL provide clear error message indicating where to place sources

### Requirement: Compiler compatibility
The build SHALL support MSVC, Clang, and GCC C++ compilers with C++11 standard.

#### Scenario: MSVC toolchain on Windows
- **WHEN** building on Windows with Visual Studio installed
- **THEN** cc crate detects and uses MSVC compiler with /std:c++11 flag

#### Scenario: GCC toolchain on Linux
- **WHEN** building on Linux with GCC installed
- **THEN** cc crate uses g++ with -std=c++11 flag

#### Scenario: Clang toolchain on macOS
- **WHEN** building on macOS with Xcode command-line tools
- **THEN** cc crate uses clang++ with -std=c++11 flag

### Requirement: Static linking output
The build SHALL produce a single self-contained binary with WORLD code statically linked, eliminating all runtime DLL dependencies.

#### Scenario: Binary execution without DLL
- **WHEN** user runs the compiled backend executable
- **THEN** all WORLD functionality works without requiring world.dll in PATH or executable directory

#### Scenario: Distribution packaging
- **WHEN** packaging the application for distribution
- **THEN** only the main executable needs to be included (no world.dll required)

### Requirement: Build time characteristics
The initial build with WORLD compilation SHALL complete within 90 seconds on a standard development machine.

#### Scenario: Cold build timing
- **WHEN** running cargo build --release on a clean checkout with 4-core CPU
- **THEN** total build time including WORLD compilation SHALL be under 90 seconds

#### Scenario: Incremental build timing
- **WHEN** WORLD sources are unchanged and only Rust code is modified
- **THEN** rebuild time SHALL be under 10 seconds

### Requirement: FFI interface compatibility
The statically linked WORLD SHALL expose the same C FFI interface as the DLL version, maintaining binary compatibility.

#### Scenario: Function signature compatibility
- **WHEN** Rust code calls WORLD functions via extern "C" declarations
- **THEN** all function signatures, calling conventions, and data layouts SHALL match DLL version

#### Scenario: Struct layout compatibility
- **WHEN** passing DioOption, HarvestOption, CheapTrickOption, or D4COption structs across FFI boundary
- **THEN** struct memory layout SHALL be identical to DLL version (same padding, alignment, field order)
