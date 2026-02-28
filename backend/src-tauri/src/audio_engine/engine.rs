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

use super::mix::{render_callback_f32, render_callback_i16, render_callback_u16};
use super::resource_manager::ResourceManager;
use super::snapshot::{
    build_snapshot, build_snapshot_for_file, schedule_stretch_jobs, source_bounds_frames,
};
use crate::pitch_clip::schedule_clip_pitch_jobs;
use super::types::{
    AudioEngineStateSnapshot, EngineCommand, EngineSnapshot, ResampledStereo, StretchJob,
    StretchKey,
};

use crate::pitch_editing::PitchEditAlgorithm;

use super::realtime_stats::RealtimeRenderStats;
use super::realtime_stats::RealtimeRenderStatsSnapshot;

pub struct AudioEngine {
    tx: mpsc::Sender<EngineCommand>,

    snapshot: Arc<ArcSwap<EngineSnapshot>>,

    realtime_stats: Arc<RealtimeRenderStats>,

    is_playing: Arc<AtomicBool>,
    target: Arc<Mutex<Option<String>>>,
    base_frames: Arc<AtomicU64>,
    position_frames: Arc<AtomicU64>,
    duration_frames: Arc<AtomicU64>,
    sample_rate: Arc<AtomicU32>,
}

impl Clone for AudioEngine {
    fn clone(&self) -> Self {
        Self {
            tx: self.tx.clone(),
            snapshot: self.snapshot.clone(),
            realtime_stats: self.realtime_stats.clone(),
            is_playing: self.is_playing.clone(),
            target: self.target.clone(),
            base_frames: self.base_frames.clone(),
            position_frames: self.position_frames.clone(),
            duration_frames: self.duration_frames.clone(),
            sample_rate: self.sample_rate.clone(),
        }
    }
}

impl AudioEngine {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<EngineCommand>();
        let tx_for_worker = tx.clone();

        let realtime_stats: Arc<RealtimeRenderStats> = Arc::new(RealtimeRenderStats::default());

        let is_playing = Arc::new(AtomicBool::new(false));
        let target = Arc::new(Mutex::new(None));
        let base_frames = Arc::new(AtomicU64::new(0));
        let position_frames = Arc::new(AtomicU64::new(0));
        let duration_frames = Arc::new(AtomicU64::new(0));
        let sample_rate = Arc::new(AtomicU32::new(44100));

        // Shared snapshot store for both the audio callback and command-side status queries.
        // This is updated by the engine worker thread.
        let snapshot: Arc<ArcSwap<EngineSnapshot>> =
            Arc::new(ArcSwap::from_pointee(EngineSnapshot::empty(44100)));

        let is_playing_thread = is_playing.clone();
        let target_thread = target.clone();
        let base_frames_thread = base_frames.clone();
        let position_frames_thread = position_frames.clone();
        let duration_frames_thread = duration_frames.clone();
        let sample_rate_thread = sample_rate.clone();

        let snapshot_for_thread = snapshot.clone();
        let realtime_stats_thread = realtime_stats.clone();
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

            // Re-initialize the shared snapshot to the actual output sample rate.
            snapshot_for_thread.store(Arc::new(EngineSnapshot::empty(sr)));
            let snapshot_for_cb = snapshot_for_thread.clone();

            // Async resource manager for decoded/resampled PCM.
            let resources = ResourceManager::new(tx_for_worker.clone());
            let cache_for_cmd = resources.cache().clone();

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
                let cache = cache_for_cmd.clone();
                let stretch_cache = stretch_cache_for_worker.clone();
                let inflight = stretch_inflight_for_worker.clone();
                let tx_ready = tx_for_worker.clone();
                thread::spawn(move || {
                    while let Ok(job) = stretch_rx.recv() {
                        // If RubberBand isn't available, drop the job.
                        if !crate::rubberband::is_available() {
                            if let Ok(mut s) = inflight.lock() {
                                s.remove(&job.key);
                            }
                            continue;
                        }

                        let src = match super::io::get_resampled_stereo_cached(
                            &job.key.path,
                            job.key.out_rate,
                            &cache,
                        ) {
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

                        let playback_rate =
                            if job.playback_rate.is_finite() && job.playback_rate > 0.0 {
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
                        let loop_out_frames =
                            ((loop_in_frames as f64) / playback_rate).round().max(2.0) as usize;

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
                    }
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
            let realtime_stats_cb = realtime_stats_thread.clone();

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
                                    realtime_stats_cb.as_ref(),
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
                                    realtime_stats_cb.as_ref(),
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
                                    realtime_stats_cb.as_ref(),
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
            let mut last_play_file: Option<(PathBuf, f64, String)> = None;
            let stretch_stream_epoch: Arc<AtomicU64> = Arc::new(AtomicU64::new(1));
            // per-clip stretch epoch map（方案 D）
            let mut clip_stretch_epochs: HashMap<String, Arc<AtomicU64>> = HashMap::new();

            loop {
                match rx.recv() {
                    Ok(EngineCommand::Shutdown) | Err(_) => break,
                    Ok(cmd) => {
                        let mut state = EngineWorkerState {
                            sr,
                            is_playing: &is_playing_thread,
                            target: &target_thread,
                            base_frames: &base_frames_thread,
                            position_frames: &position_frames_thread,
                            duration_frames: &duration_frames_thread,
                            snapshot: &snapshot_for_thread,
                            cache: &cache_for_cmd,
                            stretch_cache: &stretch_cache_for_cmd,
                            stretch_inflight: &stretch_inflight_for_cmd,
                            stretch_tx: &stretch_tx,
                            stretch_stream_epoch: &stretch_stream_epoch,
                            clip_stretch_epochs: &mut clip_stretch_epochs,
                            resources: &resources,
                            tx: &tx_for_worker,
                            last_timeline: &mut last_timeline,
                            last_play_file: &mut last_play_file,
                        };
                        match cmd {
                            EngineCommand::Stop => handle_stop(&mut state),
                            EngineCommand::SeekSec { sec } => handle_seek_sec(&mut state, sec),
                            EngineCommand::SetPlaying { playing, target } => {
                                handle_set_playing(&mut state, playing, target)
                            }
                            EngineCommand::UpdateTimeline(tl) => {
                                handle_update_timeline(&mut state, tl)
                            }
                            EngineCommand::StretchReady { key } => {
                                handle_stretch_ready(&mut state, key)
                            }
                            EngineCommand::ClipPitchReady { clip_id } => {
                                handle_clip_pitch_ready(&mut state, clip_id)
                            }
                            EngineCommand::AudioReady { key } => handle_audio_ready(&mut state, key),
                            EngineCommand::PlayFile {
                                path,
                                offset_sec,
                                target,
                            } => handle_play_file(&mut state, path, offset_sec, target),
                            EngineCommand::Shutdown => unreachable!(),
                        }
                    }
                }
            }
        });

        Self {
            tx,
            snapshot,
            realtime_stats,
            is_playing,
            target,
            base_frames,
            position_frames,
            duration_frames,
            sample_rate,
        }
    }

    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate.load(Ordering::Relaxed).max(1)
    }

    #[allow(dead_code)]
    pub fn position_frames(&self) -> u64 {
        self.position_frames.load(Ordering::Relaxed)
    }

    pub fn pitch_stream_priming_info(&self) -> Option<(PitchEditAlgorithm, u64, u64, bool)> {
        let snap = self.snapshot.load();
        let algo = snap.pitch_stream_algo?;
        let stream = snap.pitch_stream.as_ref()?;
        let base = stream.base_frame.load(Ordering::Acquire);
        let write = stream.write_frame.load(Ordering::Acquire);
        let hard_start = stream.is_hard_start_enabled();
        Some((algo, base, write, hard_start))
    }

    #[allow(dead_code)]
    pub fn set_pitch_stream_hard_start_enabled(&self, enabled: bool) -> bool {
        let snap = self.snapshot.load();
        let Some(stream) = snap.pitch_stream.as_ref() else {
            return false;
        };
        stream.set_hard_start_enabled(enabled);
        true
    }

    #[allow(dead_code)]
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
        let debug_stats = std::env::var("HIFISHIFTER_DEBUG_RENDER_STATS").ok().as_deref() == Some("1");
        let realtime_stats: Option<RealtimeRenderStatsSnapshot> = if debug_stats {
            Some(self.realtime_stats.snapshot())
        } else {
            None
        };
        AudioEngineStateSnapshot {
            is_playing: self.is_playing(),
            target: self
                .target
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            base_sec: base as f64 / sr as f64,
            position_sec: pos as f64 / sr as f64,
            duration_sec: dur as f64 / sr as f64,
            sample_rate: sr,
            realtime_stats,
        }
    }

    pub fn realtime_render_stats_snapshot(&self) -> RealtimeRenderStatsSnapshot {
        self.realtime_stats.snapshot()
    }
}

// ─── Worker 状态结构体 ────────────────────────────────────────────────────────

/// Worker 线程的所有可变状态，按命令处理函数传递。
struct EngineWorkerState<'a> {
    sr: u32,
    is_playing: &'a Arc<AtomicBool>,
    target: &'a Arc<Mutex<Option<String>>>,
    base_frames: &'a Arc<AtomicU64>,
    position_frames: &'a Arc<AtomicU64>,
    duration_frames: &'a Arc<AtomicU64>,
    snapshot: &'a Arc<ArcSwap<EngineSnapshot>>,
    cache: &'a Arc<Mutex<HashMap<(PathBuf, u32), ResampledStereo>>>,
    stretch_cache: &'a Arc<Mutex<HashMap<StretchKey, ResampledStereo>>>,
    stretch_inflight: &'a Arc<Mutex<HashSet<StretchKey>>>,
    stretch_tx: &'a mpsc::Sender<StretchJob>,
    stretch_stream_epoch: &'a Arc<AtomicU64>,
    /// per-clip stretch epoch map，用于细化 cancel 粒度（方案 D）
    clip_stretch_epochs: &'a mut HashMap<String, Arc<AtomicU64>>,
    resources: &'a ResourceManager,
    tx: &'a mpsc::Sender<EngineCommand>,
    last_timeline: &'a mut Option<TimelineState>,
    last_play_file: &'a mut Option<(PathBuf, f64, String)>,
}

// ─── 命令处理函数 ─────────────────────────────────────────────────────────────

fn handle_stop(s: &mut EngineWorkerState) {
    s.is_playing.store(false, Ordering::Relaxed);
    *s.target.lock().unwrap_or_else(|e| e.into_inner()) = None;
    s.base_frames.store(0, Ordering::Relaxed);
    *s.last_play_file = None;
}

fn handle_seek_sec(s: &mut EngineWorkerState, sec: f64) {
    let sec = sec.max(0.0);
    let frame = (sec * s.sr as f64).round().max(0.0) as u64;
    // Timeline playback reports absolute position via position_frames.
    s.base_frames.store(0, Ordering::Relaxed);
    s.position_frames.store(frame, Ordering::Relaxed);
}

fn handle_set_playing(s: &mut EngineWorkerState, playing: bool, target: Option<String>) {
    s.is_playing.store(playing, Ordering::Relaxed);
    *s.target.lock().unwrap_or_else(|e| e.into_inner()) = target;
}

fn handle_update_timeline(s: &mut EngineWorkerState, tl: TimelineState) {
    // 对参数变化的 clip 递增其 per-clip epoch（方案 D）。
    // 新增 clip 也会初始化 epoch；已删除 clip 的 epoch 在最后清理。
    for clip in &tl.clips {
        let changed = s
            .last_timeline
            .as_ref()
            .and_then(|old_tl| old_tl.clips.iter().find(|c| c.id == clip.id))
            .map(|old| clip_stretch_params_changed(old, clip))
            .unwrap_or(true); // 新 clip 视为"已变化"
        if changed {
            s.clip_stretch_epochs
                .entry(clip.id.clone())
                .or_insert_with(|| Arc::new(AtomicU64::new(1)))
                .fetch_add(1, Ordering::Relaxed);
        }
    }
    // 清理已删除 clip 的 epoch
    s.clip_stretch_epochs
        .retain(|id, _| tl.clips.iter().any(|c| &c.id == id));

    *s.last_timeline = Some(tl.clone());
    *s.last_play_file = None;

    // 全局 epoch 仍然递增（用于 base_stream / pitch_stream）。
    s.stretch_stream_epoch.fetch_add(1, Ordering::Relaxed);

    // Pre-request decoded PCM for all audible clips (async, non-blocking).
    {
        let track_gain = super::snapshot::compute_track_gains(&tl.tracks);
        let mut audible_tracks: HashSet<String> = HashSet::new();
        for (tid, (_gain, muted, solo_ok)) in &track_gain {
            if !*muted && *solo_ok {
                audible_tracks.insert(tid.clone());
            }
        }
        for clip in &tl.clips {
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
            if !super::io::is_audio_path(path) {
                continue;
            }
            let _ = s.resources.get_or_request(path, s.sr);
        }
    }

    // Schedule stretch work in background (do not block snapshot build).
    if crate::rubberband::is_available() {
        schedule_stretch_jobs(
            &tl,
            s.sr,
            s.stretch_tx,
            s.stretch_inflight.as_ref(),
            s.stretch_cache,
        );
    }

    // 异步预计算所有可见 clip 的 pitch MIDI（缓存未命中时后台计算，
    // 完成后发送 ClipPitchReady 触发 snapshot rebuild，不阻塞当前构建）。
    schedule_clip_pitch_jobs(&tl, s.tx);

    let snap = build_snapshot(
        &tl,
        s.sr,
        s.cache,
        s.stretch_cache,
        s.position_frames,
        s.is_playing,
        s.stretch_stream_epoch,
        s.clip_stretch_epochs,
    );
    s.duration_frames.store(snap.duration_frames, Ordering::Relaxed);
    s.snapshot.store(Arc::new(snap));
}

fn handle_stretch_ready(s: &mut EngineWorkerState, key: StretchKey) {
    if let Ok(mut inflight) = s.stretch_inflight.lock() {
        inflight.remove(&key);
    }
    // Switch to cache-backed buffers; stop any streaming workers.
    s.stretch_stream_epoch.fetch_add(1, Ordering::Relaxed);
    if let Some(tl) = s.last_timeline.as_ref() {
        let snap = build_snapshot(
            tl,
            s.sr,
            s.cache,
            s.stretch_cache,
            s.position_frames,
            s.is_playing,
            s.stretch_stream_epoch,
            s.clip_stretch_epochs,
        );
        s.duration_frames.store(snap.duration_frames, Ordering::Relaxed);
        s.snapshot.store(Arc::new(snap));
    }
}

fn handle_clip_pitch_ready(s: &mut EngineWorkerState, _clip_id: String) {
    // clip pitch MIDI 异步预计算完成，缓存已就绪，重建 snapshot 以接入 pitch edit。
    // 无需停止 stretch streamer，pitch stream 会在 build_snapshot 内重建。
    if let Some(tl) = s.last_timeline.as_ref() {
        let snap = build_snapshot(
            tl,
            s.sr,
            s.cache,
            s.stretch_cache,
            s.position_frames,
            s.is_playing,
            s.stretch_stream_epoch,
            s.clip_stretch_epochs,
        );
        s.duration_frames.store(snap.duration_frames, Ordering::Relaxed);
        s.snapshot.store(Arc::new(snap));
    }
}

fn handle_audio_ready(s: &mut EngineWorkerState, _key: super::types::AudioKey) {
    // A decoded/resampled buffer became available.
    // Rebuild the snapshot so missing clips can be attached.
    if let Some(tl) = s.last_timeline.as_ref() {
        let snap = build_snapshot(
            tl,
            s.sr,
            s.cache,
            s.stretch_cache,
            s.position_frames,
            s.is_playing,
            s.stretch_stream_epoch,
            s.clip_stretch_epochs,
        );
        s.duration_frames.store(snap.duration_frames, Ordering::Relaxed);
        s.snapshot.store(Arc::new(snap));
    } else if let Some((path, offset_sec, _target)) = s.last_play_file.as_ref() {
        let snap = build_snapshot_for_file(path.as_path(), s.sr, *offset_sec, s.cache);
        s.duration_frames.store(snap.duration_frames, Ordering::Relaxed);
        s.snapshot.store(Arc::new(snap));
    }
}

fn handle_play_file(
    s: &mut EngineWorkerState,
    path: PathBuf,
    offset_sec: f64,
    target: String,
) {
    *s.last_timeline = None;
    *s.last_play_file = Some((path.clone(), offset_sec, target.clone()));

    // Request decode asynchronously (snapshot building is cache-only).
    let _ = s.resources.get_or_request(path.as_path(), s.sr);

    // Snapshot will be replaced; stop any timeline streamers.
    s.stretch_stream_epoch.fetch_add(1, Ordering::Relaxed);
    // Represent the file as a single clip in a snapshot.
    let snap = build_snapshot_for_file(&path, s.sr, offset_sec, s.cache);
    s.duration_frames.store(snap.duration_frames, Ordering::Relaxed);
    s.snapshot.store(Arc::new(snap));
    // File playback reports absolute position via base_sec + position_sec.
    let base = (offset_sec.max(0.0) * s.sr as f64).round().max(0.0) as u64;
    s.base_frames.store(base, Ordering::Relaxed);
    s.position_frames.store(0, Ordering::Relaxed);
    s.is_playing.store(true, Ordering::Relaxed);
    *s.target.lock().unwrap_or_else(|e| e.into_inner()) = Some(target);
}

// ─── 辅助函数 ───────────────────────────────────────────────────────────────

/// 判断 clip 的 stretch 相关参数是否发生变化。
/// 只有这些参数变化时才需要 cancel 并重建该 clip 的 stretch_stream worker。
fn clip_stretch_params_changed(old: &crate::state::Clip, new: &crate::state::Clip) -> bool {
    (old.playback_rate - new.playback_rate).abs() > 1e-6
        || (old.trim_start_beat - new.trim_start_beat).abs() > 1e-6
        || (old.trim_end_beat - new.trim_end_beat).abs() > 1e-6
}
