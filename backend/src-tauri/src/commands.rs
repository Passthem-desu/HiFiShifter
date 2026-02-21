use crate::audio_utils::try_read_wav_info;
use crate::mixdown::{render_mixdown_wav, MixdownOptions};
use crate::models::{PlaybackStatePayload, ProcessAudioPayload, SynthesizePayload};
use crate::project::{make_paths_relative, project_name_from_path, resolve_paths_relative, ProjectFile};
use crate::state::AppState;
use crate::waveform;
use base64::Engine;
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use tauri::{State, Window};
use uuid::Uuid;

fn guard_json_command(name: &str, f: impl FnOnce() -> serde_json::Value) -> serde_json::Value {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("command panicked: {name}");
            serde_json::json!({"ok": false, "error": format!("panic in command: {name}")})
        }
    }
}

fn guard_waveform_command(
    name: &str,
    f: impl FnOnce() -> waveform::WaveformPeaksSegmentPayload,
) -> waveform::WaveformPeaksSegmentPayload {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("command panicked: {name}");
            waveform::WaveformPeaksSegmentPayload {
                ok: false,
                min: vec![],
                max: vec![],
                sample_rate: 0,
                hop: 0,
            }
        }
    }
}

fn ok_bool() -> serde_json::Value {
    serde_json::json!({ "ok": true })
}

#[tauri::command(rename_all = "camelCase")]
pub fn ping() -> serde_json::Value {
    serde_json::json!({ "ok": true, "message": "pong" })
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_runtime_info(state: State<'_, AppState>) -> crate::models::RuntimeInfoPayload {
    state.runtime_info()
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_timeline_state(state: State<'_, AppState>) -> crate::models::TimelineStatePayload {
    let tl = state
        .timeline
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

fn get_timeline_state_from_ref(state: &AppState) -> crate::models::TimelineStatePayload {
    let tl = state
        .timeline
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_transport(
    state: State<'_, AppState>,
    playhead_beat: Option<f64>,
    bpm: Option<f64>,
) -> serde_json::Value {
    if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
        eprintln!(
            "set_transport(playhead_beat={:?}, bpm={:?})",
            playhead_beat, bpm
        );
    }
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    let prev_bpm = tl.bpm;
    if let Some(v) = playhead_beat {
        tl.playhead_beat = v.max(0.0);
    }
    if let Some(v) = bpm {
        if v.is_finite() && v > 0.0 {
            // BPM is project-affecting: checkpoint for undo.
            state.checkpoint_timeline(&tl);
            tl.bpm = v;
        }
    }

    // Keep realtime engine transport aligned.
    let playhead_sec = (tl.playhead_beat.max(0.0)) * 60.0 / tl.bpm.max(1e-6);
    state.audio_engine.seek_sec(playhead_sec);
    if (tl.bpm - prev_bpm).abs() > 1e-9 {
        state.audio_engine.update_timeline(tl.clone());
    }

    serde_json::json!({"ok": true, "playhead_beat": tl.playhead_beat, "bpm": tl.bpm })
}

// ===================== undo / redo =====================

#[tauri::command(rename_all = "camelCase")]
pub fn undo_timeline(state: State<'_, AppState>) -> crate::models::TimelineStatePayload {
    state.undo_timeline()
}

#[tauri::command(rename_all = "camelCase")]
pub fn redo_timeline(state: State<'_, AppState>) -> crate::models::TimelineStatePayload {
    state.redo_timeline()
}

// ===================== project io =====================

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
    let txt = serde_json::to_string_pretty(&pf).map_err(|e| e.to_string())?;
    fs::write(&path, txt).map_err(|e| e.to_string())?;

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

#[tauri::command(rename_all = "camelCase")]
pub fn get_project_meta(state: State<'_, AppState>) -> crate::models::ProjectMetaPayload {
    state.project_meta_payload()
}

#[tauri::command(rename_all = "camelCase")]
pub fn new_project(state: State<'_, AppState>, window: Window) -> crate::models::TimelineStatePayload {
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

#[tauri::command(rename_all = "camelCase")]
pub fn open_project_dialog() -> serde_json::Value {
    let picked = rfd::FileDialog::new()
        .add_filter("HiFiShifter Project", &["hsp", "json"])
        .pick_file();
    match picked {
        None => serde_json::json!({"ok": true, "canceled": true}),
        Some(path) => serde_json::json!({"ok": true, "canceled": false, "path": path.display().to_string()}),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn open_project(state: State<'_, AppState>, window: Window, project_path: String) -> crate::models::TimelineStatePayload {
    let path = PathBuf::from(&project_path);
    let txt = fs::read_to_string(&path).unwrap_or_else(|_| "".to_string());
    let parsed: Result<ProjectFile, _> = serde_json::from_str(&txt);
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

#[tauri::command(rename_all = "camelCase")]
pub fn save_project(state: State<'_, AppState>, window: Window) -> serde_json::Value {
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

#[tauri::command(rename_all = "camelCase")]
pub fn save_project_as(state: State<'_, AppState>, window: Window) -> serde_json::Value {
    let default_name = {
        let p = state.project.lock().unwrap_or_else(|e| e.into_inner());
        if p.name.trim().is_empty() { "Untitled".to_string() } else { p.name.clone() }
    };
    let picked = rfd::FileDialog::new()
        .add_filter("HiFiShifter Project", &["hsp", "json"])
        .set_file_name(format!("{}.hsp", default_name))
        .save_file();
    match picked {
        None => serde_json::json!({"ok": true, "canceled": true}),
        Some(path) => save_project_to_path(state, window, path.display().to_string()),
    }
}

fn save_project_to_path(state: State<'_, AppState>, window: Window, project_path: String) -> serde_json::Value {
    match save_project_to_path_inner(state.inner(), &window, project_path.clone()) {
        Ok(timeline) => serde_json::json!({"ok": true, "canceled": false, "path": project_path, "timeline": timeline }),
        Err(e) => serde_json::json!({"ok": false, "error": e}),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn close_window(window: Window) -> serde_json::Value {
    let _ = window.close();
    ok_bool()
}

// ===================== dialogs / io =====================

#[tauri::command(rename_all = "camelCase")]
pub fn open_audio_dialog() -> serde_json::Value {
    let picked = rfd::FileDialog::new()
        .add_filter("Audio", &["wav", "flac", "mp3", "ogg", "m4a"]) 
        .pick_file();

    match picked {
        None => serde_json::json!({"ok": true, "canceled": true}),
        Some(path) => serde_json::json!({"ok": true, "canceled": false, "path": path.display().to_string()}),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn pick_output_path() -> serde_json::Value {
    let picked = rfd::FileDialog::new()
        .add_filter("WAV", &["wav"])
        .set_file_name("output.wav")
        .save_file();

    match picked {
        None => serde_json::json!({"ok": true, "canceled": true}),
        Some(path) => serde_json::json!({"ok": true, "canceled": false, "path": path.display().to_string()}),
    }
}

// ===================== waveform peaks =====================

#[tauri::command(rename_all = "camelCase")]
pub fn get_waveform_peaks_segment(
    state: State<'_, AppState>,
    source_path: String,
    start_sec: f64,
    duration_sec: f64,
    columns: usize,
) -> waveform::WaveformPeaksSegmentPayload {
    let hop = 256usize;
    let cols = columns.clamp(16, 8192);

    let peaks = match state.get_or_compute_waveform_peaks(&source_path, hop) {
        Ok(p) => p,
        Err(_) => {
            return waveform::WaveformPeaksSegmentPayload {
                ok: false,
                min: vec![],
                max: vec![],
                sample_rate: 44100,
                hop: hop as u32,
            }
        }
    };

    waveform::segment_from_cached(peaks.as_ref(), start_sec, duration_sec, cols)
}

#[tauri::command(rename_all = "camelCase")]
pub fn clear_waveform_cache(state: State<'_, AppState>) -> serde_json::Value {
    let stats = state.clear_waveform_cache();
    let dir = {
        state
            .waveform_cache_dir
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .display()
            .to_string()
    };
    serde_json::json!({
        "ok": true,
        "removed_files": stats.removed_files,
        "removed_bytes": stats.removed_bytes,
        "dir": dir,
    })
}

fn ensure_temp_dir() -> std::io::Result<PathBuf> {
    let dir = std::env::temp_dir().join("hifishifter");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn new_temp_wav_path(prefix: &str) -> Result<PathBuf, String> {
    let dir = ensure_temp_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(format!(
        "{}_{}.wav",
        prefix,
        Uuid::new_v4().simple()
    )))
}

fn render_timeline_to_wav(
    state: &AppState,
    output_path: &Path,
    start_sec: f64,
    end_sec: Option<f64>,
) -> Result<crate::mixdown::MixdownResult, String> {
    let timeline = state
        .timeline
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    render_mixdown_wav(
        &timeline,
        output_path,
        MixdownOptions {
            sample_rate: 44100,
            start_sec,
            end_sec,
            stretch: crate::time_stretch::StretchAlgorithm::RubberBand,
        },
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn import_audio_bytes(
    state: State<'_, AppState>,
    file_name: String,
    base64_data: String,
    track_id: Option<Option<String>>,
    start_beat: Option<f64>,
) -> crate::models::TimelineStatePayload {
    if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
        eprintln!(
            "import_audio_bytes(file_name={}, base64_len={}, track_id={:?}, start_beat={:?})",
            file_name,
            base64_data.len(),
            track_id,
            start_beat
        );
    }
    let engine = base64::engine::general_purpose::STANDARD;
    let bytes = engine
        .decode(base64_data.as_bytes())
        .unwrap_or_default();

    let ext = Path::new(&file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let tmp_dir = ensure_temp_dir().ok();
    let path = tmp_dir
        .unwrap_or_else(std::env::temp_dir)
        .join(format!("{}_{}.{}", "import", Uuid::new_v4().simple(), ext));

    let _ = fs::write(&path, &bytes);

    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    state.checkpoint_timeline(&tl);
    let resolved_track_id: Option<String> = match track_id {
        None => None,
        Some(Some(id)) => Some(id),
        Some(None) => Some(tl.add_track(Some("Track".to_string()), None, None)),
    };

    tl.import_audio_item(
        &path.display().to_string(),
        resolved_track_id,
        start_beat,
    );
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn import_audio_item(
    state: State<'_, AppState>,
    audio_path: String,
    track_id: Option<Option<String>>,
    start_beat: Option<f64>,
) -> crate::models::TimelineStatePayload {
    if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
        eprintln!(
            "import_audio_item(audio_path={}, track_id={:?}, start_beat={:?})",
            audio_path,
            track_id,
            start_beat
        );
    }
    {
        let mut rt = state.runtime.lock().unwrap_or_else(|e| e.into_inner());
        rt.audio_loaded = true;
    }

    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    state.checkpoint_timeline(&tl);
    let resolved_track_id: Option<String> = match track_id {
        None => None,
        Some(Some(id)) => Some(id),
        Some(None) => Some(tl.add_track(Some("Track".to_string()), None, None)),
    };

    tl.import_audio_item(&audio_path, resolved_track_id, start_beat);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

// ===================== timeline CRUD =====================

#[tauri::command(rename_all = "camelCase")]
pub fn add_track(
    state: State<'_, AppState>,
    name: Option<String>,
    parent_track_id: Option<String>,
    index: Option<usize>,
) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    state.checkpoint_timeline(&tl);
    tl.add_track(name, parent_track_id, index);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn remove_track(state: State<'_, AppState>, track_id: String) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    state.checkpoint_timeline(&tl);
    tl.remove_track(&track_id);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn move_track(
    state: State<'_, AppState>,
    track_id: String,
    target_index: usize,
    parent_track_id: Option<String>,
) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    state.checkpoint_timeline(&tl);
    tl.move_track(&track_id, target_index, parent_track_id);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_track_state(
    state: State<'_, AppState>,
    track_id: String,
    muted: Option<bool>,
    solo: Option<bool>,
    volume: Option<f32>,
    compose_enabled: Option<bool>,
    pitch_analysis_algo: Option<String>,
) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    state.checkpoint_timeline(&tl);
    let algo = pitch_analysis_algo.as_deref().map(|s| match s {
        "world_dll" | "world" => crate::state::PitchAnalysisAlgo::WorldDll,
        "nsf_hifigan_onnx" | "nsf_hifigan" | "onnx" => crate::state::PitchAnalysisAlgo::NsfHifiganOnnx,
        "none" => crate::state::PitchAnalysisAlgo::None,
        _ => crate::state::PitchAnalysisAlgo::Unknown,
    });
    tl.set_track_state(&track_id, muted, solo, volume, compose_enabled, algo);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

// ===================== param curves =====================

#[tauri::command(rename_all = "camelCase")]
pub fn get_param_frames(
    state: State<'_, AppState>,
    track_id: String,
    param: String,
    start_frame: u32,
    frame_count: u32,
    stride: Option<u32>,
) -> crate::models::ParamFramesPayload {
    if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
        eprintln!(
            "get_param_frames(track_id={}, param={}, start_frame={}, frame_count={}, stride={:?})",
            track_id, param, start_frame, frame_count, stride
        );
    }
    let (root, fp, entry, compose_enabled) = {
        let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());

        let root = match tl.resolve_root_track_id(&track_id) {
            Some(id) => id,
            None => {
                return crate::models::ParamFramesPayload {
                    ok: false,
                    root_track_id: "".to_string(),
                    param,
                    frame_period_ms: tl.frame_period_ms(),
                    start_frame,
                    orig: vec![],
                    edit: vec![],
                }
            }
        };

        tl.ensure_params_for_root(&root);
        let fp = tl.frame_period_ms();
        let compose_enabled = tl
            .tracks
            .iter()
            .find(|t| t.id == root)
            .map(|t| t.compose_enabled)
            .unwrap_or(false);
        let entry = tl
            .params_by_root_track
            .get(&root)
            .cloned()
            .unwrap_or_default();

        (root, fp, entry, compose_enabled)
    };

    if param == "pitch" && !compose_enabled {
        return crate::models::ParamFramesPayload {
            ok: true,
            root_track_id: root,
            param,
            frame_period_ms: fp,
            start_frame,
            orig: vec![],
            edit: vec![],
        };
    }

    // Schedule pitch_orig analysis in background; return current cached curve immediately.
    if param == "pitch" {
        crate::pitch_analysis::maybe_schedule_pitch_orig(&state, &root);
    }

    let start = start_frame as usize;
    let count = (frame_count as usize).max(1);
    let step = (stride.unwrap_or(1).max(1)) as usize;

    let (orig_src, edit_src) = match param.as_str() {
        "pitch" => (&entry.pitch_orig, &entry.pitch_edit),
        "tension" => (&entry.tension_orig, &entry.tension_edit),
        _ => (&entry.pitch_orig, &entry.pitch_edit),
    };

    let mut orig = Vec::with_capacity(count);
    let mut edit = Vec::with_capacity(count);
    for i in 0..count {
        let idx = start.saturating_add(i.saturating_mul(step));
        let o = orig_src.get(idx).copied().unwrap_or(0.0);
        let mut e = edit_src.get(idx).copied().unwrap_or(o);
        // For pitch, treat 0 as "unset" in edit curve and fall back to orig.
        // (UI edits are clamped to MIDI range, so 0 is not a meaningful edited value.)
        if param == "pitch" && e == 0.0 && o != 0.0 {
            e = o;
        }
        orig.push(o);
        edit.push(e);
    }

    crate::models::ParamFramesPayload {
        ok: true,
        root_track_id: root,
        param,
        frame_period_ms: fp,
        start_frame,
        orig,
        edit,
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_param_frames(
    state: State<'_, AppState>,
    track_id: String,
    param: String,
    start_frame: u32,
    values: Vec<f32>,
    checkpoint: Option<bool>,
) -> serde_json::Value {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    let do_checkpoint = checkpoint.unwrap_or(true);
    if do_checkpoint {
        state.checkpoint_timeline(&tl);
    }

    let Some(root) = tl.resolve_root_track_id(&track_id) else {
        return serde_json::json!({"ok": false});
    };
    tl.ensure_params_for_root(&root);

    let Some(entry) = tl.params_by_root_track.get_mut(&root) else {
        return serde_json::json!({"ok": false, "error": "params missing"});
    };

    let dst = match param.as_str() {
        "pitch" => &mut entry.pitch_edit,
        "tension" => &mut entry.tension_edit,
        _ => &mut entry.pitch_edit,
    };

    let debug = std::env::var("HIFISHIFTER_DEBUG_COMMANDS")
        .ok()
        .as_deref()
        == Some("1");

    let start = start_frame as usize;
    let mut written = 0usize;
    let mut non_finite = 0usize;
    let mut clamped = 0usize;
    let mut min_v = f32::INFINITY;
    let mut max_v = f32::NEG_INFINITY;
    let mut max_delta = 0.0f32;
    let mut prev_v: Option<f32> = None;
    for (i, v) in values.into_iter().enumerate() {
        let idx = start.saturating_add(i);
        if idx >= dst.len() {
            break;
        }

        let mut v = if v.is_finite() {
            v
        } else {
            non_finite += 1;
            0.0
        };

        match param.as_str() {
            "pitch" => {
                // MIDI pitch. Keep 0 as "unset"; otherwise clamp into a reasonable range.
                if v != 0.0 {
                    let vv = v.clamp(1.0, 127.0);
                    if vv != v {
                        clamped += 1;
                    }
                    v = vv;
                }
            }
            "tension" => {
                // Tension is a UI parameter in [-100, 100].
                let vv = v.clamp(-100.0, 100.0);
                if vv != v {
                    clamped += 1;
                }
                v = vv;
            }
            _ => {}
        }

        min_v = min_v.min(v);
        max_v = max_v.max(v);
        if let Some(p) = prev_v {
            max_delta = max_delta.max((v - p).abs());
        }
        prev_v = Some(v);

        dst[idx] = v;
        written += 1;
    }

    if debug {
        // This helps diagnose whether the frontend is sending invalid / extreme curves.
        eprintln!(
            "set_param_frames(param={param}, start_frame={start_frame}, len={}): non_finite={non_finite} clamped={clamped} min={min_v:.3} max={max_v:.3} max_delta={max_delta:.3}",
            written
        );
    }

    // Ensure realtime playback reflects edits immediately.
    state.audio_engine.update_timeline(tl.clone());

    serde_json::json!({"ok": true})
}

#[tauri::command(rename_all = "camelCase")]
pub fn restore_param_frames(
    state: State<'_, AppState>,
    track_id: String,
    param: String,
    start_frame: u32,
    frame_count: u32,
    checkpoint: Option<bool>,
) -> serde_json::Value {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    let do_checkpoint = checkpoint.unwrap_or(true);
    if do_checkpoint {
        state.checkpoint_timeline(&tl);
    }

    let Some(root) = tl.resolve_root_track_id(&track_id) else {
        return serde_json::json!({"ok": false});
    };
    tl.ensure_params_for_root(&root);
    let Some(entry) = tl.params_by_root_track.get_mut(&root) else {
        return serde_json::json!({"ok": false, "error": "params missing"});
    };

    let start = start_frame as usize;
    let count = (frame_count as usize).max(1);

    match param.as_str() {
        "pitch" => {
            for i in 0..count {
                let idx = start.saturating_add(i);
                if idx >= entry.pitch_edit.len() {
                    break;
                }
                let o = entry.pitch_orig.get(idx).copied().unwrap_or(0.0);
                entry.pitch_edit[idx] = o;
            }
        }
        "tension" => {
            for i in 0..count {
                let idx = start.saturating_add(i);
                if idx >= entry.tension_edit.len() {
                    break;
                }
                let o = entry.tension_orig.get(idx).copied().unwrap_or(0.0);
                entry.tension_edit[idx] = o;
            }
        }
        _ => {}
    }

    // Ensure realtime playback reflects edits immediately.
    state.audio_engine.update_timeline(tl.clone());

    serde_json::json!({"ok": true})
}

// ===================== root mix waveform peaks =====================

#[tauri::command(rename_all = "camelCase")]
pub fn get_root_mix_waveform_peaks_segment(
    state: State<'_, AppState>,
    track_id: String,
    start_sec: f64,
    duration_sec: f64,
    columns: usize,
) -> waveform::WaveformPeaksSegmentPayload {
    guard_waveform_command("get_root_mix_waveform_peaks_segment", || {
        if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
            eprintln!(
                "get_root_mix_waveform_peaks_segment(track_id={}, start_sec={:.3}, duration_sec={:.3}, columns={})",
                track_id, start_sec, duration_sec, columns
            );
        }
        let tl0 = state
            .timeline
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let Some(root) = tl0.resolve_root_track_id(&track_id) else {
            return waveform::WaveformPeaksSegmentPayload {
                ok: false,
                min: vec![],
                max: vec![],
                sample_rate: 44100,
                hop: 1,
            };
        };

    // Collect root + descendants.
    let mut included: std::collections::HashSet<String> = std::collections::HashSet::new();
    included.insert(root.clone());
    let mut idx = 0usize;
    let mut frontier = vec![root.clone()];
    while idx < frontier.len() {
        let cur = frontier[idx].clone();
        for child in tl0
            .tracks
            .iter()
            .filter(|t| t.parent_id.as_deref() == Some(cur.as_str()))
            .map(|t| t.id.clone())
            .collect::<Vec<_>>()
        {
            if included.insert(child.clone()) {
                frontier.push(child);
            }
        }
        idx += 1;
        if idx > 4096 {
            break;
        }
    }

    let mut tl = tl0.clone();
    tl.tracks.retain(|t| included.contains(&t.id));
    tl.clips.retain(|c| included.contains(&c.track_id));

    // Peaks are used as a visual background in the UI; do not hide waveforms
    // due to mixer states (mute/solo) which would otherwise result in a silent
    // mix and an invisible waveform.
    for t in &mut tl.tracks {
        t.muted = false;
        t.solo = false;
    }
    for c in &mut tl.clips {
        c.muted = false;
    }

    let cols = columns.clamp(16, 8192);
    let opts = crate::mixdown::MixdownOptions {
        sample_rate: 44100,
        start_sec,
        end_sec: Some(start_sec + duration_sec.max(0.0)),
        // Peaks are used as a visual timing reference. Prefer RubberBand so
        // stretched clips line up with the same timing as pitch analysis.
        // (Falls back to LinearResample if RubberBand is unavailable.)
        stretch: crate::time_stretch::StretchAlgorithm::RubberBand,
    };

    let (sr, ch, _dur, mix) = match crate::mixdown::render_mixdown_interleaved(&tl, opts) {
        Ok(v) => v,
        Err(_) => {
            return waveform::WaveformPeaksSegmentPayload {
                ok: false,
                min: vec![],
                max: vec![],
                sample_rate: 44100,
                hop: 1,
            }
        }
    };

    let channels = ch.max(1) as usize;
    let frames = mix.len() / channels;
    if frames == 0 {
        return waveform::WaveformPeaksSegmentPayload {
            ok: true,
            min: vec![0.0; cols],
            max: vec![0.0; cols],
            sample_rate: sr,
            hop: 1,
        };
    }

    let mut out_min = vec![f32::INFINITY; cols];
    let mut out_max = vec![f32::NEG_INFINITY; cols];
    for x in 0..cols {
        let i0 = (x * frames) / cols;
        let i1 = ((x + 1) * frames) / cols;
        let i1 = i1.max(i0 + 1).min(frames);
        for f in i0..i1 {
            let base = f * channels;
            let mut sum = 0.0f32;
            for c in 0..channels {
                sum += mix[base + c];
            }
            let v = sum / channels as f32;
            if v < out_min[x] {
                out_min[x] = v;
            }
            if v > out_max[x] {
                out_max[x] = v;
            }
        }
        if !out_min[x].is_finite() {
            out_min[x] = 0.0;
        }
        if !out_max[x].is_finite() {
            out_max[x] = 0.0;
        }
    }

        waveform::WaveformPeaksSegmentPayload {
            ok: true,
            min: out_min,
            max: out_max,
            sample_rate: sr,
            hop: 1,
        }
    })
}

// ===================== track subtree mix waveform peaks =====================

#[tauri::command(rename_all = "camelCase")]
pub fn get_track_mix_waveform_peaks_segment(
    state: State<'_, AppState>,
    track_id: String,
    start_sec: f64,
    duration_sec: f64,
    columns: usize,
) -> waveform::WaveformPeaksSegmentPayload {
    guard_waveform_command("get_track_mix_waveform_peaks_segment", || {
        if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
            eprintln!(
                "get_track_mix_waveform_peaks_segment(track_id={}, start_sec={:.3}, duration_sec={:.3}, columns={})",
                track_id, start_sec, duration_sec, columns
            );
        }
        let tl0 = state
            .timeline
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if !tl0.tracks.iter().any(|t| t.id == track_id) {
            return waveform::WaveformPeaksSegmentPayload {
                ok: false,
                min: vec![],
                max: vec![],
                sample_rate: 44100,
                hop: 1,
            };
        }

    // Collect track + descendants.
    let mut included: std::collections::HashSet<String> = std::collections::HashSet::new();
    included.insert(track_id.clone());
    let mut idx = 0usize;
    let mut frontier = vec![track_id.clone()];
    while idx < frontier.len() {
        let cur = frontier[idx].clone();
        for child in tl0
            .tracks
            .iter()
            .filter(|t| t.parent_id.as_deref() == Some(cur.as_str()))
            .map(|t| t.id.clone())
            .collect::<Vec<_>>()
        {
            if included.insert(child.clone()) {
                frontier.push(child);
            }
        }
        idx += 1;
        if idx > 4096 {
            break;
        }
    }

    let mut tl = tl0.clone();
    tl.tracks.retain(|t| included.contains(&t.id));
    tl.clips.retain(|c| included.contains(&c.track_id));

    // Peaks are used as a visual background in the UI; do not hide waveforms
    // due to mixer states (mute/solo) which would otherwise result in a silent
    // mix and an invisible waveform.
    for t in &mut tl.tracks {
        t.muted = false;
        t.solo = false;
    }
    for c in &mut tl.clips {
        c.muted = false;
    }

    let cols = columns.clamp(16, 8192);
    let opts = crate::mixdown::MixdownOptions {
        sample_rate: 44100,
        start_sec,
        end_sec: Some(start_sec + duration_sec.max(0.0)),
        // Peaks are used as a visual timing reference. Prefer RubberBand so
        // stretched clips line up with the same timing as pitch analysis.
        // (Falls back to LinearResample if RubberBand is unavailable.)
        stretch: crate::time_stretch::StretchAlgorithm::RubberBand,
    };

    let (sr, ch, _dur, mix) = match crate::mixdown::render_mixdown_interleaved(&tl, opts) {
        Ok(v) => v,
        Err(_) => {
            return waveform::WaveformPeaksSegmentPayload {
                ok: false,
                min: vec![],
                max: vec![],
                sample_rate: 44100,
                hop: 1,
            }
        }
    };

    let channels = ch.max(1) as usize;
    let frames = mix.len() / channels;
    if frames == 0 {
        return waveform::WaveformPeaksSegmentPayload {
            ok: true,
            min: vec![0.0; cols],
            max: vec![0.0; cols],
            sample_rate: sr,
            hop: 1,
        };
    }

    let mut out_min = vec![f32::INFINITY; cols];
    let mut out_max = vec![f32::NEG_INFINITY; cols];
    for x in 0..cols {
        let i0 = (x * frames) / cols;
        let i1 = ((x + 1) * frames) / cols;
        let i1 = i1.max(i0 + 1).min(frames);
        for f in i0..i1 {
            let base = f * channels;
            let mut sum = 0.0f32;
            for c in 0..channels {
                sum += mix[base + c];
            }
            let v = sum / channels as f32;
            if v < out_min[x] {
                out_min[x] = v;
            }
            if v > out_max[x] {
                out_max[x] = v;
            }
        }
        if !out_min[x].is_finite() {
            out_min[x] = 0.0;
        }
        if !out_max[x].is_finite() {
            out_max[x] = 0.0;
        }
    }

        waveform::WaveformPeaksSegmentPayload {
            ok: true,
            min: out_min,
            max: out_max,
            sample_rate: sr,
            hop: 1,
        }
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn select_track(state: State<'_, AppState>, track_id: String) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    tl.select_track(&track_id);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_project_length(state: State<'_, AppState>, project_beats: f64) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    state.checkpoint_timeline(&tl);
    tl.set_project_length(project_beats);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn add_clip(
    state: State<'_, AppState>,
    track_id: Option<String>,
    name: Option<String>,
    start_beat: Option<f64>,
    length_beats: Option<f64>,
    source_path: Option<String>,
) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    state.checkpoint_timeline(&tl);
    tl.add_clip(track_id, name, start_beat, length_beats, source_path);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn remove_clip(state: State<'_, AppState>, clip_id: String) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    state.checkpoint_timeline(&tl);
    tl.remove_clip(&clip_id);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn move_clip(
    state: State<'_, AppState>,
    clip_id: String,
    start_beat: f64,
    track_id: Option<String>,
) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    state.checkpoint_timeline(&tl);
    tl.move_clip(&clip_id, start_beat, track_id);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_clip_state(
    state: State<'_, AppState>,
    clip_id: String,
    length_beats: Option<f64>,
    gain: Option<f32>,
    muted: Option<bool>,
    trim_start_beat: Option<f64>,
    trim_end_beat: Option<f64>,
    playback_rate: Option<f32>,
    fade_in_beats: Option<f64>,
    fade_out_beats: Option<f64>,
) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    state.checkpoint_timeline(&tl);
    tl.set_clip_state(
        &clip_id,
        length_beats,
        gain,
        muted,
        trim_start_beat,
        trim_end_beat,
        playback_rate,
        fade_in_beats,
        fade_out_beats,
    );
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn split_clip(state: State<'_, AppState>, clip_id: String, split_beat: f64) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    state.checkpoint_timeline(&tl);
    tl.split_clip(&clip_id, split_beat);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn glue_clips(state: State<'_, AppState>, clip_ids: Vec<String>) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    state.checkpoint_timeline(&tl);
    tl.glue_clips(&clip_ids);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn select_clip(state: State<'_, AppState>, clip_id: Option<String>) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    tl.select_clip(clip_id);
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_track_summary(state: State<'_, AppState>, track_id: Option<String>) -> serde_json::Value {
    // Minimal placeholder summary; waveform is empty until audio pipeline is migrated.
    let tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
    let tid = track_id
        .or_else(|| tl.selected_track_id.clone())
        .or_else(|| tl.tracks.first().map(|t| t.id.clone()))
        .unwrap_or_else(|| "".to_string());

    let clip_count = tl.clips.iter().filter(|c| c.track_id == tid).count();

    serde_json::json!({
        "ok": true,
        "track_id": tid,
        "clip_count": clip_count,
        "waveform_preview": [],
        "pitch_range": {"min": -24, "max": 24}
    })
}

// ===================== model / processing / synthesis =====================

#[tauri::command(rename_all = "camelCase")]
pub fn load_default_model(state: State<'_, AppState>) -> crate::models::ModelConfigPayload {
    {
        let mut rt = state.runtime.lock().unwrap_or_else(|e| e.into_inner());
        rt.model_loaded = true;
    }
    state.model_config_ok()
}

#[tauri::command(rename_all = "camelCase")]
pub fn load_model(state: State<'_, AppState>, model_dir: String) -> crate::models::ModelConfigPayload {
    let _ = model_dir;
    {
        let mut rt = state.runtime.lock().unwrap_or_else(|e| e.into_inner());
        rt.model_loaded = true;
    }
    state.model_config_ok()
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_pitch_shift(semitones: f64) -> serde_json::Value {
    serde_json::json!({"ok": true, "pitch_shift": semitones, "frames": 0})
}

#[tauri::command(rename_all = "camelCase")]
pub fn process_audio(state: State<'_, AppState>, audio_path: String) -> ProcessAudioPayload {
    let path = Path::new(&audio_path);
    let mut duration_sec = 0.0f64;
    let mut sample_rate = 44100u32;
    let mut waveform_preview: Option<Vec<f32>> = None;

    if let Some(info) = try_read_wav_info(path, 4096) {
        duration_sec = info.duration_sec;
        sample_rate = info.sample_rate;
        waveform_preview = Some(info.waveform_preview);
    }

    {
        let mut rt = state.runtime.lock().unwrap_or_else(|e| e.into_inner());
        rt.audio_loaded = true;
    }

    ProcessAudioPayload {
        ok: true,
        audio: Some(crate::models::ProcessedAudio {
            path: audio_path,
            sample_rate,
            duration_sec,
        }),
        feature: Some(crate::models::AudioFeature {
            mel_shape: None,
            f0_frames: None,
            segment_count: None,
            segments_preview: None,
            waveform_preview,
            pitch_range: Some(crate::models::PitchRange { min: -24.0, max: 24.0 }),
        }),
        timeline: None,
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn synthesize(state: State<'_, AppState>) -> SynthesizePayload {
    let out_path = match new_temp_wav_path("synth") {
        Ok(p) => p,
        Err(e) => {
            eprintln!("synthesize: temp path error: {e}");
            return SynthesizePayload {
                ok: false,
                sample_rate: 44100,
                num_samples: 0,
                duration_sec: 0.0,
            };
        }
    };

    let result = match render_timeline_to_wav(&state, &out_path, 0.0, None) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("synthesize: render error: {e}");
            return SynthesizePayload {
                ok: false,
                sample_rate: 44100,
                num_samples: 0,
                duration_sec: 0.0,
            };
        }
    };

    {
        let mut rt = state.runtime.lock().unwrap_or_else(|e| e.into_inner());
        rt.has_synthesized = true;
        rt.synthesized_wav_path = Some(out_path.display().to_string());
    }

    let num_samples = (result.duration_sec * result.sample_rate as f64)
        .round()
        .max(0.0) as u32;

    SynthesizePayload {
        ok: true,
        sample_rate: result.sample_rate,
        num_samples,
        duration_sec: result.duration_sec,
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_synthesized(state: State<'_, AppState>, output_path: String) -> serde_json::Value {
    let out_path = Path::new(&output_path);

    let synthesized_path = {
        state
            .runtime
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .synthesized_wav_path
            .clone()
    };

    let mix = if let Some(p) = synthesized_path {
        // Best-effort copy the already rendered synth.
        match fs::copy(&p, out_path) {
            Ok(_) => try_read_wav_info(out_path, 0),
            Err(e) => {
                eprintln!("save_synthesized: copy failed: {e}");
                None
            }
        }
    } else {
        // No cached synth; render directly to output.
        match render_timeline_to_wav(&state, out_path, 0.0, None) {
            Ok(_) => try_read_wav_info(out_path, 0),
            Err(e) => {
                eprintln!("save_synthesized: render failed: {e}");
                None
            }
        }
    };

    match mix {
        Some(info) => serde_json::json!({
            "ok": true,
            "path": output_path,
            "sample_rate": info.sample_rate,
            "num_samples": (info.duration_sec * info.sample_rate as f64).round().max(0.0) as u32
        }),
        None => serde_json::json!({
            "ok": false,
            "path": output_path
        }),
    }
}

// ===================== playback clock =====================

#[tauri::command(rename_all = "camelCase")]
pub fn play_original(state: State<'_, AppState>, start_sec: f64) -> serde_json::Value {
    guard_json_command("play_original", || {
        if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
            eprintln!("play_original(start_sec={})", start_sec);
        }
        let timeline = state
            .timeline
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let bpm = timeline.bpm;
        let playhead_beat = timeline.playhead_beat;
        if !(bpm.is_finite() && bpm > 0.0) {
            return serde_json::json!({"ok": false, "error": "invalid bpm"});
        }
        let playhead_sec = (playhead_beat.max(0.0)) * 60.0 / bpm;
        let start_sec = playhead_sec + start_sec.max(0.0);

        state.audio_engine.update_timeline(timeline);
        state.audio_engine.seek_sec(start_sec);
        state.audio_engine.set_playing(true, Some("original"));

        serde_json::json!({"ok": true, "playing": "original", "start_sec": start_sec})
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn play_synthesized(state: State<'_, AppState>, start_sec: f64) -> serde_json::Value {
    guard_json_command("play_synthesized", || {
        if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
            eprintln!("play_synthesized(start_sec={})", start_sec);
        }
        let (bpm, playhead_beat) = {
            let tl = state.timeline.lock().unwrap_or_else(|e| e.into_inner());
            (tl.bpm, tl.playhead_beat)
        };
        if !(bpm.is_finite() && bpm > 0.0) {
            return serde_json::json!({"ok": false, "error": "invalid bpm"});
        }
        let playhead_sec = (playhead_beat.max(0.0)) * 60.0 / bpm;
        let start_sec = playhead_sec + start_sec.max(0.0);

        let mut synthesized_path = {
            state
                .runtime
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .synthesized_wav_path
                .clone()
        };

        if synthesized_path.is_none() {
            // Render on-demand.
            let out_path = match new_temp_wav_path("synth") {
                Ok(p) => p,
                Err(e) => return serde_json::json!({"ok": false, "error": e}),
            };
            if let Err(e) = render_timeline_to_wav(&state, &out_path, 0.0, None) {
                return serde_json::json!({"ok": false, "error": e});
            }
            synthesized_path = Some(out_path.display().to_string());
            let mut rt = state.runtime.lock().unwrap_or_else(|e| e.into_inner());
            rt.has_synthesized = true;
            rt.synthesized_wav_path = synthesized_path.clone();
        }

        let Some(p) = synthesized_path.as_deref() else {
            return serde_json::json!({"ok": false, "error": "synth path missing"});
        };
        let path = Path::new(p);
        state.audio_engine.play_file(path, start_sec, "synthesized");
        serde_json::json!({"ok": true, "playing": "synthesized", "start_sec": start_sec})
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn stop_audio(state: State<'_, AppState>) -> serde_json::Value {
    state.audio_engine.stop();
    ok_bool()
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_playback_state(state: State<'_, AppState>) -> PlaybackStatePayload {
    let pb = state.audio_engine.snapshot_state();
    PlaybackStatePayload {
        ok: true,
        is_playing: pb.is_playing,
        target: pb.target,
        base_sec: pb.base_sec,
        position_sec: pb.position_sec,
        duration_sec: pb.duration_sec,
    }
}
