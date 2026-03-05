use crate::project::{
    load_project_file, make_paths_relative, project_name_from_path, resolve_paths_relative,
    ProjectFile,
};
use crate::state::AppState;
use std::fs;
use std::path::PathBuf;
use tauri::{State, Window};

use super::common::ok_bool;
use super::core::{get_timeline_state, get_timeline_state_from_ref};

fn update_window_title(window: &Window, name: &str, dirty: bool) {
    let suffix = if dirty { "*" } else { "" };
    let title = format!("HiFiShifter - {}{}", name, suffix);
    let _ = window.set_title(&title);
}

pub(crate) fn save_project_to_path_inner(
    state: &AppState,
    window: &Window,
    project_path: String,
) -> Result<crate::models::TimelineStatePayload, String> {
    let path = PathBuf::from(&project_path);
    let name = {
        let p = state.project.lock().unwrap_or_else(|e| e.into_inner());
        if p.name.trim().is_empty() {
            project_name_from_path(&path)
        } else {
            p.name.clone()
        }
    };

    let tl = state
        .timeline
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let tl_rel = make_paths_relative(tl, &path);
    let pf = ProjectFile::new(name.clone(), tl_rel);
    // 使用 MessagePack 格式保存（v2），体积更小、解析更快。
    let bytes = rmp_serde::to_vec_named(&pf).map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| e.to_string())?;

    {
        let mut p = state.project.lock().unwrap_or_else(|e| e.into_inner());
        p.name = name;
        p.path = Some(project_path.clone());
        p.dirty = false;
        p.recent.retain(|x| x != &project_path);
        p.recent.insert(0, project_path.clone());
        if p.recent.len() > 10 {
            p.recent.truncate(10);
        }
        update_window_title(window, &p.name, p.dirty);
    }

    Ok(get_timeline_state_from_ref(state))
}




pub(super) fn get_project_meta(state: State<'_, AppState>) -> crate::models::ProjectMetaPayload {
    state.project_meta_payload()
}




pub(super) fn new_project(state: State<'_, AppState>, window: Window) -> crate::models::TimelineStatePayload {
    {
        let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
        *tl = crate::state::TimelineState::default();
        state.audio_engine.update_timeline(tl.clone());
    }
    state.clear_history();
    {
        let mut p = state.project.lock().unwrap_or_else(|e| e.into_inner());
        p.name = "Untitled".to_string();
        p.path = None;
        p.dirty = false;
    }
    update_window_title(&window, "Untitled", false);
    get_timeline_state(state)
}




pub(super) fn open_project_dialog() -> serde_json::Value {
    let picked = rfd::FileDialog::new()
        .add_filter("HiFiShifter Project", &["hshp", "hsp", "json"])
        .pick_file();
    match picked {
        None => serde_json::json!({"ok": true, "canceled": true}),
        Some(path) => {
            serde_json::json!({"ok": true, "canceled": false, "path": path.display().to_string()})
        }
    }
}




pub(super) fn open_project(
    state: State<'_, AppState>,
    window: Window,
    project_path: String,
) -> crate::models::TimelineStatePayload {
    let path = PathBuf::from(&project_path);
    // 读取字节流，自动检测 MessagePack（v2）或 JSON（v1 兼容）格式。
    let bytes = fs::read(&path).unwrap_or_default();
    let parsed = load_project_file(&bytes);
    let Ok(mut pf) = parsed else {
        let mut payload = get_timeline_state(state);
        payload.ok = false;
        return payload;
    };

    pf.timeline = resolve_paths_relative(pf.timeline, &path);
    {
        let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
        *tl = pf.timeline.clone();
        state.audio_engine.update_timeline(tl.clone());
    }
    state.clear_history();
    {
        let mut p = state.project.lock().unwrap_or_else(|e| e.into_inner());
        p.name = if pf.name.trim().is_empty() {
            project_name_from_path(&path)
        } else {
            pf.name.clone()
        };
        p.path = Some(project_path.clone());
        p.dirty = false;
        // recent list (in-memory)
        p.recent.retain(|x| x != &project_path);
        p.recent.insert(0, project_path.clone());
        if p.recent.len() > 10 {
            p.recent.truncate(10);
        }
        update_window_title(&window, &p.name, p.dirty);
    }

    get_timeline_state(state)
}




pub(super) fn save_project(state: State<'_, AppState>, window: Window) -> serde_json::Value {
    let existing_path = {
        let p = state.project.lock().unwrap_or_else(|e| e.into_inner());
        p.path.clone()
    };
    if let Some(path) = existing_path {
        return save_project_to_path(state, window, path);
    }
    // No path yet -> Save As
    save_project_as(state, window)
}




pub(super) fn save_project_as(state: State<'_, AppState>, window: Window) -> serde_json::Value {
    let default_name = {
        let p = state.project.lock().unwrap_or_else(|e| e.into_inner());
        if p.name.trim().is_empty() {
            "Untitled".to_string()
        } else {
            p.name.clone()
        }
    };
    let picked = rfd::FileDialog::new()
        .add_filter("HiFiShifter Project", &["hshp", "hsp", "json"])
        .set_file_name(format!("{}.hshp", default_name))
        .save_file();
    match picked {
        None => serde_json::json!({"ok": true, "canceled": true}),
        Some(path) => save_project_to_path(state, window, path.display().to_string()),
    }
}

fn save_project_to_path(state: State<'_, AppState>, window: Window, project_path: String) -> serde_json::Value {
    match save_project_to_path_inner(state.inner(), &window, project_path.clone()) {
        Ok(timeline) => {
            serde_json::json!({"ok": true, "canceled": false, "path": project_path, "timeline": timeline })
        }
        Err(e) => serde_json::json!({"ok": false, "error": e}),
    }
}




pub(super) fn close_window(window: Window) -> serde_json::Value {
    let _ = window.close();
    ok_bool()
}
