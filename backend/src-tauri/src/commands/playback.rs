use crate::models::PlaybackStatePayload;
use crate::state::AppState;
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri::State;

use super::common::{
    guard_json_command, new_temp_wav_path, ok_bool, render_timeline_to_wav, PlaybackRenderingStateEvent,
};

// ===================== playback clock =====================




pub(super) fn play_original(state: State<'_, AppState>, start_sec: f64) -> serde_json::Value {
    guard_json_command("play_original", || {
        if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
            eprintln!("play_original(start_sec={})", start_sec);
        }
        let timeline = state
            .timeline
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let bpm = timeline.bpm;
        let playhead_sec = timeline.playhead_sec;
        if !(bpm.is_finite() && bpm > 0.0) {
            return serde_json::json!({"ok": false, "error": "invalid bpm"});
        }
        let start_sec = playhead_sec.max(0.0) + start_sec.max(0.0);

        // IMPORTANT: order matters (mpsc is FIFO).
        // Seek first so the snapshot build (and pitch_stream ring.reset) uses the correct base.
        state.audio_engine.seek_sec(start_sec);
        state.audio_engine.update_timeline(timeline);
        state.audio_engine.set_playing(true, Some("original"));

        // If ONNX pitch streaming is active, we may be in A-mode hard-start (silent, not advancing)
        // until enough frames are rendered. Emit a UI hint so the user sees "渲染中".
        if let Some(app) = state.app_handle.get().cloned() {
            let engine = state.audio_engine.clone();
            std::thread::spawn(move || {
                // Small delay to let the engine thread build the snapshot.
                std::thread::sleep(Duration::from_millis(5));

                let (algo, base, write0, hard_start) = match engine.pitch_stream_priming_info() {
                    Some(v) => v,
                    None => return,
                };

                if !hard_start {
                    return;
                }

                // Configure priming window.
                let prime_sec: f64 = if algo == crate::pitch_editing::PitchEditAlgorithm::NsfHifiganOnnx {
                    std::env::var("HIFISHIFTER_ONNX_STREAM_PRIME_SEC")
                        .ok()
                        .and_then(|s| s.trim().parse::<f64>().ok())
                        .filter(|v| v.is_finite() && *v > 0.0)
                        .unwrap_or(0.25)
                } else {
                    std::env::var("HIFISHIFTER_PITCH_STREAM_PRIME_SEC")
                        .ok()
                        .and_then(|s| s.trim().parse::<f64>().ok())
                        .filter(|v| v.is_finite() && *v > 0.0)
                        .unwrap_or(0.25)
                };
                let timeout_ms: u64 = if algo == crate::pitch_editing::PitchEditAlgorithm::NsfHifiganOnnx {
                    std::env::var("HIFISHIFTER_ONNX_STREAM_PRIME_TIMEOUT_MS")
                        .ok()
                        .and_then(|s| s.trim().parse::<u64>().ok())
                        .filter(|v| *v > 0)
                        .unwrap_or(4000)
                } else {
                    std::env::var("HIFISHIFTER_PITCH_STREAM_PRIME_TIMEOUT_MS")
                        .ok()
                        .and_then(|s| s.trim().parse::<u64>().ok())
                        .filter(|v| *v > 0)
                        .unwrap_or(4000)
                };

                let sr = engine.sample_rate_hz() as f64;
                let prime_frames = (prime_sec * sr).round().max(1.0) as u64;
                let need_frame = base.saturating_add(prime_frames);

                // If already covered, don't flash UI.
                if write0 >= need_frame {
                    return;
                }

                let _ = app.emit(
                    "playback_rendering_state",
                    PlaybackRenderingStateEvent {
                        active: true,
                        progress: Some(0.0),
                        target: Some("original".to_string()),
                    },
                );

                let t0 = Instant::now();
                let mut last_progress_bucket: i64 = -1;
                loop {
                    if !engine.is_playing() {
                        break;
                    }

                    let (_algo_now, base_now, write_now, _hard_start_now) =
                        match engine.pitch_stream_priming_info() {
                            Some(v) => v,
                            None => break,
                        };
                    let _ = (_algo_now, _hard_start_now);

                    // If the stream base moved (seek/reset), recompute the target.
                    let need_frame = base_now.saturating_add(prime_frames);

                    if write_now >= need_frame {
                        let _ = app.emit(
                            "playback_rendering_state",
                            PlaybackRenderingStateEvent {
                                active: false,
                                progress: Some(1.0),
                                target: Some("original".to_string()),
                            },
                        );
                        return;
                    }

                    let denom = prime_frames.max(1) as f64;
                    let p = ((write_now.saturating_sub(base_now)) as f64 / denom).clamp(0.0, 1.0);
                    let bucket = (p * 100.0).floor() as i64;
                    if bucket != last_progress_bucket {
                        last_progress_bucket = bucket;
                        let _ = app.emit(
                            "playback_rendering_state",
                            PlaybackRenderingStateEvent {
                                active: true,
                                progress: Some(p),
                                target: Some("original".to_string()),
                            },
                        );
                    }

                    if t0.elapsed().as_millis() as u64 >= timeout_ms {
                        // Fail-safe: if pitch streaming fails to prime, stop playback instead of
                        // disabling hard-start (which would leak unpitched realtime fallback).
                        engine.stop();
                        let _ = app.emit(
                            "playback_rendering_state",
                            PlaybackRenderingStateEvent {
                                active: false,
                                progress: None,
                                target: Some("original".to_string()),
                            },
                        );
                        return;
                    }

                    std::thread::sleep(Duration::from_millis(15));
                }

                let _ = app.emit(
                    "playback_rendering_state",
                    PlaybackRenderingStateEvent {
                        active: false,
                        progress: None,
                        target: Some("original".to_string()),
                    },
                );
            });
        }

        serde_json::json!({"ok": true, "playing": "original", "start_sec": start_sec})
    })
}




pub(super) fn play_synthesized(state: State<'_, AppState>, start_sec: f64) -> serde_json::Value {
    guard_json_command("play_synthesized", || {
        if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
            eprintln!("play_synthesized(start_sec={})", start_sec);
        }
        let (bpm, playhead_sec) = {
            let tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
            (tl.bpm, tl.playhead_sec)
        };
        if !(bpm.is_finite() && bpm > 0.0) {
            return serde_json::json!({"ok": false, "error": "invalid bpm"});
        }
        let start_sec = playhead_sec.max(0.0) + start_sec.max(0.0);

        let mut synthesized_path = {
            state
                .runtime
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .synthesized_wav_path
                .clone()
        };

        if synthesized_path.is_none() {
            // Render on-demand.
            let out_path = match new_temp_wav_path("synth") {
                Ok(p) => p,
                Err(e) => return serde_json::json!({"ok": false, "error": e}),
            };
            if let Err(e) = render_timeline_to_wav(&state, &out_path, 0.0, None) {
                return serde_json::json!({"ok": false, "error": e});
            }
            synthesized_path = Some(out_path.display().to_string());
            let mut rt = state.runtime.lock().unwrap_or_else(|e| e.into_inner());
            rt.has_synthesized = true;
            rt.synthesized_wav_path = synthesized_path.clone();
        }

        let Some(p) = synthesized_path.as_deref() else {
            return serde_json::json!({"ok": false, "error": "synth path missing"});
        };
        let path = Path::new(p);
        state.audio_engine.play_file(path, start_sec, "synthesized");
        serde_json::json!({"ok": true, "playing": "synthesized", "start_sec": start_sec})
    })
}




pub(super) fn stop_audio(state: State<'_, AppState>) -> serde_json::Value {
    state.audio_engine.stop();
    ok_bool()
}




pub(super) fn get_playback_state(state: State<'_, AppState>) -> PlaybackStatePayload {
    let pb = state.audio_engine.snapshot_state();
    PlaybackStatePayload {
        ok: true,
        is_playing: pb.is_playing,
        target: pb.target,
        base_sec: pb.base_sec,
        position_sec: pb.position_sec,
        duration_sec: pb.duration_sec,
    }
}
