use std::ffi::c_int;

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

// Static FFI declarations for Rubber Band C API
// Since v2026.03, Rubber Band is statically linked at compile time
extern "C" {
    fn rubberband_new(
        sample_rate: u32,
        channels: u32,
        options: i32,
        initial_time_ratio: f64,
        initial_pitch_scale: f64,
    ) -> RubberBandState;
    
    fn rubberband_delete(state: RubberBandState);
    
    fn rubberband_reset(state: RubberBandState);
    
    fn rubberband_set_time_ratio(state: RubberBandState, ratio: f64);
    
    fn rubberband_set_pitch_scale(state: RubberBandState, scale: f64);
    
    fn rubberband_get_pitch_scale(state: RubberBandState) -> f64;
    
    fn rubberband_get_time_ratio(state: RubberBandState) -> f64;
    
    fn rubberband_set_expected_input_duration(state: RubberBandState, samples: u32);
    
    fn rubberband_set_max_process_size(state: RubberBandState, samples: u32);
    
    fn rubberband_study(
        state: RubberBandState,
        input: *const *const f32,
        samples: u32,
        final_: c_int,
    );
    
    fn rubberband_process(
        state: RubberBandState,
        input: *const *const f32,
        samples: u32,
        final_: c_int,
    );
    
    fn rubberband_available(state: RubberBandState) -> c_int;
    
    fn rubberband_retrieve(
        state: RubberBandState,
        output: *const *mut f32,
        samples: u32,
    ) -> u32;
    
    fn rubberband_calculate_stretch(state: RubberBandState);

    fn rubberband_get_preferred_start_pad(state: RubberBandState) -> u32;
    fn rubberband_get_start_delay(state: RubberBandState) -> u32;
    fn rubberband_get_samples_required(state: RubberBandState) -> u32;
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

/// Check if Rubber Band API is available.
/// Since static linking, this always returns true.
pub fn is_available() -> bool {
    true
}

impl RubberBandRealtimeStretcher {
    pub fn new(sample_rate: u32, channels: usize, time_ratio: f64) -> Result<Self, String> {
        if channels == 0 {
            return Err("rubberband: channels == 0".to_string());
        }
        if channels > 2 {
            return Err("rubberband: channels > 2 not supported yet".to_string());
        }

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

        eprintln!("[RubberBand DEBUG] Creating with sample_rate={}, channels={}, time_ratio={:.6}, pitch_scale=1.0", 
                 sample_rate, channels, time_ratio);
        eprintln!("[RubberBand DEBUG] Options: ProcessRealTime={}, EngineFiner={}, PitchHighQuality={}",
                 (options & opts::RubberBandOptionProcessRealTime) != 0,
                 (options & opts::RubberBandOptionEngineFiner) != 0,
                 (options & opts::RubberBandOptionPitchHighQuality) != 0);

        let state = unsafe {
            rubberband_new(
                sample_rate.max(1),
                channels as u32,
                options,
                time_ratio,
                1.0,
            )
        };
        if state.is_null() {
            eprintln!("[RubberBand ERROR] rubberband_new returned null!");
            return Err("rubberband_new returned null".to_string());
        }

        // Keep processing blocks reasonably small.
        const BLOCK: usize = 1024;
        unsafe {
            rubberband_set_max_process_size(state, BLOCK as u32);
            rubberband_set_time_ratio(state, time_ratio);
            rubberband_set_pitch_scale(state, 1.0);
            
            // Debug: verify pitch scale is set correctly
            let actual_pitch = rubberband_get_pitch_scale(state);
            let actual_time = rubberband_get_time_ratio(state);
            eprintln!("[RubberBand] ✓ Created successfully: time_ratio={:.6}, pitch_scale={:.6} (pitch should be 1.0 for constant pitch)",
                     actual_time, actual_pitch);
            
            if (actual_pitch - 1.0).abs() > 0.001 {
                eprintln!("[RubberBand WARNING] pitch_scale is NOT 1.0! Got {:.6}, this will cause pitch changes!", actual_pitch);
            }
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
        let time_ratio = if time_ratio.is_finite() && time_ratio > 1e-6 {
            time_ratio
        } else {
            1.0
        };
        unsafe {
            rubberband_reset(self.state);
            rubberband_set_max_process_size(self.state, self.max_block as u32);
            rubberband_set_time_ratio(self.state, time_ratio);
            rubberband_set_pitch_scale(self.state, 1.0);
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
                rubberband_process(
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
        let avail = unsafe { rubberband_available(self.state) };
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
            rubberband_retrieve(self.state, out_ptrs.as_ptr(), req as u32) as usize
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
        unsafe {
            rubberband_reset(self.state);
            rubberband_delete(self.state);
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
        let state = rubberband_new(sample_rate, channels as u32, options, time_ratio, 1.0);
        if state.is_null() {
            return Err("rubberband_new returned null".to_string());
        }

        // Help the library make better choices.
        rubberband_set_expected_input_duration(state, in_frames as u32);
        rubberband_set_time_ratio(state, time_ratio);
        rubberband_set_pitch_scale(state, 1.0);

        // Keep processing blocks reasonably small.
        const BLOCK: usize = 4096;
        rubberband_set_max_process_size(state, BLOCK as u32);

        // Study pass.
        let mut i = 0;
        while i < in_frames {
            let end = (i + BLOCK).min(in_frames);
            let count = end - i;
            let final_ = if end >= in_frames { 1 } else { 0 };

            let ptrs: Vec<*const f32> = ch_buf.iter().map(|b| b.as_ptr().add(i)).collect();
            rubberband_study(state, ptrs.as_ptr(), count as u32, final_);
            i = end;
        }

        rubberband_calculate_stretch(state);

        // Process pass.
        let mut i = 0;
        while i < in_frames {
            let end = (i + BLOCK).min(in_frames);
            let count = end - i;
            let final_ = if end >= in_frames { 1 } else { 0 };

            let ptrs: Vec<*const f32> = ch_buf.iter().map(|b| b.as_ptr().add(i)).collect();
            rubberband_process(state, ptrs.as_ptr(), count as u32, final_);
            i = end;
        }

        // Retrieve all available output.
        let mut out_ch: Vec<Vec<f32>> = (0..channels)
            .map(|_| Vec::with_capacity(out_frames_hint.max(1)))
            .collect();
        let mut temp: Vec<Vec<f32>> = (0..channels).map(|_| vec![0.0f32; BLOCK]).collect();

        loop {
            let avail = rubberband_available(state);
            if avail <= 0 {
                break;
            }
            let req = (avail as usize).min(BLOCK);

            let out_ptrs: Vec<*mut f32> = temp.iter_mut().map(|t| t.as_mut_ptr()).collect();

            let got = rubberband_retrieve(state, out_ptrs.as_ptr(), req as u32) as usize;
            if got == 0 {
                break;
            }
            for (out_buf, tmp) in out_ch.iter_mut().zip(temp.iter()) {
                out_buf.extend_from_slice(&tmp[..got]);
            }
        }

        rubberband_reset(state);
        rubberband_delete(state);

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

/// 使用 RubberBand **实时模式**（`OptionProcessRealTime`）完成批量时间拉伸。
///
/// 与 [`try_time_stretch_interleaved_offline`] 的区别：
/// - 不需要 `study` pass，只需一次 `process` + `retrieve` 遍历
/// - 内存占用更低（无需两次遍历缓冲区）
/// - 与 `stretch_stream` 实时路径使用相同的 API 模式，代码路径统一
/// - 需要处理实时模式的延迟补偿（`getPreferredStartPad` + `getStartDelay`）
///
/// # 延迟补偿
/// 实时模式不自动补偿启动延迟，需要：
/// 1. 在输入前填充 `getPreferredStartPad()` 个静音帧
/// 2. 丢弃输出前 `getStartDelay()` 个帧
///
/// # 参数
/// - `input_interleaved`: 交错 PCM 输入（f32，范围 -1.0 ~ 1.0）
/// - `channels`: 声道数（1 或 2）
/// - `sample_rate`: 采样率（Hz）
/// - `time_ratio`: 时间拉伸比（输出时长 / 输入时长），> 1 减速，< 1 加速
/// - `out_frames_hint`: 期望输出帧数（用于预分配缓冲区）
pub fn try_time_stretch_interleaved_realtime(
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

    let in_frames = input_interleaved.len() / channels;
    if in_frames < 2 {
        return Ok(input_interleaved.to_vec());
    }
    let time_ratio = if time_ratio.is_finite() && time_ratio > 1e-6 {
        time_ratio
    } else {
        1.0
    };

    // 实时模式选项：与 stretch_stream 保持一致
    let options = opts::RubberBandOptionProcessRealTime
        | opts::RubberBandOptionEngineFiner
        | opts::RubberBandOptionPitchHighQuality
        | opts::RubberBandOptionFormantPreserved
        | opts::RubberBandOptionChannelsTogether
        | opts::RubberBandOptionTransientsSmooth
        | opts::RubberBandOptionDetectorSoft
        | opts::RubberBandOptionPhaseLaminar;

    // 反交错为声道主序缓冲区
    let mut ch_buf: Vec<Vec<f32>> = (0..channels).map(|_| vec![0.0; in_frames]).collect();
    for f in 0..in_frames {
        for ch in 0..channels {
            ch_buf[ch][f] = input_interleaved[f * channels + ch];
        }
    }

    unsafe {
        let state = rubberband_new(sample_rate, channels as u32, options, time_ratio, 1.0);
        if state.is_null() {
            return Err("rubberband_new returned null".to_string());
        }

        rubberband_set_time_ratio(state, time_ratio);
        rubberband_set_pitch_scale(state, 1.0);

        const BLOCK: usize = 1024;
        rubberband_set_max_process_size(state, BLOCK as u32);

        // 实时模式延迟补偿：
        // 1. 查询需要填充的静音帧数（start pad）
        // 2. 查询需要丢弃的输出帧数（start delay）
        let start_pad = rubberband_get_preferred_start_pad(state) as usize;
        let start_delay = rubberband_get_start_delay(state) as usize;

        // 填充静音帧（start pad）
        if start_pad > 0 {
            let silence: Vec<f32> = vec![0.0; start_pad * channels];
            let mut pad_ch: Vec<Vec<f32>> = (0..channels).map(|_| vec![0.0; start_pad]).collect();
            let _ = silence; // 已通过 pad_ch 零初始化

            let mut pad_pos = 0;
            while pad_pos < start_pad {
                let end = (pad_pos + BLOCK).min(start_pad);
                let count = end - pad_pos;
                let ptrs: Vec<*const f32> = pad_ch.iter().map(|b| b.as_ptr().add(pad_pos)).collect();
                rubberband_process(state, ptrs.as_ptr(), count as u32, 0);
                pad_pos = end;
            }
        }

        // 主处理 pass（process + retrieve 交替）
        let mut out_ch: Vec<Vec<f32>> = (0..channels)
            .map(|_| Vec::with_capacity(out_frames_hint.max(1) + start_pad))
            .collect();
        let mut temp: Vec<Vec<f32>> = (0..channels).map(|_| vec![0.0f32; BLOCK]).collect();

        let mut i = 0;
        while i < in_frames {
            let end = (i + BLOCK).min(in_frames);
            let count = end - i;
            let is_final = if end >= in_frames { 1 } else { 0 };

            let ptrs: Vec<*const f32> = ch_buf.iter().map(|b| b.as_ptr().add(i)).collect();
            rubberband_process(state, ptrs.as_ptr(), count as u32, is_final);
            i = end;

            // 每次 process 后立即 retrieve，避免内部缓冲区积压
            loop {
                let avail = rubberband_available(state);
                if avail <= 0 {
                    break;
                }
                let req = (avail as usize).min(BLOCK);
                let out_ptrs: Vec<*mut f32> = temp.iter_mut().map(|t| t.as_mut_ptr()).collect();
                let got = rubberband_retrieve(state, out_ptrs.as_ptr(), req as u32) as usize;
                if got == 0 {
                    break;
                }
                for (out_buf, tmp) in out_ch.iter_mut().zip(temp.iter()) {
                    out_buf.extend_from_slice(&tmp[..got]);
                }
            }
        }

        // 最终 flush：继续 retrieve 直到无更多输出
        loop {
            let avail = rubberband_available(state);
            if avail <= 0 {
                break;
            }
            let req = (avail as usize).min(BLOCK);
            let out_ptrs: Vec<*mut f32> = temp.iter_mut().map(|t| t.as_mut_ptr()).collect();
            let got = rubberband_retrieve(state, out_ptrs.as_ptr(), req as u32) as usize;
            if got == 0 {
                break;
            }
            for (out_buf, tmp) in out_ch.iter_mut().zip(temp.iter()) {
                out_buf.extend_from_slice(&tmp[..got]);
            }
        }

        rubberband_reset(state);
        rubberband_delete(state);

        // 丢弃 start_delay 帧（延迟补偿）
        let out_frames_raw = out_ch
            .first()
            .map(|v| v.len())
            .unwrap_or(0)
            .min(out_ch.get(1).map(|v| v.len()).unwrap_or(usize::MAX));

        let skip = start_delay.min(out_frames_raw);
        let out_frames = out_frames_raw.saturating_sub(skip);

        if out_frames == 0 {
            return Ok(vec![]);
        }

        // 交错输出
        let mut out = vec![0.0f32; out_frames * channels];
        for (f, frame) in out.chunks_exact_mut(channels).enumerate() {
            for (ch, v) in frame.iter_mut().enumerate() {
                *v = out_ch[ch].get(skip + f).copied().unwrap_or(0.0);
            }
        }
        Ok(out)
    }
}
