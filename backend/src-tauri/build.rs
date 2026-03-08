fn main() {
    build_frontend();
    tauri_build::build();
    build_world_static();
    build_rubberband_static();
    build_vslib();
}

/// 在编译时自动构建前端静态资源。
///
/// 当 `frontend/dist` 目录不存在时，自动执行 `npm run build` 生成前端产物，
/// 确保 Tauri 能找到 `frontendDist`。
/// 若 dist 已存在则跳过（开发者可手动删除 dist 目录强制重建）。
fn build_frontend() {
    use std::path::Path;
    use std::process::Command;

    // build.rs 的工作目录是 src-tauri/，前端目录在上两级
    let frontend_dir = Path::new("../../frontend");
    let dist_dir = frontend_dir.join("dist");

    if !frontend_dir.exists() {
        println!("cargo:warning=[Frontend] frontend 目录不存在，跳过前端构建");
        return;
    }

    // 当关键文件变更时重新触发 build.rs
    println!("cargo:rerun-if-changed=../../frontend/src");
    println!("cargo:rerun-if-changed=../../frontend/package.json");
    println!("cargo:rerun-if-changed=../../frontend/vite.config.ts");
    println!("cargo:rerun-if-changed=../../frontend/vite.config.js");

    // dist 已存在则跳过，避免每次编译都重新构建前端
    if dist_dir.exists() {
        println!("cargo:warning=[Frontend] dist 已存在，跳过构建（删除 frontend/dist 可强制重建）");
        return;
    }

    println!("cargo:warning=[Frontend] 正在构建前端，请稍候...");

    let npm_cmd = if cfg!(target_os = "windows") { "npm.cmd" } else { "npm" };

    let status = Command::new(npm_cmd)
        .arg("run")
        .arg("build")
        .current_dir(frontend_dir)
        .status();

    match status {
        Ok(s) if s.success() => {
            println!("cargo:warning=[Frontend] 前端构建成功");
        }
        Ok(s) => {
            panic!("[Frontend] 前端构建失败，退出码: {:?}", s.code());
        }
        Err(e) => {
            panic!(
                "[Frontend] 无法执行 npm run build: {}。请确保已安装 Node.js 和 npm。",
                e
            );
        }
    }
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
/// Version: v4.0.0
///
/// The Rubber Band Library (https://github.com/breakfastquay/rubberband) provides:
/// - High-quality pitch-preserving time stretching
/// - Real-time and offline processing modes
/// - Dual-engine architecture (R2 "faster" + R3 "finer")
/// - Live shifting via R3LiveShifter (new in v4.0.0)
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
        eprintln!("  git clone --depth 1 --branch v4.0.0 https://github.com/breakfastquay/rubberband.git rubberband");
        eprintln!("\nOr from project root:");
        eprintln!("  git clone --depth 1 --branch v4.0.0 https://github.com/breakfastquay/rubberband.git backend/src-tauri/third_party/rubberband-static/rubberband");
        eprintln!("========================================\n");
        panic!("Rubber Band sources missing. See error message above for instructions.");
    }

    // Verify critical files exist
    let critical_files = [
        "rubberband-c.cpp",
        "RubberBandStretcher.cpp",
        "RubberBandLiveShifter.cpp",
        "common/Allocators.cpp",
        "faster/R2Stretcher.cpp",
        "finer/R3Stretcher.cpp",
        "finer/R3LiveShifter.cpp",
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
        .file(format!("{}/RubberBandLiveShifter.cpp", rb_src_dir))
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
        .file(format!("{}/finer/R3LiveShifter.cpp", rb_src_dir))
        // External dependencies (FFT and resampler implementations)
        // These are CRITICAL for pitch preservation functionality
        .file(format!("{}/ext/kissfft/kiss_fft.c", rb_src_dir))    // Core FFT implementation
        .file(format!("{}/ext/kissfft/kiss_fftr.c", rb_src_dir));   // Real-valued FFT

    println!("cargo:warning=[RubberBand] Compiling with HAVE_KISSFFT for full pitch shifting support");

    // Platform-specific flags: detect actual compiler toolchain, not just OS.
    // On Windows, the compiler may be MinGW g++ (GCC flags) or MSVC cl.exe (MSVC flags).
    // Using cfg!(target_os = "windows") would incorrectly apply MSVC flags to MinGW g++.
    let compiler = build.get_compiler();
    if compiler.is_like_msvc() {
        build.flag("/EHsc"); // Enable C++ exception handling (MSVC)
        build.flag("/std:c++14"); // C++14 standard (MSVC uses /std: not -std=)
        build.define("NOMINMAX", None); // Prevent Windows min/max macros from interfering with std::min/max
    } else {
        build.flag("-std=c++14"); // C++14 standard for GCC/Clang/MinGW
        if !cfg!(target_os = "windows") {
            build.flag("-fPIC"); // Position-independent code for Unix (not needed on Windows/MinGW)
        }
    }

    build.compile("rubberband");

    println!("cargo:rustc-link-lib=static=rubberband");
}

/// Link against vslib_x64.dll via its import library.
///
/// The DLL and import lib live in third_party/vslib/:
///   vslib_x64.dll  — needs to sit next to the final binary at runtime
///   vslib_x64.lib  — import library linked at compile time
///
/// Enabled only when the `vslib` cargo feature is active.
fn build_vslib() {
    if !cfg!(feature = "vslib") {
        return;
    }

    let lib_dir = std::path::Path::new("third_party/vslib");

    if !lib_dir.exists() {
        panic!(
            "[vslib] third_party/vslib/ not found. \
             Place vslib_x64.dll and vslib_x64.lib there."
        );
    }

    // Resolve to an absolute path so rustc can find the import lib
    let abs = lib_dir
        .canonicalize()
        .expect("[vslib] failed to canonicalize third_party/vslib path");

    println!("cargo:rerun-if-changed=third_party/vslib/vslib_x64.lib");
    println!("cargo:rerun-if-changed=third_party/vslib/vslib_x64.dll");
    println!("cargo:rustc-link-search=native={}", abs.display());
    println!("cargo:rustc-link-lib=dylib=vslib_x64");

    // Copy the DLL next to the output binary so `cargo tauri dev` works.
    // OUT_DIR = .../target/<profile>/build/<pkg>/out  →  4 levels up = target/<profile>/
    if let Ok(out_dir) = std::env::var("OUT_DIR") {
        let dll_src = lib_dir.join("vslib_x64.dll");
        let target_dir = std::path::Path::new(&out_dir)
            .ancestors()
            .nth(3)
            .expect("[vslib] unexpected OUT_DIR depth");
        let dll_dst = target_dir.join("vslib_x64.dll");
        if let Err(e) = std::fs::copy(&dll_src, &dll_dst) {
            println!("cargo:warning=[vslib] could not copy DLL to {}: {}", dll_dst.display(), e);
        } else {
            println!("cargo:warning=[vslib] copied vslib_x64.dll to {}", dll_dst.display());
        }
    }
}
