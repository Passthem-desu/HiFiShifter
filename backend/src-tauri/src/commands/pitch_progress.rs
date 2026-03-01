use crate::pitch_analysis::PitchProgressPayload;
use crate::state::AppState;

/// Get current pitch analysis progress (Task 3.6)
pub(super) fn get_pitch_analysis_progress(
    state: tauri::State<AppState>,
) -> Result<Option<PitchProgressPayload>, String> {
    let progress = state.pitch_analysis_progress.read()
        .map_err(|e| format!("Failed to read progress: {}", e))?;
    
    Ok(progress.as_ref().map(|p| PitchProgressPayload::from(p)))
}
