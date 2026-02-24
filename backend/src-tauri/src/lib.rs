mod audio_engine;
mod audio_utils;
mod commands;
mod mixdown;
mod models;
mod pitch_analysis;
mod pitch_clip;
mod pitch_editing;

#[cfg(feature = "onnx")]
mod nsf_hifigan_onnx;
#[cfg(not(feature = "onnx"))]
mod nsf_hifigan_onnx_stub;
#[cfg(not(feature = "onnx"))]
use nsf_hifigan_onnx_stub as nsf_hifigan_onnx;

mod project;
mod rubberband;
mod state;
mod time_stretch;
mod waveform;
mod waveform_disk_cache;
mod world;
mod world_lock;
mod world_vocoder;

use std::path::PathBuf;
use tauri::Manager;

pub fn nsf_hifigan_onnx_probe() -> Result<String, String> {
    // Probe ONNX model availability.
    #[cfg(feature = "onnx")]
    {
        nsf_hifigan_onnx::probe_load();
        Ok("ok".to_string())
    }
    #[cfg(not(feature = "onnx"))]
    {
        Err("onnx feature disabled".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::default())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Prefer pre-bundled Rubber Band DLL if present.
            // We expose it to the runtime loader via env var so `rubberband.rs`
            // can stay independent of Tauri handles.
            if std::env::var_os("HIFISHIFTER_RUBBERBAND_DLL").is_none() {
                // 1) Bundled resource dir (packaged apps)
                if let Ok(res_dir) = app.path().resource_dir() {
                    let p = res_dir
                        .join("rubberband")
                        .join("windows")
                        .join("x64")
                        .join("rubberband.dll");
                    if p.exists() {
                        std::env::set_var("HIFISHIFTER_RUBBERBAND_DLL", p);
                    }
                }

                // 2) Workspace path (dev runs)
                if std::env::var_os("HIFISHIFTER_RUBBERBAND_DLL").is_none() {
                    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("resources")
                        .join("rubberband")
                        .join("windows")
                        .join("x64")
                        .join("rubberband.dll");
                    if p.exists() {
                        std::env::set_var("HIFISHIFTER_RUBBERBAND_DLL", p);
                    }
                }
            }

            // Prefer pre-bundled WORLD DLL if present.
            if std::env::var_os("HIFISHIFTER_WORLD_DLL").is_none() {
                // 1) Bundled resource dir (packaged apps)
                if let Ok(res_dir) = app.path().resource_dir() {
                    let p = res_dir
                        .join("world")
                        .join("windows")
                        .join("x64")
                        .join("world.dll");
                    if p.exists() {
                        std::env::set_var("HIFISHIFTER_WORLD_DLL", p);
                    }
                }

                // 2) Workspace path (dev runs)
                if std::env::var_os("HIFISHIFTER_WORLD_DLL").is_none() {
                    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("resources")
                        .join("world")
                        .join("windows")
                        .join("x64")
                        .join("world.dll");
                    if p.exists() {
                        std::env::set_var("HIFISHIFTER_WORLD_DLL", p);
                    }
                }
            }

            let state = app.state::<state::AppState>();

            // Expose app handle for background workers.
            let _ = state.app_handle.set(app.handle().clone());

            // Prefer the OS-level app cache dir so peaks persist across runs.
            let base = app
                .path()
                .app_cache_dir()
                .unwrap_or_else(|_| waveform_disk_cache::default_cache_dir());
            let dir = base.join("hifishifter").join("waveform_peaks_cache");
            {
                let mut d = state
                    .waveform_cache_dir
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                *d = dir.clone();
            }
            let _ = waveform_disk_cache::ensure_dir(&dir);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<state::AppState>();
                let (dirty, allow_close, has_path, name) = {
                    let mut p = state.project.lock().unwrap_or_else(|e| e.into_inner());
                    if p.allow_close {
                        p.allow_close = false;
                        return;
                    }
                    (p.dirty, p.allow_close, p.path.is_some(), p.name.clone())
                };

                let _ = allow_close;
                if !dirty {
                    return;
                }

                api.prevent_close();

                let decision = rfd::MessageDialog::new()
                    .set_title("HiFiShifter")
                    .set_description("Project has unsaved changes. Save before exiting?")
                    .set_buttons(rfd::MessageButtons::YesNoCancel)
                    .show();

                match decision {
                    rfd::MessageDialogResult::Yes => {
                        let project_path = if has_path {
                            let p = state.project.lock().unwrap_or_else(|e| e.into_inner());
                            p.path.clone()
                        } else {
                            let default_name = if name.trim().is_empty() {
                                "Untitled".to_string()
                            } else {
                                name
                            };
                            rfd::FileDialog::new()
                                .add_filter("HiFiShifter Project", &["hsp", "json"])
                                .set_file_name(format!("{}.hsp", default_name))
                                .save_file()
                                .map(|p| p.display().to_string())
                        };

                        let Some(path) = project_path else {
                            return; // canceled
                        };

                        match commands::save_project_to_path_inner(state.inner(), window, path) {
                            Ok(_) => {
                                {
                                    let mut p =
                                        state.project.lock().unwrap_or_else(|e| e.into_inner());
                                    p.allow_close = true;
                                }
                                let _ = window.close();
                            }
                            Err(e) => {
                                let _ = rfd::MessageDialog::new()
                                    .set_title("Save failed")
                                    .set_description(&e)
                                    .set_buttons(rfd::MessageButtons::Ok)
                                    .show();
                            }
                        }
                    }
                    rfd::MessageDialogResult::No => {
                        {
                            let mut p = state.project.lock().unwrap_or_else(|e| e.into_inner());
                            p.allow_close = true;
                        }
                        let _ = window.close();
                    }
                    rfd::MessageDialogResult::Cancel => {
                        // keep window open
                    }
                    _ => {
                        // keep window open
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::get_runtime_info,
            commands::get_timeline_state,
            commands::set_transport,
            commands::close_window,
            commands::undo_timeline,
            commands::redo_timeline,
            commands::get_project_meta,
            commands::new_project,
            commands::open_project_dialog,
            commands::open_project,
            commands::save_project,
            commands::save_project_as,
            commands::open_audio_dialog,
            commands::pick_output_path,
            commands::get_waveform_peaks_segment,
            commands::get_root_mix_waveform_peaks_segment,
            commands::get_track_mix_waveform_peaks_segment,
            commands::clear_waveform_cache,
            commands::import_audio_item,
            commands::import_audio_bytes,
            commands::add_track,
            commands::remove_track,
            commands::move_track,
            commands::set_track_state,
            commands::select_track,
            commands::set_project_length,
            commands::get_track_summary,
            commands::get_param_frames,
            commands::set_param_frames,
            commands::restore_param_frames,
            commands::add_clip,
            commands::remove_clip,
            commands::move_clip,
            commands::set_clip_state,
            commands::split_clip,
            commands::glue_clips,
            commands::select_clip,
            commands::load_default_model,
            commands::load_model,
            commands::set_pitch_shift,
            commands::process_audio,
            commands::synthesize,
            commands::save_synthesized,
            commands::play_original,
            commands::play_synthesized,
            commands::stop_audio,
            commands::get_playback_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
