// Reaper 工程 / 剪贴板数据转换为 HiFiShifter 工程
//
// 将 reaper_parser 解析出的 ReaperData 转换为 HiFiShifter 的 TimelineState。
// 参考 vocalshifter_import.rs 的转换逻辑和 UltraPaste/ReaperDataHelper.cs。

use crate::audio_utils::try_read_wav_info;
use crate::models::PitchRange;
use crate::reaper_parser::{
    self, ReaperData, ReaperEnvelope,  ReaperItem,
    stretch_segments_from_markers,
};
use crate::state::{Clip, PitchAnalysisAlgo, TimelineState, Track, TrackParamsState};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// HiFiShifter 支持的音频格式扩展名
const SUPPORTED_AUDIO_EXTS: &[&str] = &["wav", "flac", "mp3", "ogg", "m4a"];

/// 帧周期（秒）
const FRAME_PERIOD: f64 = 0.005;

/// 分段重叠（秒）
const SEGMENT_OVERLAP_SEC: f64 = 0.005;

/// 轨道颜色调色板（与 state.rs / vocalshifter_import.rs 一致）
const TRACK_COLORS: &[&str] = &[
    "#4f8ef7", "#a78bfa", "#34d399", "#fb923c", "#f472b6", "#38bdf8", "#facc15", "#f87171",
];

fn clip_color() -> String {
    "#4fc3f7".to_string()
}

fn new_track_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn new_clip_id() -> String {
    format!("clip_{}", uuid::Uuid::new_v4())
}

fn is_audio_supported(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| SUPPORTED_AUDIO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// 将 Reaper 音量倍率转换为 HiFiShifter 的 0.0–1.0 范围。
fn convert_volume(vol: f64) -> f32 {
    (vol as f32).clamp(0.0, 1.0)
}

pub struct ReaperImportResult {
    pub timeline: TimelineState,
    pub skipped_files: Vec<String>,
}

/// 导入 Reaper 工程文件（.rpp）。
pub fn import_rpp(path: &Path) -> Result<ReaperImportResult, String> {
    let data = reaper_parser::parse_rpp_file(path)?;
    let rpp_dir = path.parent().unwrap_or_else(|| Path::new("."));
    convert_reaper_data(data, Some(rpp_dir))
}

/// 导入 Reaper 剪贴板数据。
/// `existing_track_id` 是 HiFiShifter 中当前选中的轨道 ID（用于无 Track 时粘贴到该轨道）。
pub fn import_reaper_clipboard(
    data: &[u8],
    existing_track_id: Option<&str>,
) -> Result<ReaperImportResult, String> {
    let reaper_data = reaper_parser::parse_clipboard_bytes(data)?;
    convert_reaper_data_clipboard(reaper_data, existing_track_id)
}

/// 剪贴板导入：如果数据有 Track 信息则新建轨道，否则放到 existing_track_id。
fn convert_reaper_data_clipboard(
    data: ReaperData,
    existing_track_id: Option<&str>,
) -> Result<ReaperImportResult, String> {
    if data.is_track_data {
        // 有 Track 信息，创建新轨道
        convert_reaper_data(data, None)
    } else {
        // 没有 Track 信息，导入到指定轨道
        convert_reaper_data_to_track(data, existing_track_id)
    }
}

/// 将没有 Track 的 Reaper 数据的 items 导入到指定轨道。
/// 返回的 timeline 中只包含新建的 clips（由调用者合并到现有 timeline）。
fn convert_reaper_data_to_track(
    data: ReaperData,
    existing_track_id: Option<&str>,
) -> Result<ReaperImportResult, String> {
    let track_id = existing_track_id.unwrap_or("").to_string();
    let mut skipped_files: Vec<String> = Vec::new();
    let mut clips: Vec<Clip> = Vec::new();
    let mut pitch_accum: std::collections::HashMap<usize, PitchFrameAccumulator> =
        std::collections::HashMap::new();

    for track in &data.tracks {
        for item in &track.items {
            process_item(
                item,
                &track_id,
                None, // no base dir for clipboard
                &mut clips,
                &mut skipped_files,
                &mut pitch_accum,
            );
        }
    }

    // Build pitch params if any data was accumulated
    let mut params_by_root_track: BTreeMap<String, TrackParamsState> = BTreeMap::new();
    if !pitch_accum.is_empty() && !track_id.is_empty() {
        let project_end = clips
            .iter()
            .map(|c| c.start_sec + c.length_sec)
            .fold(0.0_f64, f64::max);
        let frame_period_ms = FRAME_PERIOD * 1000.0;
        let total_frames = ((project_end * 1000.0 / frame_period_ms).ceil() as usize).max(1);
        let pitch_edit = build_pitch_frames(&pitch_accum, total_frames);
        params_by_root_track.insert(
            track_id.clone(),
            TrackParamsState {
                frame_period_ms,
                pitch_orig: pitch_edit.clone(),
                pitch_edit,
                pitch_edit_user_modified: true,
                tension_orig: Vec::new(),
                tension_edit: Vec::new(),
                pitch_orig_key: None,
            },
        );
    }

    let project_end = clips
        .iter()
        .map(|c| c.start_sec + c.length_sec)
        .fold(32.0_f64, f64::max);

    let timeline = TimelineState {
        tracks: Vec::new(), // 不创建新轨道
        clips,
        selected_track_id: None,
        selected_clip_id: None,
        bpm: 120.0,
        playhead_sec: 0.0,
        project_sec: project_end,
        params_by_root_track,
        next_track_order: 0,
    };

    Ok(ReaperImportResult {
        timeline,
        skipped_files,
    })
}

/// 将含有 Track 信息的 Reaper 数据转换为完整 TimelineState。
fn convert_reaper_data(
    data: ReaperData,
    base_dir: Option<&Path>,
) -> Result<ReaperImportResult, String> {
    let mut hs_tracks: Vec<Track> = Vec::new();
    let mut hs_clips: Vec<Clip> = Vec::new();
    let mut skipped_files: Vec<String> = Vec::new();
    let mut track_order: i32 = 0;

    // track_id → pitch accumulator
    let mut pitch_data_by_track: std::collections::HashMap<
        String,
        std::collections::HashMap<usize, PitchFrameAccumulator>,
    > = std::collections::HashMap::new();

    for reaper_track in &data.tracks {
        let track_id = new_track_id();
        let volume = if !reaper_track.vol_pan.is_empty() {
            convert_volume(reaper_track.vol_pan[0])
        } else {
            0.9
        };
        let muted = reaper_track.mute_solo.first().copied().unwrap_or(0) != 0;
        let solo = reaper_track.mute_solo.get(1).copied().unwrap_or(0) != 0;

        let has_audio_items = reaper_track.items.iter().any(|item| {
            let take = item.active_take();
            take.source.as_ref().map(|s| !s.file_path.is_empty()).unwrap_or(false)
        });

        hs_tracks.push(Track {
            id: track_id.clone(),
            name: if reaper_track.name.is_empty() {
                format!("Track {}", track_order + 1)
            } else {
                reaper_track.name.clone()
            },
            parent_id: None,
            order: track_order,
            muted,
            solo,
            volume,
            compose_enabled: has_audio_items,
            pitch_analysis_algo: PitchAnalysisAlgo::default(),
            color: TRACK_COLORS[hs_tracks.len() % TRACK_COLORS.len()].to_string(),
        });

        let mut track_pitch_accum: std::collections::HashMap<usize, PitchFrameAccumulator> =
            std::collections::HashMap::new();

        for item in &reaper_track.items {
            process_item(
                item,
                &track_id,
                base_dir,
                &mut hs_clips,
                &mut skipped_files,
                &mut track_pitch_accum,
            );
        }

        if !track_pitch_accum.is_empty() {
            pitch_data_by_track.insert(track_id.clone(), track_pitch_accum);
        }

        track_order += 1;
    }

    // 计算工程时长
    let project_end = hs_clips
        .iter()
        .map(|c| c.start_sec + c.length_sec)
        .fold(32.0_f64, f64::max);

    // 构建 pitch 参数
    let mut params_by_root_track: BTreeMap<String, TrackParamsState> = BTreeMap::new();
    let frame_period_ms = FRAME_PERIOD * 1000.0;

    for track in &hs_tracks {
        if let Some(points) = pitch_data_by_track.get(&track.id) {
            if points.is_empty() {
                continue;
            }
            let total_frames =
                ((project_end * 1000.0 / frame_period_ms).ceil() as usize).max(1);
            let pitch_edit = build_pitch_frames(points, total_frames);

            params_by_root_track.insert(
                track.id.clone(),
                TrackParamsState {
                    frame_period_ms,
                    pitch_orig: pitch_edit.clone(),
                    pitch_edit,
                    pitch_edit_user_modified: true,
                    tension_orig: Vec::new(),
                    tension_edit: Vec::new(),
                    pitch_orig_key: None,
                },
            );
        }
    }

    let timeline = TimelineState {
        tracks: hs_tracks,
        clips: hs_clips,
        selected_track_id: None,
        selected_clip_id: None,
        bpm: 120.0,
        playhead_sec: 0.0,
        project_sec: project_end,
        params_by_root_track,
        next_track_order: track_order,
    };

    Ok(ReaperImportResult {
        timeline,
        skipped_files,
    })
}

// ─── Item 处理 ───

#[derive(Default, Clone, Copy)]
struct PitchFrameAccumulator {
    sum: f64,
    weight: f64,
}

/// 处理一个 Reaper Item，生成一个或多个 HiFiShifter Clip。
fn process_item(
    item: &ReaperItem,
    track_id: &str,
    base_dir: Option<&Path>,
    clips: &mut Vec<Clip>,
    skipped_files: &mut Vec<String>,
    pitch_accum: &mut std::collections::HashMap<usize, PitchFrameAccumulator>,
) {
    let take = item.active_take();

    // 获取音频文件路径
    let raw_path = match &take.source {
        Some(src) => src.resolved_path().to_string(),
        None => return, // skip MIDI or empty items
    };
    if raw_path.is_empty() {
        return;
    }

    // 如果使用相对路径且有 base_dir，拼接成绝对路径
    let audio_path = resolve_path(&raw_path, base_dir);

    // 检查格式支持
    if !is_audio_supported(&audio_path) {
        skipped_files.push(raw_path);
        return;
    }

    // 检查文件存在
    if !Path::new(&audio_path).exists() {
        skipped_files.push(raw_path);
        return;
    }

    // 读取音频文件信息
    let audio_info = try_read_wav_info(Path::new(&audio_path), 4096);
    let (duration_sec, duration_frames, source_sr, waveform_preview) = match &audio_info {
        Some(info) => (
            Some(info.duration_sec),
            Some(info.total_frames),
            Some(info.sample_rate),
            Some(info.waveform_preview.clone()),
        ),
        None => (None, None, None, None),
    };
    let source_duration_sec = duration_sec.unwrap_or(0.0);

    // 获取 take 参数
    let play_rate = take.play_rate.first().copied().unwrap_or(1.0).max(0.01);
    let item_pitch_semitones = take.play_rate.get(2).copied().unwrap_or(0.0); // 整体音高偏移
    let take_volume = take.vol_pan.first().copied().unwrap_or(1.0);
    // vol_pan[2] 在 Reaper 中是 gainTrim
    let gain_trim = take.vol_pan.get(2).copied().unwrap_or(1.0);
    let item_muted = item.mute.first().copied().unwrap_or(0) != 0;
    let s_offs = take.s_offs; // source offset (seconds)
    let item_pos = item.position; // timeline position (seconds)
    let item_length = item.length; // visible length (seconds)
    let fade_in_sec = item.fade_in.get(1).copied().unwrap_or(0.0);
    let fade_out_sec = item.fade_out.get(1).copied().unwrap_or(0.0);

    // 获取音高包络（如果有）
    let pitch_envelope = find_pitch_envelope(&item.envelopes);

    // ─── 处理 Stretch Markers ───
    let segments = stretch_segments_from_markers(&item.stretch_markers);

    if segments.len() >= 2 {
        // 有 stretch markers：拆分为多段
        let seg_count = segments.len();
        let mut current_timeline_pos = item_pos;

        for (seg_idx, seg) in segments.iter().enumerate() {
            let avg_rate = seg.velocity_average().max(0.01);
            let seg_src_duration = seg.offset_length();
            let seg_timeline_duration = seg_src_duration / avg_rate;

            // 分段重叠与淡入淡出
            let want_pre = if seg_idx > 0 { SEGMENT_OVERLAP_SEC } else { 0.0 };
            let want_post = if seg_idx + 1 < seg_count { SEGMENT_OVERLAP_SEC } else { 0.0 };
            let actual_pre_src = (want_pre * avg_rate).min(seg.offset_start);
            let actual_post_src = want_post * avg_rate;
            let actual_pre_tl = actual_pre_src / avg_rate;
            let actual_post_tl = actual_post_src / avg_rate;

            let clip_src_start = s_offs + seg.offset_start - actual_pre_src;
            let clip_src_end = (s_offs + seg.offset_end + actual_post_src)
                .min(source_duration_sec.max(s_offs + seg.offset_end));
            let clip_start = current_timeline_pos - actual_pre_tl;
            let clip_length = (seg_timeline_duration + actual_pre_tl + actual_post_tl).max(0.001);

            let fi = if seg_idx > 0 {
                actual_pre_tl.min(SEGMENT_OVERLAP_SEC)
            } else {
                fade_in_sec
            };
            let fo = if seg_idx + 1 < seg_count {
                actual_post_tl.min(SEGMENT_OVERLAP_SEC)
            } else {
                fade_out_sec
            };

            let clip_name = clip_name_from_path(&audio_path);
            let clip_id = new_clip_id();

            clips.push(Clip {
                id: clip_id.clone(),
                track_id: track_id.to_string(),
                name: format!("{} ({})", clip_name, seg_idx + 1),
                start_sec: clip_start,
                length_sec: clip_length,
                color: clip_color(),
                source_path: Some(audio_path.clone()),
                duration_sec,
                duration_frames,
                source_sample_rate: source_sr,
                waveform_preview: waveform_preview.clone(),
                pitch_range: Some(PitchRange { min: -24.0, max: 24.0 }),
                gain: convert_volume(take_volume * gain_trim),
                muted: item_muted,
                trim_start_sec: clip_src_start.max(0.0),
                trim_end_sec: clip_src_end,
                playback_rate: (avg_rate as f32).clamp(0.1, 10.0),
                fade_in_sec: fi,
                fade_out_sec: fo,
            });

            // 写入 pitch 数据
            write_pitch_for_clip(
                pitch_accum,
                clip_start,
                clip_length,
                clip_src_start,
                avg_rate,
                item_pitch_semitones,
                pitch_envelope.as_ref(),
                item_pos,
                item_length,
            );

            current_timeline_pos += seg_timeline_duration;
        }
    } else {
        // 无 stretch markers 或只有一两个点：使用 take 的 play_rate
        let effective_rate = play_rate;
        let source_start = s_offs;
        let source_end = s_offs + item_length * effective_rate;
        let clip_name = clip_name_from_path(&audio_path);
        let clip_id = new_clip_id();

        clips.push(Clip {
            id: clip_id.clone(),
            track_id: track_id.to_string(),
            name: clip_name,
            start_sec: item_pos,
            length_sec: item_length,
            color: clip_color(),
            source_path: Some(audio_path.clone()),
            duration_sec,
            duration_frames,
            source_sample_rate: source_sr,
            waveform_preview,
            pitch_range: Some(PitchRange { min: -24.0, max: 24.0 }),
            gain: convert_volume(take_volume * gain_trim),
            muted: item_muted,
            trim_start_sec: source_start.max(0.0),
            trim_end_sec: source_end.min(source_duration_sec.max(source_end)),
            playback_rate: (effective_rate as f32).clamp(0.1, 10.0),
            fade_in_sec,
            fade_out_sec,
        });

        // 写入 pitch 数据
        write_pitch_for_clip(
            pitch_accum,
            item_pos,
            item_length,
            source_start,
            effective_rate,
            item_pitch_semitones,
            pitch_envelope.as_ref(),
            item_pos,
            item_length,
        );
    }
}

// ─── Pitch 处理 ───

/// 在 item 的 envelopes 中查找音高包络。
/// Reaper 的音高包络类型为 "ENVSEG" 且通常是 "PITCHENV" 或以 "PITCH" 开头。
/// 也可能直接作为 item level 的 envelope 出现。
fn find_pitch_envelope(envelopes: &[ReaperEnvelope]) -> Option<Vec<(f64, f64)>> {
    for env in envelopes {
        let t = env.env_type.to_uppercase();
        // 在 item 级别的 pitch envelope 通常类型名包含 "PITCH"
        // 但 Reaper 也可能使用 ENVSEG
        if t.contains("PITCH") || t == "ENVSEG" {
            // 检查 act[0] 是否启用（默认 act=[1, -1]）
            if env.act.first().copied().unwrap_or(1) == 0 {
                continue;
            }
            let mut points = Vec::new();
            for pt in &env.points {
                if pt.len() >= 2 {
                    // pt[0] = time (seconds, relative to item start)
                    // pt[1] = value (semitones for pitch envelope, range typically -24..+24)
                    points.push((pt[0], pt[1]));
                }
            }
            if !points.is_empty() {
                return Some(points);
            }
        }
    }
    None
}

/// 在音高包络上插值取得指定时间点的值。
fn interpolate_pitch_envelope(points: &[(f64, f64)], time_sec: f64) -> f64 {
    if points.is_empty() {
        return 0.0;
    }
    if time_sec <= points[0].0 {
        return points[0].1;
    }
    if time_sec >= points[points.len() - 1].0 {
        return points[points.len() - 1].1;
    }
    for i in 1..points.len() {
        if time_sec <= points[i].0 {
            let (t0, v0) = points[i - 1];
            let (t1, v1) = points[i];
            let dt = t1 - t0;
            if dt.abs() < 1e-12 {
                return v0;
            }
            let t = (time_sec - t0) / dt;
            return v0 + (v1 - v0) * t;
        }
    }
    points.last().map(|p| p.1).unwrap_or(0.0)
}

/// 将 pitch 数据写入帧级别的 accumulator。
/// Reaper 的音高是"相对于原始"的半音偏移，要叠加到原始音高上。
/// 但由于 HiFiShifter 导入时还没有分析原始音高，这里先记录偏移量，
/// 后续在 pitch params 构建阶段会将它写入 pitch_edit。
///
/// 实现策略：由于 Reaper 的音高是偏移量（相对原始），而 HiFiShifter 的 pitch_edit 是绝对值，
/// 在导入时我们暂时记录偏移量，等 HiFiShifter 进行音高分析后会用 pitch_orig + offset 来计算。
/// 如果没有偏移（0半音），则不写入 pitch 数据，让 HiFiShifter 的后续音高分析流程来处理。
fn write_pitch_for_clip(
    accum: &mut std::collections::HashMap<usize, PitchFrameAccumulator>,
    clip_start_sec: f64,
    clip_length_sec: f64,
    _source_start_sec: f64,
    _play_rate: f64,
    item_pitch_semitones: f64,
    pitch_envelope: Option<&Vec<(f64, f64)>>,
    item_start_sec: f64,
    item_length_sec: f64,
) {
    // 如果没有任何音高偏移，跳过（让 HiFiShifter 默认处理）
    let has_pitch_shift = item_pitch_semitones.abs() > 1e-6;
    let has_envelope = pitch_envelope.map(|e| !e.is_empty()).unwrap_or(false);

    if !has_pitch_shift && !has_envelope {
        return;
    }

    let clip_end_sec = clip_start_sec + clip_length_sec;
    let start_frame = (clip_start_sec / FRAME_PERIOD).floor().max(0.0) as usize;
    let end_frame = (clip_end_sec / FRAME_PERIOD).ceil().max(0.0) as usize;

    for frame_idx in start_frame..=end_frame {
        let frame_time = frame_idx as f64 * FRAME_PERIOD;
        // 相对于 item 开始的时间
        let time_in_item = frame_time - item_start_sec;

        if time_in_item < 0.0 || time_in_item > item_length_sec {
            continue;
        }

        // 计算音高偏移 = 整体偏移 + 包络偏移
        let mut pitch_offset = item_pitch_semitones;
        if let Some(env_points) = pitch_envelope {
            pitch_offset += interpolate_pitch_envelope(env_points, time_in_item);
        }

        let entry = accum.entry(frame_idx).or_default();
        entry.sum += pitch_offset;
        entry.weight += 1.0;
    }
}

/// 从 accumulator 构建 pitch_edit 帧数组。
/// 值是半音偏移量（会在后续音高分析后叠加到 pitch_orig 上）。
fn build_pitch_frames(
    accum: &std::collections::HashMap<usize, PitchFrameAccumulator>,
    total_frames: usize,
) -> Vec<f32> {
    let mut frames = vec![0.0f32; total_frames];
    for (&idx, acc) in accum {
        if idx < total_frames && acc.weight > 0.0 {
            frames[idx] = (acc.sum / acc.weight) as f32;
        }
    }
    frames
}

// ─── 辅助函数 ───

fn clip_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Audio")
        .to_string()
}

fn resolve_path(raw_path: &str, base_dir: Option<&Path>) -> String {
    let p = PathBuf::from(raw_path);
    if p.is_absolute() {
        return p.to_string_lossy().to_string();
    }
    if let Some(dir) = base_dir {
        let resolved = dir.join(&p);
        return resolved.to_string_lossy().to_string();
    }
    raw_path.to_string()
}
