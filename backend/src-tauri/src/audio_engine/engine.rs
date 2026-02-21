use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread;

use arc_swap::ArcSwap;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::state::TimelineState;
use crate::time_stretch::{time_stretch_interleaved, StretchAlgorithm};

use super::io::get_resampled_stereo;
use super::mix::{render_callback_f32, render_callback_i16, render_callback_u16};
use super::snapshot::{build_snapshot, build_snapshot_for_file, schedule_stretch_jobs, source_bounds_frames};
use super::types::{AudioEngineStateSnapshot, EngineCommand, EngineSnapshot, ResampledStereo, StretchJob, StretchKey};

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
                                *target_thread.lock().unwrap_or_else(|e| e.into_inner()) = None;
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
                            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                render_callback_f32(
                                    data,
                                    channels,
                                    &snapshot_for_cb,
                                    is_playing_cb.as_ref(),
                                    position_frames_cb.as_ref(),
                                    duration_frames_cb.as_ref(),
                                    &mut scratch_mix,
                                );
                            }));
                            if r.is_err() {
                                eprintln!(
                                    "AudioEngine: panic in audio callback (f32); silencing output"
                                );
                                data.fill(0.0);
                                is_playing_cb.store(false, Ordering::Relaxed);
                            }
                        },
                        err_fn,
                        None,
                    )
                    .ok(),
                cpal::SampleFormat::I16 => device
                    .build_output_stream(
                        &config,
                        move |data: &mut [i16], _| {
                            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                render_callback_i16(
                                    data,
                                    channels,
                                    &snapshot_for_cb,
                                    is_playing_cb.as_ref(),
                                    position_frames_cb.as_ref(),
                                    duration_frames_cb.as_ref(),
                                    &mut scratch_mix,
                                );
                            }));
                            if r.is_err() {
                                eprintln!(
                                    "AudioEngine: panic in audio callback (i16); silencing output"
                                );
                                data.fill(0);
                                is_playing_cb.store(false, Ordering::Relaxed);
                            }
                        },
                        err_fn,
                        None,
                    )
                    .ok(),
                cpal::SampleFormat::U16 => device
                    .build_output_stream(
                        &config,
                        move |data: &mut [u16], _| {
                            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                render_callback_u16(
                                    data,
                                    channels,
                                    &snapshot_for_cb,
                                    is_playing_cb.as_ref(),
                                    position_frames_cb.as_ref(),
                                    duration_frames_cb.as_ref(),
                                    &mut scratch_mix,
                                );
                            }));
                            if r.is_err() {
                                eprintln!(
                                    "AudioEngine: panic in audio callback (u16); silencing output"
                                );
                                data.fill(u16::MAX / 2);
                                is_playing_cb.store(false, Ordering::Relaxed);
                            }
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
                        *target_thread.lock().unwrap_or_else(|e| e.into_inner()) = None;
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
                        *target_thread.lock().unwrap_or_else(|e| e.into_inner()) = target;
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
                        *target_thread.lock().unwrap_or_else(|e| e.into_inner()) = Some(target);
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
            target: self.target.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            base_sec: base as f64 / sr as f64,
            position_sec: pos as f64 / sr as f64,
            duration_sec: dur as f64 / sr as f64,
            sample_rate: sr,
        }
    }
}
