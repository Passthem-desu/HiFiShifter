import { createAsyncThunk } from "@reduxjs/toolkit";
import { webApi } from "../../../services/webviewApi";
import { settingsApi } from "../../../services/api";

export const refreshRuntime = createAsyncThunk(
    "session/refreshRuntime",
    async () => {
        return webApi.getRuntimeInfo();
    },
);

export const clearWaveformCacheRemote = createAsyncThunk(
    "session/clearWaveformCacheRemote",
    async () => {
        return webApi.clearWaveformCache();
    },
);

export const loadUiSettings = createAsyncThunk(
    "session/loadUiSettings",
    async () => {
        return settingsApi.getUiSettings();
    },
);

/** Read current UI toggle state from Redux and persist to backend config. */
export const persistUiSettings = createAsyncThunk(
    "session/persistUiSettings",
    async (_, { getState }) => {
        const s = (getState() as { session: { autoCrossfadeEnabled: boolean; gridSnapEnabled: boolean; grid: string; pitchSnapEnabled: boolean; pitchSnapUnit: string; pitchSnapScale: string; playheadZoomEnabled: boolean; autoScrollEnabled: boolean; showClipboardPreview: boolean } }).session;
        return settingsApi.saveUiSettings({
            autoCrossfade: s.autoCrossfadeEnabled,
            gridSnap: s.gridSnapEnabled,
            gridSize: s.grid,
            pitchSnap: s.pitchSnapEnabled,
            pitchSnapUnit: s.pitchSnapUnit,
            pitchSnapScale: s.pitchSnapScale,
            playheadZoom: s.playheadZoomEnabled,
            autoScroll: s.autoScrollEnabled,
            showClipboardPreview: s.showClipboardPreview,
        });
    },
);
