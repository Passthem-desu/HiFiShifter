use num_complex::Complex32;
use ort::session::Session;
use ort::value::Tensor;
use rustfft::FftPlanner;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

static ORT_INIT: OnceLock<Result<(), String>> = OnceLock::new();

fn ensure_ort_init() -> Result<(), String> {
    match ORT_INIT.get_or_init(|| {
        ort::init().with_name("hifishifter").commit();
        Ok(())
    }) {
        Ok(()) => Ok(()),
        Err(e) => Err(e.clone()),
    }
}

#[derive(Debug, Clone, Deserialize)]
struct NsfHifiganConfig {
    sampling_rate: u32,
    num_mels: usize,
    hop_size: usize,
    n_fft: usize,
    win_size: usize,
    fmin: f32,
    fmax: f32,
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var(name)
        .ok()
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn default_model_dir_guess() -> Option<PathBuf> {
    // Prefer repo-relative default used in this workspace.
    // 1) Current working directory
    if let Ok(cd) = std::env::current_dir() {
        let p = cd.join("pc_nsf_hifigan_44.1k_hop512_128bin_2025.02");
        if p.is_dir() {
            return Some(p);
        }
    }

    // 2) Dev runs: backend/src-tauri -> repo root
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf());
    if let Some(root) = root {
        let p = root.join("pc_nsf_hifigan_44.1k_hop512_128bin_2025.02");
        if p.is_dir() {
            return Some(p);
        }
    }

    None
}

fn resolve_model_paths() -> Result<(PathBuf, PathBuf), String> {
    // Returns (onnx_path, config_path)
    if let Some(onnx) = env_path("HIFISHIFTER_NSF_HIFIGAN_ONNX") {
        let dir = onnx.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let cfg = env_path("HIFISHIFTER_NSF_HIFIGAN_CONFIG")
            .or_else(|| {
                let p = dir.join("config.json");
                if p.is_file() {
                    Some(p)
                } else {
                    None
                }
            })
            .unwrap_or_else(|| dir.join("config.json"));
        return Ok((onnx, cfg));
    }

    if let Some(dir) = env_path("HIFISHIFTER_NSF_HIFIGAN_MODEL_DIR")
        .or_else(default_model_dir_guess)
    {
        let onnx = dir.join("pc_nsf_hifigan.onnx");
        let cfg = dir.join("config.json");
        if onnx.is_file() && cfg.is_file() {
            return Ok((onnx, cfg));
        }
    }

    Err(
        "NSF-HiFiGAN ONNX model not found. Set HIFISHIFTER_NSF_HIFIGAN_ONNX (or HIFISHIFTER_NSF_HIFIGAN_MODEL_DIR)."
            .to_string(),
    )
}

fn read_config(path: &Path) -> Result<NsfHifiganConfig, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read config.json failed: {e}"))?;
    serde_json::from_slice::<NsfHifiganConfig>(&bytes)
        .map_err(|e| format!("parse config.json failed: {e}"))
}

pub(crate) fn probe_load() -> Result<String, String> {
    ensure_ort_init()?;
    let (onnx_path, cfg_path) = resolve_model_paths()?;
    let cfg = read_config(&cfg_path)?;

    // Create a session (this also validates that the model is loadable by ORT).
    let mut session = Session::builder()
        .map_err(|e| format!("create ort session builder failed: {e}"))?
        .commit_from_file(&onnx_path)
        .map_err(|e| format!("load onnx into ort session failed: {e}"))?;

    // Best-effort smoke run to ensure inputs/outputs are compatible.
    // Model expects mel: (1, n_mels, T) and f0: (1, T).
    let t = 10usize;
    let mel = vec![0.0f32; cfg.num_mels.saturating_mul(t)];
    let f0 = vec![0.0f32; t];
    let mel_tensor = Tensor::from_array(([1usize, cfg.num_mels, t], mel.into_boxed_slice()))
        .map_err(|e| format!("build mel tensor failed: {e}"))?;
    let f0_tensor = Tensor::from_array(([1usize, t], f0.into_boxed_slice()))
        .map_err(|e| format!("build f0 tensor failed: {e}"))?;
    let outputs = session
        .run(ort::inputs![mel_tensor, f0_tensor])
        .map_err(|e| format!("ort session run failed: {e}"))?;
    let output0 = outputs
        .into_iter()
        .next()
        .ok_or_else(|| "ort returned no outputs".to_string())?;
    let (_shape, data) = output0
        .1
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("ort output extract failed: {e}"))?;
    if data.is_empty() {
        return Err("ort output tensor is empty".to_string());
    }

    Ok(format!(
        "nsf_hifigan_onnx: OK\n  onnx: {}\n  cfg: {}\n  sr={} mels={} hop={} n_fft={} win={} fmin={} fmax={}",
        onnx_path.display(),
        cfg_path.display(),
        cfg.sampling_rate,
        cfg.num_mels,
        cfg.hop_size,
        cfg.n_fft,
        cfg.win_size,
        cfg.fmin,
        cfg.fmax
    ))
}

fn reflect_index(i: isize, len: usize) -> usize {
    if len <= 1 {
        return 0;
    }
    let period = 2 * ((len as isize) - 1);
    let mut m = i % period;
    if m < 0 {
        m += period;
    }
    if m < len as isize {
        m as usize
    } else {
        (period - m) as usize
    }
}

fn reflect_pad(y: &[f32], left: usize, right: usize) -> Vec<f32> {
    if y.is_empty() {
        return vec![0.0; left + right];
    }

    let len = y.len();
    let mut out = Vec::with_capacity(left + len + right);
    let start = -(left as isize);
    let end = (len as isize) + (right as isize);
    for i in start..end {
        let idx = reflect_index(i, len);
        out.push(y[idx]);
    }
    out
}

fn hann_window(len: usize) -> Vec<f32> {
    if len == 0 {
        return vec![];
    }
    if len == 1 {
        return vec![1.0];
    }

    let denom = (len - 1) as f32;
    let mut w = Vec::with_capacity(len);
    for n in 0..len {
        let x = (2.0 * std::f32::consts::PI * (n as f32)) / denom;
        w.push(0.5 - 0.5 * x.cos());
    }
    w
}

fn hz_to_mel_slaney(hz: f32) -> f32 {
    let f_min = 0.0;
    let f_sp = 200.0 / 3.0;
    let min_log_hz = 1000.0;
    let min_log_mel = (min_log_hz - f_min) / f_sp;
    let logstep = (6.4f32).ln() / 27.0;

    if hz >= min_log_hz {
        min_log_mel + (hz / min_log_hz).ln() / logstep
    } else {
        (hz - f_min) / f_sp
    }
}

fn mel_to_hz_slaney(mel: f32) -> f32 {
    let f_min = 0.0;
    let f_sp = 200.0 / 3.0;
    let min_log_hz = 1000.0;
    let min_log_mel = (min_log_hz - f_min) / f_sp;
    let logstep = (6.4f32).ln() / 27.0;

    if mel >= min_log_mel {
        min_log_hz * (logstep * (mel - min_log_mel)).exp()
    } else {
        f_min + f_sp * mel
    }
}

fn mel_filterbank_slaney(
    sr: u32,
    n_fft: usize,
    n_mels: usize,
    fmin: f32,
    fmax: f32,
) -> Vec<Vec<f32>> {
    let n_freqs = n_fft / 2 + 1;

    let mel_min = hz_to_mel_slaney(fmin.max(0.0));
    let mel_max = hz_to_mel_slaney(fmax.max(fmin));

    let mut mel_points = Vec::with_capacity(n_mels + 2);
    for i in 0..(n_mels + 2) {
        let t = i as f32 / (n_mels + 1) as f32;
        mel_points.push(mel_min + (mel_max - mel_min) * t);
    }

    let mut hz_points = Vec::with_capacity(n_mels + 2);
    for &m in &mel_points {
        hz_points.push(mel_to_hz_slaney(m));
    }

    let mut fftfreqs = Vec::with_capacity(n_freqs);
    for i in 0..n_freqs {
        fftfreqs.push((i as f32) * (sr as f32) / (n_fft as f32));
    }

    let mut weights = vec![vec![0.0f32; n_freqs]; n_mels];
    for m in 0..n_mels {
        let f_left = hz_points[m];
        let f_center = hz_points[m + 1];
        let f_right = hz_points[m + 2];

        let fdiff_left = (f_center - f_left).max(1e-6);
        let fdiff_right = (f_right - f_center).max(1e-6);

        for (i, &f) in fftfreqs.iter().enumerate() {
            let lower = (f - f_left) / fdiff_left;
            let upper = (f_right - f) / fdiff_right;
            let v = lower.min(upper).max(0.0);
            weights[m][i] = v;
        }

        // Slaney normalization.
        let enorm = 2.0 / (f_right - f_left).max(1e-6);
        for i in 0..n_freqs {
            weights[m][i] *= enorm;
        }
    }

    weights
}

fn stft_magnitude(
    y: &[f32],
    n_fft: usize,
    win_size: usize,
    hop: usize,
    window: &[f32],
) -> Result<Vec<Vec<f32>>, String> {
    if win_size == 0 || hop == 0 || n_fft == 0 {
        return Err("stft: invalid params".to_string());
    }
    if window.len() != win_size {
        return Err("stft: window length mismatch".to_string());
    }

    let n_freqs = n_fft / 2 + 1;
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n_fft);

    if y.len() < win_size {
        return Ok(vec![vec![0.0; 1]; n_freqs]);
    }

    let n_frames = 1 + (y.len().saturating_sub(win_size)) / hop;
    let mut out = vec![vec![0.0f32; n_frames]; n_freqs];

    let mut buf: Vec<Complex32> = vec![Complex32::new(0.0, 0.0); n_fft];

    for frame in 0..n_frames {
        let start = frame * hop;
        for i in 0..win_size {
            let v = y.get(start + i).copied().unwrap_or(0.0);
            buf[i] = Complex32::new(v * window[i], 0.0);
        }
        for i in win_size..n_fft {
            buf[i] = Complex32::new(0.0, 0.0);
        }

        fft.process(&mut buf);

        for f in 0..n_freqs {
            let c = buf[f];
            out[f][frame] = (c.re * c.re + c.im * c.im).sqrt();
        }
    }

    Ok(out)
}

fn dynamic_range_compression_ln(x: f32) -> f32 {
    (x.max(1e-9)).ln()
}

fn midi_to_hz(midi: f64) -> f32 {
    if !(midi.is_finite() && midi > 0.0) {
        return 0.0;
    }
    let hz = 440.0 * (2.0f64).powf((midi - 69.0) / 12.0);
    if hz.is_finite() {
        hz as f32
    } else {
        0.0
    }
}

fn linear_resample_mono(input: &[f32], in_rate: u32, out_rate: u32) -> Vec<f32> {
    if input.is_empty() {
        return vec![];
    }
    if in_rate == out_rate {
        return input.to_vec();
    }
    if input.len() < 2 {
        return input.to_vec();
    }

    let ratio = out_rate as f64 / in_rate as f64;
    let out_frames = ((input.len() as f64) * ratio).round().max(1.0) as usize;
    let mut out = vec![0.0f32; out_frames];

    for of in 0..out_frames {
        let t_in = (of as f64) / ratio;
        let i0 = t_in.floor() as isize;
        let frac = (t_in - (i0 as f64)) as f32;
        let i0 = i0.clamp(0, (input.len() - 1) as isize) as usize;
        let i1 = (i0 + 1).min(input.len() - 1);
        let a = input[i0];
        let b = input[i1];
        out[of] = a + (b - a) * frac;
    }

    out
}

pub struct NsfHifiganOnnx {
    cfg: NsfHifiganConfig,
    mel_fb: Vec<Vec<f32>>,
    session: Session,
}

impl NsfHifiganOnnx {
    fn load() -> Result<Self, String> {
        ensure_ort_init()?;
        let (onnx_path, cfg_path) = resolve_model_paths()?;
        let cfg = read_config(&cfg_path)?;

        if cfg.sampling_rate == 0 || cfg.num_mels == 0 || cfg.hop_size == 0 || cfg.n_fft == 0 {
            return Err("invalid NSF-HiFiGAN config.json".to_string());
        }

        let mel_fb = mel_filterbank_slaney(
            cfg.sampling_rate,
            cfg.n_fft,
            cfg.num_mels,
            cfg.fmin,
            cfg.fmax,
        );

        let session = Session::builder()
            .map_err(|e| format!("create ort session builder failed: {e}"))?
            .commit_from_file(&onnx_path)
            .map_err(|e| format!("load onnx into ort session failed: {e}"))?;

        Ok(Self {
            cfg,
            mel_fb,
            session,
        })
    }

    fn mel_from_audio(&self, audio: &[f32], key_shift_semitones: f32) -> Result<Vec<f32>, String> {
        // Replicates utils/wav2mel.py (PitchAdjustableMelSpectrogram + log compression),
        // but we currently only use key_shift=0 in the app.
        let factor = 2.0f32.powf(key_shift_semitones / 12.0);
        let n_fft_new = ((self.cfg.n_fft as f32) * factor).round().max(1.0) as usize;
        let win_size_new = ((self.cfg.win_size as f32) * factor).round().max(1.0) as usize;
        let hop = self.cfg.hop_size;

        let pad_left = ((win_size_new as isize - hop as isize) / 2).max(0) as usize;
        let pad_right = ((win_size_new as isize - hop as isize + 1) / 2).max(0) as usize;
        let y = reflect_pad(audio, pad_left, pad_right);

        let window = hann_window(win_size_new);
        let mut spec = stft_magnitude(&y, n_fft_new, win_size_new, hop, &window)?;

        // Handle pitch shift by resizing frequency bins (python behavior).
        if key_shift_semitones.abs() > 1e-6 {
            let size = self.cfg.n_fft / 2 + 1;
            let resize = spec.len();
            if resize < size {
                spec.extend(std::iter::repeat(vec![0.0f32; spec[0].len()]).take(size - resize));
            }
            spec.truncate(size);
            let scale = (self.cfg.win_size as f32) / (win_size_new as f32);
            for row in &mut spec {
                for v in row.iter_mut() {
                    *v *= scale;
                }
            }
        }

        // Mel projection.
        let n_freqs = self.cfg.n_fft / 2 + 1;
        if spec.len() != n_freqs {
            return Err(format!(
                "mel: unexpected spec bins (got {}, expected {})",
                spec.len(),
                n_freqs
            ));
        }
        let n_frames = spec[0].len();
        let mut mel = vec![0.0f32; self.cfg.num_mels * n_frames];
        for m in 0..self.cfg.num_mels {
            let fb = &self.mel_fb[m];
            for t in 0..n_frames {
                let mut acc = 0.0f32;
                for f in 0..n_freqs {
                    acc += fb[f] * spec[f][t];
                }
                mel[m * n_frames + t] = dynamic_range_compression_ln(acc);
            }
        }
        Ok(mel)
    }

    pub fn infer_from_audio_and_midi(
        &mut self,
        audio_mono: &[f32],
        sample_rate: u32,
        start_sec: f64,
        midi_at_time: impl Fn(f64) -> f64,
    ) -> Result<Vec<f32>, String> {
        let model_sr = self.cfg.sampling_rate;
        let audio_model = linear_resample_mono(audio_mono, sample_rate, model_sr);

        let mel = self.mel_from_audio(&audio_model, 0.0)?;

        // mel is stored as (n_mels, T) contiguous. Build f0 (1, T) in Hz.
        let t = mel.len() / self.cfg.num_mels;
        if t == 0 {
            return Ok(vec![0.0; audio_mono.len()]);
        }

        let hop_sec = (self.cfg.hop_size as f64) / (model_sr.max(1) as f64);
        let mut f0 = vec![0.0f32; t];
        for i in 0..t {
            let abs_t = start_sec + (i as f64) * hop_sec;
            let midi = midi_at_time(abs_t);
            f0[i] = midi_to_hz(midi);
        }

        let mel_tensor = Tensor::from_array(([1usize, self.cfg.num_mels, t], mel.into_boxed_slice()))
            .map_err(|e| format!("build mel tensor failed: {e}"))?;
        let f0_tensor = Tensor::from_array(([1usize, t], f0.into_boxed_slice()))
            .map_err(|e| format!("build f0 tensor failed: {e}"))?;

        let outputs = self
            .session
            .run(ort::inputs![mel_tensor, f0_tensor])
            .map_err(|e| format!("ort run failed: {e}"))?;
        let output0 = outputs
            .into_iter()
            .next()
            .ok_or_else(|| "onnx returned no outputs".to_string())?;

        let (_shape, data) = output0
            .1
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("ort output type mismatch: {e}"))?;
        let y_vec: Vec<f32> = data.to_vec();

        // Resample back to mixdown rate if needed.
        let y_mix = linear_resample_mono(&y_vec, model_sr, sample_rate);

        // Force length to match input buffer for in-place mixdown.
        let target = audio_mono.len();
        let mut out = y_mix;
        if out.len() > target {
            out.truncate(target);
        } else if out.len() < target {
            out.resize(target, 0.0);
        }
        Ok(out)
    }
}

static SESSION: OnceLock<Mutex<Result<NsfHifiganOnnx, String>>> = OnceLock::new();
static LOGGED_UNAVAILABLE: AtomicBool = AtomicBool::new(false);

fn session() -> &'static Mutex<Result<NsfHifiganOnnx, String>> {
    SESSION.get_or_init(|| Mutex::new(NsfHifiganOnnx::load()))
}

pub fn is_available() -> bool {
    // Best-effort: treat as available if model can be loaded.
    let guard = session().lock().ok();
    match guard.as_deref() {
        Some(Ok(_)) => true,
        Some(Err(e)) => {
            let debug = std::env::var("HIFISHIFTER_DEBUG_COMMANDS")
                .ok()
                .as_deref()
                == Some("1");
            if debug && !LOGGED_UNAVAILABLE.swap(true, Ordering::Relaxed) {
                eprintln!("nsf_hifigan_onnx: unavailable: {e}");
            }
            false
        }
        None => false,
    }
}

pub fn infer_pitch_edit_mono(
    audio_mono: &[f32],
    sample_rate: u32,
    start_sec: f64,
    midi_at_time: impl Fn(f64) -> f64,
) -> Result<Vec<f32>, String> {
    let mut lock = session()
        .lock()
        .map_err(|_| "nsf_hifigan: session lock poisoned".to_string())?;
    let mut binding = lock.as_mut();
    let sess = binding.as_mut().map_err(|e| (*e).clone())?;

    sess.infer_from_audio_and_midi(audio_mono, sample_rate, start_sec, midi_at_time)
}
