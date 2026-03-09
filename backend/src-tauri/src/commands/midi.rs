// MIDI 导入命令
//
// 提供两个 Tauri 命令：
// - get_midi_tracks: 解析 MIDI 文件并返回轨道列表（供前端轨道选择面板使用）
// - import_midi_to_pitch: 将选中的 MIDI 轨道音符写入 pitch_edit

use crate::midi_import::{self, MidiTrackInfo};
use crate::state::AppState;

/// 读取 MIDI 文件并返回轨道摘要列表。
pub(super) fn get_midi_tracks(midi_path: String) -> serde_json::Value {
    let path = std::path::Path::new(&midi_path);

    if !path.exists() {
        return serde_json::json!({"ok": false, "error": "file_not_found"});
    }

    match midi_import::parse_midi_file(path) {
        Ok(result) => {
            // 只返回有音符的轨道
            let tracks_with_notes: Vec<&MidiTrackInfo> = result
                .tracks
                .iter()
                .filter(|t| t.note_count > 0)
                .collect();

            serde_json::json!({
                "ok": true,
                "tracks": tracks_with_notes,
            })
        }
        Err(e) => serde_json::json!({"ok": false, "error": e}),
    }
}

/// 将 MIDI 文件中指定轨道的音符写入当前选中根轨的 pitch_edit。
pub(super) fn import_midi_to_pitch(
    state: &AppState,
    midi_path: String,
    track_index: Option<usize>,
    offset_sec: Option<f64>,
) -> serde_json::Value {
    let path = std::path::Path::new(&midi_path);

    if !path.exists() {
        return serde_json::json!({"ok": false, "error": "file_not_found"});
    }

    let parse_result = match midi_import::parse_midi_file(path) {
        Ok(r) => r,
        Err(e) => return serde_json::json!({"ok": false, "error": e}),
    };

    // 收集要写入的音符：如果指定了 track_index 则只取该轨道，否则合并所有轨道
    let notes: Vec<midi_import::MidiNoteEvent> = match track_index {
        Some(idx) => {
            if idx >= parse_result.track_notes.len() {
                return serde_json::json!({"ok": false, "error": "track_index_out_of_range"});
            }
            parse_result.track_notes[idx].clone()
        }
        None => {
            // 合并所有轨道的音符
            let mut all_notes: Vec<midi_import::MidiNoteEvent> = parse_result
                .track_notes
                .into_iter()
                .flatten()
                .collect();
            // 按起始时间排序
            all_notes.sort_by(|a, b| {
                a.start_sec
                    .partial_cmp(&b.start_sec)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            all_notes
        }
    };

    if notes.is_empty() {
        return serde_json::json!({"ok": false, "error": "no_notes_in_track"});
    }

    let offset = offset_sec.unwrap_or(0.0);

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

    let touched = midi_import::write_notes_to_pitch_edit(
        &notes,
        frame_period_ms,
        &mut entry.pitch_edit,
        offset,
    );

    if touched > 0 {
        entry.pitch_edit_user_modified = true;
    }

    state.audio_engine.update_timeline(tl.clone());

    serde_json::json!({
        "ok": true,
        "notes_imported": notes.len(),
        "frames_touched": touched,
    })
}
