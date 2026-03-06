import { createAsyncThunk } from "@reduxjs/toolkit";
import { webApi } from "../../../services/webviewApi";

export const undoRemote = createAsyncThunk("session/undoRemote", async () => {
    return webApi.undoTimeline();
});

export const redoRemote = createAsyncThunk("session/redoRemote", async () => {
    return webApi.redoTimeline();
});

export const newProjectRemote = createAsyncThunk(
    "session/newProjectRemote",
    async () => {
        return webApi.newProject();
    },
);

export const openProjectFromDialog = createAsyncThunk(
    "session/openProjectFromDialog",
    async (_, { rejectWithValue }) => {
        const picked = await webApi.openProjectDialog();
        if (!picked.ok) return rejectWithValue("open_project_dialog_failed");
        if (picked.canceled || !picked.path) {
            return { ok: true, canceled: true } as const;
        }
        const timeline = await webApi.openProject(picked.path);
        return { ok: true, canceled: false, timeline } as const;
    },
);

export const openProjectFromPath = createAsyncThunk(
    "session/openProjectFromPath",
    async (projectPath: string) => {
        const timeline = await webApi.openProject(projectPath);
        return timeline;
    },
);

export const saveProjectRemote = createAsyncThunk(
    "session/saveProjectRemote",
    async (_, { rejectWithValue, getState }) => {
        const state = getState() as any;
        const hasPath = Boolean(state?.session?.project?.path);

        const res = hasPath
            ? await webApi.saveProject()
            : await webApi.saveProjectAs();
        if (!res || res.ok === false) {
            return rejectWithValue(res?.error ?? "save_project_failed");
        }
        return res as any;
    },
);

export const saveProjectAsRemote = createAsyncThunk(
    "session/saveProjectAsRemote",
    async (_, { rejectWithValue }) => {
        const res = await webApi.saveProjectAs();
        if (!res || res.ok === false) {
            return rejectWithValue(res?.error ?? "save_project_as_failed");
        }
        return res as any;
    },
);

export const openVocalShifterFromDialog = createAsyncThunk(
    "session/openVocalShifterFromDialog",
    async (_, { rejectWithValue }) => {
        const picked = await webApi.openVocalShifterDialog();
        if (!picked.ok) return rejectWithValue("open_vocalshifter_dialog_failed");
        if (picked.canceled || !picked.path) {
            return { ok: true, canceled: true } as const;
        }
        const timeline = await webApi.importVocalShifterProject(picked.path);
        return { ok: true, canceled: false, timeline } as const;
    },
);
