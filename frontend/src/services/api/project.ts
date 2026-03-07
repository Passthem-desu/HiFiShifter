import type { TimelineResult } from "../../types/api";

import { invoke } from "../invoke";

export const projectApi = {
    // Project meta
    getProjectMeta: () =>
        invoke<{
            name: string;
            path?: string | null;
            dirty: boolean;
            recent: string[];
        }>("get_project_meta"),

    newProject: () => invoke<TimelineResult>("new_project"),

    openProjectDialog: () =>
        invoke<{ ok: boolean; canceled?: boolean; path?: string }>(
            "open_project_dialog",
        ),

    openProject: (projectPath: string) =>
        invoke<TimelineResult>("open_project", projectPath),

    saveProject: () => invoke<any>("save_project"),

    saveProjectAs: () => invoke<any>("save_project_as"),

    openVocalShifterDialog: () =>
        invoke<{ ok: boolean; canceled?: boolean; path?: string }>(
            "open_vocalshifter_dialog",
        ),

    importVocalShifterProject: (vspPath: string) =>
        invoke<TimelineResult & { error?: string; skipped_files?: string[] }>("import_vocalshifter_project", vspPath),

    openReaperDialog: () =>
        invoke<{ ok: boolean; canceled?: boolean; path?: string }>(
            "open_reaper_dialog",
        ),

    importReaperProject: (rppPath: string) =>
        invoke<TimelineResult & { error?: string; skipped_files?: string[] }>("import_reaper_project", rppPath),
};
