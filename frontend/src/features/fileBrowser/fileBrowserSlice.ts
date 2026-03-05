import {
    createSlice,
    createAsyncThunk,
    type PayloadAction,
} from "@reduxjs/toolkit";
import {
    fileBrowserApi,
    type FileEntry,
} from "../../services/api/fileBrowser";

interface FileBrowserState {
    visible: boolean;
    currentPath: string;
    entries: FileEntry[];
    loading: boolean;
    error: string | null;
    previewVolume: number; // 0~1
    previewingFile: string | null;
    searchQuery: string; // 搜索过滤关键词
}

const STORAGE_KEY = "hifishifter.fileBrowser.lastPath";

function getInitialPath(): string {
    return localStorage.getItem(STORAGE_KEY) || "";
}

const initialState: FileBrowserState = {
    visible: false,
    currentPath: getInitialPath(),
    entries: [],
    loading: false,
    error: null,
    previewVolume: 0.8,
    previewingFile: null,
    searchQuery: "",
};

export const loadDirectory = createAsyncThunk(
    "fileBrowser/loadDirectory",
    async (dirPath: string, { rejectWithValue }) => {
        try {
            const entries = await fileBrowserApi.listDirectory(dirPath);
            return { dirPath, entries };
        } catch (err) {
            return rejectWithValue(
                err instanceof Error ? err.message : "Failed to load directory",
            );
        }
    },
);

const fileBrowserSlice = createSlice({
    name: "fileBrowser",
    initialState,
    reducers: {
        toggleVisible(state) {
            state.visible = !state.visible;
        },
        setVisible(state, action: PayloadAction<boolean>) {
            state.visible = action.payload;
        },
        setPreviewVolume(state, action: PayloadAction<number>) {
            state.previewVolume = Math.max(0, Math.min(1, action.payload));
        },
        setPreviewingFile(state, action: PayloadAction<string | null>) {
            state.previewingFile = action.payload;
        },
        setSearchQuery(state, action: PayloadAction<string>) {
            state.searchQuery = action.payload;
        },
    },
    extraReducers: (builder) => {
        builder
            .addCase(loadDirectory.pending, (state) => {
                state.loading = true;
                state.error = null;
            })
            .addCase(loadDirectory.fulfilled, (state, action) => {
                state.loading = false;
                state.currentPath = action.payload.dirPath;
                state.entries = action.payload.entries;
                localStorage.setItem(STORAGE_KEY, action.payload.dirPath);
            })
            .addCase(loadDirectory.rejected, (state, action) => {
                state.loading = false;
                state.error = String(action.payload ?? "Unknown error");
            });
    },
});

export const {
    toggleVisible,
    setVisible,
    setPreviewVolume,
    setPreviewingFile,
    setSearchQuery,
} = fileBrowserSlice.actions;

export default fileBrowserSlice.reducer;
