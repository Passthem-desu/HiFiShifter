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

type StoneMaskFn = unsafe extern "C" fn(
    x: *const f64,
    x_length: i32,
    fs: i32,
    temporal_positions: *const f64,
    f0: *const f64,
    f0_length: i32,
    refined_f0: *mut f64,
);

struct WorldApi {
    _lib: Library,
    dio: DioFn,
    initialize_dio_option: InitializeDioOptionFn,
    get_samples_for_dio: GetSamplesForDIOFn,
    harvest: HarvestFn,
    initialize_harvest_option: InitializeHarvestOptionFn,
    get_samples_for_harvest: GetSamplesForHarvestFn,
    stone_mask: StoneMaskFn,
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

fn api() -> Result<&'static WorldApi, String> {
    static API: OnceLock<Result<WorldApi, String>> = OnceLock::new();
    let v = API.get_or_init(|| {
        let lib = try_load_library()?;
        unsafe {
            let dio: DioFn = *lib.get(b"Dio\0").map_err(|e| e.to_string())?;
            let initialize_dio_option: InitializeDioOptionFn = *lib
                .get(b"InitializeDioOption\0")
                .map_err(|e| e.to_string())?;
            let get_samples_for_dio: GetSamplesForDIOFn = *lib
                .get(b"GetSamplesForDIO\0")
                .map_err(|e| e.to_string())?;

            let harvest: HarvestFn = *lib.get(b"Harvest\0").map_err(|e| e.to_string())?;
            let initialize_harvest_option: InitializeHarvestOptionFn = *lib
                .get(b"InitializeHarvestOption\0")
                .map_err(|e| e.to_string())?;
            let get_samples_for_harvest: GetSamplesForHarvestFn = *lib
                .get(b"GetSamplesForHarvest\0")
                .map_err(|e| e.to_string())?;

            let stone_mask: StoneMaskFn =
                *lib.get(b"StoneMask\0").map_err(|e| e.to_string())?;

            Ok(WorldApi {
                _lib: lib,
                dio,
                initialize_dio_option,
                get_samples_for_dio,
                harvest,
                initialize_harvest_option,
                get_samples_for_harvest,
                stone_mask,
            })
        }
    });

    match v {
        Ok(api) => Ok(api),
        Err(e) => Err(e.clone()),
    }
}

pub fn is_available() -> bool {
    api().is_ok()
}

pub fn compute_f0_hz_harvest(
    x: &[f64],
    fs: i32,
    frame_period_ms: f64,
    f0_floor: f64,
    f0_ceil: f64,
) -> Result<Vec<f64>, String> {
    let _guard = crate::world_lock::world_dll_mutex()
        .lock()
        .map_err(|_| "WORLD: mutex poisoned".to_string())?;
    let api = api()?;
    if x.is_empty() {
        return Ok(vec![]);
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
        return Ok(vec![]);
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

    // Harvest already produces stable F0; keep StoneMask for Dio only.
    Ok(f0)
}

pub fn compute_f0_hz_dio_stonemask(
    x: &[f64],
    fs: i32,
    frame_period_ms: f64,
    f0_floor: f64,
    f0_ceil: f64,
) -> Result<Vec<f64>, String> {
    let _guard = crate::world_lock::world_dll_mutex()
        .lock()
        .map_err(|_| "WORLD: mutex poisoned".to_string())?;
    let api = api()?;
    if x.is_empty() {
        return Ok(vec![]);
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
        return Ok(vec![]);
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

    Ok(refined)
}
