use crate::audio_utils::try_read_wav_info;
use crate::mixdown::{render_mixdown_wav, MixdownOptions};
use crate::models::{PlaybackStatePayload, ProcessAudioPayload, SynthesizePayload};
use crate::project::{make_paths_relative, project_name_from_path, resolve_paths_relative, ProjectFile};
use crate::state::AppState;
use crate::waveform;
use base64::Engine;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{State, Window};
use uuid::Uuid;

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
        .expect("timeline mutex poisoned")
        .clone();
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

fn get_timeline_state_from_ref(state: &AppState) -> crate::models::TimelineStatePayload {
    let tl = state
        .timeline
        .lock()
        .expect("timeline mutex poisoned")
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
    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
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
        let p = state.project.lock().expect("project mutex poisoned");
        if p.name.trim().is_empty() {
            project_name_from_path(&path)
        } else {
            p.name.clone()
        }
    };

    let tl = state.timeline.lock().expect("timeline mutex poisoned").clone();
    let tl_rel = make_paths_relative(tl, &path);
    let pf = ProjectFile::new(name.clone(), tl_rel);
    let txt = serde_json::to_string_pretty(&pf).map_err(|e| e.to_string())?;
    fs::write(&path, txt).map_err(|e| e.to_string())?;

    {
        let mut p = state.project.lock().expect("project mutex poisoned");
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
        let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
        *tl = crate::state::TimelineState::default();
        state.audio_engine.update_timeline(tl.clone());
    }
    state.clear_history();
    {
        let mut p = state.project.lock().expect("project mutex poisoned");
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
        let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
        *tl = pf.timeline.clone();
        state.audio_engine.update_timeline(tl.clone());
    }
    state.clear_history();
    {
        let mut p = state.project.lock().expect("project mutex poisoned");
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
        let p = state.project.lock().expect("project mutex poisoned");
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
        let p = state.project.lock().expect("project mutex poisoned");
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
            .expect("waveform_cache_dir mutex poisoned")
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
    let timeline = state.timeline.lock().expect("timeline mutex poisoned").clone();
    render_mixdown_wav(
        &timeline,
        output_path,
        MixdownOptions {
            sample_rate: 44100,
            start_sec,
            end_sec,
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

    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
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
        let mut rt = state.runtime.lock().expect("runtime mutex poisoned");
        rt.audio_loaded = true;
    }

    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
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
    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
    state.checkpoint_timeline(&tl);
    tl.add_track(name, parent_track_id, index);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn remove_track(state: State<'_, AppState>, track_id: String) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
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
    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
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
) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
    state.checkpoint_timeline(&tl);
    tl.set_track_state(&track_id, muted, solo, volume);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn select_track(state: State<'_, AppState>, track_id: String) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
    tl.select_track(&track_id);
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_project_length(state: State<'_, AppState>, project_beats: f64) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
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
    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
    state.checkpoint_timeline(&tl);
    tl.add_clip(track_id, name, start_beat, length_beats, source_path);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn remove_clip(state: State<'_, AppState>, clip_id: String) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
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
    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
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
    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
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
    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
    state.checkpoint_timeline(&tl);
    tl.split_clip(&clip_id, split_beat);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn glue_clips(state: State<'_, AppState>, clip_ids: Vec<String>) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
    state.checkpoint_timeline(&tl);
    tl.glue_clips(&clip_ids);
    state.audio_engine.update_timeline(tl.clone());
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn select_clip(state: State<'_, AppState>, clip_id: Option<String>) -> crate::models::TimelineStatePayload {
    let mut tl = state.timeline.lock().expect("timeline mutex poisoned");
    tl.select_clip(clip_id);
    let mut payload = tl.to_payload();
    payload.project = Some(state.project_meta_payload());
    payload
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_track_summary(state: State<'_, AppState>, track_id: Option<String>) -> serde_json::Value {
    // Minimal placeholder summary; waveform is empty until audio pipeline is migrated.
    let tl = state.timeline.lock().expect("timeline mutex poisoned");
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
        let mut rt = state.runtime.lock().expect("runtime mutex poisoned");
        rt.model_loaded = true;
    }
    state.model_config_ok()
}

#[tauri::command(rename_all = "camelCase")]
pub fn load_model(state: State<'_, AppState>, model_dir: String) -> crate::models::ModelConfigPayload {
    let _ = model_dir;
    {
        let mut rt = state.runtime.lock().expect("runtime mutex poisoned");
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
        let mut rt = state.runtime.lock().expect("runtime mutex poisoned");
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
        let mut rt = state.runtime.lock().expect("runtime mutex poisoned");
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
            .expect("runtime mutex poisoned")
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
    if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
        eprintln!("play_original(start_sec={})", start_sec);
    }
    let timeline = state.timeline.lock().expect("timeline mutex poisoned").clone();
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
}

#[tauri::command(rename_all = "camelCase")]
pub fn play_synthesized(state: State<'_, AppState>, start_sec: f64) -> serde_json::Value {
    if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
        eprintln!("play_synthesized(start_sec={})", start_sec);
    }
    let (bpm, playhead_beat) = {
        let tl = state.timeline.lock().expect("timeline mutex poisoned");
        (tl.bpm, tl.playhead_beat)
    };
    if !(bpm.is_finite() && bpm > 0.0) {
        return serde_json::json!({"ok": false, "error": "invalid bpm"});
    }
    let playhead_sec = (playhead_beat.max(0.0)) * 60.0 / bpm;
    let _start_sec = playhead_sec + start_sec.max(0.0);

    let mut synthesized_path = {
        state
            .runtime
            .lock()
            .expect("runtime mutex poisoned")
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
        let mut rt = state.runtime.lock().expect("runtime mutex poisoned");
        rt.has_synthesized = true;
        rt.synthesized_wav_path = synthesized_path.clone();
    }

    let path = Path::new(synthesized_path.as_ref().expect("synth path missing"));
    state.audio_engine.play_file(path, _start_sec, "synthesized");
    serde_json::json!({"ok": true, "playing": "synthesized", "start_sec": _start_sec})
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
