// VocalShifter 剪贴板文件解析模块。
//
// 临时目录 %TEMP%/vocalshifter_tmp/ 下的候选文件（按修改时间取最晚的）：
// - vocalshifter_tr.clb.vshp   (工程文件)
// - vocalshifter_le_tr.clb.vshp (工程文件)
// - vocalshifter_tr.clb.vsp    (工程文件)
// - vocalshifter_le_tr.clb.vsp (工程文件)
// - vocalshifter_id.clb        (音高线数据)
// - vocalshifter_le_id.clb     (音高线数据)
//
// .clb 记录格式：每条 0x80 字节（16 个 little-endian f64），仅使用前 3 个字段：
// - [0] time_sec
// - [1] disabled (1.0 disabled / 0.0 enabled)
// - [2] pitch_cents (0 = C-1, 6000 = C4)

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const RECORD_SIZE: usize = 0x80;
const CENTS_TO_MIDI: f64 = 1.0 / 100.0;

#[derive(Debug, Clone, Copy)]
pub struct ClipboardPitchPoint {
    pub time_sec: f64,
    pub disabled: bool,
    pub midi_pitch: f32,
}

/// 剪贴板文件类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardFileKind {
    /// .clb 文件 — 纯音高线数据
    PitchData,
    /// .clb.vshp / .clb.vsp 文件 — VocalShifter 工程文件
    Project,
}

/// 查找最新的 VocalShifter 剪贴板文件，返回路径及其类型。
pub fn find_latest_clipboard_file() -> Option<(PathBuf, ClipboardFileKind)> {
    let base = std::env::temp_dir().join("vocalshifter_tmp");
    let candidates = [
        (base.join("vocalshifter_tr.clb.vshp"), ClipboardFileKind::Project),
        (base.join("vocalshifter_le_tr.clb.vshp"), ClipboardFileKind::Project),
        (base.join("vocalshifter_tr.clb.vsp"), ClipboardFileKind::Project),
        (base.join("vocalshifter_le_tr.clb.vsp"), ClipboardFileKind::Project),
        (base.join("vocalshifter_id.clb"), ClipboardFileKind::PitchData),
        (base.join("vocalshifter_le_id.clb"), ClipboardFileKind::PitchData),
    ];

    let mut best: Option<(PathBuf, ClipboardFileKind, SystemTime)> = None;
    for (path, kind) in candidates {
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        match &best {
            None => best = Some((path, kind, modified)),
            Some((_, _, t)) if modified > *t => best = Some((path, kind, modified)),
            _ => {}
        }
    }

    best.map(|(p, k, _)| (p, k))
}

pub fn parse_clipboard_file(path: &Path) -> Result<Vec<ClipboardPitchPoint>, String> {
    let data = fs::read(path)
        .map_err(|e| format!("io_error: {}", e))?;

    if data.len() % RECORD_SIZE != 0 {
        return Err(format!(
            "invalid_format: file size {} is not multiple of {}",
            data.len(),
            RECORD_SIZE
        ));
    }

    let mut out = Vec::with_capacity(data.len() / RECORD_SIZE);
    for rec in data.chunks_exact(RECORD_SIZE) {
        let time_sec = f64::from_le_bytes(
            rec[0..8]
                .try_into()
                .map_err(|_| "invalid_format: bad time field".to_string())?,
        );
        let disabled_raw = f64::from_le_bytes(
            rec[8..16]
                .try_into()
                .map_err(|_| "invalid_format: bad disabled field".to_string())?,
        );
        let pitch_cents = f64::from_le_bytes(
            rec[16..24]
                .try_into()
                .map_err(|_| "invalid_format: bad pitch field".to_string())?,
        );

        out.push(ClipboardPitchPoint {
            time_sec,
            disabled: (disabled_raw - 1.0).abs() < 1e-9,
            midi_pitch: (pitch_cents * CENTS_TO_MIDI) as f32,
        });
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    fn test_base_dir() -> PathBuf {
        let base = std::env::temp_dir().join("vocalshifter_tmp");
        let _ = fs::create_dir_all(&base);
        base
    }

    #[test]
    fn test_find_latest_clipboard_file_selects_latest_candidate() {
        let base = test_base_dir();
        let id_path = base.join("vocalshifter_id.clb");
        let le_id_path = base.join("vocalshifter_le_id.clb");

        // Clean up any existing files from previous runs.
        let _ = fs::remove_file(&id_path);
        let _ = fs::remove_file(&le_id_path);

        // Also clean up project file candidates that could interfere.
        for name in &[
            "vocalshifter_tr.clb.vshp",
            "vocalshifter_le_tr.clb.vshp",
            "vocalshifter_tr.clb.vsp",
            "vocalshifter_le_tr.clb.vsp",
        ] {
            let _ = fs::remove_file(base.join(name));
        }

        // Create first candidate file.
        fs::write(&id_path, b"first").expect("failed to write first candidate");
        // Ensure the second file has a later modification time.
        thread::sleep(Duration::from_millis(10));
        fs::write(&le_id_path, b"second").expect("failed to write second candidate");

        let latest = find_latest_clipboard_file();
        let (latest_path, latest_kind) = latest.expect("Expected to find a clipboard file");
        assert_eq!(
            latest_path, le_id_path,
            "Expected latest clipboard file to be the *_le_id.clb candidate"
        );
        assert_eq!(
            latest_kind,
            ClipboardFileKind::PitchData,
            "Expected PitchData kind for .clb file"
        );
    }

    #[test]
    fn test_parse_clipboard_file_rejects_non_multiple_of_record_size() {
        let base = test_base_dir();
        let path = base.join("parse_invalid.clb");

        // Size is RECORD_SIZE + 1, which is not a multiple of RECORD_SIZE.
        let buf = vec![0u8; RECORD_SIZE + 1];
        fs::write(&path, &buf).expect("failed to write invalid-size clipboard file");

        let res = parse_clipboard_file(&path);
        assert!(
            res.is_err(),
            "Expected parse_clipboard_file to return Err for invalid-size file"
        );

        let err = res.unwrap_err();
        assert!(
            err.contains("invalid_format"),
            "Expected error message to mention invalid_format, got: {}",
            err
        );
    }

    #[test]
    fn test_parse_clipboard_file_decodes_synthetic_clb() {
        let base = test_base_dir();
        let path = base.join("parse_valid.clb");

        let record_count = 2;
        let mut buf = vec![0u8; RECORD_SIZE * record_count];

        // Record 0: enabled point (disabled flag = 0.0), time = 0.5, pitch = 6000 cents (MIDI 60).
        let time0 = 0.5_f64;
        let disabled0 = 0.0_f64;
        let pitch0 = 6000.0_f64;
        buf[0..8].copy_from_slice(&time0.to_le_bytes());
        buf[8..16].copy_from_slice(&disabled0.to_le_bytes());
        buf[16..24].copy_from_slice(&pitch0.to_le_bytes());

        // Record 1: disabled point (disabled flag = 1.0), time = 1.0, pitch = 6100 cents (MIDI 61).
        let time1 = 1.0_f64;
        let disabled1 = 1.0_f64;
        let pitch1 = 6100.0_f64;
        let offset1 = RECORD_SIZE;
        buf[offset1 + 0..offset1 + 8].copy_from_slice(&time1.to_le_bytes());
        buf[offset1 + 8..offset1 + 16].copy_from_slice(&disabled1.to_le_bytes());
        buf[offset1 + 16..offset1 + 24].copy_from_slice(&pitch1.to_le_bytes());

        fs::write(&path, &buf).expect("failed to write valid synthetic clipboard file");

        let points = parse_clipboard_file(&path).expect("expected valid parse for synthetic clb");
        assert_eq!(points.len(), 2, "Expected exactly two parsed points");

        let p0 = &points[0];
        let p1 = &points[1];

        // Check times.
        assert!((p0.time_sec - time0).abs() < 1e-9, "Unexpected time for first point");
        assert!((p1.time_sec - time1).abs() < 1e-9, "Unexpected time for second point");

        // Check disabled flags.
        assert_eq!(p0.disabled, false, "First point should be enabled");
        assert_eq!(p1.disabled, true, "Second point should be disabled");

        // Check MIDI pitches (cents * CENTS_TO_MIDI).
        let expected_midi0 = (pitch0 * CENTS_TO_MIDI) as f32;
        let expected_midi1 = (pitch1 * CENTS_TO_MIDI) as f32;
        assert!(
            (p0.midi_pitch - expected_midi0).abs() < 1e-6,
            "Unexpected MIDI pitch for first point: got {}, expected {}",
            p0.midi_pitch,
            expected_midi0
        );
        assert!(
            (p1.midi_pitch - expected_midi1).abs() < 1e-6,
            "Unexpected MIDI pitch for second point: got {}, expected {}",
            p1.midi_pitch,
            expected_midi1
        );
    }
}
