mod audio_engine;
mod audio_utils;
mod commands;
mod mixdown;
mod models;
mod pitch_analysis;
mod pitch_clip;
mod pitch_editing;
mod synth_clip_cache;
mod clip_pitch_cache;
mod pitch_progress;
mod renderer;
mod clip_rendering_state;

#[cfg(feature = "onnx")]
mod nsf_hifigan_onnx;
#[cfg(not(feature = "onnx"))]
mod nsf_hifigan_onnx_stub;
#[cfg(not(feature = "onnx"))]
use nsf_hifigan_onnx_stub as nsf_hifigan_onnx;

mod project;
mod rubberband;
mod vocalshifter_clipboard;
mod vocalshifter_import;
mod state;
mod time_stretch;
mod waveform;
mod waveform_disk_cache;
mod config;
mod world;
mod streaming_world;
mod world_vocoder;

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
            // 打包后的应用：从 resource_dir 查找内嵌的 ONNX 模型
            if std::env::var_os("HIFISHIFTER_NSF_HIFIGAN_MODEL_DIR").is_none() {
                if let Ok(res_dir) = app.path().resource_dir() {
                    let p = res_dir.join("models").join("nsf_hifigan");
                    if p.join("pc_nsf_hifigan.onnx").exists()
                        && p.join("config.json").exists()
                    {
                        std::env::set_var("HIFISHIFTER_NSF_HIFIGAN_MODEL_DIR", &p);
                    }
                }
            }

            let state = app.state::<state::AppState>();

            // Expose app handle for background workers.
            let _ = state.app_handle.set(app.handle().clone());

            // 将 app_handle 传递给 audio engine worker，使其能向前端推送事件。
            state.audio_engine.set_app_handle(app.handle().clone());

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

            // 加载持久化的最近工程列表
            if let Ok(cfg_base) = app.path().app_config_dir() {
                let cfg_dir = cfg_base.join("HiFiShifter");
                let _ = std::fs::create_dir_all(&cfg_dir);
                let recent = crate::config::load_recent(&cfg_dir);
                {
                    let mut p = state.project.lock().unwrap_or_else(|e| e.into_inner());
                    p.recent = recent;
                }
                let _ = state.config_dir.set(cfg_dir);
            }

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

                let is_zh = {
                    let locale = state
                        .ui_locale
                        .read()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone();
                    locale.to_lowercase().starts_with("zh")
                };

                let unsaved_desc = if is_zh {
                    "工程有未保存的更改。是否在退出前保存？"
                } else {
                    "Project has unsaved changes. Save before exiting?"
                };

                let decision = rfd::MessageDialog::new()
                    .set_title("HiFiShifter")
                    .set_description(unsaved_desc)
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
                                .add_filter("HiFiShifter Project", &["hshp", "hsp", "json"])
                                .set_file_name(format!("{}.hshp", default_name))
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
                                let save_failed_title = if is_zh {
                                    "保存失败"
                                } else {
                                    "Save failed"
                                };
                                let _ = rfd::MessageDialog::new()
                                    .set_title(save_failed_title)
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
            commands::set_ui_locale,
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
            commands::pick_directory,
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
            commands::save_separated,
            commands::play_original,
            commands::play_synthesized,
            commands::stop_audio,
            commands::get_playback_state,
            commands::debug_realtime_render_stats,
            commands::get_pitch_analysis_progress,
            commands::get_onnx_status,
            commands::get_onnx_diagnostic,
            commands::clear_pitch_cache,
            commands::get_pitch_cache_stats,
            commands::list_directory,
            commands::get_audio_file_info,
            commands::read_audio_preview,
            commands::search_files_recursive,
            commands::open_vocalshifter_dialog,
            commands::import_vocalshifter_project,
            commands::paste_vocalshifter_clipboard
            // TODO: 异步音高刷新命令暂时禁用，等待基础设施完成
            // commands::start_pitch_refresh_task,
            // commands::get_pitch_refresh_status,
            // commands::cancel_pitch_task
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
