use crate::state::AppState;

fn show_error_dialog(state: &AppState, message_zh: &str, message_en: &str) {
    let is_zh = {
        let locale = state
            .ui_locale
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        locale.to_lowercase().starts_with("zh")
    };
    let title = if is_zh {
        "粘贴错误"
    } else {
        "Paste Error"
    };
    let desc = if is_zh { message_zh } else { message_en };

    let _ = rfd::MessageDialog::new()
        .set_title(title)
        .set_description(desc)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

pub(super) fn paste_vocalshifter_clipboard(state: &AppState) -> serde_json::Value {
    let Some(path) = crate::vocalshifter_clipboard::find_latest_clipboard_file() else {
        show_error_dialog(
            state,
            "未找到 VocalShifter 剪贴板数据。",
            "VocalShifter clipboard data was not found.",
        );
        return serde_json::json!({"ok": false, "error": "clipboard_not_found"});
    };

    let points = match crate::vocalshifter_clipboard::parse_clipboard_file(&path) {
        Ok(v) => v,
        Err(e) => {
            if e.starts_with("invalid_format:") {
                show_error_dialog(
                    state,
                    "剪贴板文件格式不正确（文件大小不是 0x80 的整数倍，或记录损坏）。",
                    "Clipboard file format is invalid (size is not a multiple of 0x80, or record is corrupted).",
                );
                return serde_json::json!({"ok": false, "error": "clipboard_invalid_format"});
            }
            show_error_dialog(
                state,
                "读取 VocalShifter 剪贴板文件时发生 IO 错误。",
                "An I/O error occurred while reading VocalShifter clipboard file.",
            );
            return serde_json::json!({"ok": false, "error": "clipboard_io_error"});
        }
    };

    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());

    let Some(selected_track_id) = tl.selected_track_id.clone() else {
        show_error_dialog(
            state,
            "当前没有选中的音高线，请先选择一条音高线。",
            "No pitch line is selected. Please select one first.",
        );
        return serde_json::json!({"ok": false, "error": "no_pitch_line_selected"});
    };

    let Some(root_track_id) = tl.resolve_root_track_id(&selected_track_id) else {
        show_error_dialog(
            state,
            "当前没有选中的音高线，请先选择一条音高线。",
            "No pitch line is selected. Please select one first.",
        );
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
