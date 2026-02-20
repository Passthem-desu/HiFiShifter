use crate::state::TimelineState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProjectFile {
    pub version: u32,
    pub name: String,
    pub timeline: TimelineState,
}

impl ProjectFile {
    pub fn new(name: String, timeline: TimelineState) -> Self {
        Self {
            version: 1,
            name,
            timeline,
        }
    }
}

pub fn project_name_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string()
}

pub fn make_paths_relative(mut tl: TimelineState, project_path: &Path) -> TimelineState {
    let dir = project_path.parent().unwrap_or_else(|| Path::new("."));
    for c in tl.clips.iter_mut() {
        if let Some(sp) = c.source_path.clone() {
            let p = PathBuf::from(&sp);
            if p.is_absolute() {
                if let Ok(stripped) = p.strip_prefix(dir) {
                    c.source_path = Some(stripped.to_string_lossy().to_string());
                }
            }
        }
    }
    tl
}

pub fn resolve_paths_relative(mut tl: TimelineState, project_path: &Path) -> TimelineState {
    let dir = project_path.parent().unwrap_or_else(|| Path::new("."));
    for c in tl.clips.iter_mut() {
        if let Some(sp) = c.source_path.clone() {
            let p = PathBuf::from(&sp);
            if !p.is_absolute() {
                let joined = dir.join(p);
                c.source_path = Some(joined.to_string_lossy().to_string());
            }
        }
    }
    tl
}
