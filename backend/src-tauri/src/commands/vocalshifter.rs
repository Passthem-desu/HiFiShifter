// VocalShifter 工程导入命令
//
// 提供两个 Tauri 命令：
// - open_vocalshifter_dialog: 打开文件选择对话框
// - import_vocalshifter_project: 解析并导入 .vshp/.vsp 工程

use crate::state::AppState;
use crate::vocalshifter_import;
use std::path::Path;
use tauri::{State, Window};

use super::common::ok_bool;
use super::core::get_timeline_state_from_ref;

fn update_window_title(window: &Window, name: &str, dirty: bool) {
    let suffix = if dirty { "*" } else { "" };
    let title = format!("HiFiShifter - {}{}", name, suffix);
    let _ = window.set_title(&title);
}

/// 弹出文件选择对话框，选择 .vshp / .vsp 文件。
pub(super) fn open_vocalshifter_dialog(state: &AppState) -> serde_json::Value {
    let is_zh = {
        let locale = state
            .ui_locale
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        locale.to_lowercase().starts_with("zh")
    };
    let filter_name = if is_zh {
        "VocalShifter 工程"
    } else {
        "VocalShifter Project"
    };

    let picked = rfd::FileDialog::new()
        .add_filter(filter_name, &["vshp", "vsp"])
        .pick_file();

    match picked {
        None => serde_json::json!({"ok": true, "canceled": true}),
        Some(path) => {
            serde_json::json!({"ok": true, "canceled": false, "path": path.display().to_string()})
        }
    }
}

/// 解析 VocalShifter 工程并导入到 HiFiShifter。
pub(super) fn import_vocalshifter_project(
    state: &AppState,
    window: &Window,
    vsp_path: String,
) -> crate::models::TimelineStatePayload {
    let path = Path::new(&vsp_path);

    // 读取文件
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(e) => {
            show_error_dialog(state, &format!("Failed to read file: {}", e));
            let mut payload = get_timeline_state_from_ref(state);
            payload.ok = false;
            return payload;
        }
    };

    // 获取 .vshp/.vsp 所在目录，用于解析相对路径
    let vsp_dir = path.parent().unwrap_or_else(|| Path::new("."));

    // 解析并转换
    let result = match vocalshifter_import::import_vsp(&data, vsp_dir) {
        Ok(r) => r,
        Err(e) => {
            show_error_dialog(state, &e);
            let mut payload = get_timeline_state_from_ref(state);
            payload.ok = false;
            return payload;
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

    // 如果有跳过的文件，弹出警告
    if !result.skipped_files.is_empty() {
        show_skipped_warning(state, &result.skipped_files);
    }

    get_timeline_state_from_ref(state)
}

fn show_error_dialog(state: &AppState, message: &str) {
    let is_zh = {
        let locale = state
            .ui_locale
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        locale.to_lowercase().starts_with("zh")
    };
    let title = if is_zh { "导入错误" } else { "Import Error" };
    rfd::MessageDialog::new()
        .set_title(title)
        .set_description(message)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

fn show_skipped_warning(state: &AppState, skipped: &[String]) {
    let is_zh = {
        let locale = state
            .ui_locale
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        locale.to_lowercase().starts_with("zh")
    };

    let title = if is_zh {
        "导入警告"
    } else {
        "Import Warning"
    };

    let header = if is_zh {
        "以下音频文件因格式不支持或文件不存在而被跳过：\n"
    } else {
        "The following audio files were skipped (unsupported format or not found):\n"
    };

    let file_list: String = skipped
        .iter()
        .map(|f| format!("  • {}", f))
        .collect::<Vec<_>>()
        .join("\n");

    rfd::MessageDialog::new()
        .set_title(title)
        .set_description(&format!("{}{}", header, file_list))
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}
