fn main() {
    tauri_build::build();
    build_world_static();
    build_rubberband_static();
}

/// Build WORLD vocoder as a static library using cc crate.
///
/// Since v2026.03, WORLD is statically linked at compile time instead of
/// dynamically loaded via DLL. This approach provides:
/// - Single self-contained binary (no external DLL dependencies)
/// - Improved reliability (no runtime loading failures)
/// - Simplified cross-platform builds
/// - Faster startup (no DLL search overhead)
///
/// Source location: third_party/world-static/World/
/// Build time: ~60-90s on first build, ~5-10s incremental
///
/// The WORLD library (https://github.com/mmorise/World) provides:
/// - Dio/Harvest: F0 (pitch) analysis algorithms
/// - CheapTrick: Spectral envelope estimation
/// - D4C: Aperiodicity estimation
/// - Synthesis: High-quality vocoder reconstruction
fn build_world_static() {
    use std::path::Path;

    let world_src_dir = "third_party/world-static/World/src";
    let world_src_path = Path::new(world_src_dir);

    // Check if WORLD sources exist
    if !world_src_path.exists() {
        eprintln!("\n========================================");
        eprintln!("ERROR: WORLD source code not found!");
        eprintln!("========================================");
        eprintln!("\nExpected location: {}", world_src_path.display());
        eprintln!("\nTo fix this, run:");
        eprintln!("  cd backend/src-tauri/third_party/world-static");
        eprintln!("  git clone https://github.com/mmorise/World.git");
        eprintln!("\nOr from project root:");
        eprintln!("  git clone https://github.com/mmorise/World.git backend/src-tauri/third_party/world-static/World");
        eprintln!("========================================\n");
        panic!("WORLD sources missing. See error message above for instructions.");
    }

    // Verify all required source files exist
    let required_files = [
        "cheaptrick.cpp",
        "codec.cpp",
        "common.cpp",
        "d4c.cpp",
        "dio.cpp",
        "fft.cpp",
        "harvest.cpp",
        "matlabfunctions.cpp",
        "stonemask.cpp",
        "synthesis.cpp",
        "synthesisrealtime.cpp",
    ];

    for file in &required_files {
        let file_path = world_src_path.join(file);
        if !file_path.exists() {
            panic!("Required WORLD source file not found: {}", file_path.display());
        }
    }

    println!("cargo:rerun-if-changed={}", world_src_dir);

    // Compile WORLD as static library
    cc::Build::new()
        .cpp(true)
        .std("c++11")
        .include(world_src_dir)
        .file(format!("{}/cheaptrick.cpp", world_src_dir))
        .file(format!("{}/codec.cpp", world_src_dir))
        .file(format!("{}/common.cpp", world_src_dir))
        .file(format!("{}/d4c.cpp", world_src_dir))
        .file(format!("{}/dio.cpp", world_src_dir))
        .file(format!("{}/fft.cpp", world_src_dir))
        .file(format!("{}/harvest.cpp", world_src_dir))
        .file(format!("{}/matlabfunctions.cpp", world_src_dir))
        .file(format!("{}/stonemask.cpp", world_src_dir))
        .file(format!("{}/synthesis.cpp", world_src_dir))
        .file(format!("{}/synthesisrealtime.cpp", world_src_dir))
        .compile("world");

    println!("cargo:rustc-link-lib=static=world");
}

/// Build Rubber Band Library as a static library using cc crate.
///
/// Since v2026.03, Rubber Band is statically linked at compile time instead of
/// dynamically loaded via DLL. This approach provides:
/// - Single self-contained binary (no external DLL dependencies)
/// - Improved reliability (no runtime loading failures)
/// - Simplified cross-platform builds
/// - Consistent with WORLD vocoder static linking approach
///
/// Source location: third_party/rubberband-static/rubberband/
/// Build time: ~2-5 minutes on first build (larger than WORLD), ~10-20s incremental
///
/// The Rubber Band Library (https://github.com/breakfastquay/rubberband) provides:
/// - High-quality pitch-preserving time stretching
/// - Real-time and offline processing modes
/// - Dual-engine architecture (R2 "faster" + R3 "finer")
/// - Formant preservation and transient detection
///
/// Note: Rubber Band is GPL-licensed, which affects the licensing of the final binary.
fn build_rubberband_static() {
    use std::path::Path;

    let rb_src_dir = "third_party/rubberband-static/rubberband/src";
    let rb_include_dir = "third_party/rubberband-static/rubberband";
    let rb_src_path = Path::new(rb_src_dir);

    // Check if Rubber Band sources exist
    if !rb_src_path.exists() {
        eprintln!("\n========================================");
        eprintln!("ERROR: Rubber Band source code not found!");
        eprintln!("========================================");
        eprintln!("\nExpected location: {}", rb_src_path.display());
        eprintln!("\nTo fix this, run:");
        eprintln!("  cd backend/src-tauri/third_party/rubberband-static");
        eprintln!("  git clone --depth 1 --branch v3.3.0 https://github.com/breakfastquay/rubberband.git rubberband");
        eprintln!("\nOr from project root:");
        eprintln!("  git clone --depth 1 --branch v3.3.0 https://github.com/breakfastquay/rubberband.git backend/src-tauri/third_party/rubberband-static/rubberband");
        eprintln!("========================================\n");
        panic!("Rubber Band sources missing. See error message above for instructions.");
    }

    // Verify critical files exist
    let critical_files = [
        "rubberband-c.cpp",
        "RubberBandStretcher.cpp",
        "common/Allocators.cpp",
        "faster/R2Stretcher.cpp",
        "finer/R3Stretcher.cpp",
    ];

    for file in &critical_files {
        let file_path = rb_src_path.join(file);
        if !file_path.exists() {
            panic!("Required Rubber Band source file not found: {}", file_path.display());
        }
    }

    // Patch VectorOpsComplex.cpp to fix incorrect include path
    // v3.3.0 has '#include "system/sysutils.h"' but no system/ directory exists
    // We need to change it to '#include "sysutils.h"' (file is in same directory)
    let vector_ops_path = rb_src_path.join("common/VectorOpsComplex.cpp");
    if vector_ops_path.exists() {
        let content = std::fs::read_to_string(&vector_ops_path)
            .expect("Failed to read VectorOpsComplex.cpp");
        
        if content.contains("#include \"system/sysutils.h\"") {
            let patched = content.replace(
                "#include \"system/sysutils.h\"",
                "#include \"sysutils.h\""
            );
            std::fs::write(&vector_ops_path, patched)
                .expect("Failed to patch VectorOpsComplex.cpp");
            println!("cargo:warning=Patched VectorOpsComplex.cpp to fix include path");
        }
    }

    println!("cargo:rerun-if-changed={}", rb_src_dir);

    // Compile Rubber Band as static library
    let mut build = cc::Build::new();
    build
        .cpp(true)
        .include(rb_include_dir)
        .include(rb_src_dir)
        .include(format!("{}/ext", rb_src_dir))        // Include external dependencies
        .include(format!("{}/ext/kissfft", rb_src_dir)) // KissFFT headers
        .include(format!("{}/ext/speex", rb_src_dir))   // Speex resampler headers
        .define("HAVE_KISSFFT", None)    // Use KissFFT for full-featured FFT (REQUIRED for pitch preservation)
        .define("USE_BQRESAMPLER", None) // Use Rubber Band's built-in BQResampler (lightweight, no external deps)
        .warnings(false) // Suppress warnings (Rubber Band has many size_t/int conversion warnings on MSVC)
        // C API wrapper and main interface
        .file(format!("{}/rubberband-c.cpp", rb_src_dir))
        .file(format!("{}/RubberBandStretcher.cpp", rb_src_dir))
        // Common utilities
        .file(format!("{}/common/Allocators.cpp", rb_src_dir))
        .file(format!("{}/common/BQResampler.cpp", rb_src_dir))
        .file(format!("{}/common/FFT.cpp", rb_src_dir))
        .file(format!("{}/common/Log.cpp", rb_src_dir))
        .file(format!("{}/common/mathmisc.cpp", rb_src_dir))
        .file(format!("{}/common/Profiler.cpp", rb_src_dir))
        .file(format!("{}/common/Resampler.cpp", rb_src_dir))
        .file(format!("{}/common/StretchCalculator.cpp", rb_src_dir))
        .file(format!("{}/common/sysutils.cpp", rb_src_dir))
        .file(format!("{}/common/Thread.cpp", rb_src_dir))
        .file(format!("{}/common/VectorOpsComplex.cpp", rb_src_dir))
        // R2 Engine (faster)
        .file(format!("{}/faster/AudioCurveCalculator.cpp", rb_src_dir))
        .file(format!("{}/faster/CompoundAudioCurve.cpp", rb_src_dir))
        .file(format!("{}/faster/HighFrequencyAudioCurve.cpp", rb_src_dir))
        .file(format!("{}/faster/PercussiveAudioCurve.cpp", rb_src_dir))
        .file(format!("{}/faster/R2Stretcher.cpp", rb_src_dir))
        .file(format!("{}/faster/SilentAudioCurve.cpp", rb_src_dir))
        .file(format!("{}/faster/StretcherChannelData.cpp", rb_src_dir))
        .file(format!("{}/faster/StretcherProcess.cpp", rb_src_dir))
        // R3 Engine (finer)
        .file(format!("{}/finer/R3Stretcher.cpp", rb_src_dir))
        // External dependencies (FFT and resampler implementations)
        // These are CRITICAL for pitch preservation functionality
        .file(format!("{}/ext/kissfft/kiss_fft.c", rb_src_dir))    // Core FFT implementation
        .file(format!("{}/ext/kissfft/kiss_fftr.c", rb_src_dir));   // Real-valued FFT

    println!("cargo:warning=[RubberBand] Compiling with HAVE_KISSFFT for full pitch shifting support");

    // Platform-specific flags
    if cfg!(target_os = "windows") {
        build.flag("/EHsc"); // Enable C++ exception handling
        build.flag("/std:c++14"); // C++14 standard (MSVC uses /std: not -std=)
        build.define("NOMINMAX", None); // Prevent Windows min/max macros from interfering with std::min/max
    } else {
        build.flag("-std=c++14"); // C++14 standard for GCC/Clang
        build.flag("-fPIC"); // Position-independent code for Unix
    }

    build.compile("rubberband");

    println!("cargo:rustc-link-lib=static=rubberband");
}
