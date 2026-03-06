// VocalShifter 工程文件 (.vshp / .vsp) 解析与转换模块
//
// 文件格式：二进制、小端序，由多个数据块组成。
// 支持的块类型：PRJP, TRKP, ITMP, Itmp, Ctrp, Time
//
// 参考规范：用户需求文档§2

use crate::audio_utils::try_read_wav_info;
use crate::models::PitchRange;
use crate::state::{Clip, PitchAnalysisAlgo, TimelineState, Track, TrackParamsState};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

// ─── 块标识 (8 bytes each) ───

const TAG_PRJP: [u8; 8] = [0x50, 0x52, 0x4A, 0x50, 0x00, 0x01, 0x00, 0x00];
const TAG_TRKP: [u8; 8] = [0x54, 0x52, 0x4B, 0x50, 0x00, 0x01, 0x00, 0x00];
const TAG_ITMP: [u8; 8] = [0x49, 0x54, 0x4D, 0x50, 0x00, 0x02, 0x00, 0x00];
const TAG_ITMP_EXT: [u8; 8] = [0x49, 0x74, 0x6D, 0x70, 0x00, 0x01, 0x00, 0x00]; // Itmp
const TAG_CTRP: [u8; 8] = [0x43, 0x74, 0x72, 0x70, 0x60, 0x00, 0x00, 0x00];
const TAG_TIME: [u8; 8] = [0x54, 0x69, 0x6D, 0x65, 0x10, 0x00, 0x00, 0x00];

const PRJP_DATA_SIZE: usize = 0x100;
const TRKP_DATA_SIZE: usize = 0x100;
const ITMP_DATA_SIZE: usize = 0x200;
const ITMP_EXT_DATA_SIZE: usize = 0x100;
const CTRP_DATA_SIZE: usize = 0x60;
const TIME_DATA_SIZE: usize = 0x10;

/// VocalShifter pitch 值 0 = C-1 (MIDI 0), 6000 = C4 (MIDI 60)
/// 换算公式: midi_note = vsp_pitch / 100.0
const VSP_PITCH_TO_MIDI: f64 = 1.0 / 100.0;

/// 每个 Ctrp 调音点固定间隔（秒）
const CTRP_FRAME_PERIOD: f64 = 0.005;

/// Time 标记分段平滑重叠（秒）
const SEGMENT_OVERLAP_SEC: f64 = 0.005;

/// HiFiShifter 支持的音频格式扩展名
const SUPPORTED_AUDIO_EXTS: &[&str] = &["wav", "flac", "mp3", "ogg", "m4a"];

const FILE_HEADER_SIZE: usize = 16;
const MAGIC: [u8; 4] = [0x56, 0x53, 0x50, 0x44]; // "VSPD"

// ─── 解析后的中间数据结构 ───

#[derive(Debug, Clone)]
struct VspProject {
    sample_rate: u32,
    time_sig_num: i32,
    time_sig_den: i32,
    bpm: f64,
}

#[derive(Debug, Clone)]
struct VspTrack {
    name: String,
    volume: f64,
    pan: f64,
    muted: bool,
    solo: bool,
    _inverted: bool,
}

#[derive(Debug, Clone)]
struct VspItemBase {
    audio_path: String,
    track_index: i32,
    start_sample: f64,
}

#[derive(Debug, Clone)]
struct VspItemExt {
    algo_type: i16,
    pitch_points: Vec<VspPitchPoint>,
    time_markers: Vec<VspTimeMarker>,
}

#[derive(Debug, Clone, Copy)]
struct VspPitchPoint {
    disabled: bool,
    pitch: i16,
}

#[derive(Debug, Clone, Copy)]
struct VspTimeMarker {
    original_pos: f64,
    new_pos: f64,
}

// ─── 导入结果 ───

pub struct VspImportResult {
    pub timeline: TimelineState,
    pub skipped_files: Vec<String>,
}

#[derive(Default, Clone, Copy)]
struct PitchFrameAccumulator {
    sum: f64,
    weight: f64,
    disabled_weight: f64,
}

// ─── 系统编码检测 ───

/// 将系统本地编码的字节串解码为 UTF-8。
/// VocalShifter 使用系统 ANSI 编码（Windows 上常为 GBK 或 Shift-JIS）。
fn decode_local_string(bytes: &[u8]) -> String {
    // 找到 null 终止符
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    let raw = &bytes[..end];

    // 使用系统编码
    let encoding = get_system_encoding();
    let (result, _, _) = encoding.decode(raw);
    result.to_string()
}

#[cfg(windows)]
fn get_system_encoding() -> &'static encoding_rs::Encoding {
    extern "system" {
        fn GetACP() -> u32;
    }
    let cp = unsafe { GetACP() };
    match cp {
        936 | 54936 => encoding_rs::GBK,
        932 => encoding_rs::SHIFT_JIS,
        950 => encoding_rs::BIG5,
        949 => encoding_rs::EUC_KR,
        1252 => encoding_rs::WINDOWS_1252,
        _ => encoding_rs::SHIFT_JIS, // VocalShifter 默认 Shift-JIS
    }
}

#[cfg(not(windows))]
fn get_system_encoding() -> &'static encoding_rs::Encoding {
    encoding_rs::SHIFT_JIS
}

// ─── 二进制读取辅助 ───

struct BinReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BinReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    fn peek_bytes(&self, n: usize) -> Option<&'a [u8]> {
        if self.pos + n <= self.data.len() {
            Some(&self.data[self.pos..self.pos + n])
        } else {
            None
        }
    }

    fn skip(&mut self, n: usize) {
        self.pos = (self.pos + n).min(self.data.len());
    }

    fn read_bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.pos + n <= self.data.len() {
            let slice = &self.data[self.pos..self.pos + n];
            self.pos += n;
            Some(slice)
        } else {
            None
        }
    }

    fn read_i16_le(&mut self) -> Option<i16> {
        let b = self.read_bytes(2)?;
        Some(i16::from_le_bytes([b[0], b[1]]))
    }

    fn read_i32_le(&mut self) -> Option<i32> {
        let b = self.read_bytes(4)?;
        Some(i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn read_f64_le(&mut self) -> Option<f64> {
        let b = self.read_bytes(8)?;
        Some(f64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }
}

// ─── 从数据块中的偏移位置读取值（不移动主游标） ───

fn read_i16_at(data: &[u8], offset: usize) -> Option<i16> {
    if offset + 2 > data.len() {
        return None;
    }
    Some(i16::from_le_bytes([data[offset], data[offset + 1]]))
}

fn read_i32_at(data: &[u8], offset: usize) -> Option<i32> {
    if offset + 4 > data.len() {
        return None;
    }
    Some(i32::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ]))
}

fn read_f64_at(data: &[u8], offset: usize) -> Option<f64> {
    if offset + 8 > data.len() {
        return None;
    }
    Some(f64::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
        data[offset + 4],
        data[offset + 5],
        data[offset + 6],
        data[offset + 7],
    ]))
}

// ─── 文件解析 ───

/// 解析 VocalShifter 工程文件 (.vshp / .vsp)。
/// 返回解析后的中间结构或错误信息。
fn parse_vsp_file(
    data: &[u8],
) -> Result<(VspProject, Vec<VspTrack>, Vec<VspItemBase>, Vec<VspItemExt>), String> {
    // §2.1 文件头校验
    if data.len() < FILE_HEADER_SIZE {
        return Err("File too small to be a valid VocalShifter project".into());
    }
    if data[0..4] != MAGIC {
        return Err("Invalid file header: expected VSPD magic bytes".into());
    }
    // 文件总大小（来自头部后 12 字节中的最后 4 字节）
    let _file_size = i32::from_le_bytes([data[12], data[13], data[14], data[15]]);

    let mut project: Option<VspProject> = None;
    let mut tracks: Vec<VspTrack> = Vec::new();
    let mut item_bases: Vec<VspItemBase> = Vec::new();
    let mut item_exts: Vec<VspItemExt> = Vec::new();

    let mut reader = BinReader::new(data);
    reader.skip(FILE_HEADER_SIZE);

    while reader.remaining() >= 8 {
        let tag = match reader.peek_bytes(8) {
            Some(t) => {
                let mut arr = [0u8; 8];
                arr.copy_from_slice(t);
                arr
            }
            None => break,
        };

        if tag == TAG_PRJP {
            reader.skip(8);
            if let Some(block_data) = reader.read_bytes(PRJP_DATA_SIZE) {
                project = Some(parse_prjp(block_data));
            }
        } else if tag == TAG_TRKP {
            reader.skip(8);
            if let Some(block_data) = reader.read_bytes(TRKP_DATA_SIZE) {
                tracks.push(parse_trkp(block_data));
            }
        } else if tag == TAG_ITMP {
            reader.skip(8);
            if let Some(block_data) = reader.read_bytes(ITMP_DATA_SIZE) {
                item_bases.push(parse_itmp(block_data));
            }
        } else if tag == TAG_ITMP_EXT {
            reader.skip(8);
            if let Some(block_data) = reader.read_bytes(ITMP_EXT_DATA_SIZE) {
                let mut ext = parse_itmp_ext(block_data);

                // 读取后续的 Ctrp 和 Time 块
                loop {
                    if reader.remaining() < 8 {
                        break;
                    }
                    let sub_tag = match reader.peek_bytes(8) {
                        Some(t) => {
                            let mut arr = [0u8; 8];
                            arr.copy_from_slice(t);
                            arr
                        }
                        None => break,
                    };

                    if sub_tag == TAG_CTRP {
                        reader.skip(8);
                        if let Some(ctrp_data) = reader.read_bytes(CTRP_DATA_SIZE) {
                            ext.pitch_points.push(parse_ctrp(ctrp_data));
                        }
                    } else if sub_tag == TAG_TIME {
                        reader.skip(8);
                        if let Some(time_data) = reader.read_bytes(TIME_DATA_SIZE) {
                            ext.time_markers.push(parse_time_marker(time_data));
                        }
                    } else {
                        break;
                    }
                }

                item_exts.push(ext);
            }
        } else {
            // 未知块：跳过 8 字节继续
            reader.skip(8);
        }
    }

    let project = project.ok_or("Missing PRJP block: no project information found")?;
    Ok((project, tracks, item_bases, item_exts))
}

fn parse_prjp(data: &[u8]) -> VspProject {
    VspProject {
        sample_rate: read_i32_at(data, 16).unwrap_or(44100) as u32,
        time_sig_num: read_i32_at(data, 20).unwrap_or(4),
        time_sig_den: read_i32_at(data, 24).unwrap_or(4),
        bpm: read_f64_at(data, 32).unwrap_or(120.0),
    }
}

fn parse_trkp(data: &[u8]) -> VspTrack {
    let name = decode_local_string(&data[0..64.min(data.len())]);
    VspTrack {
        name,
        volume: read_f64_at(data, 64).unwrap_or(1.0),
        pan: read_f64_at(data, 72).unwrap_or(0.0),
        muted: read_i32_at(data, 80).unwrap_or(0) != 0,
        solo: read_i32_at(data, 84).unwrap_or(0) != 0,
        _inverted: read_i32_at(data, 96).unwrap_or(0) != 0,
    }
}

fn parse_itmp(data: &[u8]) -> VspItemBase {
    // 偏移 0: 变长字符串到 null 终止
    let path_end = data.iter().position(|&b| b == 0).unwrap_or(0x108.min(data.len()));
    let audio_path = decode_local_string(&data[0..path_end]);

    VspItemBase {
        audio_path,
        track_index: read_i32_at(data, 0x108).unwrap_or(0),
        start_sample: read_f64_at(data, 0x110).unwrap_or(0.0),
    }
}

fn parse_itmp_ext(data: &[u8]) -> VspItemExt {
    VspItemExt {
        algo_type: read_i16_at(data, 0x30).unwrap_or(0),
        pitch_points: Vec::new(),
        time_markers: Vec::new(),
    }
}

fn parse_ctrp(data: &[u8]) -> VspPitchPoint {
    VspPitchPoint {
        disabled: read_i16_at(data, 18).unwrap_or(0) != 0,
        pitch: read_i16_at(data, 22).unwrap_or(0),
    }
}

fn parse_time_marker(data: &[u8]) -> VspTimeMarker {
    VspTimeMarker {
        original_pos: read_f64_at(data, 0).unwrap_or(0.0),
        new_pos: read_f64_at(data, 8).unwrap_or(0.0),
    }
}

// ─── 转换为 HiFiShifter 工程 ───

fn new_track_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn new_clip_id() -> String {
    format!("clip_{}", uuid::Uuid::new_v4())
}

/// 判断音频文件扩展名是否被 HiFiShifter 支持。
fn is_audio_supported(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| SUPPORTED_AUDIO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// 将 VocalShifter 音量倍率（1.0 = 0 dB）转换为 HiFiShifter 的 0.0–1.0 音量范围。
/// HiFiShifter 默认音量为 0.9，VocalShifter 1.0 对应全音量。
fn convert_volume(vs_volume: f64) -> f32 {
    (vs_volume as f32).clamp(0.0, 1.0)
}

/// 轨道颜色调色板（与 state.rs 中一致）
const TRACK_COLORS: &[&str] = &[
    "#4f8ef7", "#a78bfa", "#34d399", "#fb923c", "#f472b6", "#38bdf8", "#facc15", "#f87171",
];

fn clip_color() -> String {
    "#4fc3f7".to_string()
}

/// 将解析后的 VocalShifter 数据转换为 HiFiShifter TimelineState。
pub fn import_vsp(data: &[u8], vsp_file_dir: &Path) -> Result<VspImportResult, String> {
    let (project, vsp_tracks, item_bases, item_exts) = parse_vsp_file(data)?;

    let sample_rate = project.sample_rate.max(1) as f64;
    let bpm = if project.bpm > 0.0 { project.bpm } else { 120.0 };

    let mut skipped_files: Vec<String> = Vec::new();

    // ─── 第一步：创建轨道映射 ───
    // 检测每个原始轨道内是否存在混合算法，需要拆分
    // key: (original_track_index, is_world_algo) → new_track_id
    let mut track_algo_map: std::collections::HashMap<(i32, bool), String> =
        std::collections::HashMap::new();
    let mut hs_tracks: Vec<Track> = Vec::new();
    let mut track_order: i32 = 0;

    // 统计每个原始轨道内使用的算法
    let mut track_algos: std::collections::HashMap<i32, std::collections::HashSet<bool>> =
        std::collections::HashMap::new();
    for (i, base) in item_bases.iter().enumerate() {
        let is_world = item_exts.get(i).map(|e| e.algo_type == 8).unwrap_or(false);
        track_algos
            .entry(base.track_index)
            .or_default()
            .insert(is_world);
    }

    // 为每个 VspTrack 创建 HiFiShifter 轨道
    for (vsp_idx, vsp_track) in vsp_tracks.iter().enumerate() {
        let idx = vsp_idx as i32;
        let algos = track_algos.get(&idx);
        let has_mixed = algos.map(|s| s.len() > 1).unwrap_or(false);

        if has_mixed {
            // 需要拆分：为 World 和 非-World 各建一条轨道
            for &is_world in &[true, false] {
                if algos.map(|s| s.contains(&is_world)).unwrap_or(false) {
                    let suffix = if is_world { " (World)" } else { " (NSF-HiFiGAN)" };
                    let id = new_track_id();
                    let algo = if is_world {
                        PitchAnalysisAlgo::WorldDll
                    } else {
                        PitchAnalysisAlgo::NsfHifiganOnnx
                    };
                    hs_tracks.push(Track {
                        id: id.clone(),
                        name: format!("{}{}", vsp_track.name, suffix),
                        parent_id: None,
                        order: track_order,
                        muted: vsp_track.muted,
                        solo: vsp_track.solo,
                        volume: convert_volume(vsp_track.volume),
                        compose_enabled: true,
                        pitch_analysis_algo: algo,
                        color: TRACK_COLORS[hs_tracks.len() % TRACK_COLORS.len()].to_string(),
                    });
                    track_algo_map.insert((idx, is_world), id);
                    track_order += 1;
                }
            }
        } else {
            // 单一算法或无音频项
            let is_world = algos
                .and_then(|s| s.iter().next().copied())
                .unwrap_or(false);
            let algo = if is_world {
                PitchAnalysisAlgo::WorldDll
            } else {
                PitchAnalysisAlgo::NsfHifiganOnnx
            };
            let id = new_track_id();
            let has_items = algos.is_some();
            hs_tracks.push(Track {
                id: id.clone(),
                name: vsp_track.name.clone(),
                parent_id: None,
                order: track_order,
                muted: vsp_track.muted,
                solo: vsp_track.solo,
                volume: convert_volume(vsp_track.volume),
                compose_enabled: has_items,
                pitch_analysis_algo: algo,
                color: TRACK_COLORS[hs_tracks.len() % TRACK_COLORS.len()].to_string(),
            });
            // 对两种 is_world 值都映射到同一个轨道（因为不混合）
            track_algo_map.insert((idx, true), id.clone());
            track_algo_map.insert((idx, false), id);
            track_order += 1;
        }
    }

    // 如果某些 item 引用了超出 vsp_tracks 范围的轨道索引，为其创建轨道
    for base in &item_bases {
        if (base.track_index as usize) >= vsp_tracks.len() {
            let idx = base.track_index;
            if !track_algo_map.contains_key(&(idx, true))
                && !track_algo_map.contains_key(&(idx, false))
            {
                let id = new_track_id();
                hs_tracks.push(Track {
                    id: id.clone(),
                    name: format!("Track {}", idx + 1),
                    parent_id: None,
                    order: track_order,
                    muted: false,
                    solo: false,
                    volume: 0.9,
                    compose_enabled: true,
                    pitch_analysis_algo: PitchAnalysisAlgo::default(),
                    color: TRACK_COLORS[hs_tracks.len() % TRACK_COLORS.len()].to_string(),
                });
                track_algo_map.insert((idx, true), id.clone());
                track_algo_map.insert((idx, false), id);
                track_order += 1;
            }
        }
    }

    // ─── 第二步：创建剪辑 ───
    let mut hs_clips: Vec<Clip> = Vec::new();
    // 用于收集每个轨道的 pitch 数据：track_id → frame_idx → 累积加权值
    let mut pitch_data_by_track: std::collections::HashMap<
        String,
        std::collections::HashMap<usize, PitchFrameAccumulator>,
    > = std::collections::HashMap::new();

    for (i, base) in item_bases.iter().enumerate() {
        let ext = item_exts.get(i);

        // 解析音频路径
        let audio_path = resolve_audio_path(&base.audio_path, vsp_file_dir);

        // 检查格式支持
        if !is_audio_supported(&audio_path) {
            skipped_files.push(base.audio_path.clone());
            continue;
        }

        // 检查文件是否存在
        if !Path::new(&audio_path).exists() {
            skipped_files.push(base.audio_path.clone());
            continue;
        }

        // 确定目标轨道
        let is_world = ext.map(|e| e.algo_type == 8).unwrap_or(false);
        let track_id = track_algo_map
            .get(&(base.track_index, is_world))
            .cloned()
            .unwrap_or_else(|| {
                hs_tracks
                    .first()
                    .map(|t| t.id.clone())
                    .unwrap_or_default()
            });

        let item_start_sec = base.start_sample / sample_rate;

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

        // 处理时间拉伸标记
        let time_markers = ext.map(|e| &e.time_markers[..]).unwrap_or(&[]);
        let pitch_points = ext.map(|e| &e.pitch_points[..]).unwrap_or(&[]);

        if time_markers.len() >= 3 {
            // 非线性拉伸：拆分为多个子剪辑
            let seg_count = time_markers.len() - 1;
            for seg_idx in 0..seg_count {
                let m_start = &time_markers[seg_idx];
                let m_end = &time_markers[seg_idx + 1];

                let src_start = m_start.original_pos / sample_rate;
                let src_end = m_end.original_pos / sample_rate;
                let src_dur = (src_end - src_start).max(0.001);

                let new_start = m_start.new_pos / sample_rate;
                let new_end = m_end.new_pos / sample_rate;
                let new_dur = (new_end - new_start).max(0.001);

                let rate = (src_dur / new_dur) as f32;

                // 在分割边界处增加 0.01s 重叠，并配合淡入淡出实现平滑过渡。
                let want_pre_tl = if seg_idx > 0 { SEGMENT_OVERLAP_SEC } else { 0.0 };
                let want_post_tl = if seg_idx + 1 < seg_count {
                    SEGMENT_OVERLAP_SEC
                } else {
                    0.0
                };
                let rate64 = (rate as f64).max(0.0001);
                let want_pre_src = want_pre_tl * rate64;
                let want_post_src = want_post_tl * rate64;

                let seg_src_start = (src_start - want_pre_src).max(0.0);
                let seg_src_end = (src_end + want_post_src).min(source_duration_sec.max(src_end));
                let actual_pre_tl = (src_start - seg_src_start) / rate64;
                let actual_post_tl = (seg_src_end - src_end).max(0.0) / rate64;

                let clip_start = item_start_sec + new_start - actual_pre_tl;
                let clip_length = (new_dur + actual_pre_tl + actual_post_tl).max(0.001);
                let fade_in = if seg_idx > 0 {
                    actual_pre_tl.min(SEGMENT_OVERLAP_SEC)
                } else {
                    0.0
                };
                let fade_out = if seg_idx + 1 < seg_count {
                    actual_post_tl.min(SEGMENT_OVERLAP_SEC)
                } else {
                    0.0
                };

                let clip_id = new_clip_id();
                let clip_name = Path::new(&audio_path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Audio")
                    .to_string();

                hs_clips.push(Clip {
                    id: clip_id.clone(),
                    track_id: track_id.clone(),
                    name: format!("{} ({})", clip_name, seg_idx + 1),
                    start_sec: clip_start,
                    length_sec: clip_length,
                    color: clip_color(),
                    source_path: Some(audio_path.clone()),
                    duration_sec,
                    duration_frames,
                    source_sample_rate: source_sr,
                    waveform_preview: waveform_preview.clone(),
                    pitch_range: Some(PitchRange {
                        min: -24.0,
                        max: 24.0,
                    }),
                    gain: 1.0,
                    muted: false,
                    source_start_sec: seg_src_start,
                    source_end_sec: seg_src_end,
                    playback_rate: rate.clamp(0.1, 10.0),
                    fade_in_sec: fade_in,
                    fade_out_sec: fade_out,
                    fade_in_curve: String::new(),
                    fade_out_curve: String::new(),
                });

                // 写入 pitch 数据（源时间范围内的 Ctrp 点）
                write_pitch_data_for_segment(
                    &track_id,
                    pitch_points,
                    seg_src_start,
                    seg_src_end,
                    clip_start,
                    rate64,
                    fade_in,
                    fade_out,
                    &mut pitch_data_by_track,
                );
            }
        } else {
            // 线性拉伸或无拉伸
            let (rate, clip_length) = if time_markers.len() == 2 {
                let m0 = &time_markers[0];
                let m1 = &time_markers[1];
                let src_dur =
                    ((m1.original_pos - m0.original_pos) / sample_rate).max(0.001);
                let new_dur = ((m1.new_pos - m0.new_pos) / sample_rate).max(0.001);
                let r = src_dur / new_dur;
                (r as f32, new_dur)
            } else {
                (1.0f32, source_duration_sec)
            };

            let clip_id = new_clip_id();
            let clip_name = Path::new(&audio_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Audio")
                .to_string();

            hs_clips.push(Clip {
                id: clip_id.clone(),
                track_id: track_id.clone(),
                name: clip_name,
                start_sec: item_start_sec,
                length_sec: clip_length,
                color: clip_color(),
                source_path: Some(audio_path.clone()),
                duration_sec,
                duration_frames,
                source_sample_rate: source_sr,
                waveform_preview,
                pitch_range: Some(PitchRange {
                    min: -24.0,
                    max: 24.0,
                }),
                gain: 1.0,
                muted: false,
                    source_start_sec: 0.0,
                    source_end_sec: source_duration_sec,
                playback_rate: rate.clamp(0.1, 10.0),
                    fade_in_sec: 0.0,
                    fade_out_sec: 0.0,
                    fade_in_curve: String::new(),
                    fade_out_curve: String::new(),
                });

            // 写入 pitch 数据
            write_pitch_data_for_segment(
                &track_id,
                pitch_points,
                0.0,
                source_duration_sec,
                item_start_sec,
                rate as f64,
                0.0,
                0.0,
                &mut pitch_data_by_track,
            );
        }
    }

    // ─── 第三步：计算工程时长 ───
    let project_end = hs_clips
        .iter()
        .map(|c| c.start_sec + c.length_sec)
        .fold(32.0_f64, f64::max);

    // ─── 第四步：构建 pitch 参数 ───
    let mut params_by_root_track: BTreeMap<String, TrackParamsState> = BTreeMap::new();
    let frame_period_ms = CTRP_FRAME_PERIOD * 1000.0; // 5.0ms

    for track in &hs_tracks {
        if let Some(points) = pitch_data_by_track.get(&track.id) {
            if points.is_empty() {
                continue;
            }
            let total_frames =
                ((project_end * 1000.0 / frame_period_ms).ceil() as usize).max(1);
            let mut pitch_edit = vec![0.0f32; total_frames];

            for (&frame_idx, acc) in points {
                if frame_idx < total_frames {
                    if acc.weight > 0.0 {
                        pitch_edit[frame_idx] = (acc.sum / acc.weight) as f32;
                    } else if acc.disabled_weight > 0.0 {
                        pitch_edit[frame_idx] = 0.0;
                    }
                }
            }

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

    // ─── 第五步：组装 TimelineState ───
    let timeline = TimelineState {
        tracks: hs_tracks,
        clips: hs_clips,
        selected_track_id: None,
        selected_clip_id: None,
        bpm,
        playhead_sec: 0.0,
        project_sec: project_end,
        params_by_root_track,
        next_track_order: track_order,
    };

    Ok(VspImportResult {
        timeline,
        skipped_files,
    })
}

/// 将 Ctrp 调音点写入指定轨道的 pitch 数据。
fn write_pitch_data_for_segment(
    track_id: &str,
    pitch_points: &[VspPitchPoint],
    src_start_sec: f64,
    src_end_sec: f64,
    clip_start_sec: f64,
    playback_rate: f64,
    fade_in_sec: f64,
    fade_out_sec: f64,
    pitch_data: &mut std::collections::HashMap<
        String,
        std::collections::HashMap<usize, PitchFrameAccumulator>,
    >,
) {
    if pitch_points.is_empty() {
        return;
    }

    let rate = playback_rate.max(0.0001);
    let clip_end_sec = clip_start_sec + (src_end_sec - src_start_sec).max(0.0) / rate;
    if clip_end_sec <= clip_start_sec {
        return;
    }

    let start_frame = (clip_start_sec / CTRP_FRAME_PERIOD).floor().max(0.0) as usize;
    let end_frame = (clip_end_sec / CTRP_FRAME_PERIOD).ceil().max(0.0) as usize;

    let entry = pitch_data.entry(track_id.to_string()).or_default();

    // 按目标时间线逐帧采样，避免拉伸后 round 投影造成的“漏帧锯齿”。
    for frame_idx in start_frame..=end_frame {
        let timeline_time = frame_idx as f64 * CTRP_FRAME_PERIOD;
        if timeline_time < clip_start_sec || timeline_time > clip_end_sec {
            continue;
        }

        let rel_t = timeline_time - clip_start_sec;
        let src_time = src_start_sec + rel_t * rate;
        if src_time < src_start_sec || src_time > src_end_sec {
            continue;
        }

        let src_idx = (src_time / CTRP_FRAME_PERIOD).round().max(0.0) as usize;
        let Some(point) = pitch_points.get(src_idx) else {
            continue;
        };

        let mut weight = 1.0;
        if fade_in_sec > 0.0 {
            let fi_end = clip_start_sec + fade_in_sec;
            if timeline_time <= fi_end {
                let k = ((timeline_time - clip_start_sec) / fade_in_sec).clamp(0.0, 1.0);
                weight *= k;
            }
        }
        if fade_out_sec > 0.0 {
            let fo_start = (clip_end_sec - fade_out_sec).max(clip_start_sec);
            if timeline_time >= fo_start {
                let k = ((clip_end_sec - timeline_time) / fade_out_sec).clamp(0.0, 1.0);
                weight *= k;
            }
        }
        if weight <= 0.0 {
            continue;
        }

        let acc = entry.entry(frame_idx).or_default();
        if point.disabled {
            acc.disabled_weight += weight;
            continue;
        }

        let midi_val = point.pitch as f64 * VSP_PITCH_TO_MIDI;
        if midi_val > 0.0 {
            acc.sum += midi_val * weight;
            acc.weight += weight;
        }
    }
}

/// 将相对路径解析为绝对路径。
fn resolve_audio_path(raw_path: &str, vsp_dir: &Path) -> String {
    let p = PathBuf::from(raw_path);
    if p.is_absolute() {
        // 规范化路径分隔符
        return p.to_string_lossy().to_string();
    }
    // 相对路径：基于 .vshp/.vsp 所在目录拼接
    let resolved = vsp_dir.join(&p);
    resolved.to_string_lossy().to_string()
}
