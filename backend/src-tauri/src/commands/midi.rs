// MIDI 导入命令
//
// 提供两个 Tauri 命令：
// - get_midi_tracks: 解析 MIDI 文件并返回轨道列表（供前端轨道选择面板使用）
// - import_midi_to_pitch: 将选中的 MIDI 轨道音符写入 pitch_edit

use crate::midi_import::{self, MidiTrackInfo};
use crate::state::{AppState, PitchAnalysisAlgo, Track};

fn midi_log(message: impl AsRef<str>) {
    eprintln!("[midi_import] {}", message.as_ref());
}

fn validate_midi_import_target(track: &Track) -> Result<(), &'static str> {
    if !track.compose_enabled {
        return Err("pitch_requires_compose");
    }

    if matches!(track.pitch_analysis_algo, PitchAnalysisAlgo::None) {
        return Err("pitch_requires_algo");
    }

    Ok(())
}

fn required_project_length(
    notes: &[midi_import::MidiNoteEvent],
    offset_sec: f64,
) -> Option<f64> {
    notes.iter()
        .filter_map(|note| {
            let end_sec = note.end_sec + offset_sec;
            (end_sec.is_finite() && end_sec > 0.0).then_some(end_sec)
        })
        .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
}

fn align_notes_to_offset(notes: &[midi_import::MidiNoteEvent], offset_sec: f64) -> f64 {
    let first_start_sec = notes
        .iter()
        .filter_map(|note| {
            (note.start_sec.is_finite() && note.start_sec >= 0.0).then_some(note.start_sec)
        })
        .min_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or(0.0);

    offset_sec - first_start_sec
}

/// 读取 MIDI 文件并返回轨道摘要列表。
pub(super) fn get_midi_tracks(midi_path: String) -> serde_json::Value {
    let path = std::path::Path::new(&midi_path);
    midi_log(format!("get_midi_tracks: path={midi_path}"));

    if !path.exists() {
        midi_log("get_midi_tracks: file_not_found");
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

            midi_log(format!(
                "get_midi_tracks: parsed tracks_total={} tracks_with_notes={}",
                result.tracks.len(),
                tracks_with_notes.len()
            ));

            serde_json::json!({
                "ok": true,
                "tracks": tracks_with_notes,
            })
        }
        Err(e) => {
            midi_log(format!("get_midi_tracks: parse_error={e}"));
            serde_json::json!({"ok": false, "error": e})
        }
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
    midi_log(format!(
        "import_midi_to_pitch: path={} track_index={:?} offset_sec={:?}",
        midi_path, track_index, offset_sec
    ));

    if !path.exists() {
        midi_log("import_midi_to_pitch: file_not_found");
        return serde_json::json!({"ok": false, "error": "file_not_found"});
    }

    let parse_result = match midi_import::parse_midi_file(path) {
        Ok(r) => r,
        Err(e) => {
            midi_log(format!("import_midi_to_pitch: parse_error={e}"));
            return serde_json::json!({"ok": false, "error": e});
        }
    };

    // 收集要写入的音符：如果指定了 track_index 则只取该轨道，否则合并所有轨道
    let notes: Vec<midi_import::MidiNoteEvent> = match track_index {
        Some(idx) => {
            if idx >= parse_result.track_notes.len() {
                midi_log(format!(
                    "import_midi_to_pitch: track_index_out_of_range idx={} available={}",
                    idx,
                    parse_result.track_notes.len()
                ));
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

    let first_start_sec = notes.first().map(|note| note.start_sec).unwrap_or(0.0);
    let last_end_sec = notes.last().map(|note| note.end_sec).unwrap_or(0.0);
    midi_log(format!(
        "import_midi_to_pitch: notes_selected={} first_start_sec={:.3} last_end_sec={:.3}",
        notes.len(), first_start_sec, last_end_sec
    ));

    if notes.is_empty() {
        midi_log("import_midi_to_pitch: no_notes_in_track");
        return serde_json::json!({"ok": false, "error": "no_notes_in_track"});
    }

    let requested_offset = offset_sec.unwrap_or(0.0);
    let offset = align_notes_to_offset(&notes, requested_offset);
    midi_log(format!(
        "import_midi_to_pitch: requested_offset_sec={:.3} aligned_offset_sec={:.3}",
        requested_offset, offset
    ));

    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());

    let Some(selected_track_id) = tl.selected_track_id.clone() else {
        midi_log("import_midi_to_pitch: no_pitch_line_selected (selected_track_id missing)");
        return serde_json::json!({"ok": false, "error": "no_pitch_line_selected"});
    };

    let Some(root_track_id) = tl.resolve_root_track_id(&selected_track_id) else {
        midi_log(format!(
            "import_midi_to_pitch: no_pitch_line_selected (resolve_root_track_id failed for selected_track_id={})",
            selected_track_id
        ));
        return serde_json::json!({"ok": false, "error": "no_pitch_line_selected"});
    };

    let Some(root_track) = tl.tracks.iter().find(|track| track.id == root_track_id) else {
        midi_log(format!(
            "import_midi_to_pitch: no_pitch_line_selected (root_track missing root_track_id={})",
            root_track_id
        ));
        return serde_json::json!({"ok": false, "error": "no_pitch_line_selected"});
    };

    midi_log(format!(
        "import_midi_to_pitch: selected_track_id={} root_track_id={} compose_enabled={} pitch_analysis_algo={:?} project_sec_before={:.3}",
        selected_track_id,
        root_track_id,
        root_track.compose_enabled,
        root_track.pitch_analysis_algo,
        tl.project_sec
    ));

    if let Err(error) = validate_midi_import_target(root_track) {
        midi_log(format!("import_midi_to_pitch: validation_failed error={error}"));
        return serde_json::json!({"ok": false, "error": error});
    }

    if let Some(required_sec) = required_project_length(&notes, offset) {
        if required_sec > tl.project_sec {
            midi_log(format!(
                "import_midi_to_pitch: extend_project_length from={:.3} to={:.3}",
                tl.project_sec, required_sec
            ));
            tl.set_project_length(required_sec);
        }
    }

    tl.ensure_params_for_root(&root_track_id);
    let frame_period_ms = tl.frame_period_ms().max(0.1);

    state.checkpoint_timeline(&tl);

    let Some(entry) = tl.params_by_root_track.get_mut(&root_track_id) else {
        midi_log(format!(
            "import_midi_to_pitch: params_missing root_track_id={}",
            root_track_id
        ));
        return serde_json::json!({"ok": false, "error": "params_missing"});
    };

    midi_log(format!(
        "import_midi_to_pitch: frame_period_ms={:.3} pitch_edit_len={} pitch_edit_user_modified_before={}",
        frame_period_ms,
        entry.pitch_edit.len(),
        entry.pitch_edit_user_modified
    ));

    let touched = midi_import::write_notes_to_pitch_edit(
        &notes,
        frame_period_ms,
        &mut entry.pitch_edit,
        offset,
    );

    if touched > 0 {
        entry.pitch_edit_user_modified = true;
        midi_log(format!(
            "import_midi_to_pitch: success frames_touched={} notes_imported={} pitch_edit_len={} project_sec_after={:.3}",
            touched,
            notes.len(),
            entry.pitch_edit.len(),
            tl.project_sec
        ));
    } else {
        midi_log(format!(
            "import_midi_to_pitch: no_frames_touched notes_imported={} pitch_edit_len={} offset={:.3} frame_period_ms={:.3}",
            notes.len(),
            entry.pitch_edit.len(),
            offset,
            frame_period_ms
        ));
        return serde_json::json!({"ok": false, "error": "no_frames_touched"});
    }

    state.audio_engine.update_timeline(tl.clone());

    serde_json::json!({
        "ok": true,
        "notes_imported": notes.len(),
        "frames_touched": touched,
    })
}

#[cfg(test)]
mod tests {
    use super::{align_notes_to_offset, required_project_length, validate_midi_import_target};
    use crate::midi_import::MidiNoteEvent;
    use crate::state::{PitchAnalysisAlgo, Track};

    fn make_track(compose_enabled: bool, pitch_analysis_algo: PitchAnalysisAlgo) -> Track {
        Track {
            id: "track_1".to_string(),
            name: "Track 1".to_string(),
            parent_id: None,
            order: 0,
            muted: false,
            solo: false,
            volume: 1.0,
            compose_enabled,
            pitch_analysis_algo,
            color: String::new(),
        }
    }

    #[test]
    fn validate_midi_import_target_requires_compose() {
        let track = make_track(false, PitchAnalysisAlgo::WorldDll);
        assert_eq!(validate_midi_import_target(&track), Err("pitch_requires_compose"));
    }

    #[test]
    fn validate_midi_import_target_requires_algorithm() {
        let track = make_track(true, PitchAnalysisAlgo::None);
        assert_eq!(validate_midi_import_target(&track), Err("pitch_requires_algo"));
    }

    #[test]
    fn validate_midi_import_target_accepts_enabled_pitch_track() {
        let track = make_track(true, PitchAnalysisAlgo::WorldDll);
        assert_eq!(validate_midi_import_target(&track), Ok(()));
    }

    #[test]
    fn required_project_length_uses_max_note_end_with_offset() {
        let notes = vec![
            MidiNoteEvent {
                start_sec: 0.0,
                end_sec: 1.5,
                note: 60,
                velocity: 100,
            },
            MidiNoteEvent {
                start_sec: 2.0,
                end_sec: 3.25,
                note: 64,
                velocity: 100,
            },
        ];

        assert_eq!(required_project_length(&notes, 4.0), Some(7.25));
    }

    #[test]
    fn required_project_length_ignores_non_finite_end_times() {
        let notes = vec![MidiNoteEvent {
            start_sec: 0.0,
            end_sec: f64::NAN,
            note: 60,
            velocity: 100,
        }];

        assert_eq!(required_project_length(&notes, 0.0), None);
    }

    #[test]
    fn align_notes_to_offset_moves_first_note_to_requested_time() {
        let notes = vec![
            MidiNoteEvent {
                start_sec: 217.586,
                end_sec: 218.0,
                note: 60,
                velocity: 100,
            },
            MidiNoteEvent {
                start_sec: 220.0,
                end_sec: 221.0,
                note: 64,
                velocity: 100,
            },
        ];

        assert_eq!(align_notes_to_offset(&notes, 0.0), -217.586);
        assert_eq!(align_notes_to_offset(&notes, 12.0), -205.586);
    }
}
