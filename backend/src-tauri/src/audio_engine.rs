use arc_swap::ArcSwap;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
use std::sync::atomic::AtomicU32 as AtomicU32Cell;
use std::thread;

use crate::state::{Clip, TimelineState, Track};
use crate::time_stretch::{time_stretch_interleaved, StretchAlgorithm};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct StretchKey {
    path: PathBuf,
    out_rate: u32,
    bpm_q: u32,
    trim_start_q: i64,
    trim_end_q: i64,
    playback_rate_q: u32,
}

#[derive(Debug, Clone)]
struct StretchJob {
    key: StretchKey,
    bpm: f64,
    trim_start_beat: f64,
    trim_end_beat: f64,
    playback_rate: f64,
}

#[derive(Debug, Clone)]
pub struct AudioEngineStateSnapshot {
    pub is_playing: bool,
    pub target: Option<String>,
    pub base_sec: f64,
    pub position_sec: f64,
    pub duration_sec: f64,
    pub sample_rate: u32,
}

#[derive(Debug, Clone)]
struct ResampledStereo {
    sample_rate: u32,
    frames: usize,
    // interleaved stereo f32 in [-1, 1]
    pcm: Arc<Vec<f32>>,
}

#[derive(Debug)]
struct StreamRingStereo {
    cap_frames: u64,
    // Interleaved stereo stored as atomic bits so the audio callback can read lock-free.
    buf: Vec<AtomicU32Cell>,
    base_frame: AtomicU64,
    write_frame: AtomicU64,
}

impl StreamRingStereo {
    fn new(cap_frames: u64) -> Self {
        let cap_frames = cap_frames.max(256);
        let len = (cap_frames as usize) * 2;
        let mut buf = Vec::with_capacity(len);
        buf.resize_with(len, || AtomicU32Cell::new(0));
        Self {
            cap_frames,
            buf,
            base_frame: AtomicU64::new(0),
            write_frame: AtomicU64::new(0),
        }
    }

    fn reset(&self, start_frame: u64) {
        self.base_frame.store(start_frame, Ordering::Release);
        self.write_frame.store(start_frame, Ordering::Release);
    }

    fn write_interleaved(&self, start_frame: u64, pcm: &[f32]) {
        let frames = pcm.len() / 2;
        if frames == 0 {
            return;
        }

        // Ensure the window never exceeds capacity.
        let mut base = self.base_frame.load(Ordering::Acquire);
        let end_frame = start_frame.saturating_add(frames as u64);
        if end_frame.saturating_sub(base) > self.cap_frames {
            base = end_frame.saturating_sub(self.cap_frames);
            self.base_frame.store(base, Ordering::Release);
        }

        for i in 0..frames {
            let f = start_frame.saturating_add(i as u64);
            if f < base {
                continue;
            }
            let idx = ((f % self.cap_frames) as usize) * 2;
            self.buf[idx].store(pcm[i * 2].to_bits(), Ordering::Relaxed);
            self.buf[idx + 1].store(pcm[i * 2 + 1].to_bits(), Ordering::Relaxed);
        }

        let prev = self.write_frame.load(Ordering::Acquire);
        if end_frame > prev {
            self.write_frame.store(end_frame, Ordering::Release);
        }
    }

    fn read_frame(&self, frame: u64) -> Option<(f32, f32)> {
        let base = self.base_frame.load(Ordering::Acquire);
        let write = self.write_frame.load(Ordering::Acquire);
        if frame < base || frame >= write {
            return None;
        }
        let idx = ((frame % self.cap_frames) as usize) * 2;
        let l = f32::from_bits(self.buf[idx].load(Ordering::Relaxed));
        let r = f32::from_bits(self.buf[idx + 1].load(Ordering::Relaxed));
        Some((l, r))
    }
}

#[derive(Debug, Clone)]
struct EngineClip {
    start_frame: u64,
    length_frames: u64,

    // Source PCM is always stereo and resampled to engine rate.
    src: ResampledStereo,

    // Source loop bounds in frames (end is exclusive).
    // For timeline clips we repeat within [src_start_frame, src_end_frame).
    // For file playback we do not repeat and treat src_end_frame as a hard end.
    src_start_frame: u64,
    src_end_frame: u64,
    playback_rate: f64,

    // Optional pitch-preserving, streaming time-stretch buffer.
    // When present and filled, we prefer it; otherwise we fall back to `src` + `playback_rate`.
    stretch_stream: Option<Arc<StreamRingStereo>>,

    repeat: bool,

    fade_in_frames: u64,
    fade_out_frames: u64,
    gain: f32,
}

#[derive(Debug, Clone)]
struct EngineSnapshot {
    bpm: f64,
    sample_rate: u32,
    duration_frames: u64,
    clips: Vec<EngineClip>,
}

impl EngineSnapshot {
    fn empty(sample_rate: u32) -> Self {
        Self {
            bpm: 120.0,
            sample_rate,
            duration_frames: 0,
            clips: vec![],
        }
    }
}

enum EngineCommand {
    UpdateTimeline(TimelineState),
    SeekSec { sec: f64 },
    SetPlaying { playing: bool, target: Option<String> },
    PlayFile { path: PathBuf, offset_sec: f64, target: String },
    StretchReady { key: StretchKey },
    Stop,
    Shutdown,
}

pub struct AudioEngine {
    tx: mpsc::Sender<EngineCommand>,

    is_playing: Arc<AtomicBool>,
    target: Arc<Mutex<Option<String>>>,
    base_frames: Arc<AtomicU64>,
    position_frames: Arc<AtomicU64>,
    duration_frames: Arc<AtomicU64>,
    sample_rate: Arc<AtomicU32>,
}

impl AudioEngine {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<EngineCommand>();
        let tx_for_worker = tx.clone();

        let is_playing = Arc::new(AtomicBool::new(false));
        let target = Arc::new(Mutex::new(None));
        let base_frames = Arc::new(AtomicU64::new(0));
        let position_frames = Arc::new(AtomicU64::new(0));
        let duration_frames = Arc::new(AtomicU64::new(0));
        let sample_rate = Arc::new(AtomicU32::new(44100));

        let is_playing_thread = is_playing.clone();
        let target_thread = target.clone();
        let base_frames_thread = base_frames.clone();
        let position_frames_thread = position_frames.clone();
        let duration_frames_thread = duration_frames.clone();
        let sample_rate_thread = sample_rate.clone();

        thread::spawn(move || {
            let host = cpal::default_host();
            let device = match host.default_output_device() {
                Some(d) => d,
                None => {
                    eprintln!("AudioEngine: no default output device");
                    loop {
                        match rx.recv() {
                            Ok(EngineCommand::Shutdown) | Err(_) => break,
                            Ok(_) => {
                                is_playing_thread.store(false, Ordering::Relaxed);
                                *target_thread.lock().unwrap() = None;
                            }
                        }
                    }
                    return;
                }
            };

            let default_config = match device.default_output_config() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("AudioEngine: default_output_config failed: {e}");
                    return;
                }
            };

            let sr = default_config.sample_rate().0;
            sample_rate_thread.store(sr, Ordering::Relaxed);

            let snapshot: Arc<ArcSwap<EngineSnapshot>> =
                Arc::new(ArcSwap::from_pointee(EngineSnapshot::empty(sr)));
            let snapshot_for_cb = snapshot.clone();

            // cache: (path, out_rate) -> stereo pcm
            let cache: Arc<Mutex<HashMap<(PathBuf, u32), ResampledStereo>>> =
                Arc::new(Mutex::new(HashMap::new()));
            let cache_for_cmd = cache.clone();

            // Time-stretch cache: computed, pitch-preserving loop buffers.
            let stretch_cache: Arc<Mutex<HashMap<StretchKey, ResampledStereo>>> =
                Arc::new(Mutex::new(HashMap::new()));
            let stretch_cache_for_cmd = stretch_cache.clone();
            let stretch_cache_for_worker = stretch_cache.clone();

            let stretch_inflight: Arc<Mutex<HashSet<StretchKey>>> =
                Arc::new(Mutex::new(HashSet::new()));
            let stretch_inflight_for_cmd = stretch_inflight.clone();
            let stretch_inflight_for_worker = stretch_inflight.clone();

            let (stretch_tx, stretch_rx) = mpsc::channel::<StretchJob>();

            // Worker that computes RubberBand stretches off the command thread.
            // Keep it small to avoid CPU spikes.
            {
                let cache = cache.clone();
                let stretch_cache = stretch_cache_for_worker.clone();
                let inflight = stretch_inflight_for_worker.clone();
                let tx_ready = tx_for_worker.clone();
                thread::spawn(move || loop {
                    let job = match stretch_rx.recv() {
                        Ok(j) => j,
                        Err(_) => break,
                    };

                    // If RubberBand isn't available, drop the job.
                    if !crate::rubberband::is_available() {
                        if let Ok(mut s) = inflight.lock() {
                            s.remove(&job.key);
                        }
                        continue;
                    }

                    let src = match get_resampled_stereo(&job.key.path, job.key.out_rate, &cache) {
                        Some(v) => v,
                        None => {
                            if let Ok(mut s) = inflight.lock() {
                                s.remove(&job.key);
                            }
                            continue;
                        }
                    };

                    let (src_start, src_end) = source_bounds_frames(
                        job.trim_start_beat,
                        job.trim_end_beat,
                        job.bpm,
                        src.frames,
                        job.key.out_rate,
                    );
                    let loop_in_frames = src_end.saturating_sub(src_start) as usize;
                    if loop_in_frames < 2 {
                        if let Ok(mut s) = inflight.lock() {
                            s.remove(&job.key);
                        }
                        continue;
                    }

                    let playback_rate = if job.playback_rate.is_finite() && job.playback_rate > 0.0 {
                        job.playback_rate
                    } else {
                        1.0
                    };
                    if (playback_rate - 1.0).abs() <= 1e-6 {
                        if let Ok(mut s) = inflight.lock() {
                            s.remove(&job.key);
                        }
                        continue;
                    }

                    let i0 = (src_start as usize) * 2;
                    let i1 = (src_end as usize) * 2;
                    if i1 > src.pcm.len() || i0 + 4 > i1 {
                        if let Ok(mut s) = inflight.lock() {
                            s.remove(&job.key);
                        }
                        continue;
                    }

                    let loop_pcm: Vec<f32> = src.pcm[i0..i1].to_vec();
                    let loop_out_frames = ((loop_in_frames as f64) / playback_rate)
                        .round()
                        .max(2.0) as usize;

                    let stretched = time_stretch_interleaved(
                        &loop_pcm,
                        2,
                        job.key.out_rate,
                        loop_out_frames,
                        StretchAlgorithm::RubberBand,
                    );

                    let stretched_src = ResampledStereo {
                        sample_rate: job.key.out_rate,
                        frames: loop_out_frames,
                        pcm: Arc::new(stretched),
                    };

                    if let Ok(mut m) = stretch_cache.lock() {
                        m.insert(job.key.clone(), stretched_src);
                    }

                    let _ = tx_ready.send(EngineCommand::StretchReady { key: job.key });
                });
            }

            // Helper to (re)build snapshot from timeline.
            let channels = default_config.channels() as usize;
            let sample_format = default_config.sample_format();
            let config: cpal::StreamConfig = default_config.into();

            let mut scratch_mix: Vec<f32> = Vec::new();

            // Clone atomics for the audio callback to avoid moving the originals.
            let is_playing_cb = is_playing_thread.clone();
            let position_frames_cb = position_frames_thread.clone();
            let duration_frames_cb = duration_frames_thread.clone();

            let err_fn = |err| eprintln!("AudioEngine stream error: {err}");

            let stream = match sample_format {
                cpal::SampleFormat::F32 => device
                    .build_output_stream(
                        &config,
                        move |data: &mut [f32], _| {
                            render_callback_f32(
                                data,
                                channels,
                                &snapshot_for_cb,
                                is_playing_cb.as_ref(),
                                position_frames_cb.as_ref(),
                                duration_frames_cb.as_ref(),
                                &mut scratch_mix,
                            );
                        },
                        err_fn,
                        None,
                    )
                    .ok(),
                cpal::SampleFormat::I16 => device
                    .build_output_stream(
                        &config,
                        move |data: &mut [i16], _| {
                            render_callback_i16(
                                data,
                                channels,
                                &snapshot_for_cb,
                                is_playing_cb.as_ref(),
                                position_frames_cb.as_ref(),
                                duration_frames_cb.as_ref(),
                                &mut scratch_mix,
                            );
                        },
                        err_fn,
                        None,
                    )
                    .ok(),
                cpal::SampleFormat::U16 => device
                    .build_output_stream(
                        &config,
                        move |data: &mut [u16], _| {
                            render_callback_u16(
                                data,
                                channels,
                                &snapshot_for_cb,
                                is_playing_cb.as_ref(),
                                position_frames_cb.as_ref(),
                                duration_frames_cb.as_ref(),
                                &mut scratch_mix,
                            );
                        },
                        err_fn,
                        None,
                    )
                    .ok(),
                _ => None,
            };

            let Some(stream) = stream else {
                eprintln!("AudioEngine: failed to build output stream");
                return;
            };

            if let Err(e) = stream.play() {
                eprintln!("AudioEngine: stream.play failed: {e}");
                return;
            }

            let mut last_timeline: Option<TimelineState> = None;
            let stretch_stream_epoch: Arc<AtomicU64> = Arc::new(AtomicU64::new(1));

            loop {
                match rx.recv() {
                    Ok(EngineCommand::Shutdown) | Err(_) => break,
                    Ok(EngineCommand::Stop) => {
                        is_playing_thread.store(false, Ordering::Relaxed);
                        *target_thread.lock().unwrap() = None;
                        base_frames_thread.store(0, Ordering::Relaxed);
                    }
                    Ok(EngineCommand::SeekSec { sec }) => {
                        let sec = sec.max(0.0);
                        let frame = (sec * sr as f64).round().max(0.0) as u64;
                        // Timeline playback reports absolute position via position_frames.
                        base_frames_thread.store(0, Ordering::Relaxed);
                        position_frames_thread.store(frame, Ordering::Relaxed);
                    }
                    Ok(EngineCommand::SetPlaying { playing, target }) => {
                        is_playing_thread.store(playing, Ordering::Relaxed);
                        *target_thread.lock().unwrap() = target;
                    }
                    Ok(EngineCommand::UpdateTimeline(tl)) => {
                        last_timeline = Some(tl.clone());

                        // Cancel any existing streamers; the new snapshot will respawn them.
                        stretch_stream_epoch.fetch_add(1, Ordering::Relaxed);

                        // Schedule stretch work in background (do not block snapshot build).
                        if crate::rubberband::is_available() {
                            schedule_stretch_jobs(
                                &tl,
                                sr,
                                &stretch_tx,
                                stretch_inflight_for_cmd.as_ref(),
                                &stretch_cache_for_cmd,
                            );
                        }

                        let snap = build_snapshot(
                            &tl,
                            sr,
                            &cache_for_cmd,
                            &stretch_cache_for_cmd,
                            &position_frames_thread,
                            &is_playing_thread,
                            &stretch_stream_epoch,
                        );
                        duration_frames_thread.store(snap.duration_frames, Ordering::Relaxed);
                        snapshot.store(Arc::new(snap));
                    }
                    Ok(EngineCommand::StretchReady { key }) => {
                        if let Ok(mut s) = stretch_inflight_for_cmd.lock() {
                            s.remove(&key);
                        }
                        // Switch to cache-backed buffers; stop any streaming workers.
                        stretch_stream_epoch.fetch_add(1, Ordering::Relaxed);
                        if let Some(tl) = last_timeline.as_ref() {
                            let snap = build_snapshot(
                                tl,
                                sr,
                                &cache_for_cmd,
                                &stretch_cache_for_cmd,
                                &position_frames_thread,
                                &is_playing_thread,
                                &stretch_stream_epoch,
                            );
                            duration_frames_thread.store(snap.duration_frames, Ordering::Relaxed);
                            snapshot.store(Arc::new(snap));
                        }
                    }
                    Ok(EngineCommand::PlayFile {
                        path,
                        offset_sec,
                        target,
                    }) => {
                        // Snapshot will be replaced; stop any timeline streamers.
                        stretch_stream_epoch.fetch_add(1, Ordering::Relaxed);
                        // Represent the file as a single clip in a snapshot.
                        let snap = build_snapshot_for_file(&path, sr, offset_sec, &cache_for_cmd);
                        duration_frames_thread.store(snap.duration_frames, Ordering::Relaxed);
                        snapshot.store(Arc::new(snap));
                        // File playback reports absolute position via base_sec + position_sec.
                        let base = (offset_sec.max(0.0) * sr as f64).round().max(0.0) as u64;
                        base_frames_thread.store(base, Ordering::Relaxed);
                        position_frames_thread.store(0, Ordering::Relaxed);
                        is_playing_thread.store(true, Ordering::Relaxed);
                        *target_thread.lock().unwrap() = Some(target);
                    }
                }
            }
        });

        Self {
            tx,
            is_playing,
            target,
            base_frames,
            position_frames,
            duration_frames,
            sample_rate,
        }
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(EngineCommand::Shutdown);
    }

    pub fn update_timeline(&self, timeline: TimelineState) {
        let _ = self.tx.send(EngineCommand::UpdateTimeline(timeline));
    }

    pub fn seek_sec(&self, sec: f64) {
        let _ = self.tx.send(EngineCommand::SeekSec { sec });
    }

    pub fn set_playing(&self, playing: bool, target: Option<&str>) {
        let _ = self.tx.send(EngineCommand::SetPlaying {
            playing,
            target: target.map(|s| s.to_string()),
        });
    }

    pub fn play_file(&self, path: &Path, offset_sec: f64, target: &str) {
        let _ = self.tx.send(EngineCommand::PlayFile {
            path: path.to_path_buf(),
            offset_sec,
            target: target.to_string(),
        });
    }

    pub fn stop(&self) {
        let _ = self.tx.send(EngineCommand::Stop);
    }

    pub fn is_playing(&self) -> bool {
        self.is_playing.load(Ordering::Relaxed)
    }

    pub fn snapshot_state(&self) -> AudioEngineStateSnapshot {
        let sr = self.sample_rate.load(Ordering::Relaxed).max(1);
        let base = self.base_frames.load(Ordering::Relaxed);
        let pos = self.position_frames.load(Ordering::Relaxed);
        let dur = self.duration_frames.load(Ordering::Relaxed);
        AudioEngineStateSnapshot {
            is_playing: self.is_playing(),
            target: self.target.lock().unwrap().clone(),
            base_sec: base as f64 / sr as f64,
            position_sec: pos as f64 / sr as f64,
            duration_sec: dur as f64 / sr as f64,
            sample_rate: sr,
        }
    }
}

fn beat_to_sec(beat: f64, bpm: f64) -> f64 {
    let bpm = if bpm.is_finite() && bpm > 0.0 { bpm } else { 120.0 };
    beat * 60.0 / bpm
}

fn clamp01(x: f32) -> f32 {
    if x < 0.0 {
        0.0
    } else if x > 1.0 {
        1.0
    } else {
        x
    }
}

fn clamp11(x: f32) -> f32 {
    if x < -1.0 {
        -1.0
    } else if x > 1.0 {
        1.0
    } else {
        x
    }
}

fn linear_resample_interleaved(
    input: &[f32],
    channels: usize,
    in_rate: u32,
    out_rate: u32,
) -> Vec<f32> {
    if input.is_empty() || channels == 0 {
        return vec![];
    }
    if in_rate == out_rate {
        return input.to_vec();
    }

    let in_frames = input.len() / channels;
    if in_frames < 2 {
        return input.to_vec();
    }

    let ratio = out_rate as f64 / in_rate as f64;
    let out_frames = ((in_frames as f64) * ratio).round().max(1.0) as usize;
    let mut out = vec![0.0f32; out_frames * channels];

    for of in 0..out_frames {
        let t_in = (of as f64) / ratio;
        let i0 = t_in.floor() as isize;
        let frac = (t_in - (i0 as f64)) as f32;
        let i0 = i0.clamp(0, (in_frames - 1) as isize) as usize;
        let i1 = (i0 + 1).min(in_frames - 1);

        for ch in 0..channels {
            let a = input[i0 * channels + ch];
            let b = input[i1 * channels + ch];
            out[of * channels + ch] = a + (b - a) * frac;
        }
    }

    out
}

fn compute_track_gains(tracks: &[Track]) -> HashMap<String, (f32, bool, bool)> {
    fn build_parent_map(tracks: &[Track]) -> HashMap<String, Option<String>> {
        let mut map = HashMap::new();
        for t in tracks {
            map.insert(t.id.clone(), t.parent_id.clone());
        }
        map
    }

    fn track_lineage(track_id: &str, parent_map: &HashMap<String, Option<String>>) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = Some(track_id.to_string());
        let mut safety = 0;
        while let Some(id) = cur {
            out.push(id.clone());
            cur = parent_map.get(&id).and_then(|p| p.clone());
            safety += 1;
            if safety > 2048 {
                break;
            }
        }
        out
    }

    let parent_map = build_parent_map(tracks);
    let by_id: HashMap<String, Track> = tracks
        .iter()
        .cloned()
        .map(|t| (t.id.clone(), t))
        .collect();

    let any_solo = tracks.iter().any(|t| t.solo);
    let mut out = HashMap::new();

    for t in tracks {
        let lineage = track_lineage(&t.id, &parent_map);

        let mut gain = 1.0f32;
        let mut muted = false;
        let mut soloed = false;
        for id in &lineage {
            if let Some(node) = by_id.get(id) {
                gain *= clamp01(node.volume);
                muted |= node.muted;
                soloed |= node.solo;
            }
        }

        if any_solo {
            out.insert(t.id.clone(), (gain, muted, soloed));
        } else {
            out.insert(t.id.clone(), (gain, muted, true));
        }
    }

    out
}

fn is_audio_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            matches!(e.as_str(), "wav" | "mp3" | "flac" | "ogg" | "m4a" | "aac")
        })
        .unwrap_or(false)
}

fn read_wav_f32_interleaved(path: &Path) -> Option<(u32, u16, Vec<f32>)> {
    use hound::{SampleFormat, WavReader};

    let mut reader = WavReader::open(path).ok()?;
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return None;
    }

    let channels = spec.channels;
    let sample_rate = spec.sample_rate;

    let mut out: Vec<f32> = Vec::with_capacity(reader.duration() as usize);

    match (spec.sample_format, spec.bits_per_sample) {
        (SampleFormat::Int, 16) => {
            for s in reader.samples::<i16>() {
                let v = s.ok()? as f32 / i16::MAX as f32;
                out.push(v);
            }
        }
        (SampleFormat::Int, 24) => {
            let denom = (1u32 << 23) as f32;
            for s in reader.samples::<i32>() {
                let v = s.ok()? as f32 / denom;
                out.push(v);
            }
        }
        (SampleFormat::Int, 32) => {
            for s in reader.samples::<i32>() {
                let v = s.ok()? as f32 / i32::MAX as f32;
                out.push(v);
            }
        }
        (SampleFormat::Float, 32) => {
            for s in reader.samples::<f32>() {
                out.push(s.ok()?);
            }
        }
        _ => return None,
    }

    Some((sample_rate, channels, out))
}

fn decode_audio_f32_interleaved(path: &Path) -> Result<(u32, usize, Vec<f32>), String> {
    // Fast-path WAV via hound.
    if path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("wav"))
        .unwrap_or(false)
    {
        if let Some((sr, ch, pcm)) = read_wav_f32_interleaved(path) {
            return Ok((sr, ch as usize, pcm));
        }
    }

    use symphonia::core::audio::{AudioBufferRef, Signal};
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::errors::Error;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| e.to_string())?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| "no default track".to_string())?;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| e.to_string())?;

    let sample_rate = track.codec_params.sample_rate.ok_or_else(|| {
        "missing sample_rate in codec params".to_string()
    })?;

    let channels = track
        .codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(1);

    let mut out: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(_)) => break,
            Err(Error::ResetRequired) => {
                return Err("decoder reset required".to_string())
            }
            Err(e) => return Err(e.to_string()),
        };

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(Error::IoError(_)) => break,
            Err(Error::DecodeError(_)) => continue,
            Err(e) => return Err(e.to_string()),
        };

        match decoded {
            AudioBufferRef::F32(buf) => {
                let frames = buf.frames();
                let planes_buf = buf.planes();
                let planes = planes_buf.planes();
                for f in 0..frames {
                    for ch in 0..channels {
                        let v = planes
                            .get(ch)
                            .and_then(|p| p.get(f))
                            .copied()
                            .unwrap_or(0.0);
                        out.push(v);
                    }
                }
            }
            _ => {
                // Convert anything else into f32 interleaved.
                let spec = *decoded.spec();
                let duration = decoded.capacity() as u64;
                let mut sbuf = symphonia::core::audio::SampleBuffer::<f32>::new(duration, spec);
                sbuf.copy_interleaved_ref(decoded);
                out.extend_from_slice(sbuf.samples());
            }
        }
    }

    Ok((sample_rate, channels, out))
}

fn get_resampled_stereo(
    path: &Path,
    out_rate: u32,
    cache: &Arc<Mutex<HashMap<(PathBuf, u32), ResampledStereo>>>,
) -> Option<ResampledStereo> {
    if !path.exists() {
        return None;
    }

    let key = (path.to_path_buf(), out_rate);
    if let Ok(map) = cache.lock() {
        if let Some(v) = map.get(&key) {
            return Some(v.clone());
        }
    }

    let (in_rate, in_channels, pcm) = match decode_audio_f32_interleaved(path) {
        Ok(v) => v,
        Err(e) => {
            if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
                eprintln!("AudioEngine: decode failed: path={} err={}", path.display(), e);
            }
            return None;
        }
    };
    let in_channels = in_channels.max(1);

    let resampled = linear_resample_interleaved(&pcm, in_channels, in_rate, out_rate);

    let stereo: Vec<f32> = if in_channels == 1 {
        let mut out = Vec::with_capacity(resampled.len() * 2);
        for s in resampled {
            out.push(s);
            out.push(s);
        }
        out
    } else {
        let frames = resampled.len() / in_channels;
        let mut out = Vec::with_capacity(frames * 2);
        for f in 0..frames {
            out.push(resampled[f * in_channels]);
            out.push(resampled[f * in_channels + 1]);
        }
        out
    };

    let frames = stereo.len() / 2;
    let v = ResampledStereo {
        sample_rate: out_rate,
        frames,
        pcm: Arc::new(stereo),
    };

    if let Ok(mut map) = cache.lock() {
        map.insert(key, v.clone());
    }

    Some(v)
}

fn source_bounds_frames(
    trim_start_beat: f64,
    trim_end_beat: f64,
    bpm: f64,
    src_total_frames: usize,
    sr: u32,
) -> (u64, u64) {
    let bs = 60.0 / bpm.max(1e-6);
    let trim_start_sec = trim_start_beat.max(0.0) * bs;
    let trim_end_sec = trim_end_beat.max(0.0) * bs;

    let total_sec = (src_total_frames as f64) / sr.max(1) as f64;
    let start = (trim_start_sec * sr as f64).round().max(0.0);
    let end_limit_sec = (total_sec - trim_end_sec).max(trim_start_sec);
    let end = (end_limit_sec * sr as f64).round().max(start);

    // Keep within source length.
    let max_start = src_total_frames.saturating_sub(1) as u64;
    let mut start_u = (start as u64).min(max_start);
    let mut end_u = (end as u64).min(src_total_frames as u64);
    if end_u <= start_u {
        end_u = (start_u + 1).min(src_total_frames as u64);
    }
    // Ensure exclusive end.
    if end_u > src_total_frames as u64 {
        end_u = src_total_frames as u64;
    }
    if start_u >= end_u {
        start_u = end_u.saturating_sub(1);
    }
    (start_u, end_u)
}

fn clip_source_bounds_frames(clip: &Clip, bpm: f64, src_total_frames: usize, sr: u32) -> (u64, u64) {
    source_bounds_frames(
        clip.trim_start_beat,
        clip.trim_end_beat,
        bpm,
        src_total_frames,
        sr,
    )
}

fn quantize_i64(x: f64, scale: f64) -> i64 {
    if !x.is_finite() {
        return 0;
    }
    (x * scale).round() as i64
}

fn quantize_u32(x: f64, scale: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    let v = (x * scale).round();
    if v <= 0.0 {
        0
    } else if v > (u32::MAX as f64) {
        u32::MAX
    } else {
        v as u32
    }
}

fn make_stretch_key(path: &Path, out_rate: u32, bpm: f64, trim_start: f64, trim_end: f64, playback_rate: f64) -> StretchKey {
    StretchKey {
        path: path.to_path_buf(),
        out_rate,
        bpm_q: quantize_u32(bpm, 100.0),
        trim_start_q: quantize_i64(trim_start, 1000.0),
        trim_end_q: quantize_i64(trim_end, 1000.0),
        playback_rate_q: quantize_u32(playback_rate, 10000.0),
    }
}

fn schedule_stretch_jobs(
    timeline: &TimelineState,
    out_rate: u32,
    stretch_tx: &mpsc::Sender<StretchJob>,
    inflight: &Mutex<HashSet<StretchKey>>,
    stretch_cache: &Arc<Mutex<HashMap<StretchKey, ResampledStereo>>>,
) {
    let bpm = if timeline.bpm.is_finite() && timeline.bpm > 0.0 {
        timeline.bpm
    } else {
        120.0
    };

    let track_gain = compute_track_gains(&timeline.tracks);
    let mut audible_tracks: HashSet<String> = HashSet::new();
    for (tid, (_gain, muted, solo_ok)) in &track_gain {
        if !*muted && *solo_ok {
            audible_tracks.insert(tid.clone());
        }
    }

    for clip in &timeline.clips {
        if clip.muted {
            continue;
        }
        if !audible_tracks.contains(&clip.track_id) {
            continue;
        }
        let Some(source_path) = clip.source_path.as_ref() else {
            continue;
        };
        let playback_rate = clip.playback_rate as f64;
        let playback_rate = if playback_rate.is_finite() && playback_rate > 0.0 {
            playback_rate
        } else {
            1.0
        };
        if (playback_rate - 1.0).abs() <= 1e-6 {
            continue;
        }
        let path = Path::new(source_path);
        if !is_audio_path(path) {
            continue;
        }

        let key = make_stretch_key(
            path,
            out_rate,
            bpm,
            clip.trim_start_beat,
            clip.trim_end_beat,
            playback_rate,
        );

        if let Ok(m) = stretch_cache.lock() {
            if m.contains_key(&key) {
                continue;
            }
        }

        let should_enqueue = if let Ok(mut s) = inflight.lock() {
            if s.contains(&key) {
                false
            } else {
                s.insert(key.clone());
                true
            }
        } else {
            false
        };
        if !should_enqueue {
            continue;
        }

        let _ = stretch_tx.send(StretchJob {
            key,
            bpm,
            trim_start_beat: clip.trim_start_beat,
            trim_end_beat: clip.trim_end_beat,
            playback_rate,
        });
    }
}

fn build_snapshot(
    timeline: &TimelineState,
    out_rate: u32,
    cache: &Arc<Mutex<HashMap<(PathBuf, u32), ResampledStereo>>>,
    stretch_cache: &Arc<Mutex<HashMap<StretchKey, ResampledStereo>>>,
    position_frames: &Arc<AtomicU64>,
    is_playing: &Arc<AtomicBool>,
    stretch_stream_epoch: &Arc<AtomicU64>,
) -> EngineSnapshot {
    let bpm = if timeline.bpm.is_finite() && timeline.bpm > 0.0 {
        timeline.bpm
    } else {
        120.0
    };
    let bs = 60.0 / bpm;

    let duration_frames = ((timeline.project_beats.max(0.0) * bs) * out_rate as f64)
        .round()
        .max(0.0) as u64;

    let track_gain = compute_track_gains(&timeline.tracks);
    let mut audible_tracks: HashSet<String> = HashSet::new();
    for (tid, (_gain, muted, solo_ok)) in &track_gain {
        if !*muted && *solo_ok {
            audible_tracks.insert(tid.clone());
        }
    }

    let mut clips_out: Vec<EngineClip> = Vec::new();

    for clip in &timeline.clips {
        if clip.muted {
            continue;
        }
        if !audible_tracks.contains(&clip.track_id) {
            continue;
        }
        let Some(source_path) = clip.source_path.as_ref() else {
            continue;
        };
        let path = Path::new(source_path);
        if !is_audio_path(path) {
            continue;
        }

        let (track_gain_value, _tmuted, _solo_ok) = track_gain
            .get(&clip.track_id)
            .cloned()
            .unwrap_or((1.0, false, true));

        let gain = (clip.gain.max(0.0) * track_gain_value).clamp(0.0, 4.0);
        if gain <= 0.0 {
            continue;
        }

        let timeline_len_sec = (clip.length_beats.max(0.0) * bs).max(0.0);
        if !(timeline_len_sec.is_finite() && timeline_len_sec > 1e-6) {
            continue;
        }
        let length_frames = (timeline_len_sec * out_rate as f64).round().max(1.0) as u64;

        let start_sec = (clip.start_beat.max(0.0)) * bs;
        let start_frame = (start_sec * out_rate as f64).round().max(0.0) as u64;

        let playback_rate = clip.playback_rate as f64;
        let playback_rate = if playback_rate.is_finite() && playback_rate > 0.0 {
            playback_rate
        } else {
            1.0
        };

        let src = match get_resampled_stereo(path, out_rate, cache) {
            Some(v) => v,
            None => continue,
        };

        let (mut src_start, mut src_end) = clip_source_bounds_frames(clip, bpm, src.frames, out_rate);
        if src_end.saturating_sub(src_start) <= 1 {
            continue;
        }

        let mut repeat = true;
        let mut stretch_stream: Option<Arc<StreamRingStereo>> = None;

        // If playback_rate != 1, prefer an asynchronously precomputed, pitch-preserving buffer.
        // Never block snapshot building here.
        let mut src_render = src;
        let mut playback_rate_render = playback_rate;
        if (playback_rate - 1.0).abs() > 1e-6 {
            let key = make_stretch_key(
                path,
                out_rate,
                bpm,
                clip.trim_start_beat,
                clip.trim_end_beat,
                playback_rate,
            );
            if let Ok(m) = stretch_cache.lock() {
                if let Some(stretched) = m.get(&key) {
                    src_render = stretched.clone();
                    src_start = 0;
                    src_end = src_render.frames as u64;
                    playback_rate_render = 1.0;
                    repeat = false;
                }
            }

            // Streaming stage (low-latency): if cache is missing, start a realtime stretcher
            // that incrementally fills a small ring buffer for the audio callback.
            if (playback_rate_render - 1.0).abs() > 1e-6 && crate::rubberband::is_available() {
                let cap_frames = (out_rate as u64).saturating_mul(2); // ~2s buffer
                let ring = Arc::new(StreamRingStereo::new(cap_frames));
                let ring_for_thread = ring.clone();

                // Start close to current playhead to reduce perceived delay.
                let now = position_frames.load(Ordering::Relaxed);
                let local0 = if now > start_frame { now - start_frame } else { 0 };
                ring.reset(local0);

                let my_epoch = stretch_stream_epoch.load(Ordering::Relaxed);
                let epoch = stretch_stream_epoch.clone();
                let playing = is_playing.clone();
                let pos = position_frames.clone();

                let src_for_thread = src_render.clone();
                let src_start_u = src_start;
                let src_end_u = src_end;
                let pr = playback_rate_render;
                let clip_len = length_frames;
                let repeat_clip = repeat;

                thread::spawn(move || {
                    let time_ratio = 1.0 / pr.max(1e-6);
                    let mut rb = match crate::rubberband::RubberBandRealtimeStretcher::new(out_rate, 2, time_ratio) {
                        Ok(v) => v,
                        Err(_) => return,
                    };

                    let src_pcm = src_for_thread.pcm.as_slice();
                    let src_total = src_for_thread.frames as u64;

                    let mut out_cursor: u64 = local0;
                    let mut in_cursor: u64 = src_start_u;

                    let mut in_block: Vec<f32> = vec![0.0; 1024 * 2];
                    let mut out_block: Vec<f32> = Vec::with_capacity(2048 * 2);

                    loop {
                        if epoch.load(Ordering::Relaxed) != my_epoch {
                            break;
                        }
                        if !playing.load(Ordering::Relaxed) {
                            std::thread::sleep(std::time::Duration::from_millis(8));
                            continue;
                        }

                        let now_abs = pos.load(Ordering::Relaxed);
                        let local = if now_abs > start_frame { now_abs - start_frame } else { 0 };
                        if local >= clip_len {
                            std::thread::sleep(std::time::Duration::from_millis(8));
                            continue;
                        }

                        // Reset on large jumps (seek).
                        let base = ring_for_thread.base_frame.load(Ordering::Acquire);
                        let write = ring_for_thread.write_frame.load(Ordering::Acquire);
                        if local < base || local > write.saturating_add(4096) {
                            let _ = rb.reset(time_ratio);
                            ring_for_thread.reset(local);
                            out_cursor = local;

                            let start_in = (local as f64 * pr).floor().max(0.0) as u64;
                            if repeat_clip {
                                let loop_len = src_end_u.saturating_sub(src_start_u).max(1);
                                in_cursor = src_start_u + (start_in % loop_len);
                            } else {
                                in_cursor = (src_start_u + start_in).min(src_end_u);
                            }
                        }

                        // Maintain some lookahead.
                        let ahead = write.saturating_sub(local);
                        if ahead >= 4096 {
                            std::thread::sleep(std::time::Duration::from_millis(2));
                            continue;
                        }

                        // Fill an input block from the source window.
                        let mut want_in = 1024usize;
                        if !repeat_clip {
                            if in_cursor >= src_end_u {
                                std::thread::sleep(std::time::Duration::from_millis(4));
                                continue;
                            }
                            let remain = src_end_u.saturating_sub(in_cursor) as usize;
                            want_in = want_in.min(remain.max(1));
                        }

                        for i in 0..want_in {
                            let src_f = if repeat_clip {
                                let loop_len = src_end_u.saturating_sub(src_start_u).max(1);
                                let within = (in_cursor.saturating_sub(src_start_u) + i as u64) % loop_len;
                                (src_start_u + within).min(src_total.saturating_sub(1))
                            } else {
                                (in_cursor + i as u64).min(src_total.saturating_sub(1))
                            };
                            let si = (src_f as usize) * 2;
                            in_block[i * 2] = src_pcm.get(si).copied().unwrap_or(0.0);
                            in_block[i * 2 + 1] = src_pcm.get(si + 1).copied().unwrap_or(0.0);
                        }

                        let _ = rb.process_interleaved(&in_block[..want_in * 2], false);
                        in_cursor = in_cursor.saturating_add(want_in as u64);
                        if repeat_clip {
                            let loop_len = src_end_u.saturating_sub(src_start_u).max(1);
                            if in_cursor >= src_end_u {
                                in_cursor = src_start_u + ((in_cursor - src_start_u) % loop_len);
                            }
                        }

                        out_block.clear();
                        for _ in 0..4 {
                            let got = match rb.retrieve_interleaved_into(&mut out_block, 1024) {
                                Ok(g) => g,
                                Err(_) => 0,
                            };
                            if got == 0 {
                                break;
                            }
                        }

                        if !out_block.is_empty() {
                            ring_for_thread.write_interleaved(out_cursor, out_block.as_slice());
                            out_cursor = out_cursor.saturating_add((out_block.len() / 2) as u64);
                        }
                    }
                });

                stretch_stream = Some(ring);
            }
        }

        let fade_in_frames = ((clip.fade_in_beats.max(0.0) * bs) * out_rate as f64)
            .round()
            .max(0.0) as u64;
        let fade_out_frames = ((clip.fade_out_beats.max(0.0) * bs) * out_rate as f64)
            .round()
            .max(0.0) as u64;

        clips_out.push(EngineClip {
            start_frame,
            length_frames,
            src: src_render,
            src_start_frame: src_start,
            src_end_frame: src_end,
            playback_rate: playback_rate_render,
            stretch_stream,
            repeat,
            fade_in_frames,
            fade_out_frames,
            gain,
        });
    }

    clips_out.sort_by_key(|c| c.start_frame);

    if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
        eprintln!(
            "AudioEngine: snapshot built: tracks={} clips_in_timeline={} clips_audible={} duration_frames={} sr={}",
            timeline.tracks.len(),
            timeline.clips.len(),
            clips_out.len(),
            duration_frames,
            out_rate
        );
        if let Some(c0) = clips_out.first() {
            eprintln!(
                "AudioEngine: first clip: start_frame={} len_frames={} src_start={:.1} src_end={:.1} gain={:.3} rate={:.3}",
                c0.start_frame,
                c0.length_frames,
                c0.src_start_frame,
                c0.src_end_frame,
                c0.gain,
                c0.playback_rate
            );
        }
    }

    EngineSnapshot {
        bpm,
        sample_rate: out_rate,
        duration_frames,
        clips: clips_out,
    }
}

fn build_snapshot_for_file(
    path: &Path,
    out_rate: u32,
    offset_sec: f64,
    cache: &Arc<Mutex<HashMap<(PathBuf, u32), ResampledStereo>>>,
) -> EngineSnapshot {
    let src = match get_resampled_stereo(path, out_rate, cache) {
        Some(v) => v,
        None => return EngineSnapshot::empty(out_rate),
    };

    let offset_frames = (offset_sec.max(0.0) * out_rate as f64).round().max(0.0) as u64;
    let offset_frames = offset_frames.min(src.frames.saturating_sub(1) as u64);
    let available_frames = src.frames.saturating_sub(offset_frames as usize);
    let length_frames = available_frames.max(1) as u64;
    let src_end_frame = offset_frames
        .saturating_add(length_frames)
        .min(src.frames as u64);

    EngineSnapshot {
        bpm: 120.0,
        sample_rate: out_rate,
        duration_frames: length_frames,
        clips: vec![EngineClip {
            start_frame: 0,
            length_frames,
            src,
            src_start_frame: offset_frames,
            src_end_frame,
            playback_rate: 1.0,
            stretch_stream: None,
            repeat: false,
            fade_in_frames: 0,
            fade_out_frames: 0,
            gain: 1.0,
        }],
    }
}

fn mix_into_scratch_stereo(
    frames: usize,
    snapshot: &Arc<ArcSwap<EngineSnapshot>>,
    is_playing: &AtomicBool,
    position_frames: &AtomicU64,
    duration_frames: &AtomicU64,
    scratch: &mut Vec<f32>,
) {
    scratch.resize(frames * 2, 0.0);
    scratch.fill(0.0);

    if !is_playing.load(Ordering::Relaxed) {
        return;
    }

    let snap = snapshot.load();
    let pos0 = position_frames.load(Ordering::Relaxed);
    let pos1 = pos0.saturating_add(frames as u64);

    for clip in &snap.clips {
        let clip_start = clip.start_frame;
        let clip_end = clip.start_frame.saturating_add(clip.length_frames);
        if clip_end <= pos0 || clip_start >= pos1 {
            continue;
        }

        let overlap_start = clip_start.max(pos0);
        let overlap_end = clip_end.min(pos1);
        if overlap_end <= overlap_start {
            continue;
        }

        let out_off = (overlap_start - pos0) as usize;
        let clip_off = (overlap_start - clip_start) as u64;
        let mix_frames = (overlap_end - overlap_start) as usize;

        let src_pcm = clip.src.pcm.as_slice();
        let src_frames = clip.src.frames as u64;
        let loop_len = clip.src_end_frame.saturating_sub(clip.src_start_frame) as f64;

        for f in 0..mix_frames {
            let local = clip_off + f as u64;

            let mut g = clip.gain;
            if clip.fade_in_frames > 0 && local < clip.fade_in_frames {
                g *= (local as f32 / clip.fade_in_frames as f32).clamp(0.0, 1.0);
            }
            if clip.fade_out_frames > 0 && local + clip.fade_out_frames > clip.length_frames {
                let remain = clip.length_frames.saturating_sub(local);
                g *= (remain as f32 / clip.fade_out_frames as f32).clamp(0.0, 1.0);
            }
            if g <= 0.0 {
                continue;
            }

            let (l, r) = if let Some(stream) = clip.stretch_stream.as_ref() {
                if let Some((sl, sr)) = stream.read_frame(local) {
                    (sl * g, sr * g)
                } else {
                    // Fallback while the streamer warms up.
                    let src_pos = if clip.repeat {
                        if loop_len <= 1.0 {
                            continue;
                        }
                        let within = ((local as f64) * clip.playback_rate).rem_euclid(loop_len);
                        (clip.src_start_frame as f64) + within
                    } else {
                        (clip.src_start_frame as f64) + (local as f64) * clip.playback_rate
                    };

                    if !clip.repeat {
                        if src_pos + 1.0 >= clip.src_end_frame as f64 {
                            continue;
                        }
                    }

                    let i0 = src_pos.floor().max(0.0) as u64;
                    if i0 >= src_frames {
                        continue;
                    }
                    let mut i1 = i0.saturating_add(1);
                    if clip.repeat {
                        if i1 >= clip.src_end_frame {
                            i1 = clip.src_start_frame;
                        }
                    } else if i1 >= src_frames {
                        continue;
                    }

                    let frac = (src_pos - (i0 as f64)) as f32;

                    let i0u = i0 as usize;
                    let i1u = i1 as usize;

                    let l0 = src_pcm[i0u * 2];
                    let r0 = src_pcm[i0u * 2 + 1];
                    let l1 = src_pcm[i1u * 2];
                    let r1 = src_pcm[i1u * 2 + 1];

                    let l = l0 + (l1 - l0) * frac;
                    let r = r0 + (r1 - r0) * frac;
                    (l * g, r * g)
                }
            } else {
                let src_pos = if clip.repeat {
                    if loop_len <= 1.0 {
                        continue;
                    }
                    let within = ((local as f64) * clip.playback_rate).rem_euclid(loop_len);
                    (clip.src_start_frame as f64) + within
                } else {
                    (clip.src_start_frame as f64) + (local as f64) * clip.playback_rate
                };

                if !clip.repeat {
                    if src_pos + 1.0 >= clip.src_end_frame as f64 {
                        continue;
                    }
                }

                let i0 = src_pos.floor().max(0.0) as u64;
                if i0 >= src_frames {
                    continue;
                }
                let mut i1 = i0.saturating_add(1);
                if clip.repeat {
                    if i1 >= clip.src_end_frame {
                        i1 = clip.src_start_frame;
                    }
                } else if i1 >= src_frames {
                    continue;
                }

                let frac = (src_pos - (i0 as f64)) as f32;

                let i0u = i0 as usize;
                let i1u = i1 as usize;

                let l0 = src_pcm[i0u * 2];
                let r0 = src_pcm[i0u * 2 + 1];
                let l1 = src_pcm[i1u * 2];
                let r1 = src_pcm[i1u * 2 + 1];

                let l = l0 + (l1 - l0) * frac;
                let r = r0 + (r1 - r0) * frac;
                (l * g, r * g)
            };

            let oi = (out_off + f) * 2;
            scratch[oi] += l;
            scratch[oi + 1] += r;
        }
    }

    let new_pos = pos0.saturating_add(frames as u64);
    position_frames.store(new_pos, Ordering::Relaxed);

    let dur = duration_frames.load(Ordering::Relaxed);
    if dur > 0 && new_pos >= dur {
        is_playing.store(false, Ordering::Relaxed);
    }
}

fn render_callback_f32(
    data: &mut [f32],
    out_channels: usize,
    snapshot: &Arc<ArcSwap<EngineSnapshot>>,
    is_playing: &AtomicBool,
    position_frames: &AtomicU64,
    duration_frames: &AtomicU64,
    scratch: &mut Vec<f32>,
) {
    let frames = if out_channels == 0 {
        0
    } else {
        data.len() / out_channels
    };
    if frames == 0 {
        return;
    }

    let was_playing = is_playing.load(Ordering::Relaxed);
    if !was_playing {
        data.fill(0.0);
        return;
    }

    mix_into_scratch_stereo(
        frames,
        snapshot,
        is_playing,
        position_frames,
        duration_frames,
        scratch,
    );

    for f in 0..frames {
        let l = clamp11(scratch[f * 2]);
        let r = clamp11(scratch[f * 2 + 1]);
        if out_channels == 1 {
            data[f] = (l + r) * 0.5;
        } else {
            let base = f * out_channels;
            data[base] = l;
            data[base + 1] = r;
            for ch in 2..out_channels {
                data[base + ch] = 0.0;
            }
        }
    }
}

fn render_callback_i16(
    data: &mut [i16],
    out_channels: usize,
    snapshot: &Arc<ArcSwap<EngineSnapshot>>,
    is_playing: &AtomicBool,
    position_frames: &AtomicU64,
    duration_frames: &AtomicU64,
    scratch: &mut Vec<f32>,
) {
    let frames = if out_channels == 0 {
        0
    } else {
        data.len() / out_channels
    };
    if frames == 0 {
        return;
    }

    if !is_playing.load(Ordering::Relaxed) {
        data.fill(0);
        return;
    }

    mix_into_scratch_stereo(
        frames,
        snapshot,
        is_playing,
        position_frames,
        duration_frames,
        scratch,
    );

    for f in 0..frames {
        let l = clamp11(scratch[f * 2]);
        let r = clamp11(scratch[f * 2 + 1]);
        if out_channels == 1 {
            let v = clamp11((l + r) * 0.5);
            data[f] = (v * i16::MAX as f32) as i16;
        } else {
            let base = f * out_channels;
            data[base] = (l * i16::MAX as f32) as i16;
            data[base + 1] = (r * i16::MAX as f32) as i16;
            for ch in 2..out_channels {
                data[base + ch] = 0;
            }
        }
    }
}

fn render_callback_u16(
    data: &mut [u16],
    out_channels: usize,
    snapshot: &Arc<ArcSwap<EngineSnapshot>>,
    is_playing: &AtomicBool,
    position_frames: &AtomicU64,
    duration_frames: &AtomicU64,
    scratch: &mut Vec<f32>,
) {
    let frames = if out_channels == 0 {
        0
    } else {
        data.len() / out_channels
    };
    if frames == 0 {
        return;
    }

    if !is_playing.load(Ordering::Relaxed) {
        data.fill(u16::MAX / 2);
        return;
    }

    mix_into_scratch_stereo(
        frames,
        snapshot,
        is_playing,
        position_frames,
        duration_frames,
        scratch,
    );

    for f in 0..frames {
        let l = clamp11(scratch[f * 2]);
        let r = clamp11(scratch[f * 2 + 1]);
        if out_channels == 1 {
            let v = clamp11((l + r) * 0.5);
            let s = ((v * 0.5 + 0.5) * u16::MAX as f32).round();
            data[f] = s.clamp(0.0, u16::MAX as f32) as u16;
        } else {
            let base = f * out_channels;
            let sl = ((l * 0.5 + 0.5) * u16::MAX as f32).round();
            let sr = ((r * 0.5 + 0.5) * u16::MAX as f32).round();
            data[base] = sl.clamp(0.0, u16::MAX as f32) as u16;
            data[base + 1] = sr.clamp(0.0, u16::MAX as f32) as u16;
            for ch in 2..out_channels {
                data[base + ch] = u16::MAX / 2;
            }
        }
    }
}
