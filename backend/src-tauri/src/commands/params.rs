use crate::state::AppState;
use tauri::State;

// ===================== param curves =====================




pub(super) fn get_param_frames(
    state: State<'_, AppState>,
    track_id: String,
    param: String,
    start_frame: u32,
    frame_count: u32,
    stride: Option<u32>,
) -> crate::models::ParamFramesPayload {
    if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
        eprintln!(
            "get_param_frames(track_id={}, param={}, start_frame={}, frame_count={}, stride={:?})",
            track_id, param, start_frame, frame_count, stride
        );
    }
    let (root, fp, entry, compose_enabled) = {
        let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());

        let root = match tl.resolve_root_track_id(&track_id) {
            Some(id) => id,
            None => {
                return crate::models::ParamFramesPayload {
                    ok: false,
                    root_track_id: "".to_string(),
                    param,
                    frame_period_ms: tl.frame_period_ms(),
                    start_frame,
                    orig: vec![],
                    edit: vec![],
                    analysis_pending: None,
                    analysis_progress: None,
                }
            }
        };

        tl.ensure_params_for_root(&root);
        let fp = tl.frame_period_ms();
        let compose_enabled = tl
            .tracks
            .iter()
            .find(|t| t.id == root)
            .map(|t| t.compose_enabled)
            .unwrap_or(false);
        let entry = tl
            .params_by_root_track
            .get(&root)
            .cloned()
            .unwrap_or_default();

        (root, fp, entry, compose_enabled)
    };

    if param == "pitch" && !compose_enabled {
        return crate::models::ParamFramesPayload {
            ok: true,
            root_track_id: root,
            param,
            frame_period_ms: fp,
            start_frame,
            orig: vec![],
            edit: vec![],
            analysis_pending: None,
            analysis_progress: None,
        };
    }

    // Schedule pitch_orig analysis in background; return current cached curve immediately.
    let analysis_pending = if param == "pitch" {
        Some(crate::pitch_analysis::maybe_schedule_pitch_orig(&state, &root))
    } else {
        None
    };

    let start = start_frame as usize;
    let count = (frame_count as usize).max(1);
    let step = (stride.unwrap_or(1).max(1)) as usize;

    let (orig_src, edit_src) = match param.as_str() {
        "pitch" => (&entry.pitch_orig, &entry.pitch_edit),
        "tension" => (&entry.tension_orig, &entry.tension_edit),
        _ => (&entry.pitch_orig, &entry.pitch_edit),
    };

    let mut orig = Vec::with_capacity(count);
    let mut edit = Vec::with_capacity(count);
    for i in 0..count {
        let idx = start.saturating_add(i.saturating_mul(step));
        let o = orig_src.get(idx).copied().unwrap_or(0.0);
        let mut e = edit_src.get(idx).copied().unwrap_or(o);
        // For pitch, treat 0 as "unset" in edit curve and fall back to orig.
        // (UI edits are clamped to MIDI range, so 0 is not a meaningful edited value.)
        if param == "pitch" && e == 0.0 && o != 0.0 {
            e = o;
        }
        orig.push(o);
        edit.push(e);
    }

    crate::models::ParamFramesPayload {
        ok: true,
        root_track_id: root,
        param,
        frame_period_ms: fp,
        start_frame,
        orig,
        edit,
        analysis_pending,
        analysis_progress: None,
    }
}




pub(super) fn set_param_frames(
    state: State<'_, AppState>,
    track_id: String,
    param: String,
    start_frame: u32,
    values: Vec<f32>,
    checkpoint: Option<bool>,
) -> serde_json::Value {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    let do_checkpoint = checkpoint.unwrap_or(true);
    if do_checkpoint {
        state.checkpoint_timeline(&tl);
    }

    let Some(root) = tl.resolve_root_track_id(&track_id) else {
        return serde_json::json!({"ok": false});
    };
    tl.ensure_params_for_root(&root);

    let Some(entry) = tl.params_by_root_track.get_mut(&root) else {
        return serde_json::json!({"ok": false, "error": "params missing"});
    };

    let dst = match param.as_str() {
        "pitch" => &mut entry.pitch_edit,
        "tension" => &mut entry.tension_edit,
        _ => &mut entry.pitch_edit,
    };

    let debug = std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1");

    let start = start_frame as usize;
    let mut written = 0usize;
    let mut non_finite = 0usize;
    let mut clamped = 0usize;
    let mut min_v = f32::INFINITY;
    let mut max_v = f32::NEG_INFINITY;
    let mut max_delta = 0.0f32;
    let mut prev_v: Option<f32> = None;
    for (i, v) in values.into_iter().enumerate() {
        let idx = start.saturating_add(i);
        if idx >= dst.len() {
            break;
        }

        let mut v = if v.is_finite() {
            v
        } else {
            non_finite += 1;
            0.0
        };

        match param.as_str() {
            "pitch" => {
                // MIDI pitch. Keep 0 as "unset"; otherwise clamp into a reasonable range.
                if v != 0.0 {
                    let vv = v.clamp(1.0, 127.0);
                    if vv != v {
                        clamped += 1;
                    }
                    v = vv;
                }
            }
            "tension" => {
                // Tension is a UI parameter in [-100, 100].
                let vv = v.clamp(-100.0, 100.0);
                if vv != v {
                    clamped += 1;
                }
                v = vv;
            }
            _ => {}
        }

        min_v = min_v.min(v);
        max_v = max_v.max(v);
        if let Some(p) = prev_v {
            max_delta = max_delta.max((v - p).abs());
        }
        prev_v = Some(v);

        dst[idx] = v;
        written += 1;
    }

    if debug {
        // This helps diagnose whether the frontend is sending invalid / extreme curves.
        eprintln!(
            "set_param_frames(param={param}, start_frame={start_frame}, len={}): non_finite={non_finite} clamped={clamped} min={min_v:.3} max={max_v:.3} max_delta={max_delta:.3}",
            written
        );
    }

    if param == "pitch" {
        entry.pitch_edit_user_modified = true;
    }

    // Ensure realtime playback reflects edits immediately.
    state.audio_engine.update_timeline(tl.clone());

    serde_json::json!({"ok": true})
}




pub(super) fn restore_param_frames(
    state: State<'_, AppState>,
    track_id: String,
    param: String,
    start_frame: u32,
    frame_count: u32,
    checkpoint: Option<bool>,
) -> serde_json::Value {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    let do_checkpoint = checkpoint.unwrap_or(true);
    if do_checkpoint {
        state.checkpoint_timeline(&tl);
    }

    let Some(root) = tl.resolve_root_track_id(&track_id) else {
        return serde_json::json!({"ok": false});
    };
    tl.ensure_params_for_root(&root);
    let Some(entry) = tl.params_by_root_track.get_mut(&root) else {
        return serde_json::json!({"ok": false, "error": "params missing"});
    };

    let start = start_frame as usize;
    let count = (frame_count as usize).max(1);

    match param.as_str() {
        "pitch" => {
            for i in 0..count {
                let idx = start.saturating_add(i);
                if idx >= entry.pitch_edit.len() {
                    break;
                }
                let o = entry.pitch_orig.get(idx).copied().unwrap_or(0.0);
                entry.pitch_edit[idx] = o;
            }

            // If the curve fully matches orig now, clear the user-modified flag.
            let len = entry.pitch_orig.len().min(entry.pitch_edit.len());
            entry.pitch_edit_user_modified = false;
            for i in 0..len {
                let o = entry.pitch_orig[i];
                let e = entry.pitch_edit[i];
                if (e.is_finite() && e > 0.0)
                    && (!(o.is_finite() && o > 0.0) || (e - o).abs() > 1e-3)
                {
                    entry.pitch_edit_user_modified = true;
                    break;
                }
            }
        }
        "tension" => {
            for i in 0..count {
                let idx = start.saturating_add(i);
                if idx >= entry.tension_edit.len() {
                    break;
                }
                let o = entry.tension_orig.get(idx).copied().unwrap_or(0.0);
                entry.tension_edit[idx] = o;
            }
        }
        _ => {}
    }

    // Ensure realtime playback reflects edits immediately.
    state.audio_engine.update_timeline(tl.clone());

    serde_json::json!({"ok": true})
}
