use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

use super::mix::mix_snapshot_clips_into_scratch;
use super::ring::StreamRingStereo;
use super::types::EngineSnapshot;

fn env_f64(name: &str) -> Option<f64> {
    std::env::var(name)
        .ok()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite())
}

fn sec_to_frames(sec: f64, sr: u32, min_frames: u64) -> u64 {
    let sr_f = sr.max(1) as f64;
    ((sec.max(0.0) * sr_f).round().max(min_frames as f64)) as u64
}

#[derive(Debug, Clone, Copy)]
struct BaseStreamTuning {
    warmup_block_frames: u64,
    warmup_ahead_frames: u64,
    block_frames_normal: u64,
    lookahead_frames_normal: u64,
}

impl BaseStreamTuning {
    fn from_env(sr: u32) -> Self {
        // Defaults match the previous inline implementation in snapshot.rs.
        let warmup_block_sec = env_f64("HIFISHIFTER_BASE_STREAM_WARMUP_BLOCK_SEC").unwrap_or(0.5);
        let warmup_ahead_sec = env_f64("HIFISHIFTER_BASE_STREAM_WARMUP_AHEAD_SEC").unwrap_or(0.5);
        let block_sec = env_f64("HIFISHIFTER_BASE_STREAM_BLOCK_SEC").unwrap_or(2.0);
        let lookahead_sec = env_f64("HIFISHIFTER_BASE_STREAM_LOOKAHEAD_SEC").unwrap_or(3.0);

        Self {
            warmup_block_frames: sec_to_frames(warmup_block_sec, sr, 256),
            warmup_ahead_frames: sec_to_frames(warmup_ahead_sec, sr, 256),
            block_frames_normal: sec_to_frames(block_sec, sr, 256),
            lookahead_frames_normal: sec_to_frames(lookahead_sec, sr, 256),
        }
    }
}

pub(crate) fn spawn_base_stream(
    ring: Arc<StreamRingStereo>,
    snap: EngineSnapshot,
    position_frames: Arc<AtomicU64>,
    is_playing: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
    my_epoch: u64,
    debug: bool,
) {
    let sr = snap.sample_rate;
    let dur_frames = snap.duration_frames;
    let tuning = BaseStreamTuning::from_env(sr);

    if debug {
        eprintln!(
            "base_stream: warmup_block={} warmup_ahead={} block={} lookahead={} cap_frames={}",
            tuning.warmup_block_frames,
            tuning.warmup_ahead_frames,
            tuning.block_frames_normal,
            tuning.lookahead_frames_normal,
            ring.cap_frames
        );
    }

    thread::spawn(move || {
        let mut out_cursor: u64 = position_frames.load(Ordering::Relaxed);
        let mut scratch: Vec<f32> = vec![];

        loop {
            if epoch.load(Ordering::Relaxed) != my_epoch {
                break;
            }
            if !is_playing.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(8));
                continue;
            }

            let now_abs = position_frames.load(Ordering::Relaxed);
            let base = ring.base_frame.load(Ordering::Acquire);
            let write = ring.write_frame.load(Ordering::Acquire);

            // Reset on large jumps (seek / transport changes).
            if now_abs < base || now_abs > write.saturating_add(sr as u64) {
                out_cursor = now_abs;
                ring.reset(now_abs);
                std::thread::sleep(std::time::Duration::from_millis(2));
                continue;
            }
            if out_cursor < now_abs {
                out_cursor = now_abs;
            }

            let need_until = if write <= now_abs.saturating_add(tuning.warmup_ahead_frames) {
                now_abs.saturating_add(tuning.warmup_ahead_frames)
            } else {
                now_abs.saturating_add(tuning.lookahead_frames_normal)
            };
            if write >= need_until {
                std::thread::sleep(std::time::Duration::from_millis(3));
                continue;
            }

            let block_frames = if write <= now_abs.saturating_add(tuning.warmup_ahead_frames) {
                tuning.warmup_block_frames
            } else {
                tuning.block_frames_normal
            };

            // Avoid rendering far past project end.
            if dur_frames > 0 && out_cursor >= dur_frames {
                std::thread::sleep(std::time::Duration::from_millis(8));
                continue;
            }

            let pos0 = out_cursor;
            let pos1 = out_cursor.saturating_add(block_frames);
            let frames = (pos1.saturating_sub(pos0)) as usize;
            scratch.resize(frames * 2, 0.0);
            scratch.fill(0.0);
            mix_snapshot_clips_into_scratch(frames, &snap, pos0, pos1, scratch.as_mut_slice());

            ring.write_interleaved(out_cursor, scratch.as_slice());
            out_cursor = out_cursor.saturating_add(block_frames);
        }
    });
}
