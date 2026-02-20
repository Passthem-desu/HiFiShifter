use crate::waveform::CachedPeaks;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAGIC: &[u8; 8] = b"HFSPEAKS";
const VERSION: u32 = 1;

pub fn default_cache_dir() -> PathBuf {
    std::env::temp_dir()
        .join("hifishifter")
        .join("waveform_peaks_cache")
}

pub fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())
}

fn metadata_fingerprint(path: &Path) -> (u64, u64) {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return (0, 0),
    };
    let len = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (len, mtime)
}

pub fn cache_file_path(cache_dir: &Path, source_path: &str, hop: usize) -> PathBuf {
    // Stable key: canonical path (best effort) + file size + mtime + hop + version.
    let p = Path::new(source_path);
    let canonical = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let (len, mtime) = metadata_fingerprint(&canonical);

    let mut hasher = blake3::Hasher::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    hasher.update(b"\n");
    hasher.update(&len.to_le_bytes());
    hasher.update(&mtime.to_le_bytes());
    hasher.update(&(hop as u64).to_le_bytes());
    hasher.update(&VERSION.to_le_bytes());

    let hash = hasher.finalize();
    let name = format!("{}.hfspeaks", hash.to_hex());
    cache_dir.join(name)
}

pub fn try_load_peaks(path: &Path) -> Option<CachedPeaks> {
    let mut f = fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;

    let mut off: usize = 0;
    let mut take = |n: usize| -> Option<&[u8]> {
        if off + n > buf.len() {
            return None;
        }
        let s = &buf[off..off + n];
        off += n;
        Some(s)
    };

    if take(8)? != MAGIC {
        return None;
    }
    let ver = u32::from_le_bytes(take(4)?.try_into().ok()?);
    if ver != VERSION {
        return None;
    }

    let sample_rate = u32::from_le_bytes(take(4)?.try_into().ok()?);
    let hop = u32::from_le_bytes(take(4)?.try_into().ok()?) as usize;
    let total_frames = u64::from_le_bytes(take(8)?.try_into().ok()?);
    let len = u32::from_le_bytes(take(4)?.try_into().ok()?) as usize;
    if len == 0 || len > 10_000_000 {
        return None;
    }

    let mut read_f32_vec = |count: usize| -> Option<Vec<f32>> {
        let bytes = take(count * 4)?;
        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let j = i * 4;
            let v = f32::from_le_bytes(bytes[j..j + 4].try_into().ok()?);
            out.push(v);
        }
        Some(out)
    };

    let min = read_f32_vec(len)?;
    let max = read_f32_vec(len)?;

    Some(CachedPeaks {
        sample_rate,
        hop,
        min,
        max,
        total_frames,
    })
}

pub fn save_peaks(path: &Path, peaks: &CachedPeaks) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "no parent dir".to_string())?;
    ensure_dir(parent)?;

    let len = peaks.min.len().min(peaks.max.len());
    let len_u32: u32 = len
        .try_into()
        .map_err(|_| "peaks too large".to_string())?;

    let mut tmp = path.to_path_buf();
    tmp.set_extension("tmp");

    let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(MAGIC).map_err(|e| e.to_string())?;
    f.write_all(&VERSION.to_le_bytes()).map_err(|e| e.to_string())?;
    f.write_all(&peaks.sample_rate.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&(peaks.hop as u32).to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&peaks.total_frames.to_le_bytes())
        .map_err(|e| e.to_string())?;
    f.write_all(&len_u32.to_le_bytes())
        .map_err(|e| e.to_string())?;

    for i in 0..len {
        f.write_all(&peaks.min[i].to_le_bytes())
            .map_err(|e| e.to_string())?;
    }
    for i in 0..len {
        f.write_all(&peaks.max[i].to_le_bytes())
            .map_err(|e| e.to_string())?;
    }

    f.flush().map_err(|e| e.to_string())?;
    drop(f);

    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub struct ClearStats {
    pub removed_files: u64,
    pub removed_bytes: u64,
}

pub fn clear_dir(dir: &Path) -> ClearStats {
    let mut removed_files = 0u64;
    let mut removed_bytes = 0u64;

    let entries = match fs::read_dir(dir) {
        Ok(v) => v,
        Err(_) => {
            return ClearStats {
                removed_files,
                removed_bytes,
            }
        }
    };

    for e in entries.flatten() {
        let p = e.path();
        if p.is_file() {
            let is_peaks = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("hfspeaks"))
                .unwrap_or(false);
            if !is_peaks {
                continue;
            }
            if let Ok(meta) = e.metadata() {
                removed_bytes = removed_bytes.saturating_add(meta.len());
            }
            if fs::remove_file(&p).is_ok() {
                removed_files = removed_files.saturating_add(1);
            }
        }
    }

    ClearStats {
        removed_files,
        removed_bytes,
    }
}
