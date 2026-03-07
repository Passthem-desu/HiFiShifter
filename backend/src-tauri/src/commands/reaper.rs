// Reaper 工程文件导入命令
//
// 提供两个操作：
// - open_reaper_dialog: 打开文件选择对话框（.rpp）
// - import_reaper_project: 解析并导入 .rpp 工程

use crate::state::AppState;
use crate::reaper_import;
use std::path::Path;
use tauri::Window;

use super::core::get_timeline_state_from_ref;

fn update_window_title(window: &Window, name: &str, dirty: bool) {
    let suffix = if dirty { "*" } else { "" };
    let title = format!("HiFiShifter - {}{}", name, suffix);
    let _ = window.set_title(&title);
}

/// 弹出文件选择对话框，选择 .rpp 文件。
pub(super) fn open_reaper_dialog() -> serde_json::Value {
    let picked = rfd::FileDialog::new()
        .add_filter("Reaper Project", &["rpp", "RPP"])
        .pick_file();

    match picked {
        None => serde_json::json!({"ok": true, "canceled": true}),
        Some(path) => {
            serde_json::json!({"ok": true, "canceled": false, "path": path.display().to_string()})
        }
    }
}

/// 解析 Reaper 工程并导入到 HiFiShifter。
pub(super) fn import_reaper_project(
    state: &AppState,
    window: &Window,
    rpp_path: String,
) -> serde_json::Value {
    let path = Path::new(&rpp_path);

    let result = match reaper_import::import_rpp(path) {
        Ok(r) => r,
        Err(_e) => {
            let mut payload = get_timeline_state_from_ref(state);
            payload.ok = false;
            let mut json = serde_json::to_value(&payload).unwrap_or_default();
            json["ok"] = serde_json::json!(false);
            json["error"] = serde_json::json!("import_parse_failed");
            return json;
        }
    };

    // 应用到 AppState
    {
        let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
        *tl = result.timeline.clone();
        state.audio_engine.update_timeline(tl.clone());
    }
    state.clear_history();

    // 更新工程元信息
    let project_name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported")
        .to_string();
    {
        let mut p = state.project.lock().unwrap_or_else(|e| e.into_inner());
        p.name = project_name.clone();
        p.path = None; // Reaper 工程不设为已保存路径
        p.dirty = true; // 标记为未保存（需要另存为 .hshp）
        update_window_title(window, &p.name, p.dirty);
    }

    let payload = get_timeline_state_from_ref(state);
    let mut json = serde_json::to_value(&payload).unwrap_or_default();

    if !result.skipped_files.is_empty() {
        json["skipped_files"] = serde_json::json!(result.skipped_files);
    }

    json
}
