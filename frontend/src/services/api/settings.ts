import { invoke } from "../invoke";

export interface UiSettings {
    autoCrossfade: boolean;
    gridSnap: boolean;
    gridSize?: string;
    pitchSnap: boolean;
    pitchSnapUnit: string;
    pitchSnapScale: string;
    playheadZoom: boolean;
    autoScroll: boolean;
    showClipboardPreview: boolean;
}

export const settingsApi = {
    getUiSettings: () => invoke<UiSettings>("get_ui_settings"),
    saveUiSettings: (settings: UiSettings) =>
        invoke<{ ok: boolean }>("save_ui_settings", { settings }),
};
