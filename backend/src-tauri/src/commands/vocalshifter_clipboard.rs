use crate::state::AppState;
use crate::vocalshifter_clipboard::ClipboardFileKind;

use super::core::get_timeline_state_from_ref;

pub(super) fn paste_vocalshifter_clipboard(state: &AppState) -> serde_json::Value {
    let Some((path, kind)) = crate::vocalshifter_clipboard::find_latest_clipboard_file() else {
        return serde_json::json!({"ok": false, "error": "clipboard_not_found"});
    };

    match kind {
        ClipboardFileKind::PitchData => paste_clb_pitch_data(state, &path),
        ClipboardFileKind::Project => paste_vsp_project(state, &path),
    }
}

/// 粘贴 .clb 音高线数据到当前选中轨道的 pitch_edit。
fn paste_clb_pitch_data(state: &AppState, path: &std::path::Path) -> serde_json::Value {
    let points = match crate::vocalshifter_clipboard::parse_clipboard_file(path) {
        Ok(v) => v,
        Err(e) => {
            if e.starts_with("invalid_format:") {
                return serde_json::json!({"ok": false, "error": "clipboard_invalid_format"});
            }
            return serde_json::json!({"ok": false, "error": "clipboard_io_error"});
        }
    };

    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());

    let Some(selected_track_id) = tl.selected_track_id.clone() else {
        return serde_json::json!({"ok": false, "error": "no_pitch_line_selected"});
    };

    let Some(root_track_id) = tl.resolve_root_track_id(&selected_track_id) else {
        return serde_json::json!({"ok": false, "error": "no_pitch_line_selected"});
    };

    tl.ensure_params_for_root(&root_track_id);
    let frame_period_ms = tl.frame_period_ms().max(0.1);

    state.checkpoint_timeline(&tl);

    let Some(entry) = tl.params_by_root_track.get_mut(&root_track_id) else {
        return serde_json::json!({"ok": false, "error": "params_missing"});
    };

    // 先把剪贴板点映射到时间线帧索引，并按帧去重（同一帧保留最后一个点）。
    let mut frame_points: std::collections::BTreeMap<usize, (bool, f32)> =
        std::collections::BTreeMap::new();

    for point in points {
        if !(point.time_sec.is_finite() && point.time_sec >= 0.0) {
            continue;
        }
        let idx_f = (point.time_sec * 1000.0) / frame_period_ms;
        if !(idx_f.is_finite() && idx_f >= 0.0) {
            continue;
        }
        let idx = idx_f.round() as usize;
        if idx >= entry.pitch_edit.len() {
            continue;
        }

        let v = if point.midi_pitch.is_finite() {
            point.midi_pitch
        } else {
            0.0
        };
        let clamped = if v == 0.0 { 0.0 } else { v.clamp(1.0, 127.0) };
        frame_points.insert(idx, (point.disabled, clamped));
    }

    // 第一步：写入锚点（disabled 点恢复 orig，enabled 点写入 edit）。
    let mut touched = 0usize;
    let mut ordered: Vec<(usize, bool, f32)> = Vec::with_capacity(frame_points.len());
    for (&idx, &(disabled, pitch)) in &frame_points {
        if disabled {
            let orig = entry.pitch_orig.get(idx).copied().unwrap_or(0.0);
            entry.pitch_edit[idx] = orig;
        } else {
            entry.pitch_edit[idx] = pitch;
        }
        ordered.push((idx, disabled, pitch));
        touched += 1;
    }

    // 第二步：对相邻 enabled 锚点之间做线性补帧，避免拉伸区“漏帧→回落 orig”的锯齿。
    let mut filled = 0usize;
    for win in ordered.windows(2) {
        let (idx_a, dis_a, pitch_a) = win[0];
        let (idx_b, dis_b, pitch_b) = win[1];
        if idx_b <= idx_a + 1 {
            continue;
        }
        if dis_a || dis_b {
            continue;
        }
        if !(pitch_a.is_finite() && pitch_a > 0.0 && pitch_b.is_finite() && pitch_b > 0.0) {
            continue;
        }

        let span = (idx_b - idx_a) as f32;
        for idx in (idx_a + 1)..idx_b {
            let t = (idx - idx_a) as f32 / span;
            let v = pitch_a + (pitch_b - pitch_a) * t;
            entry.pitch_edit[idx] = v.clamp(1.0, 127.0);
            filled += 1;
        }
    }

    if touched > 0 || filled > 0 {
        entry.pitch_edit_user_modified = true;
    }

    state.audio_engine.update_timeline(tl.clone());

    serde_json::json!({
        "ok": true,
        "updated": touched,
        "filled": filled,
    })
}

/// 粘贴 .clb.vshp / .clb.vsp 工程文件中被选中的 Item。
fn paste_vsp_project(state: &AppState, path: &std::path::Path) -> serde_json::Value {
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(_) => {
            return serde_json::json!({"ok": false, "error": "clipboard_io_error"});
        }
    };

    let vsp_dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));

    // 从当前 timeline 读取光标位置、选中轨道、轨道顺序
    let (playhead_sec, selected_track_idx, ordered_track_ids) = {
        let tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());

        let mut sorted_tracks: Vec<_> = tl.tracks.iter().collect();
        sorted_tracks.sort_by_key(|t| t.order);
        let ordered: Vec<String> = sorted_tracks.iter().map(|t| t.id.clone()).collect();

        let sel_idx = tl
            .selected_track_id
            .as_ref()
            .and_then(|sel| ordered.iter().position(|id| id == sel))
            .unwrap_or(0);

        (tl.playhead_sec, sel_idx, ordered)
    };

    let result = match crate::vocalshifter_import::import_vsp_clipboard(
        &data,
        vsp_dir,
        playhead_sec,
        selected_track_idx,
        &ordered_track_ids,
    ) {
        Ok(r) => r,
        Err(e) => {
            return serde_json::json!({"ok": false, "error": format!("clipboard_parse_failed: {}", e)});
        }
    };

    // 需要开启 compose_enabled 的轨道
    let tracks_needing_compose: Vec<String> = result
        .timeline
        .params_by_root_track
        .keys()
        .cloned()
        .collect();

    // 应用到 AppState
    {
        let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
        state.checkpoint_timeline(&tl);

        if !result.timeline.tracks.is_empty() {
            for track in &result.timeline.tracks {
                tl.tracks.push(track.clone());
            }
            tl.next_track_order = tl
                .next_track_order
                .max(tl.tracks.iter().map(|t| t.order).max().unwrap_or(0) + 1);
        }

        for clip in &result.timeline.clips {
            tl.clips.push(clip.clone());
        }

        for (track_id, new_params) in &result.timeline.params_by_root_track {
            if let Some(existing) = tl.params_by_root_track.get_mut(track_id) {
                // 轨道已有 pitch 数据 → 合并非零区域
                if new_params.pitch_edit_user_modified {
                    let len = existing.pitch_edit.len().max(new_params.pitch_edit.len());
                    if existing.pitch_edit.len() < len {
                        existing.pitch_edit.resize(len, 0.0);
                        existing.pitch_orig.resize(len, 0.0);
                    }
                    for (i, &v) in new_params.pitch_edit.iter().enumerate() {
                        if v > 0.0 && i < existing.pitch_edit.len() {
                            existing.pitch_edit[i] = v;
                        }
                    }
                    existing.pitch_edit_user_modified = true;
                }
            } else {
                tl.params_by_root_track
                    .insert(track_id.clone(), new_params.clone());
            }
        }

        // 为含音高数据的轨道开启 compose_enabled
        for track in &mut tl.tracks {
            if tracks_needing_compose.contains(&track.id) && !track.compose_enabled {
                track.compose_enabled = true;
            }
        }

        let max_end = tl
            .clips
            .iter()
            .map(|c| c.start_sec + c.length_sec)
            .fold(tl.project_sec, f64::max);
        tl.project_sec = max_end;

        state.audio_engine.update_timeline(tl.clone());
    }

    let payload = get_timeline_state_from_ref(state);
    let mut json = serde_json::to_value(&payload).unwrap_or_default();

    if !result.skipped_files.is_empty() {
        json["skipped_files"] = serde_json::json!(result.skipped_files);
    }

    json
}
