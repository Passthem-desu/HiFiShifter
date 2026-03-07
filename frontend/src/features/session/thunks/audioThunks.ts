import { createAsyncThunk } from "@reduxjs/toolkit";
import { webApi } from "../../../services/webviewApi";

export const processAudio = createAsyncThunk(
    "session/processAudio",
    async (audioPath: string) => {
        return webApi.processAudio(audioPath);
    },
);

export const pickOutputPath = createAsyncThunk(
    "session/pickOutputPath",
    async (_, { rejectWithValue }) => {
        const picked = await webApi.pickOutputPath();
        if (!picked.ok) {
            return rejectWithValue("pick_output_path_failed");
        }
        return picked;
    },
);

export const applyPitchShift = createAsyncThunk(
    "session/applyPitchShift",
    async (semitones: number) => {
        return webApi.setPitchShift(semitones);
    },
);

export const synthesizeAudio = createAsyncThunk(
    "session/synthesizeAudio",
    async () => {
        return webApi.synthesize();
    },
);

export const exportAudio = createAsyncThunk(
    "session/exportAudio",
    async (outputPath: string) => {
        return webApi.saveSynthesized(outputPath);
    },
);

export const exportSeparated = createAsyncThunk(
    "session/exportSeparated",
    async (outputDir: string) => {
        return webApi.saveSeparated(outputDir);
    },
);

export const pasteVocalShifterClipboard = createAsyncThunk(
    "session/pasteVocalShifterClipboard",
    async (_, { rejectWithValue }) => {
        const result = await webApi.pasteVocalShifterClipboard();
        if (!result?.ok) {
            return rejectWithValue(result?.error ?? "paste_vocalshifter_clipboard_failed");
        }
        return result;
    },
);

export const pasteReaperClipboard = createAsyncThunk(
    "session/pasteReaperClipboard",
    async (_, { rejectWithValue }) => {
        const result = await webApi.pasteReaperClipboard();
        if (!result?.ok) {
            return rejectWithValue(result?.error ?? "paste_reaper_clipboard_failed");
        }
        return {
            ok: true,
            timeline: result,
            skippedFiles: result.skipped_files as string[] | undefined,
        } as const;
    },
);
