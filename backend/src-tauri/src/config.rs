use std::fs;
use std::path::Path;

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct AppConfig {
    #[serde(default)]
    recent: Vec<String>,
}

/// 从 config dir 读取最近工程列表；读取失败时返回空列表。
pub fn load_recent(config_dir: &Path) -> Vec<String> {
    let path = config_dir.join("app_config.json");
    let Ok(data) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(cfg) = serde_json::from_str::<AppConfig>(&data) else {
        return Vec::new();
    };
    cfg.recent
}

/// 将最近工程列表写入 config dir；写入失败时静默忽略。
pub fn save_recent(config_dir: &Path, recent: &[String]) {
    let path = config_dir.join("app_config.json");
    let cfg = AppConfig {
        recent: recent.to_vec(),
    };
    if let Ok(data) = serde_json::to_string_pretty(&cfg) {
        let _ = fs::write(&path, data);
    }
}
