use libloading::Library;
use std::ffi::c_int;
use std::path::PathBuf;
use std::sync::OnceLock;

#[allow(non_upper_case_globals)]
mod opts {
    // RubberBandOptionProcessOffline = 0x00000000
    pub const RubberBandOptionProcessOffline: i32 = 0x00000000;

    // RubberBandOptionProcessRealTime = 0x00000001
    pub const RubberBandOptionProcessRealTime: i32 = 0x00000001;

    pub const RubberBandOptionTransientsSmooth: i32 = 0x00000200;
    pub const RubberBandOptionDetectorSoft: i32 = 0x00000800;
    pub const RubberBandOptionPhaseLaminar: i32 = 0x00000000;
    pub const RubberBandOptionPitchHighQuality: i32 = 0x02000000;
    pub const RubberBandOptionFormantPreserved: i32 = 0x01000000;
    pub const RubberBandOptionChannelsTogether: i32 = 0x10000000;
    pub const RubberBandOptionEngineFiner: i32 = 0x20000000;
}

#[repr(C)]
struct RubberBandStateOpaque {
    _private: [u8; 0],
}

type RubberBandState = *mut RubberBandStateOpaque;

type RubberbandNew = unsafe extern "C" fn(
    sample_rate: u32,
    channels: u32,
    options: i32,
    initial_time_ratio: f64,
    initial_pitch_scale: f64,
) -> RubberBandState;

type RubberbandDelete = unsafe extern "C" fn(state: RubberBandState);
type RubberbandReset = unsafe extern "C" fn(state: RubberBandState);
type RubberbandSetTimeRatio = unsafe extern "C" fn(state: RubberBandState, ratio: f64);
type RubberbandSetPitchScale = unsafe extern "C" fn(state: RubberBandState, scale: f64);
type RubberbandSetExpectedInputDuration =
    unsafe extern "C" fn(state: RubberBandState, samples: u32);
type RubberbandSetMaxProcessSize = unsafe extern "C" fn(state: RubberBandState, samples: u32);
type RubberbandStudy = unsafe extern "C" fn(
    state: RubberBandState,
    input: *const *const f32,
    samples: u32,
    final_: c_int,
);
type RubberbandProcess = unsafe extern "C" fn(
    state: RubberBandState,
    input: *const *const f32,
    samples: u32,
    final_: c_int,
);
type RubberbandAvailable = unsafe extern "C" fn(state: RubberBandState) -> c_int;
type RubberbandRetrieve =
    unsafe extern "C" fn(state: RubberBandState, output: *const *mut f32, samples: u32) -> u32;
type RubberbandCalculateStretch = unsafe extern "C" fn(state: RubberBandState);

struct RubberBandApi {
    _lib: Library,
    rubberband_new: RubberbandNew,
    rubberband_delete: RubberbandDelete,
    rubberband_reset: RubberbandReset,
    rubberband_set_time_ratio: RubberbandSetTimeRatio,
    rubberband_set_pitch_scale: RubberbandSetPitchScale,
    rubberband_set_expected_input_duration: RubberbandSetExpectedInputDuration,
    rubberband_set_max_process_size: RubberbandSetMaxProcessSize,
    rubberband_study: RubberbandStudy,
    rubberband_process: RubberbandProcess,
    rubberband_available: RubberbandAvailable,
    rubberband_retrieve: RubberbandRetrieve,
    rubberband_calculate_stretch: RubberbandCalculateStretch,
}

pub struct RubberBandRealtimeStretcher {
    state: RubberBandState,
    channels: usize,
    sample_rate: u32,
    max_block: usize,

    // Scratch buffers to avoid per-call allocations.
    in_ch: Vec<Vec<f32>>,
    out_ch: Vec<Vec<f32>>,
}

unsafe impl Send for RubberBandRealtimeStretcher {}

fn try_load_library() -> Result<Library, String> {
    // 1) Explicit override
    if let Ok(p) = std::env::var("HIFISHIFTER_RUBBERBAND_DLL") {
        let pb = PathBuf::from(p);
        return unsafe { Library::new(&pb) }.map_err(|e| e.to_string());
    }

    // 2) Adjacent to current executable (Tauri bundles usually place DLLs here)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let cand = dir.join("rubberband.dll");
            if cand.exists() {
                return unsafe { Library::new(&cand) }.map_err(|e| e.to_string());
            }
        }
    }

    // 3) PATH search (Library::new will use OS loader paths)
    unsafe { Library::new("rubberband.dll") }.map_err(|e| e.to_string())
}

fn api() -> Result<&'static RubberBandApi, String> {
    static API: OnceLock<Result<RubberBandApi, String>> = OnceLock::new();
    let v = API.get_or_init(|| {
        let lib = try_load_library()?;

        unsafe {
            // Store raw function pointers so we don't keep Symbol borrows alive.
            let rubberband_new: RubberbandNew =
                *lib.get(b"rubberband_new\0").map_err(|e| e.to_string())?;
            let rubberband_delete: RubberbandDelete =
                *lib.get(b"rubberband_delete\0").map_err(|e| e.to_string())?;
            let rubberband_reset: RubberbandReset =
                *lib.get(b"rubberband_reset\0").map_err(|e| e.to_string())?;
            let rubberband_set_time_ratio: RubberbandSetTimeRatio = *lib
                .get(b"rubberband_set_time_ratio\0")
                .map_err(|e| e.to_string())?;
            let rubberband_set_pitch_scale: RubberbandSetPitchScale = *lib
                .get(b"rubberband_set_pitch_scale\0")
                .map_err(|e| e.to_string())?;
            let rubberband_set_expected_input_duration: RubberbandSetExpectedInputDuration = *lib
                .get(b"rubberband_set_expected_input_duration\0")
                .map_err(|e| e.to_string())?;
            let rubberband_set_max_process_size: RubberbandSetMaxProcessSize = *lib
                .get(b"rubberband_set_max_process_size\0")
                .map_err(|e| e.to_string())?;
            let rubberband_study: RubberbandStudy =
                *lib.get(b"rubberband_study\0").map_err(|e| e.to_string())?;
            let rubberband_process: RubberbandProcess = *lib
                .get(b"rubberband_process\0")
                .map_err(|e| e.to_string())?;
            let rubberband_available: RubberbandAvailable = *lib
                .get(b"rubberband_available\0")
                .map_err(|e| e.to_string())?;
            let rubberband_retrieve: RubberbandRetrieve = *lib
                .get(b"rubberband_retrieve\0")
                .map_err(|e| e.to_string())?;
            let rubberband_calculate_stretch: RubberbandCalculateStretch = *lib
                .get(b"rubberband_calculate_stretch\0")
                .map_err(|e| e.to_string())?;

            Ok(RubberBandApi {
                _lib: lib,
                rubberband_new,
                rubberband_delete,
                rubberband_reset,
                rubberband_set_time_ratio,
                rubberband_set_pitch_scale,
                rubberband_set_expected_input_duration,
                rubberband_set_max_process_size,
                rubberband_study,
                rubberband_process,
                rubberband_available,
                rubberband_retrieve,
                rubberband_calculate_stretch,
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

impl RubberBandRealtimeStretcher {
    pub fn new(sample_rate: u32, channels: usize, time_ratio: f64) -> Result<Self, String> {
        if channels == 0 {
            return Err("rubberband: channels == 0".to_string());
        }
        if channels > 2 {
            return Err("rubberband: channels > 2 not supported yet".to_string());
        }
        let api = api()?;

        let time_ratio = if time_ratio.is_finite() && time_ratio > 1e-6 {
            time_ratio
        } else {
            1.0
        };

        let options = opts::RubberBandOptionProcessRealTime
            | opts::RubberBandOptionEngineFiner
            | opts::RubberBandOptionPitchHighQuality
            | opts::RubberBandOptionFormantPreserved
            | opts::RubberBandOptionChannelsTogether
            | opts::RubberBandOptionTransientsSmooth
            | opts::RubberBandOptionDetectorSoft
            | opts::RubberBandOptionPhaseLaminar;

        let state = unsafe {
            (api.rubberband_new)(
                sample_rate.max(1),
                channels as u32,
                options,
                time_ratio,
                1.0,
            )
        };
        if state.is_null() {
            return Err("rubberband_new returned null".to_string());
        }

        // Keep processing blocks reasonably small.
        const BLOCK: usize = 1024;
        unsafe {
            (api.rubberband_set_max_process_size)(state, BLOCK as u32);
            (api.rubberband_set_time_ratio)(state, time_ratio);
            (api.rubberband_set_pitch_scale)(state, 1.0);
        }

        Ok(Self {
            state,
            channels,
            sample_rate: sample_rate.max(1),
            max_block: BLOCK,
            in_ch: (0..channels).map(|_| vec![0.0; BLOCK]).collect(),
            out_ch: (0..channels).map(|_| vec![0.0; BLOCK]).collect(),
        })
    }

    pub fn reset(&mut self, time_ratio: f64) -> Result<(), String> {
        let api = api()?;
        let time_ratio = if time_ratio.is_finite() && time_ratio > 1e-6 {
            time_ratio
        } else {
            1.0
        };
        unsafe {
            (api.rubberband_reset)(self.state);
            (api.rubberband_set_max_process_size)(self.state, self.max_block as u32);
            (api.rubberband_set_time_ratio)(self.state, time_ratio);
            (api.rubberband_set_pitch_scale)(self.state, 1.0);
        }
        Ok(())
    }

    pub fn process_interleaved(
        &mut self,
        input_interleaved: &[f32],
        final_: bool,
    ) -> Result<(), String> {
        if input_interleaved.is_empty() {
            return Ok(());
        }
        let frames = input_interleaved.len() / self.channels.max(1);
        if frames == 0 {
            return Ok(());
        }

        let api = api()?;

        let mut i = 0usize;
        while i < frames {
            let end = (i + self.max_block).min(frames);
            let count = end - i;
            let is_final = if end >= frames { final_ } else { false };

            for ch in 0..self.channels {
                let dst = &mut self.in_ch[ch][..count];
                for f in 0..count {
                    dst[f] = input_interleaved[(i + f) * self.channels + ch];
                }
            }

            let mut ptrs: Vec<*const f32> = Vec::with_capacity(self.channels);
            for ch in 0..self.channels {
                ptrs.push(self.in_ch[ch].as_ptr());
            }

            unsafe {
                (api.rubberband_process)(
                    self.state,
                    ptrs.as_ptr(),
                    count as u32,
                    if is_final { 1 } else { 0 },
                );
            }

            i = end;
        }

        Ok(())
    }

    /// Retrieve up to `max_frames` frames, interleaved.
    pub fn retrieve_interleaved_into(
        &mut self,
        out_interleaved: &mut Vec<f32>,
        max_frames: usize,
    ) -> Result<usize, String> {
        let api = api()?;
        let avail = unsafe { (api.rubberband_available)(self.state) };
        if avail <= 0 {
            return Ok(0);
        }
        let req = (avail as usize).min(self.max_block).min(max_frames.max(1));
        if req == 0 {
            return Ok(0);
        }

        let mut out_ptrs: Vec<*mut f32> = Vec::with_capacity(self.channels);
        for ch in 0..self.channels {
            out_ptrs.push(self.out_ch[ch].as_mut_ptr());
        }

        let got = unsafe {
            (api.rubberband_retrieve)(self.state, out_ptrs.as_ptr(), req as u32) as usize
        };
        if got == 0 {
            return Ok(0);
        }

        let start = out_interleaved.len();
        out_interleaved.resize(start + got * self.channels, 0.0);
        for f in 0..got {
            for ch in 0..self.channels {
                out_interleaved[start + f * self.channels + ch] = self.out_ch[ch][f];
            }
        }

        Ok(got)
    }

    #[allow(dead_code)]
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

impl Drop for RubberBandRealtimeStretcher {
    fn drop(&mut self) {
        if self.state.is_null() {
            return;
        }
        if let Ok(api) = api() {
            unsafe {
                (api.rubberband_reset)(self.state);
                (api.rubberband_delete)(self.state);
            }
        }
        self.state = std::ptr::null_mut();
    }
}

pub fn try_time_stretch_interleaved_offline(
    input_interleaved: &[f32],
    channels: usize,
    sample_rate: u32,
    time_ratio: f64,
    out_frames_hint: usize,
) -> Result<Vec<f32>, String> {
    if input_interleaved.is_empty() || channels == 0 {
        return Ok(vec![]);
    }
    if channels > 2 {
        return Err("rubberband: channels > 2 not supported yet".to_string());
    }

    let api = api()?;

    let in_frames = input_interleaved.len() / channels;
    if in_frames < 2 {
        return Ok(input_interleaved.to_vec());
    }
    let time_ratio = if time_ratio.is_finite() && time_ratio > 1e-6 {
        time_ratio
    } else {
        1.0
    };

    let options = opts::RubberBandOptionProcessOffline
        | opts::RubberBandOptionEngineFiner
        | opts::RubberBandOptionPitchHighQuality
        | opts::RubberBandOptionFormantPreserved
        | opts::RubberBandOptionChannelsTogether
        | opts::RubberBandOptionTransientsSmooth
        | opts::RubberBandOptionDetectorSoft
        | opts::RubberBandOptionPhaseLaminar;

    // Deinterleave into channel-major buffers.
    let mut ch_buf: Vec<Vec<f32>> = (0..channels).map(|_| vec![0.0; in_frames]).collect();
    for f in 0..in_frames {
        for ch in 0..channels {
            ch_buf[ch][f] = input_interleaved[f * channels + ch];
        }
    }

    unsafe {
        let state = (api.rubberband_new)(sample_rate, channels as u32, options, time_ratio, 1.0);
        if state.is_null() {
            return Err("rubberband_new returned null".to_string());
        }

        // Help the library make better choices.
        (api.rubberband_set_expected_input_duration)(state, in_frames as u32);
        (api.rubberband_set_time_ratio)(state, time_ratio);
        (api.rubberband_set_pitch_scale)(state, 1.0);

        // Keep processing blocks reasonably small.
        const BLOCK: usize = 4096;
        (api.rubberband_set_max_process_size)(state, BLOCK as u32);

        // Study pass.
        let mut i = 0;
        while i < in_frames {
            let end = (i + BLOCK).min(in_frames);
            let count = end - i;
            let final_ = if end >= in_frames { 1 } else { 0 };

            let ptrs: Vec<*const f32> = ch_buf.iter().map(|b| b.as_ptr().add(i)).collect();
            (api.rubberband_study)(state, ptrs.as_ptr(), count as u32, final_);
            i = end;
        }

        (api.rubberband_calculate_stretch)(state);

        // Process pass.
        let mut i = 0;
        while i < in_frames {
            let end = (i + BLOCK).min(in_frames);
            let count = end - i;
            let final_ = if end >= in_frames { 1 } else { 0 };

            let ptrs: Vec<*const f32> = ch_buf.iter().map(|b| b.as_ptr().add(i)).collect();
            (api.rubberband_process)(state, ptrs.as_ptr(), count as u32, final_);
            i = end;
        }

        // Retrieve all available output.
        let mut out_ch: Vec<Vec<f32>> = (0..channels)
            .map(|_| Vec::with_capacity(out_frames_hint.max(1)))
            .collect();
        let mut temp: Vec<Vec<f32>> = (0..channels).map(|_| vec![0.0f32; BLOCK]).collect();

        loop {
            let avail = (api.rubberband_available)(state);
            if avail <= 0 {
                break;
            }
            let req = (avail as usize).min(BLOCK);

            let out_ptrs: Vec<*mut f32> = temp.iter_mut().map(|t| t.as_mut_ptr()).collect();

            let got = (api.rubberband_retrieve)(state, out_ptrs.as_ptr(), req as u32) as usize;
            if got == 0 {
                break;
            }
            for (out_buf, tmp) in out_ch.iter_mut().zip(temp.iter()) {
                out_buf.extend_from_slice(&tmp[..got]);
            }
        }

        (api.rubberband_reset)(state);
        (api.rubberband_delete)(state);

        let out_frames = out_ch
            .first()
            .map(|v| v.len())
            .unwrap_or(0)
            .min(out_ch.get(1).map(|v| v.len()).unwrap_or(usize::MAX));
        if out_frames == 0 {
            return Ok(vec![]);
        }

        // Interleave.
        let mut out = vec![0.0f32; out_frames * channels];
        for (f, frame) in out.chunks_exact_mut(channels).enumerate() {
            for (ch, v) in frame.iter_mut().enumerate() {
                *v = out_ch[ch][f];
            }
        }
        Ok(out)
    }
}
