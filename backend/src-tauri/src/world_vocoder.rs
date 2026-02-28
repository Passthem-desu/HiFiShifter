use libloading::Library;
use std::sync::OnceLock;

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct DioOption {
    pub f0_floor: f64,
    pub f0_ceil: f64,
    pub channels_in_octave: f64,
    pub frame_period: f64, // msec
    pub speed: i32,
    pub allowed_range: f64,
}

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct HarvestOption {
    pub f0_floor: f64,
    pub f0_ceil: f64,
    pub frame_period: f64, // msec
}

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct CheapTrickOption {
    pub q1: f64,
    pub f0_floor: f64,
    pub fft_size: i32,
}

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct D4COption {
    pub threshold: f64,
}

type DioFn = unsafe extern "C" fn(
    x: *const f64,
    x_length: i32,
    fs: i32,
    option: *const DioOption,
    temporal_positions: *mut f64,
    f0: *mut f64,
);

type InitializeDioOptionFn = unsafe extern "C" fn(option: *mut DioOption);

type GetSamplesForDIOFn = unsafe extern "C" fn(fs: i32, x_length: i32, frame_period: f64) -> i32;

type StoneMaskFn = unsafe extern "C" fn(
    x: *const f64,
    x_length: i32,
    fs: i32,
    temporal_positions: *const f64,
    f0: *const f64,
    f0_length: i32,
    refined_f0: *mut f64,
);

type HarvestFn = unsafe extern "C" fn(
    x: *const f64,
    x_length: i32,
    fs: i32,
    option: *const HarvestOption,
    temporal_positions: *mut f64,
    f0: *mut f64,
);

type InitializeHarvestOptionFn = unsafe extern "C" fn(option: *mut HarvestOption);

type GetSamplesForHarvestFn =
    unsafe extern "C" fn(fs: i32, x_length: i32, frame_period: f64) -> i32;

type InitializeCheapTrickOptionFn = unsafe extern "C" fn(fs: i32, option: *mut CheapTrickOption);

type GetFFTSizeForCheapTrickFn =
    unsafe extern "C" fn(fs: i32, option: *const CheapTrickOption) -> i32;

type CheapTrickFn = unsafe extern "C" fn(
    x: *const f64,
    x_length: i32,
    fs: i32,
    temporal_positions: *const f64,
    f0: *const f64,
    f0_length: i32,
    option: *const CheapTrickOption,
    spectrogram: *mut *mut f64,
);

type InitializeD4COptionFn = unsafe extern "C" fn(option: *mut D4COption);

type D4CFn = unsafe extern "C" fn(
    x: *const f64,
    x_length: i32,
    fs: i32,
    temporal_positions: *const f64,
    f0: *const f64,
    f0_length: i32,
    fft_size: i32,
    option: *const D4COption,
    aperiodicity: *mut *mut f64,
);

type SynthesisFn = unsafe extern "C" fn(
    f0: *const f64,
    f0_length: i32,
    spectrogram: *const *const f64,
    aperiodicity: *const *const f64,
    fft_size: i32,
    frame_period: f64,
    fs: i32,
    y_length: i32,
    y: *mut f64,
);

struct WorldVocoderApi {
    _lib: Library,

    dio: DioFn,
    initialize_dio_option: InitializeDioOptionFn,
    get_samples_for_dio: GetSamplesForDIOFn,
    stone_mask: StoneMaskFn,

    harvest: HarvestFn,
    initialize_harvest_option: InitializeHarvestOptionFn,
    get_samples_for_harvest: GetSamplesForHarvestFn,

    initialize_cheaptrick_option: InitializeCheapTrickOptionFn,
    get_fft_size_for_cheaptrick: GetFFTSizeForCheapTrickFn,
    cheaptrick: CheapTrickFn,

    initialize_d4c_option: InitializeD4COptionFn,
    d4c: D4CFn,

    synthesis: SynthesisFn,
}

fn try_load_library() -> Result<Library, String> {
    if let Ok(p) = std::env::var("HIFISHIFTER_WORLD_DLL") {
        return unsafe { Library::new(&p) }.map_err(|e| e.to_string());
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let cand = dir.join("world.dll");
            if cand.exists() {
                return unsafe { Library::new(&cand) }.map_err(|e| e.to_string());
            }
        }
    }

    unsafe { Library::new("world.dll") }.map_err(|e| e.to_string())
}

fn api() -> Result<&'static WorldVocoderApi, String> {
    static API: OnceLock<Result<WorldVocoderApi, String>> = OnceLock::new();
    let v = API.get_or_init(|| {
        let lib = try_load_library()?;
        unsafe {
            Ok(WorldVocoderApi {
                dio: *lib.get(b"Dio\0").map_err(|e| e.to_string())?,
                initialize_dio_option: *lib
                    .get(b"InitializeDioOption\0")
                    .map_err(|e| e.to_string())?,
                get_samples_for_dio: *lib.get(b"GetSamplesForDIO\0").map_err(|e| e.to_string())?,
                stone_mask: *lib.get(b"StoneMask\0").map_err(|e| e.to_string())?,

                harvest: *lib.get(b"Harvest\0").map_err(|e| e.to_string())?,
                initialize_harvest_option: *lib
                    .get(b"InitializeHarvestOption\0")
                    .map_err(|e| e.to_string())?,
                get_samples_for_harvest: *lib
                    .get(b"GetSamplesForHarvest\0")
                    .map_err(|e| e.to_string())?,

                initialize_cheaptrick_option: *lib
                    .get(b"InitializeCheapTrickOption\0")
                    .map_err(|e| e.to_string())?,
                get_fft_size_for_cheaptrick: *lib
                    .get(b"GetFFTSizeForCheapTrick\0")
                    .map_err(|e| e.to_string())?,
                cheaptrick: *lib.get(b"CheapTrick\0").map_err(|e| e.to_string())?,

                initialize_d4c_option: *lib
                    .get(b"InitializeD4COption\0")
                    .map_err(|e| e.to_string())?,
                d4c: *lib.get(b"D4C\0").map_err(|e| e.to_string())?,

                synthesis: *lib.get(b"Synthesis\0").map_err(|e| e.to_string())?,

                _lib: lib,
            })
        }
    });

    match v {
        Ok(api) => Ok(api),
        Err(e) => Err(e.clone()),
    }
}

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
enum WorldF0Method {
    Dio,
    Harvest,
}

fn world_f0_method() -> WorldF0Method {
    match std::env::var("HIFISHIFTER_WORLD_F0")
        .ok()
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("dio") => WorldF0Method::Dio,
        Some("harvest") => WorldF0Method::Harvest,
        _ => WorldF0Method::Harvest,
    }
}

pub fn is_available() -> bool {
    api().is_ok()
}

fn ratio_from_semitones(semitones: f64) -> f64 {
    crate::pitch_editing::semitone_to_ratio(semitones)
}

fn clamp11(x: f64) -> f64 {
    x.clamp(-1.0, 1.0)
}

fn env_f64(name: &str) -> Option<f64> {
    std::env::var(name)
        .ok()
        .and_then(|s| s.trim().parse::<f64>().ok())
}

fn cleanup_f0_inplace(f0: &mut [f64], frame_period_ms: f64, f0_floor: f64, f0_ceil: f64) {
    if f0.is_empty() {
        return;
    }

    // 1) Clamp to a reasonable range and sanitize NaN/inf.
    for hz in f0.iter_mut() {
        if !hz.is_finite() || *hz < 0.0 {
            *hz = 0.0;
            continue;
        }
        if *hz > 0.0 {
            *hz = hz.clamp(f0_floor.max(1.0), f0_ceil.max(f0_floor.max(1.0)));
        }
    }

    // 2) Fill short unvoiced gaps inside voiced regions.
    // This reduces analysis/synthesis instability ("gargling") when f0 flickers to 0 for a few frames.
    // Default: 15ms; set HIFISHIFTER_WORLD_F0_GAP_MS=0 to disable.
    let gap_ms = env_f64("HIFISHIFTER_WORLD_F0_GAP_MS").unwrap_or(15.0);
    if gap_ms <= 0.0 {
        return;
    }
    let fp = frame_period_ms.max(0.1);
    let max_gap_frames = ((gap_ms / fp).round() as isize).max(1) as usize;

    let mut i = 0usize;
    while i < f0.len() {
        if f0[i] > 0.0 {
            i += 1;
            continue;
        }

        let start = i;
        while i < f0.len() && f0[i] <= 0.0 {
            i += 1;
        }
        let end = i; // [start, end) is unvoiced
        let gap_len = end - start;
        if gap_len == 0 || gap_len > max_gap_frames {
            continue;
        }
        if start == 0 || end >= f0.len() {
            continue;
        }

        let left = f0[start - 1];
        let right = f0[end];
        if !(left > 0.0 && right > 0.0) {
            continue;
        }

        // Linear interpolate across the gap.
        for k in 0..gap_len {
            let t = (k + 1) as f64 / (gap_len + 1) as f64;
            f0[start + k] = left + (right - left) * t;
        }
    }
}

fn compute_f0_with_positions_dio_stonemask(
    x: &[f64],
    fs: i32,
    frame_period_ms: f64,
    f0_floor: f64,
    f0_ceil: f64,
) -> Result<(Vec<f64>, Vec<f64>), String> {
    let api = api()?;
    if x.is_empty() {
        return Ok((vec![], vec![]));
    }

    let fp = if frame_period_ms.is_finite() && frame_period_ms > 0.1 {
        frame_period_ms
    } else {
        5.0
    };

    let x_len: i32 = x
        .len()
        .try_into()
        .map_err(|_| "WORLD: input too long".to_string())?;

    let samples = unsafe { (api.get_samples_for_dio)(fs, x_len, fp) };
    if samples <= 0 {
        return Ok((vec![], vec![]));
    }

    let mut option = DioOption {
        f0_floor: 71.0,
        f0_ceil: 800.0,
        channels_in_octave: 2.0,
        frame_period: fp,
        speed: 1,
        allowed_range: 0.1,
    };
    unsafe { (api.initialize_dio_option)(&mut option as *mut DioOption) };
    option.frame_period = fp;
    if f0_floor.is_finite() && f0_floor > 0.0 {
        option.f0_floor = f0_floor;
    }
    if f0_ceil.is_finite() && f0_ceil > 0.0 {
        option.f0_ceil = f0_ceil;
    }

    let mut temporal_positions = vec![0.0f64; samples as usize];
    let mut f0 = vec![0.0f64; samples as usize];

    unsafe {
        (api.dio)(
            x.as_ptr(),
            x_len,
            fs,
            &option as *const DioOption,
            temporal_positions.as_mut_ptr(),
            f0.as_mut_ptr(),
        );
    }

    let mut refined = vec![0.0f64; samples as usize];
    unsafe {
        (api.stone_mask)(
            x.as_ptr(),
            x_len,
            fs,
            temporal_positions.as_ptr(),
            f0.as_ptr(),
            samples,
            refined.as_mut_ptr(),
        );
    }

    Ok((temporal_positions, refined))
}

fn compute_f0_with_positions_harvest(
    x: &[f64],
    fs: i32,
    frame_period_ms: f64,
    f0_floor: f64,
    f0_ceil: f64,
) -> Result<(Vec<f64>, Vec<f64>), String> {
    let api = api()?;
    if x.is_empty() {
        return Ok((vec![], vec![]));
    }

    let fp = if frame_period_ms.is_finite() && frame_period_ms > 0.1 {
        frame_period_ms
    } else {
        5.0
    };

    let x_len: i32 = x
        .len()
        .try_into()
        .map_err(|_| "WORLD: input too long".to_string())?;

    let samples = unsafe { (api.get_samples_for_harvest)(fs, x_len, fp) };
    if samples <= 0 {
        return Ok((vec![], vec![]));
    }

    let mut option = HarvestOption {
        f0_floor: 71.0,
        f0_ceil: 800.0,
        frame_period: fp,
    };
    unsafe { (api.initialize_harvest_option)(&mut option as *mut HarvestOption) };
    option.frame_period = fp;
    if f0_floor.is_finite() && f0_floor > 0.0 {
        option.f0_floor = f0_floor;
    }
    if f0_ceil.is_finite() && f0_ceil > 0.0 {
        option.f0_ceil = f0_ceil;
    }

    let mut temporal_positions = vec![0.0f64; samples as usize];
    let mut f0 = vec![0.0f64; samples as usize];

    unsafe {
        (api.harvest)(
            x.as_ptr(),
            x_len,
            fs,
            &option as *const HarvestOption,
            temporal_positions.as_mut_ptr(),
            f0.as_mut_ptr(),
        );
    }

    // Note: StoneMask is primarily recommended for DIO. Keep Harvest output as-is.
    Ok((temporal_positions, f0))
}

fn vocode_one(
    x_f64: &[f64],
    fs: i32,
    frame_period_ms: f64,
    f0_floor: f64,
    f0_ceil: f64,
    abs_time_start_sec: f64,
    semitone_at_time: &impl Fn(f64) -> f64,
) -> Result<Vec<f64>, String> {
    let api = api()?;

    if x_f64.is_empty() {
        return Ok(vec![]);
    }

    let fp = if frame_period_ms.is_finite() && frame_period_ms > 0.1 {
        frame_period_ms
    } else {
        5.0
    };

    let (temporal_positions, mut f0) = match world_f0_method() {
        WorldF0Method::Harvest => {
            compute_f0_with_positions_harvest(x_f64, fs, fp, f0_floor, f0_ceil).or_else(|_e| {
                // Fallback to DIO if Harvest symbols or runtime fail.
                compute_f0_with_positions_dio_stonemask(x_f64, fs, fp, f0_floor, f0_ceil)
            })?
        }
        WorldF0Method::Dio => compute_f0_with_positions_dio_stonemask(
            x_f64, fs, fp, f0_floor, f0_ceil,
        )
        .or_else(|_e| {
            // Fallback to Harvest if DIO fails.
            compute_f0_with_positions_harvest(x_f64, fs, fp, f0_floor, f0_ceil)
        })?,
    };

    cleanup_f0_inplace(&mut f0, fp, f0_floor, f0_ceil);

    let f0_len_i32: i32 = f0
        .len()
        .try_into()
        .map_err(|_| "WORLD: f0 too long".to_string())?;

    if f0.is_empty() {
        // Nothing voiced; passthrough.
        return Ok(x_f64.to_vec());
    }

    // Precompute voiced flags. WORLD uses 0 Hz for unvoiced.
    let voiced: Vec<bool> = f0.iter().map(|&hz| hz > 0.0).collect();

    // Create shifted f0.
    let mut shifted_f0 = vec![0.0f64; f0.len()];
    for i in 0..f0.len() {
        let hz = f0[i];
        if hz > 0.0 {
            let t = temporal_positions.get(i).copied().unwrap_or(0.0);
            let abs_t = abs_time_start_sec + t;
            let semitones = semitone_at_time(abs_t);
            let r = ratio_from_semitones(semitones);
            shifted_f0[i] = hz * r;
        }
    }

    // CheapTrick options.
    let mut ct_opt = CheapTrickOption {
        q1: -0.15,
        f0_floor: f0_floor.max(20.0),
        fft_size: 0,
    };
    unsafe { (api.initialize_cheaptrick_option)(fs, &mut ct_opt as *mut CheapTrickOption) };
    ct_opt.f0_floor = f0_floor.max(20.0);

    let fft_size =
        unsafe { (api.get_fft_size_for_cheaptrick)(fs, &ct_opt as *const CheapTrickOption) };
    if fft_size <= 0 {
        return Err("WORLD: invalid fft_size".to_string());
    }
    ct_opt.fft_size = fft_size;

    let spec_bins = (fft_size as usize / 2) + 1;

    // Allocate spectrogram and aperiodicity as 2D arrays.
    let mut spectrogram: Vec<Vec<f64>> = vec![vec![0.0f64; spec_bins]; f0.len()];
    let mut sp_ptrs: Vec<*mut f64> = spectrogram.iter_mut().map(|row| row.as_mut_ptr()).collect();

    unsafe {
        (api.cheaptrick)(
            x_f64.as_ptr(),
            x_f64
                .len()
                .try_into()
                .map_err(|_| "WORLD: input too long".to_string())?,
            fs,
            temporal_positions.as_ptr(),
            f0.as_ptr(),
            f0_len_i32,
            &ct_opt as *const CheapTrickOption,
            sp_ptrs.as_mut_ptr(),
        );
    }

    let mut d4c_opt = D4COption { threshold: 0.85 };
    unsafe { (api.initialize_d4c_option)(&mut d4c_opt as *mut D4COption) };

    let mut aperiodicity: Vec<Vec<f64>> = vec![vec![0.0f64; spec_bins]; f0.len()];
    let mut ap_ptrs: Vec<*mut f64> = aperiodicity
        .iter_mut()
        .map(|row| row.as_mut_ptr())
        .collect();

    unsafe {
        (api.d4c)(
            x_f64.as_ptr(),
            x_f64
                .len()
                .try_into()
                .map_err(|_| "WORLD: input too long".to_string())?,
            fs,
            temporal_positions.as_ptr(),
            f0.as_ptr(),
            f0_len_i32,
            fft_size,
            &d4c_opt as *const D4COption,
            ap_ptrs.as_mut_ptr(),
        );
    }

    // Synthesis.
    let y_length: i32 = x_f64
        .len()
        .try_into()
        .map_err(|_| "WORLD: output too long".to_string())?;
    let mut y = vec![0.0f64; x_f64.len()];

    unsafe {
        let sp_const: Vec<*const f64> = sp_ptrs.iter().map(|&p| p as *const f64).collect();
        let ap_const: Vec<*const f64> = ap_ptrs.iter().map(|&p| p as *const f64).collect();
        (api.synthesis)(
            shifted_f0.as_ptr(),
            f0_len_i32,
            sp_const.as_ptr(),
            ap_const.as_ptr(),
            fft_size,
            fp,
            fs,
            y_length,
            y.as_mut_ptr(),
        );
    }

    // Blend vocoded output with original for unvoiced / aperiodic regions.
    // This significantly reduces the typical "sand/noise" artifacts after pitch edits,
    // especially on fricatives/breath sounds where WORLD vocoding is brittle.
    // NOTE: This is not a low-pass on the control curve; it is voiced/unvoiced gating.
    let fade_ms = 10.0f64;
    let fade_samples = ((fade_ms / 1000.0) * (fs.max(1) as f64)).round().max(0.0) as usize;

    let mut out = y;
    if !voiced.is_empty() {
        let debug = std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1");
        if debug {
            let voiced_n = voiced.iter().filter(|&&b| b).count();
            let ratio = (voiced_n as f64) / (voiced.len().max(1) as f64);
            eprintln!(
                "WORLD vocoder: voiced_ratio={:.3} f0_len={} fp_ms={:.3}",
                ratio,
                voiced.len(),
                fp
            );
        }

        let mut w_prev = 0.0f64;
        let mut ramp_left = 0usize;
        let mut ramp_from = 0.0f64;
        let mut ramp_to = 0.0f64;

        for si in 0..out.len() {
            // Map sample time -> frame index.
            let t_ms = (si as f64) * 1000.0 / (fs.max(1) as f64);
            let fi = (t_ms / fp).floor().max(0.0) as usize;
            let target_w = if fi < voiced.len() && voiced[fi] {
                1.0f64
            } else {
                0.0f64
            };

            // Start a new ramp when target changes.
            if ramp_left == 0 && (target_w - w_prev).abs() > 1e-9 && fade_samples > 0 {
                ramp_left = fade_samples;
                ramp_from = w_prev;
                ramp_to = target_w;
            }

            let w = if ramp_left > 0 {
                let k = (fade_samples - ramp_left) as f64 / (fade_samples as f64);
                ramp_left = ramp_left.saturating_sub(1);
                ramp_from + (ramp_to - ramp_from) * k.clamp(0.0, 1.0)
            } else {
                target_w
            };

            // Overwrite state only when we're not in-ramp.
            if ramp_left == 0 {
                w_prev = target_w;
            }

            let dry = x_f64[si];
            let wet = out[si];
            out[si] = wet * w + dry * (1.0 - w);
        }
    }

    Ok(out)
}

/// WORLD vocoder pitch shift, chunked to avoid huge memory usage.
///
/// `start_sec` is the absolute timeline time for `mono_pcm[0]`.
pub fn vocode_pitch_shift_chunked<F>(
    mono_pcm: &[f32],
    sample_rate: u32,
    start_sec: f64,
    frame_period_ms: f64,
    f0_floor: f64,
    f0_ceil: f64,
    semitone_at_time: F,
) -> Result<Vec<f32>, String>
where
    F: Fn(f64) -> f64,
{
    if mono_pcm.is_empty() {
        return Ok(vec![]);
    }

    // WORLD DLL may not be thread-safe in practice on some builds; serialize all calls.
    let _guard = crate::world_lock::world_dll_mutex()
        .lock()
        .map_err(|_| "WORLD: mutex poisoned".to_string())?;

    // Ensure vocoder symbols exist.
    let _ = api()?;

    let sr = sample_rate.max(1) as i32;

    let total_frames = mono_pcm.len();

    // Chunk config (tunable).
    // WORLD is sensitive to clipped / DC-offset inputs.
    // Keep preprocessing minimal to avoid changing the intended sound too much:
    // - remove DC
    let chunk_sec = 6.0f64;
    let overlap_sec = 0.10f64;

    let chunk_len = (chunk_sec * (sample_rate as f64)).round().max(1.0) as usize;
    let overlap_len = (overlap_sec * (sample_rate as f64)).round().max(0.0) as usize;

    let mut out = vec![0.0f32; total_frames];

    let mut pos = 0usize;
    while pos < total_frames {
        let chunk_start = pos;
        let chunk_end = (pos + chunk_len).min(total_frames);

        // Padded region for analysis.
        let pad_start = chunk_start.saturating_sub(overlap_len);
        let pad_end = (chunk_end + overlap_len).min(total_frames);

        let x = &mono_pcm[pad_start..pad_end];
        let mut x_f64 = Vec::with_capacity(x.len());
        // Preprocessing to reduce artifacts
        let mut mean = 0.0f64;
        for &v in x {
            mean += v as f64;
        }
        mean /= x.len().max(1) as f64;

        let mut max_abs = 0.0f64;
        for &v in x {
            let vv = (v as f64) - mean;
            let a = vv.abs();
            if a.is_finite() && a > max_abs {
                max_abs = a;
            }
        }
        let scale = if max_abs.is_finite() && max_abs > 1.0 {
            (1.0 / max_abs).clamp(0.0, 1.0)
        } else {
            1.0
        };

        for &v in x {
            let vv = ((v as f64) - mean) * scale;
            x_f64.push(clamp11(vv));
        }

        let abs_time_start_sec = start_sec + (pad_start as f64) / (sample_rate as f64);
        let y_f64 = vocode_one(
            &x_f64,
            sr,
            frame_period_ms,
            f0_floor,
            f0_ceil,
            abs_time_start_sec,
            &semitone_at_time,
        )?;

        if y_f64.len() != x_f64.len() {
            return Err("WORLD: chunk output length mismatch".to_string());
        }

        // Copy central (non-padded) part back.
        let central_start = chunk_start - pad_start;

        // 等功率 crossfade（equal-power crossfade）写回策略：
        //
        // 分块边界处使用 cos/sin 曲线，保证 cos²(w) + sin²(w) = 1，能量守恒。
        //
        // 区域划分（以当前块为视角）：
        //   [chunk_start, chunk_start+overlap_len)  → fade-in 区：读取前一块已写入值，做等功率混合
        //   [chunk_start+overlap_len, chunk_end-overlap_len) → 中间区：直接覆盖写入
        //   [chunk_end-overlap_len, chunk_end)       → fade-out 区：直接写入（下一块 fade-in 时会读取并混合）
        //
        // 注意：fade-in 区必须先读取 out[dst_idx]（前一块的 fade-out 值），再做等功率混合。
        // fade-out 区直接写入当前块的值，等待下一块来做 fade-in 混合。

        let dst_start = chunk_start;
        let dst_end = chunk_end;

        for i in 0..(dst_end - dst_start) {
            let src_idx = central_start + i;
            let v = clamp11(y_f64[src_idx]) as f32;
            let dst_idx = dst_start + i;

            if overlap_len > 0 && chunk_start > 0 && dst_idx < chunk_start + overlap_len {
                // fade-in 区：等功率混合前一块（已写入）与当前块
                // w_curr = sin(t * π/2)，w_prev = cos(t * π/2)，满足 w_curr² + w_prev² = 1
                let t = (dst_idx - chunk_start) as f32 / overlap_len as f32;
                let angle = t.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2;
                let w_curr = angle.sin();
                let w_prev = angle.cos();
                let prev_val = out[dst_idx]; // 前一块在此位置写入的 fade-out 值
                out[dst_idx] = prev_val * w_prev + v * w_curr;
            } else {
                // 中间区 & fade-out 区：直接覆盖写入当前块的值
                // fade-out 区的值会在下一块的 fade-in 阶段被读取并做等功率混合
                out[dst_idx] = v;
            }
        }

        pos = chunk_end;
    }

    Ok(out)
}
