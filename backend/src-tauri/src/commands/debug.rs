use crate::models::{DebugRealtimeRenderStatsPayload, RealtimeRenderStatsPayload};
use crate::state::AppState;
use tauri::State;

pub(super) fn debug_realtime_render_stats(
    state: State<'_, AppState>,
) -> DebugRealtimeRenderStatsPayload {
    let enabled = std::env::var("HIFISHIFTER_DEBUG_RENDER_STATS")
        .ok()
        .as_deref()
        == Some("1");

    if !enabled {
        return DebugRealtimeRenderStatsPayload {
            ok: true,
            enabled: false,
            stats: None,
        };
    }

    let s = state.audio_engine.realtime_render_stats_snapshot();
    DebugRealtimeRenderStatsPayload {
        ok: true,
        enabled: true,
        stats: Some(RealtimeRenderStatsPayload {
            callbacks_total: s.callbacks_total,
            callbacks_silenced_not_playing: s.callbacks_silenced_not_playing,

            pitch_callbacks_total: s.pitch_callbacks_total,
            pitch_callbacks_silenced_waiting: s.pitch_callbacks_silenced_waiting,
            pitch_callbacks_prime_waiting: s.pitch_callbacks_prime_waiting,
            pitch_callbacks_fallback_mixed: s.pitch_callbacks_fallback_mixed,

            base_callbacks_total: s.base_callbacks_total,
            base_callbacks_covered: s.base_callbacks_covered,
            base_callbacks_fallback_mixed: s.base_callbacks_fallback_mixed,

            legacy_callbacks_mixed: s.legacy_callbacks_mixed,
        }),
    }
}
