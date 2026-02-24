


pub(super) fn open_audio_dialog() -> serde_json::Value {
    let picked = rfd::FileDialog::new()
        .add_filter("Audio", &["wav", "flac", "mp3", "ogg", "m4a"])
        .pick_file();

    match picked {
        None => serde_json::json!({"ok": true, "canceled": true}),
        Some(path) => {
            serde_json::json!({"ok": true, "canceled": false, "path": path.display().to_string()})
        }
    }
}




pub(super) fn pick_output_path() -> serde_json::Value {
    let picked = rfd::FileDialog::new()
        .add_filter("WAV", &["wav"])
        .set_file_name("output.wav")
        .save_file();

    match picked {
        None => serde_json::json!({"ok": true, "canceled": true}),
        Some(path) => {
            serde_json::json!({"ok": true, "canceled": false, "path": path.display().to_string()})
        }
    }
}
