// Reaper 剪贴板粘贴命令
//
// 从 Windows 剪贴板读取 Reaper 的 "REAPERMedia" 自定义格式数据，
// 解析并导入到当前时间线。

use crate::reaper_import;
use crate::state::AppState;

use super::core::get_timeline_state_from_ref;

/// 读取 Windows 剪贴板中的 REAPERMedia 数据。
fn read_reaper_clipboard() -> Result<Vec<u8>, String> {
    use clipboard_win::{register_format, Clipboard};

    let _clipboard =
        Clipboard::new_attempts(10).map_err(|e| format!("clipboard_open_failed: {}", e))?;

    let format =
        register_format("REAPERMedia").ok_or_else(|| "clipboard_format_not_found".to_string())?;

    // 首先获取数据大小
    let size =
        clipboard_win::raw::size(format.get()).ok_or_else(|| "clipboard_empty".to_string())?;

    let mut buf = vec![0u8; size.get()];
    let bytes_read = clipboard_win::raw::get(format.get(), &mut buf)
        .map_err(|e| format!("clipboard_read_failed: {}", e))?;

    buf.truncate(bytes_read);
    Ok(buf)
}

/// 粘贴 Reaper 剪贴板数据到当前选中的轨道。
pub(super) fn paste_reaper_clipboard(state: &AppState) -> serde_json::Value {
    // 读取剪贴板
    let data = match read_reaper_clipboard() {
        Ok(d) => d,
        Err(e) => {
            return serde_json::json!({"ok": false, "error": e});
        }
    };

    // 从当前 timeline 读取光标位置、选中轨道、轨道顺序
    let (playhead_sec, selected_track_idx, ordered_track_ids) = {
        let tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());

        // 按 order 排序的轨道 ID
        let mut sorted_tracks: Vec<_> = tl.tracks.iter().collect();
        sorted_tracks.sort_by_key(|t| t.order);
        let ordered: Vec<String> = sorted_tracks.iter().map(|t| t.id.clone()).collect();

        // 选中轨道的下标
        let sel_idx = tl
            .selected_track_id
            .as_ref()
            .and_then(|sel| ordered.iter().position(|id| id == sel))
            .unwrap_or(0);

        (tl.playhead_sec, sel_idx, ordered)
    };

    // 解析并转换
    let result = match reaper_import::import_reaper_clipboard(
        &data,
        playhead_sec,
        selected_track_idx,
        &ordered_track_ids,
    ) {
        Ok(r) => r,
        Err(e) => {
            return serde_json::json!({"ok": false, "error": format!("parse_failed: {}", e)});
        }
    };

    // 需要开启 compose_enabled 的轨道
    let tracks_needing_compose: Vec<String> = result
        .timeline
        .params_by_root_track
        .keys()
        .filter(|tid| {
            result
                .timeline
                .params_by_root_track
                .get(*tid)
                .and_then(|p| p.pending_pitch_offset.as_ref())
                .map(|offsets| offsets.iter().any(|&v| v.abs() > 1e-6))
                .unwrap_or(false)
        })
        .cloned()
        .collect();

    // 应用到 AppState
    {
        let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
        state.checkpoint_timeline(&tl);

        if !result.timeline.tracks.is_empty() {
            // 有新轨道：合并到现有 timeline
            for track in &result.timeline.tracks {
                tl.tracks.push(track.clone());
            }
            tl.next_track_order = tl
                .next_track_order
                .max(tl.tracks.iter().map(|t| t.order).max().unwrap_or(0) + 1);
        }

        // 合并 clips
        for clip in &result.timeline.clips {
            tl.clips.push(clip.clone());
        }

        // 合并 pitch params（pending_pitch_offset 需要合并到已有的 entry）
        for (track_id, new_params) in &result.timeline.params_by_root_track {
            if let Some(existing) = tl.params_by_root_track.get_mut(track_id) {
                // 轨道已有 pitch 数据 → 只设置 pending offset
                if let Some(ref offsets) = new_params.pending_pitch_offset {
                    existing.pending_pitch_offset = Some(offsets.clone());
                }
            } else {
                tl.params_by_root_track
                    .insert(track_id.clone(), new_params.clone());
            }
        }

        // 为含音高偏移的轨道开启 compose_enabled
        for track in &mut tl.tracks {
            if tracks_needing_compose.contains(&track.id) && !track.compose_enabled {
                track.compose_enabled = true;
            }
        }

        // 更新工程时长（如果需要）
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
