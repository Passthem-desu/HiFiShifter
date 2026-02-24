import { createAsyncThunk } from "@reduxjs/toolkit";
import { webApi } from "../../../services/webviewApi";

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
