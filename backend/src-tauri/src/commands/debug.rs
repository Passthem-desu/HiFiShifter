use crate::models::DebugRealtimeRenderStatsPayload;
use crate::state::AppState;
use tauri::State;

pub(super) fn debug_realtime_render_stats(
    _state: State<'_, AppState>,
) -> DebugRealtimeRenderStatsPayload {
    // 实时流式合成已移除，realtime stats 不再可用
    DebugRealtimeRenderStatsPayload {
        ok: true,
        enabled: false,
        stats: None,
    }
}
