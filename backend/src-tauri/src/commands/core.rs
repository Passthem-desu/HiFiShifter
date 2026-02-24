use crate::state::AppState;
use tauri::State;




pub(super) fn ping() -> serde_json::Value {
    serde_json::json!({ "ok": true, "message": "pong" })
}




pub(super) fn get_runtime_info(state: State<'_, AppState>) -> crate::models::RuntimeInfoPayload {
    state.runtime_info()
}




pub(super) fn get_timeline_state(state: State<'_, AppState>) -> crate::models::TimelineStatePayload {
    let tl = state
        .timeline
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

pub(crate) fn get_timeline_state_from_ref(state: &AppState) -> crate::models::TimelineStatePayload {
    let tl = state
        .timeline
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}




pub(super) fn set_transport(
    state: State<'_, AppState>,
    playhead_beat: Option<f64>,
    bpm: Option<f64>,
) -> serde_json::Value {
    if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
        eprintln!(
            "set_transport(playhead_beat={:?}, bpm={:?})",
            playhead_beat, bpm
        );
    }
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    let prev_bpm = tl.bpm;
    if let Some(v) = playhead_beat {
        tl.playhead_beat = v.max(0.0);
    }
    if let Some(v) = bpm {
        if v.is_finite() && v > 0.0 {
            // BPM is project-affecting: checkpoint for undo.
            state.checkpoint_timeline(&tl);
            tl.bpm = v;
        }
    }

    // Keep realtime engine transport aligned.
    let playhead_sec = (tl.playhead_beat.max(0.0)) * 60.0 / tl.bpm.max(1e-6);
    state.audio_engine.seek_sec(playhead_sec);
    if (tl.bpm - prev_bpm).abs() > 1e-9 {
        state.audio_engine.update_timeline(tl.clone());
    }

    serde_json::json!({"ok": true, "playhead_beat": tl.playhead_beat, "bpm": tl.bpm })
}

// ===================== undo / redo =====================




pub(super) fn undo_timeline(state: State<'_, AppState>) -> crate::models::TimelineStatePayload {
    state.undo_timeline()
}




pub(super) fn redo_timeline(state: State<'_, AppState>) -> crate::models::TimelineStatePayload {
    state.redo_timeline()
}
