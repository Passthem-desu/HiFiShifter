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
};
