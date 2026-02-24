use crate::audio_engine::AudioEngine;
use crate::audio_utils::try_read_wav_info;
use crate::models::{
    ModelConfig, ModelConfigPayload, PitchRange, ProjectMetaPayload, RuntimeInfoPayload,
    TimelineClip, TimelineStatePayload, TimelineTrack,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use uuid::Uuid;

fn default_frame_period_ms() -> f64 {
    5.0
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PitchAnalysisAlgo {
    #[default]
    WorldDll,
    NsfHifiganOnnx,
    None,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TrackParamsState {
    #[serde(default = "default_frame_period_ms")]
    pub frame_period_ms: f64,

    #[serde(default)]
    pub pitch_orig: Vec<f32>,
    #[serde(default)]
    pub pitch_edit: Vec<f32>,

    #[serde(default)]
    pub pitch_edit_user_modified: bool,

    #[serde(default)]
    pub tension_orig: Vec<f32>,
    #[serde(default)]
    pub tension_edit: Vec<f32>,

    #[serde(skip)]
    pub pitch_orig_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub order: i32,
    pub muted: bool,
    pub solo: bool,
    pub volume: f32,

    #[serde(default)]
    pub compose_enabled: bool,

    #[serde(default)]
    pub pitch_analysis_algo: PitchAnalysisAlgo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Clip {
    pub id: String,
    pub track_id: String,
    pub name: String,
    pub start_beat: f64,
    pub length_beats: f64,
    pub color: String,

    pub source_path: Option<String>,
    pub duration_sec: Option<f64>,
    pub waveform_preview: Option<Vec<f32>>,
    pub pitch_range: Option<PitchRange>,

    pub gain: f32,
    pub muted: bool,
    pub trim_start_beat: f64,
    pub trim_end_beat: f64,
    pub playback_rate: f32,
    pub fade_in_beats: f64,
    pub fade_out_beats: f64,
}

#[derive(Debug, Clone, Default)]
pub struct ClipStatePatch {
    pub length_beats: Option<f64>,
    pub gain: Option<f32>,
    pub muted: Option<bool>,
    pub trim_start_beat: Option<f64>,
    pub trim_end_beat: Option<f64>,
    pub playback_rate: Option<f32>,
    pub fade_in_beats: Option<f64>,
    pub fade_out_beats: Option<f64>,
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeState {
    pub device: String,
    pub model_loaded: bool,
    pub audio_loaded: bool,
    pub has_synthesized: bool,

    pub synthesized_wav_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineState {
    pub tracks: Vec<Track>,
    pub clips: Vec<Clip>,
    pub selected_track_id: Option<String>,
    pub selected_clip_id: Option<String>,
    pub bpm: f64,
    pub playhead_beat: f64,
    pub project_beats: f64,

    #[serde(default)]
    pub params_by_root_track: BTreeMap<String, TrackParamsState>,

    pub next_track_order: i32,
}

#[derive(Debug, Clone, Default)]
pub struct TimelineHistory {
    pub undo: Vec<TimelineState>,
    pub redo: Vec<TimelineState>,
}

#[derive(Debug, Clone)]
pub struct ProjectState {
    pub name: String,
    pub path: Option<String>,
    pub dirty: bool,
    pub recent: Vec<String>,
    pub allow_close: bool,
}

impl Default for ProjectState {
    fn default() -> Self {
        Self {
            name: "Untitled".to_string(),
            path: None,
            dirty: false,
            recent: Vec::new(),
            allow_close: false,
        }
    }
}

impl Default for TimelineState {
    fn default() -> Self {
        let track_id = "track_main".to_string();
        Self {
            tracks: vec![Track {
                id: track_id.clone(),
                name: "Main".to_string(),
                parent_id: None,
                order: 0,
                muted: false,
                solo: false,
                volume: 0.9,

                compose_enabled: false,
                pitch_analysis_algo: PitchAnalysisAlgo::default(),
            }],
            clips: vec![],
            selected_track_id: Some(track_id),
            selected_clip_id: None,
            bpm: 120.0,
            playhead_beat: 0.0,
            project_beats: 64.0,

            params_by_root_track: BTreeMap::new(),
            next_track_order: 1,
        }
    }
}

impl TimelineState {
    pub fn resolve_root_track_id(&self, track_id: &str) -> Option<String> {
        if track_id.trim().is_empty() {
            return None;
        }
        let mut cur = track_id.to_string();
        let mut safety = 0;
        loop {
            let parent = self
                .tracks
                .iter()
                .find(|t| t.id == cur)
                .and_then(|t| t.parent_id.clone());
            match parent {
                Some(p) if !p.trim().is_empty() => {
                    cur = p;
                }
                _ => return Some(cur),
            }
            safety += 1;
            if safety > 2048 {
                return Some(cur);
            }
        }
    }

    pub fn frame_period_ms(&self) -> f64 {
        default_frame_period_ms()
    }

    pub fn project_duration_sec(&self) -> f64 {
        let bpm = self.bpm;
        if !(bpm.is_finite() && bpm > 0.0) {
            return 0.0;
        }
        let beat_sec = 60.0 / bpm;
        (self.project_beats.max(0.0) * beat_sec).max(0.0)
    }

    pub fn target_param_frames(&self, frame_period_ms: f64) -> usize {
        let fp = frame_period_ms.max(0.1);
        let sec = self.project_duration_sec();
        let frames = (sec * 1000.0 / fp).ceil();
        if !(frames.is_finite() && frames > 0.0) {
            return 1;
        }
        (frames as usize).max(1)
    }

    pub fn ensure_params_for_root(&mut self, root_track_id: &str) {
        let fp = self.frame_period_ms();
        let target = self.target_param_frames(fp);
        let entry = self
            .params_by_root_track
            .entry(root_track_id.to_string())
            .or_insert_with(|| TrackParamsState {
                frame_period_ms: fp,
                ..TrackParamsState::default()
            });

        entry.frame_period_ms = fp;

        #[allow(clippy::ptr_arg)]
        fn resize_curve(v: &mut Vec<f32>, target: usize, fill: f32) {
            if v.len() < target {
                v.extend(std::iter::repeat_n(fill, target - v.len()));
            } else if v.len() > target {
                v.truncate(target);
            }
        }

        resize_curve(&mut entry.pitch_orig, target, 0.0);
        resize_curve(&mut entry.pitch_edit, target, 0.0);
        resize_curve(&mut entry.tension_orig, target, 0.0);
        resize_curve(&mut entry.tension_edit, target, 0.0);

        // Backward compatibility: older projects didn't have `pitch_edit_user_modified`.
        // Infer it if we detect a meaningful difference between edit and orig.
        if !entry.pitch_edit_user_modified {
            let len = entry.pitch_orig.len().min(entry.pitch_edit.len());
            let mut i = 0usize;
            let stride = 1usize; // keep it simple; curves are not huge.
            while i < len {
                let o = entry.pitch_orig[i];
                let e = entry.pitch_edit[i];
                if e.is_finite() && e > 0.0 {
                    if !(o.is_finite() && o > 0.0) {
                        entry.pitch_edit_user_modified = true;
                        break;
                    }
                    if (e - o).abs() > 1e-3 {
                        entry.pitch_edit_user_modified = true;
                        break;
                    }
                }
                i += stride;
            }
        }
    }
}

pub struct AppState {
    pub timeline: std::sync::Mutex<TimelineState>,
    pub timeline_history: std::sync::Mutex<TimelineHistory>,
    pub project: std::sync::Mutex<ProjectState>,
    pub runtime: std::sync::Mutex<RuntimeState>,
    pub waveform_cache_dir: std::sync::Mutex<PathBuf>,
    pub waveform_cache: std::sync::Mutex<
        std::collections::HashMap<String, std::sync::Arc<crate::waveform::CachedPeaks>>,
    >,

    // Set in Tauri setup. Used for async notifications.
    pub app_handle: OnceLock<tauri::AppHandle>,

    // De-dup background pitch analysis jobs (keyed by rootTrackId + analysis key).
    pub pitch_inflight: std::sync::Mutex<std::collections::HashSet<String>>,

    pub audio_engine: AudioEngine,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            timeline: std::sync::Mutex::new(TimelineState::default()),
            timeline_history: std::sync::Mutex::new(TimelineHistory::default()),
            project: std::sync::Mutex::new(ProjectState::default()),
            runtime: std::sync::Mutex::new(RuntimeState {
                device: "tauri".to_string(),
                synthesized_wav_path: None,
                ..RuntimeState::default()
            }),
            waveform_cache_dir: std::sync::Mutex::new(
                crate::waveform_disk_cache::default_cache_dir(),
            ),
            waveform_cache: std::sync::Mutex::new(std::collections::HashMap::new()),

            app_handle: OnceLock::new(),
            pitch_inflight: std::sync::Mutex::new(std::collections::HashSet::new()),

            audio_engine: AudioEngine::new(),
        }
    }
}

impl AppState {
    pub fn get_or_compute_waveform_peaks(
        &self,
        source_path: &str,
        hop: usize,
    ) -> Result<std::sync::Arc<crate::waveform::CachedPeaks>, String> {
        if source_path.trim().is_empty() {
            return Err("empty source_path".to_string());
        }

        let cache_key = format!("{}|{}", source_path, hop);

        {
            let cache = self
                .waveform_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(found) = cache.get(&cache_key) {
                return Ok(found.clone());
            }
        }

        // Disk cache (best-effort): if present, load and populate the in-memory cache.
        let cache_dir = {
            self.waveform_cache_dir
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        };
        let disk_path = crate::waveform_disk_cache::cache_file_path(&cache_dir, source_path, hop);
        if let Some(found) = crate::waveform_disk_cache::try_load_peaks(&disk_path) {
            if found.hop == hop {
                let found = std::sync::Arc::new(found);
                let mut cache = self
                    .waveform_cache
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                cache.insert(cache_key.clone(), found.clone());
                return Ok(found);
            }
        }

        let peaks = crate::waveform::CachedPeaks::compute(std::path::Path::new(source_path), hop)?;

        // Save to disk cache (best-effort; ignore failures).
        let _ = crate::waveform_disk_cache::save_peaks(&disk_path, &peaks);

        let peaks = std::sync::Arc::new(peaks);
        let mut cache = self
            .waveform_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        cache.insert(cache_key, peaks.clone());
        Ok(peaks)
    }

    pub fn clear_waveform_cache(&self) -> crate::waveform_disk_cache::ClearStats {
        {
            let mut cache = self
                .waveform_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            cache.clear();
        }

        let cache_dir = {
            self.waveform_cache_dir
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        };
        crate::waveform_disk_cache::clear_dir(&cache_dir)
    }

    pub fn project_meta_payload(&self) -> ProjectMetaPayload {
        let p = self
            .project
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        ProjectMetaPayload {
            name: p.name,
            path: p.path,
            dirty: p.dirty,
            recent: p.recent,
        }
    }

    pub fn checkpoint_timeline(&self, snapshot: &TimelineState) {
        let mut h = self
            .timeline_history
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        h.undo.push(snapshot.clone());
        if h.undo.len() > 100 {
            h.undo.remove(0);
        }
        h.redo.clear();
        drop(h);

        let mut p = self.project.lock().unwrap_or_else(|e| e.into_inner());
        p.dirty = true;
    }

    pub fn clear_history(&self) {
        let mut h = self
            .timeline_history
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        h.undo.clear();
        h.redo.clear();
    }

    pub fn undo_timeline(&self) -> TimelineStatePayload {
        let mut tl = self.timeline.lock().unwrap_or_else(|e| e.into_inner());
        let mut h = self
            .timeline_history
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(prev) = h.undo.pop() else {
            let mut payload = tl.to_payload();
            payload.project = Some(self.project_meta_payload());
            return payload;
        };
        h.redo.push(tl.clone());
        *tl = prev;
        drop(h);
        self.audio_engine.update_timeline(tl.clone());
        let mut payload = tl.to_payload();
        payload.project = Some(self.project_meta_payload());
        payload
    }

    pub fn redo_timeline(&self) -> TimelineStatePayload {
        let mut tl = self.timeline.lock().unwrap_or_else(|e| e.into_inner());
        let mut h = self
            .timeline_history
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(next) = h.redo.pop() else {
            let mut payload = tl.to_payload();
            payload.project = Some(self.project_meta_payload());
            return payload;
        };
        h.undo.push(tl.clone());
        *tl = next;
        drop(h);
        self.audio_engine.update_timeline(tl.clone());
        let mut payload = tl.to_payload();
        payload.project = Some(self.project_meta_payload());
        payload
    }
}

fn new_id(prefix: &str) -> String {
    format!("{}_{}", prefix, Uuid::new_v4().simple())
}

fn default_clip_color() -> String {
    "emerald".to_string()
}

impl TimelineState {
    fn ensure_project_end_beat(&mut self, end_beat: f64) {
        if !(end_beat.is_finite()) {
            return;
        }
        // Only extend; never shrink automatically.
        // Use ceil so the ruler/grid has room for the full clip.
        let target = end_beat.max(4.0).ceil();
        if target > self.project_beats {
            self.project_beats = target;
        }
    }

    pub fn to_payload(&self) -> TimelineStatePayload {
        let tracks_payload = build_track_payload(&self.tracks);
        let clips_payload = self
            .clips
            .iter()
            .map(|c| TimelineClip {
                id: c.id.clone(),
                track_id: c.track_id.clone(),
                name: c.name.clone(),
                start_beat: c.start_beat,
                length_beats: c.length_beats,
                color: c.color.clone(),
                source_path: c.source_path.clone(),
                duration_sec: c.duration_sec,
                waveform_preview: c.waveform_preview.clone(),
                pitch_range: c.pitch_range.clone(),
                gain: Some(c.gain),
                muted: Some(c.muted),
                trim_start_beat: Some(c.trim_start_beat),
                trim_end_beat: Some(c.trim_end_beat),
                playback_rate: Some(c.playback_rate),
                fade_in_beats: Some(c.fade_in_beats),
                fade_out_beats: Some(c.fade_out_beats),
            })
            .collect::<Vec<_>>();

        TimelineStatePayload {
            ok: true,
            tracks: tracks_payload,
            clips: clips_payload,
            selected_track_id: self.selected_track_id.clone(),
            selected_clip_id: self.selected_clip_id.clone(),
            bpm: self.bpm,
            playhead_beat: self.playhead_beat,
            project_beats: Some(self.project_beats),
            project: None,
        }
    }

    pub fn add_track(
        &mut self,
        name: Option<String>,
        parent_track_id: Option<String>,
        index: Option<usize>,
    ) -> String {
        let id = new_id("track");
        let order = self.next_track_order;
        self.next_track_order += 1;

        let track = Track {
            id: id.clone(),
            name: name.unwrap_or_else(|| "Track".to_string()),
            parent_id: parent_track_id,
            order,
            muted: false,
            solo: false,
            volume: 0.9,

            compose_enabled: false,
            pitch_analysis_algo: PitchAnalysisAlgo::default(),
        };
        self.tracks.push(track);

        // Best-effort insert ordering: we encode ordering using `order`, but for now
        // we accept `index` by nudging orders for the same parent.
        if let Some(i) = index {
            self.reorder_siblings(&id, i);
        }

        self.selected_track_id = Some(id.clone());
        id
    }

    fn reorder_siblings(&mut self, track_id: &str, target_index: usize) {
        let parent_id = self
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .and_then(|t| t.parent_id.clone());
        let mut siblings: Vec<_> = self
            .tracks
            .iter()
            .filter(|t| t.parent_id == parent_id && t.id != track_id)
            .cloned()
            .collect();
        siblings.sort_by_key(|t| t.order);
        let target_index = target_index.min(siblings.len());

        // Pull this track out and rebuild orders.
        let mut rebuilt: Vec<String> = siblings.into_iter().map(|t| t.id).collect();
        rebuilt.insert(target_index, track_id.to_string());

        for (i, tid) in rebuilt.iter().enumerate() {
            if let Some(t) = self.tracks.iter_mut().find(|t| &t.id == tid) {
                t.order = i as i32;
            }
        }
        self.next_track_order = rebuilt.len() as i32 + 1;
    }

    pub fn remove_track(&mut self, track_id: &str) {
        // Remove clips first.
        self.clips.retain(|c| c.track_id != track_id);

        // Remove descendants.
        let mut to_remove = vec![track_id.to_string()];
        let mut idx = 0;
        while idx < to_remove.len() {
            let cur = to_remove[idx].clone();
            for child in self
                .tracks
                .iter()
                .filter(|t| t.parent_id.as_deref() == Some(cur.as_str()))
                .map(|t| t.id.clone())
                .collect::<Vec<_>>()
            {
                to_remove.push(child);
            }
            idx += 1;
        }
        self.tracks.retain(|t| !to_remove.contains(&t.id));

        if self.selected_track_id.as_deref() == Some(track_id) {
            self.selected_track_id = self.tracks.first().map(|t| t.id.clone());
        }
        if let Some(cid) = self.selected_clip_id.clone() {
            if !self.clips.iter().any(|c| c.id == cid) {
                self.selected_clip_id = None;
            }
        }
    }

    pub fn move_track(
        &mut self,
        track_id: &str,
        target_index: usize,
        parent_track_id: Option<String>,
    ) {
        if let Some(t) = self.tracks.iter_mut().find(|t| t.id == track_id) {
            t.parent_id = parent_track_id;
        }
        self.reorder_siblings(track_id, target_index);
    }

    pub fn set_track_state(
        &mut self,
        track_id: &str,
        muted: Option<bool>,
        solo: Option<bool>,
        volume: Option<f32>,
        compose_enabled: Option<bool>,
        pitch_analysis_algo: Option<PitchAnalysisAlgo>,
    ) {
        if let Some(t) = self.tracks.iter_mut().find(|t| t.id == track_id) {
            if let Some(v) = muted {
                t.muted = v;
            }
            if let Some(v) = solo {
                t.solo = v;
            }
            if let Some(v) = volume {
                t.volume = v.clamp(0.0, 1.0);
            }

            if let Some(v) = compose_enabled {
                t.compose_enabled = v;
            }
            if let Some(v) = pitch_analysis_algo {
                t.pitch_analysis_algo = v;
            }
        }
    }

    pub fn select_track(&mut self, track_id: &str) {
        if self.tracks.iter().any(|t| t.id == track_id) {
            self.selected_track_id = Some(track_id.to_string());
        }
    }

    pub fn set_project_length(&mut self, project_beats: f64) {
        if project_beats.is_finite() {
            self.project_beats = project_beats.max(4.0);
        }
    }

    pub fn add_clip(
        &mut self,
        track_id: Option<String>,
        name: Option<String>,
        start_beat: Option<f64>,
        length_beats: Option<f64>,
        source_path: Option<String>,
    ) -> String {
        let track_id = track_id
            .or_else(|| self.selected_track_id.clone())
            .or_else(|| self.tracks.first().map(|t| t.id.clone()))
            .unwrap_or_else(|| self.add_track(Some("Main".to_string()), None, None));

        if !self.tracks.iter().any(|t| t.id == track_id) {
            // Create missing track.
            self.tracks.push(Track {
                id: track_id.clone(),
                name: "Track".to_string(),
                parent_id: None,
                order: self.next_track_order,
                muted: false,
                solo: false,
                volume: 0.9,

                compose_enabled: false,
                pitch_analysis_algo: PitchAnalysisAlgo::default(),
            });
            self.next_track_order += 1;
        }

        // If this is a new clip referencing an existing audio source, inherit cached metadata
        // (duration + waveform preview) from any existing clip that already has it.
        let inherited = source_path.as_deref().and_then(|sp| {
            self.clips
                .iter()
                .find(|c| c.source_path.as_deref() == Some(sp) && c.waveform_preview.is_some())
                .map(|c| {
                    (
                        c.duration_sec,
                        c.waveform_preview.clone(),
                        c.pitch_range.clone(),
                    )
                })
        });

        let id = new_id("clip");
        let sb = start_beat.unwrap_or(self.playhead_beat).max(0.0);
        let lb = length_beats.unwrap_or(8.0).max(0.25);
        self.ensure_project_end_beat(sb + lb);
        let clip = Clip {
            id: id.clone(),
            track_id: track_id.clone(),
            name: name.unwrap_or_else(|| "Clip".to_string()),
            start_beat: sb,
            length_beats: lb,
            color: default_clip_color(),
            source_path,
            duration_sec: inherited.as_ref().and_then(|v| v.0),
            waveform_preview: inherited.as_ref().and_then(|v| v.1.clone()),
            pitch_range: inherited
                .as_ref()
                .and_then(|v| v.2.clone())
                .or(Some(PitchRange {
                    min: -24.0,
                    max: 24.0,
                })),
            gain: 1.0,
            muted: false,
            trim_start_beat: 0.0,
            trim_end_beat: 0.0,
            playback_rate: 1.0,
            fade_in_beats: 0.0,
            fade_out_beats: 0.0,
        };
        self.clips.push(clip);
        self.selected_clip_id = Some(id.clone());
        self.playhead_beat = sb;
        id
    }

    pub fn remove_clip(&mut self, clip_id: &str) {
        self.clips.retain(|c| c.id != clip_id);
        if self.selected_clip_id.as_deref() == Some(clip_id) {
            self.selected_clip_id = None;
        }
    }

    pub fn move_clip(&mut self, clip_id: &str, start_beat: f64, track_id: Option<String>) {
        let mut end_beat: Option<f64> = None;
        if let Some(c) = self.clips.iter_mut().find(|c| c.id == clip_id) {
            c.start_beat = start_beat.max(0.0);
            if let Some(tid) = track_id {
                if self.tracks.iter().any(|t| t.id == tid) {
                    c.track_id = tid;
                }
            }
            end_beat = Some(c.start_beat + c.length_beats);
        }
        if let Some(v) = end_beat {
            self.ensure_project_end_beat(v);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_clip_state(
        &mut self,
        clip_id: &str,
        length_beats: Option<f64>,
        gain: Option<f32>,
        muted: Option<bool>,
        trim_start_beat: Option<f64>,
        trim_end_beat: Option<f64>,
        playback_rate: Option<f32>,
        fade_in_beats: Option<f64>,
        fade_out_beats: Option<f64>,
    ) {
        self.patch_clip_state(
            clip_id,
            ClipStatePatch {
                length_beats,
                gain,
                muted,
                trim_start_beat,
                trim_end_beat,
                playback_rate,
                fade_in_beats,
                fade_out_beats,
            },
        );
    }

    pub fn patch_clip_state(&mut self, clip_id: &str, patch: ClipStatePatch) {
        let mut end_beat: Option<f64> = None;
        if let Some(c) = self.clips.iter_mut().find(|c| c.id == clip_id) {
            if let Some(v) = patch.length_beats {
                c.length_beats = v.max(0.0);
            }
            if let Some(v) = patch.gain {
                c.gain = v.clamp(0.0, 2.0);
            }
            if let Some(v) = patch.muted {
                c.muted = v;
            }
            if let Some(v) = patch.trim_start_beat {
                if v.is_finite() {
                    // Negative values are allowed (slip-edit past the source start -> leading silence).
                    // Keep a reasonable bound to avoid accidental extreme values.
                    c.trim_start_beat = v.clamp(-1_000_000.0, 1_000_000.0);
                }
            }
            if let Some(v) = patch.trim_end_beat {
                c.trim_end_beat = v.max(0.0);
            }
            if let Some(v) = patch.playback_rate {
                c.playback_rate = v.clamp(0.1, 10.0);
            }
            if let Some(v) = patch.fade_in_beats {
                c.fade_in_beats = v.max(0.0);
            }
            if let Some(v) = patch.fade_out_beats {
                c.fade_out_beats = v.max(0.0);
            }

            end_beat = Some(c.start_beat + c.length_beats);
        }

        if let Some(v) = end_beat {
            self.ensure_project_end_beat(v);
        }
    }

    pub fn split_clip(&mut self, clip_id: &str, split_beat: f64) {
        let Some(idx) = self.clips.iter().position(|c| c.id == clip_id) else {
            return;
        };
        let clip = self.clips[idx].clone();
        let start = clip.start_beat;
        let end = clip.start_beat + clip.length_beats;
        let split = split_beat.clamp(start, end);
        if split <= start + 1e-6 || split >= end - 1e-6 {
            return;
        }

        self.ensure_project_end_beat(end);

        let left_len = split - start;
        let right_len = end - split;

        self.clips[idx].length_beats = left_len;
        // Fade semantics on split:
        // - fade-in is anchored to the original start, so only the left clip should keep it.
        // - fade-out is anchored to the original end, so only the right clip should keep it.
        // Clamp fades to the new clip lengths.
        self.clips[idx].fade_in_beats = self.clips[idx].fade_in_beats.min(left_len.max(0.0));
        self.clips[idx].fade_out_beats = 0.0;

        let mut right = clip;
        right.id = new_id("clip");
        right.start_beat = split;
        right.length_beats = right_len;
        right.fade_in_beats = 0.0;
        right.fade_out_beats = right.fade_out_beats.min(right_len.max(0.0));

        // Preserve the original audio offset: the right clip should continue from where the left ended.
        // trim_* are in beats (source time), while playback_rate scales source progress per timeline time.
        let rate = right.playback_rate as f64;
        let rate = if rate.is_finite() && rate > 0.0 {
            rate
        } else {
            1.0
        };
        if right.trim_start_beat.is_finite() {
            right.trim_start_beat =
                (right.trim_start_beat + left_len * rate).clamp(-1_000_000.0, 1_000_000.0);
        }
        self.clips.push(right);
    }

    pub fn glue_clips(&mut self, clip_ids: &[String]) {
        if clip_ids.len() < 2 {
            return;
        }
        let mut selected: Vec<Clip> = self
            .clips
            .iter()
            .filter(|c| clip_ids.contains(&c.id))
            .cloned()
            .collect();
        if selected.len() < 2 {
            return;
        }
        let track_id = selected[0].track_id.clone();
        if selected.iter().any(|c| c.track_id != track_id) {
            return;
        }
        selected.sort_by(|a, b| a.start_beat.total_cmp(&b.start_beat));
        let Some(first) = selected.first() else {
            return;
        };
        let start = first.start_beat;
        let end = selected
            .iter()
            .map(|c| c.start_beat + c.length_beats)
            .fold(start, f64::max);

        self.ensure_project_end_beat(end);

        let mut glued = first.clone();
        glued.id = new_id("clip");
        glued.name = "Glued".to_string();
        glued.start_beat = start;
        glued.length_beats = (end - start).max(0.25);

        self.clips.retain(|c| !clip_ids.contains(&c.id));
        self.clips.push(glued.clone());
        self.selected_clip_id = Some(glued.id);
    }

    pub fn select_clip(&mut self, clip_id: Option<String>) {
        match clip_id {
            None => self.selected_clip_id = None,
            Some(id) => {
                if self.clips.iter().any(|c| c.id == id) {
                    self.selected_clip_id = Some(id);
                }
            }
        }
    }

    pub fn import_audio_item(
        &mut self,
        audio_path: &str,
        track_id: Option<String>,
        start_beat: Option<f64>,
    ) {
        let name = Path::new(audio_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Audio")
            .to_string();

        let mut duration_sec: Option<f64> = None;
        let mut waveform_preview: Option<Vec<f32>> = None;

        match try_read_wav_info(Path::new(audio_path), 4096) {
            Some(info) => {
                if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
                    let mut max_amp = 0.0f32;
                    for &v in info.waveform_preview.iter() {
                        if v.is_finite() {
                            max_amp = max_amp.max(v.abs());
                        }
                    }
                    let head: Vec<String> = info
                        .waveform_preview
                        .iter()
                        .take(8)
                        .map(|v| format!("{:.4}", v))
                        .collect();
                    eprintln!(
                        "import_audio_item: audio_info ok: duration_sec={:.3}, preview_len={}, preview_max={:.4}, preview_head=[{}]",
                        info.duration_sec,
                        info.waveform_preview.len(),
                        max_amp,
                        head.join(", ")
                    );
                }
                duration_sec = Some(info.duration_sec);
                waveform_preview = Some(info.waveform_preview);
            }
            None => {
                if std::env::var("HIFISHIFTER_DEBUG_COMMANDS").ok().as_deref() == Some("1") {
                    let exists = Path::new(audio_path).exists();
                    eprintln!(
                        "import_audio_item: audio_info FAILED: path_exists={} path={}",
                        exists, audio_path
                    );
                }
            }
        }

        let clip_id = self.add_clip(
            track_id,
            Some(name),
            start_beat,
            duration_sec.map(|d| (d * self.bpm) / 60.0).or(Some(8.0)),
            Some(audio_path.to_string()),
        );

        if let Some(c) = self.clips.iter_mut().find(|c| c.id == clip_id) {
            c.duration_sec = duration_sec;
            c.waveform_preview = waveform_preview;
        }
    }
}

fn build_track_payload(tracks: &[Track]) -> Vec<TimelineTrack> {
    // Group by parent and keep stable ordering by `order`.
    let mut by_parent: HashMap<Option<String>, Vec<Track>> = HashMap::new();
    for t in tracks.iter().cloned() {
        by_parent.entry(t.parent_id.clone()).or_default().push(t);
    }
    for v in by_parent.values_mut() {
        v.sort_by_key(|t| t.order);
    }

    // Roots in order.
    let roots = by_parent.get(&None).cloned().unwrap_or_else(Vec::new);

    let mut out: Vec<TimelineTrack> = Vec::with_capacity(tracks.len());

    fn dfs(
        t: &Track,
        depth: u32,
        by_parent: &HashMap<Option<String>, Vec<Track>>,
        out: &mut Vec<TimelineTrack>,
    ) {
        fn algo_name(a: &PitchAnalysisAlgo) -> String {
            match a {
                PitchAnalysisAlgo::WorldDll => "world_dll".to_string(),
                PitchAnalysisAlgo::NsfHifiganOnnx => "nsf_hifigan_onnx".to_string(),
                PitchAnalysisAlgo::None => "none".to_string(),
                PitchAnalysisAlgo::Unknown => "unknown".to_string(),
            }
        }

        let children = by_parent
            .get(&Some(t.id.clone()))
            .cloned()
            .unwrap_or_else(Vec::new);
        let child_ids = children.iter().map(|c| c.id.clone()).collect::<Vec<_>>();

        out.push(TimelineTrack {
            id: t.id.clone(),
            name: t.name.clone(),
            parent_id: t.parent_id.clone(),
            depth: Some(depth),
            child_track_ids: Some(child_ids),
            muted: t.muted,
            solo: t.solo,
            volume: t.volume,
            compose_enabled: t.compose_enabled,
            pitch_analysis_algo: algo_name(&t.pitch_analysis_algo),
        });

        for c in children {
            dfs(&c, depth + 1, by_parent, out);
        }
    }

    for r in roots {
        dfs(&r, 0, &by_parent, &mut out);
    }

    // Any orphans (missing parent) appended.
    if out.len() != tracks.len() {
        let mut seen: BTreeMap<String, bool> = BTreeMap::new();
        for t in &out {
            seen.insert(t.id.clone(), true);
        }
        for t in tracks {
            if !seen.contains_key(&t.id) {
                out.push(TimelineTrack {
                    id: t.id.clone(),
                    name: t.name.clone(),
                    parent_id: t.parent_id.clone(),
                    depth: Some(0),
                    child_track_ids: Some(vec![]),
                    muted: t.muted,
                    solo: t.solo,
                    volume: t.volume,
                    compose_enabled: t.compose_enabled,
                    pitch_analysis_algo: match t.pitch_analysis_algo {
                        PitchAnalysisAlgo::WorldDll => "world_dll".to_string(),
                        PitchAnalysisAlgo::NsfHifiganOnnx => "nsf_hifigan_onnx".to_string(),
                        PitchAnalysisAlgo::None => "none".to_string(),
                        PitchAnalysisAlgo::Unknown => "unknown".to_string(),
                    },
                });
            }
        }
    }

    out
}

impl AppState {
    pub fn runtime_info(&self) -> RuntimeInfoPayload {
        let rt = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        let pb = self.audio_engine.snapshot_state();

        RuntimeInfoPayload {
            ok: true,
            device: rt.device.clone(),
            model_loaded: rt.model_loaded,
            audio_loaded: rt.audio_loaded,
            has_synthesized: rt.has_synthesized,
            is_playing: Some(pb.is_playing),
            playback_target: pb.target.clone(),
            timeline: None,
        }
    }

    pub fn model_config_ok(&self) -> ModelConfigPayload {
        ModelConfigPayload {
            ok: true,
            config: ModelConfig {
                audio_sample_rate: 44100,
                audio_num_mel_bins: 128,
                hop_size: 512,
                fmin: 40.0,
                fmax: 16000.0,
            },
        }
    }
}
