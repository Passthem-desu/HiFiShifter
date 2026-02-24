use crate::audio_utils::try_read_wav_info;
use crate::models::{ProcessAudioPayload, SynthesizePayload};
use crate::state::AppState;
use std::fs;
use std::path::Path;
use tauri::State;

use super::common::{new_temp_wav_path, render_timeline_to_wav};

// ===================== model / processing / synthesis =====================




pub(super) fn load_default_model(state: State<'_, AppState>) -> crate::models::ModelConfigPayload {
    {
        let mut rt = state.runtime.lock().unwrap_or_else(|e| e.into_inner());
        rt.model_loaded = true;
    }
    state.model_config_ok()
}




pub(super) fn load_model(state: State<'_, AppState>, model_dir: String) -> crate::models::ModelConfigPayload {
    let _ = model_dir;
    {
        let mut rt = state.runtime.lock().unwrap_or_else(|e| e.into_inner());
        rt.model_loaded = true;
    }
    state.model_config_ok()
}




pub(super) fn set_pitch_shift(semitones: f64) -> serde_json::Value {
    serde_json::json!({"ok": true, "pitch_shift": semitones, "frames": 0})
}




pub(super) fn process_audio(state: State<'_, AppState>, audio_path: String) -> ProcessAudioPayload {
    let path = Path::new(&audio_path);
    let mut duration_sec = 0.0f64;
    let mut sample_rate = 44100u32;
    let mut waveform_preview: Option<Vec<f32>> = None;

    if let Some(info) = try_read_wav_info(path, 4096) {
        duration_sec = info.duration_sec;
        sample_rate = info.sample_rate;
        waveform_preview = Some(info.waveform_preview);
    }

    {
        let mut rt = state.runtime.lock().unwrap_or_else(|e| e.into_inner());
        rt.audio_loaded = true;
    }

    ProcessAudioPayload {
        ok: true,
        audio: Some(crate::models::ProcessedAudio {
            path: audio_path,
            sample_rate,
            duration_sec,
        }),
        feature: Some(crate::models::AudioFeature {
            mel_shape: None,
            f0_frames: None,
            segment_count: None,
            segments_preview: None,
            waveform_preview,
            pitch_range: Some(crate::models::PitchRange {
                min: -24.0,
                max: 24.0,
            }),
        }),
        timeline: None,
    }
}




pub(super) fn synthesize(state: State<'_, AppState>) -> SynthesizePayload {
    let out_path = match new_temp_wav_path("synth") {
        Ok(p) => p,
        Err(e) => {
            eprintln!("synthesize: temp path error: {e}");
            return SynthesizePayload {
                ok: false,
                sample_rate: 44100,
                num_samples: 0,
                duration_sec: 0.0,
            };
        }
    };

    let result = match render_timeline_to_wav(&state, &out_path, 0.0, None) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("synthesize: render error: {e}");
            return SynthesizePayload {
                ok: false,
                sample_rate: 44100,
                num_samples: 0,
                duration_sec: 0.0,
            };
        }
    };

    {
        let mut rt = state.runtime.lock().unwrap_or_else(|e| e.into_inner());
        rt.has_synthesized = true;
        rt.synthesized_wav_path = Some(out_path.display().to_string());
    }

    let num_samples = (result.duration_sec * result.sample_rate as f64)
        .round()
        .max(0.0) as u32;

    SynthesizePayload {
        ok: true,
        sample_rate: result.sample_rate,
        num_samples,
        duration_sec: result.duration_sec,
    }
}




pub(super) fn save_synthesized(state: State<'_, AppState>, output_path: String) -> serde_json::Value {
    let out_path = Path::new(&output_path);

    let synthesized_path = {
        state
            .runtime
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .synthesized_wav_path
            .clone()
    };

    let mix = if let Some(p) = synthesized_path {
        // Best-effort copy the already rendered synth.
        match fs::copy(&p, out_path) {
            Ok(_) => try_read_wav_info(out_path, 0),
            Err(e) => {
                eprintln!("save_synthesized: copy failed: {e}");
                None
            }
        }
    } else {
        // No cached synth; render directly to output.
        match render_timeline_to_wav(&state, out_path, 0.0, None) {
            Ok(_) => try_read_wav_info(out_path, 0),
            Err(e) => {
                eprintln!("save_synthesized: render failed: {e}");
                None
            }
        }
    };

    match mix {
        Some(info) => serde_json::json!({
            "ok": true,
            "path": output_path,
            "sample_rate": info.sample_rate,
            "num_samples": (info.duration_sec * info.sample_rate as f64).round().max(0.0) as u32
        }),
        None => serde_json::json!({
            "ok": false,
            "path": output_path
        }),
    }
}
