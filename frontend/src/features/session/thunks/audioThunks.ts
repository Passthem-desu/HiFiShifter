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
