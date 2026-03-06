// VocalShifter 剪贴板文件 (.clb) 解析模块。
//
// 临时目录候选文件：
// - %TEMP%/vocalshifter_tmp/vocalshifter_id.clb
// - %TEMP%/vocalshifter_tmp/vocalshifter_le_id.clb
//
// 记录格式：每条 0x80 字节（16 个 little-endian f64），仅使用前 3 个字段：
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

pub fn find_latest_clipboard_file() -> Option<PathBuf> {
    let base = std::env::temp_dir().join("vocalshifter_tmp");
    let candidates = [
        base.join("vocalshifter_id.clb"),
        base.join("vocalshifter_le_id.clb"),
    ];

    let mut best: Option<(PathBuf, SystemTime)> = None;
    for path in candidates {
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        match &best {
            None => best = Some((path, modified)),
            Some((_, t)) if modified > *t => best = Some((path, modified)),
            _ => {}
        }
    }

    best.map(|(p, _)| p)
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
