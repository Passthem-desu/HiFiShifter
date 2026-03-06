// VocalShifter 工程导入命令
//
// 提供两个 Tauri 命令：
// - open_vocalshifter_dialog: 打开文件选择对话框
// - import_vocalshifter_project: 解析并导入 .vshp/.vsp 工程

use crate::state::AppState;
use crate::vocalshifter_import;
use std::path::Path;
use tauri::Window;

use super::core::get_timeline_state_from_ref;

fn update_window_title(window: &Window, name: &str, dirty: bool) {
    let suffix = if dirty { "*" } else { "" };
    let title = format!("HiFiShifter - {}{}", name, suffix);
    let _ = window.set_title(&title);
}

/// 弹出文件选择对话框，选择 .vshp / .vsp 文件。
pub(super) fn open_vocalshifter_dialog() -> serde_json::Value {
    let picked = rfd::FileDialog::new()
        .add_filter("VocalShifter Project", &["vshp", "vsp"])
        .pick_file();

    match picked {
        None => serde_json::json!({"ok": true, "canceled": true}),
        Some(path) => {
            serde_json::json!({"ok": true, "canceled": false, "path": path.display().to_string()})
        }
    }
}

/// 解析 VocalShifter 工程并导入到 HiFiShifter。
///
/// 返回 JSON 对象，包含 timeline 数据。失败时 `ok=false` 并附带 `error` 字段。
/// 若有跳过的文件，附带 `skipped_files` 数组。
pub(super) fn import_vocalshifter_project(
    state: &AppState,
    window: &Window,
    vsp_path: String,
) -> serde_json::Value {
    let path = Path::new(&vsp_path);

    // 读取文件
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(_e) => {
            let mut payload = get_timeline_state_from_ref(state);
            payload.ok = false;
            let mut json = serde_json::to_value(&payload).unwrap_or_default();
            json["ok"] = serde_json::json!(false);
            json["error"] = serde_json::json!("import_read_failed");
            return json;
        }
    };

    // 获取 .vshp/.vsp 所在目录，用于解析相对路径
    let vsp_dir = path.parent().unwrap_or_else(|| Path::new("."));

    // 解析并转换
    let result = match vocalshifter_import::import_vsp(&data, vsp_dir) {
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
        p.path = None; // VocalShifter 工程不设为已保存路径
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
