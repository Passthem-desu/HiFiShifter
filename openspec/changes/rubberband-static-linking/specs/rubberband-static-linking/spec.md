## ADDED Requirements

### Requirement: Build system SHALL compile Rubber Band statically
The build system SHALL compile Rubber Band C++ source files at build time using the `cc` crate and link them statically into the Rust binary, eliminating the need for separate DLL builds.

#### Scenario: First build compiles Rubber Band sources
- **WHEN** developer runs `cargo build` for the first time
- **THEN** the build script SHALL detect Rubber Band sources in `backend/src-tauri/third_party/rubberband-static/`
- **AND** compile all required C++ source files with appropriate compiler flags
- **AND** link the compiled objects as a static library
- **AND** complete the build successfully with Rubber Band functionality available

#### Scenario: Missing Rubber Band sources fail build with clear message
- **WHEN** developer runs `cargo build` without Rubber Band sources present
- **THEN** the build script SHALL fail with an error message
- **AND** the error message SHALL indicate the missing source directory
- **AND** the error message SHALL provide instructions to clone the Rubber Band repository

### Requirement: FFI layer SHALL use static extern declarations
The Rubber Band FFI layer SHALL declare C API functions using Rust `extern "C"` blocks instead of dynamic symbol loading via `libloading`, enabling direct static linking.

#### Scenario: FFI functions are called directly
- **WHEN** application code calls Rubber Band FFI functions (e.g., rubberband_new, rubberband_process)
- **THEN** the calls SHALL resolve to statically linked symbols
- **AND** no dynamic library loading SHALL occur at runtime
- **AND** no DLL search paths SHALL be consultedrequirements

#### Scenario: API availability check always succeeds
- **WHEN** application code checks if Rubber Band API is available
- **THEN** the check SHALL return true unconditionally (since static linking guarantees availability)

### Requirement: Legacy DLL infrastructure SHALL be removed or deprecated
The codebase SHALL remove or clearly mark as deprecated all DLL-related build scripts, dynamic loading code, and environment variable checks for Rubber Band.

#### Scenario: Build scripts are marked deprecated
- **WHEN** developer examines `tools/build_rubberband_windows.cmd` or `tools/verify_rubberband_windows.cmd`
- **THEN** the script SHALL contain a deprecation notice at the top
- **AND** the notice SHALL explain that Rubber Band is now statically linked
- **AND** the notice SHALL reference the cc crate build approach

#### Scenario: Dynamic loading code is removed from rubberband.rs
- **WHEN** developer inspects `backend/src-tauri/src/rubberband.rs`
- **THEN** the file SHALL NOT contain `libloading` imports or usage
- **AND** the file SHALL NOT contain DLL search path logic
- **AND** the file SHALL NOT contain environment variable checks for `HIFISHIFTER_RUBBERBAND_DLL`

#### Scenario: libloading dependency is removed
- **WHEN** developer inspects `backend/src-tauri/Cargo.toml`
- **THEN** `libloading` SHALL NOT be listed in dependencies
- **AND** no other code SHALL depend on `libloading`

### Requirement: Documentation SHALL reflect static linking approach
User and developer documentation SHALL be updated to remove DLL build instructions and explain the automatic static compilation process.

#### Scenario: User documentation mentions automatic compilation
- **WHEN** user reads the README.md setup instructions
- **THEN** the documentation SHALL NOT contain manual DLL build steps
- **AND** the documentation SHALL mention that Rubber Band is automatically compiled during first build
- **AND** the documentation SHALL indicate the approximate first-build time increase

#### Scenario: Developer documentation explains static linking
- **WHEN** developer reads DEVELOPMENT_zh.md audio processing section
- **THEN** the documentation SHALL explain that Rubber Band is statically linked via cc crate
- **AND** the documentation SHALL NOT reference DLL dynamic loading
- **AND** the documentation SHALL mark the old DLL approach as deprecated

### Requirement: Binary distribution SHALL contain no external DLL dependencies
The final release binary SHALL operate without requiring separate Rubber Band DLL files in the filesystem, as all Rubber Band code is embedded in the executable.

#### Scenario: Release binary runs without external DLLs
- **WHEN** user runs the release binary on a clean system
- **THEN** the application SHALL execute Rubber Band time-stretching operations successfully
- **AND** no DLL loading errors SHALL occur
- **AND** no environment variable configuration SHALL be required
