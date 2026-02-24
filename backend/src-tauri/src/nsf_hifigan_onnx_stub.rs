#[allow(dead_code)]
pub fn probe_load() {
    // ONNX feature disabled.
}

pub fn is_available() -> bool {
    false
}

pub fn infer_pitch_edit_mono(
    mono: &[f32],
    _sample_rate: u32,
    _start_sec: f64,
    _target_midi_at_time: impl Fn(f64) -> f64,
) -> Result<Vec<f32>, String> {
    // When ONNX is unavailable, behave as bypass (no pitch edit).
    Ok(mono.to_vec())
}
