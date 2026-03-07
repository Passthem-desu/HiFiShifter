// Reaper 剪贴板粘贴命令
//
// 从 Windows 剪贴板读取 Reaper 的 "REAPERMedia" 自定义格式数据，
// 解析并导入到当前时间线。

use crate::reaper_import;
use crate::state::AppState;

use super::core::get_timeline_state_from_ref;

/// 读取 Windows 剪贴板中的 REAPERMedia 数据。
fn read_reaper_clipboard() -> Result<Vec<u8>, String> {
    use clipboard_win::{Clipboard, register_format};

    let _clipboard = Clipboard::new_attempts(10)
        .map_err(|e| format!("clipboard_open_failed: {}", e))?;

    let format = register_format("REAPERMedia")
        .ok_or_else(|| "clipboard_format_not_found".to_string())?;

    // 首先获取数据大小
    let size = clipboard_win::raw::size(format.get())
        .ok_or_else(|| "clipboard_empty".to_string())?;

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

    // 获取当前选中的轨道 ID
    let selected_track_id = {
        let tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
        tl.selected_track_id.clone()
    };

    // 解析并转换
    let result = match reaper_import::import_reaper_clipboard(
        &data,
        selected_track_id.as_deref(),
    ) {
        Ok(r) => r,
        Err(e) => {
            return serde_json::json!({"ok": false, "error": format!("parse_failed: {}", e)});
        }
    };

    // 应用到 AppState
    {
        let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
        state.checkpoint_timeline(&tl);

        if !result.timeline.tracks.is_empty() {
            // 有新轨道：合并到现有 timeline
            for track in &result.timeline.tracks {
                tl.tracks.push(track.clone());
            }
            tl.next_track_order = tl.next_track_order.max(
                tl.tracks.iter().map(|t| t.order).max().unwrap_or(0) + 1,
            );
        }

        // 合并 clips
        for clip in &result.timeline.clips {
            tl.clips.push(clip.clone());
        }

        // 合并 pitch params
        for (track_id, params) in &result.timeline.params_by_root_track {
            tl.params_by_root_track
                .entry(track_id.clone())
                .or_insert_with(|| params.clone());
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
