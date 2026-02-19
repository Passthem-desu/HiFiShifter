import {
    createAsyncThunk,
    createSlice,
    type PayloadAction,
} from "@reduxjs/toolkit";
import { webApi } from "../../services/webviewApi";
import type {
    TimelineClip,
    TimelineState,
    TrackSummaryResult,
} from "../../types/api";

export type ToolMode = "draw" | "select";
export type EditParam = "pitch" | "tension" | "breath";
export type GridSize = "1/4" | "1/8" | "1/16" | "1/32";

export interface TrackInfo {
    id: string;
    name: string;
    parentId?: string | null;
    depth?: number;
    childTrackIds?: string[];
    muted: boolean;
    solo: boolean;
    volume: number;
}

export interface ClipInfo {
    id: string;
    trackId: string;
    name: string;
    startBeat: number;
    lengthBeats: number;
    color: "blue" | "violet" | "emerald" | "amber";
    sourcePath?: string;
    durationSec?: number;
    gain: number;
    muted: boolean;
    trimStartBeat: number;
    trimEndBeat: number;
    playbackRate: number;
    fadeInBeats: number;
    fadeOutBeats: number;
}

type ClipColor = ClipInfo["color"];

export interface AutomationPoint {
    id: string;
    beat: number;
    value: number;
}

type WaveformPreview = number[] | { l: number[]; r: number[] };

interface SessionState {
    toolMode: ToolMode;
    editParam: EditParam;
    bpm: number;
    beats: number;
    projectBeats: number;
    grid: GridSize;

    playheadBeat: number;
    tracks: TrackInfo[];
    clips: ClipInfo[];
    selectedTrackId: string | null;
    selectedClipId: string | null;
    clipAutomation: Record<
        string,
        {
            pitch: AutomationPoint[];
            tension: AutomationPoint[];
            breath: AutomationPoint[];
        }
    >;
    selectedPointId: string | null;
    clipWaveforms: Record<string, WaveformPreview>;
    clipPitchRanges: Record<string, { min: number; max: number }>;

    modelDir: string;
    audioPath: string;
    outputPath: string;
    pitchShift: number;
    playbackClipId: string | null;
    playbackAnchorBeat: number;

    runtime: {
        device: string;
        modelLoaded: boolean;
        audioLoaded: boolean;
        hasSynthesized: boolean;
        isPlaying: boolean;
        playbackTarget: string | null;
        playbackPositionSec: number;
        playbackDurationSec: number;
    };

    selectedTrackSummary: {
        trackId: string | null;
        clipCount: number;
        waveformPreview: number[];
        pitchRange: { min: number; max: number };
    };

    historyPast: StateSnapshot[];
    historyFuture: StateSnapshot[];

    busy: boolean;
    status: string;
    error?: string;
    lastResult?: unknown;
}

interface StateSnapshot {
    clips: ClipInfo[];
    clipAutomation: SessionState["clipAutomation"];
    selectedTrackId: string | null;
    selectedClipId: string | null;
    selectedPointId: string | null;
    playheadBeat: number;
    clipWaveforms: Record<string, WaveformPreview>;
    clipPitchRanges: Record<string, { min: number; max: number }>;
}

function clamp(value: number, minValue: number, maxValue: number): number {
    return Math.min(maxValue, Math.max(minValue, value));
}

function createId(prefix: string): string {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function createDefaultAutomation() {
    return {
        pitch: [
            { id: createId("pt_p"), beat: 0, value: 0 },
            { id: createId("pt_p"), beat: 3, value: 1.5 },
            { id: createId("pt_p"), beat: 7, value: -0.8 },
            { id: createId("pt_p"), beat: 12, value: 0.3 },
        ],
        tension: [
            { id: createId("pt_t"), beat: 0, value: 0.2 },
            { id: createId("pt_t"), beat: 4, value: 0.72 },
            { id: createId("pt_t"), beat: 8, value: 0.42 },
            { id: createId("pt_t"), beat: 12, value: 0.6 },
        ],
        breath: [
            { id: createId("pt_b"), beat: 0, value: 0.1 },
            { id: createId("pt_b"), beat: 4, value: 0.18 },
            { id: createId("pt_b"), beat: 8, value: 0.12 },
            { id: createId("pt_b"), beat: 12, value: 0.2 },
        ],
    };
}

function basenameFromPath(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? "Audio.wav";
}

function ensureClipAutomation(state: SessionState, clipId: string) {
    if (!state.clipAutomation[clipId]) {
        state.clipAutomation[clipId] = createDefaultAutomation();
    }
}

function createSnapshot(state: SessionState): StateSnapshot {
    return {
        clips: state.clips.map((clip) => ({ ...clip })),
        clipAutomation: JSON.parse(
            JSON.stringify(state.clipAutomation),
        ) as SessionState["clipAutomation"],
        selectedTrackId: state.selectedTrackId,
        selectedClipId: state.selectedClipId,
        selectedPointId: state.selectedPointId,
        playheadBeat: state.playheadBeat,
        clipWaveforms: JSON.parse(
            JSON.stringify(state.clipWaveforms),
        ) as Record<string, WaveformPreview>,
        clipPitchRanges: JSON.parse(
            JSON.stringify(state.clipPitchRanges),
        ) as Record<string, { min: number; max: number }>,
    };
}

function applySnapshot(state: SessionState, snapshot: StateSnapshot) {
    state.clips = snapshot.clips.map((clip) => ({ ...clip }));
    state.clipAutomation = JSON.parse(
        JSON.stringify(snapshot.clipAutomation),
    ) as SessionState["clipAutomation"];
    state.selectedTrackId = snapshot.selectedTrackId;
    state.selectedClipId = snapshot.selectedClipId;
    state.selectedPointId = snapshot.selectedPointId;
    state.playheadBeat = snapshot.playheadBeat;
    state.clipWaveforms = JSON.parse(
        JSON.stringify(snapshot.clipWaveforms),
    ) as Record<string, WaveformPreview>;
    state.clipPitchRanges = JSON.parse(
        JSON.stringify(snapshot.clipPitchRanges),
    ) as Record<string, { min: number; max: number }>;
}

function pushHistory(state: SessionState) {
    state.historyPast.push(createSnapshot(state));
    if (state.historyPast.length > 40) {
        state.historyPast.shift();
    }
    state.historyFuture = [];
}

function normalizeClipColor(color: string | undefined): ClipColor {
    if (color === "blue") return "blue";
    if (color === "violet") return "violet";
    if (color === "amber") return "amber";
    return "emerald";
}

function applyTimelineState(state: SessionState, timeline: TimelineState) {
    state.tracks = timeline.tracks.map((track) => ({
        id: track.id,
        name: track.name,
        parentId: track.parent_id ?? null,
        depth: track.depth ?? 0,
        childTrackIds: track.child_track_ids ?? [],
        muted: Boolean(track.muted),
        solo: Boolean(track.solo),
        volume: clamp(Number(track.volume ?? 0.9), 0, 1),
    }));

    state.clips = timeline.clips.map((clip: TimelineClip) => ({
        id: clip.id,
        trackId: clip.track_id,
        name: clip.name,
        startBeat: Number(clip.start_beat ?? 0),
        lengthBeats: Math.max(0.0, Number(clip.length_beats ?? 1)),
        color: normalizeClipColor(clip.color),
        sourcePath: clip.source_path,
        durationSec: Number(clip.duration_sec ?? 0) || undefined,
        gain: clamp(Number(clip.gain ?? 1), 0, 2),
        muted: Boolean(clip.muted),
        trimStartBeat: Math.max(0, Number(clip.trim_start_beat ?? 0)),
        trimEndBeat: Math.max(0, Number(clip.trim_end_beat ?? 0)),
        playbackRate: clamp(Number(clip.playback_rate ?? 1), 0.25, 4),
        fadeInBeats: Math.max(0, Number(clip.fade_in_beats ?? 0)),
        fadeOutBeats: Math.max(0, Number(clip.fade_out_beats ?? 0)),
    }));

    state.selectedTrackId = timeline.selected_track_id;
    state.selectedClipId = timeline.selected_clip_id;
    state.bpm = clamp(Number(timeline.bpm ?? state.bpm), 10, 300);
    state.playheadBeat = Math.max(0, Number(timeline.playhead_beat ?? 0));
    state.projectBeats = Math.max(
        4,
        Number(timeline.project_beats ?? state.projectBeats),
    );

    const availableClipIds = new Set(state.clips.map((clip) => clip.id));
    for (const clipId of Object.keys(state.clipAutomation)) {
        if (!availableClipIds.has(clipId)) {
            delete state.clipAutomation[clipId];
        }
    }

    const nextWaveforms: Record<string, WaveformPreview> = {};
    const nextPitchRanges: Record<string, { min: number; max: number }> = {};
    for (const clip of timeline.clips) {
        const clipId = clip.id;
        nextWaveforms[clipId] = (clip.waveform_preview ??
            []) as WaveformPreview;
        nextPitchRanges[clipId] = clip.pitch_range ?? { min: -24, max: 24 };
        ensureClipAutomation(state, clipId);
    }
    state.clipWaveforms = nextWaveforms;
    state.clipPitchRanges = nextPitchRanges;
}

function upsertImportedClip(
    state: SessionState,
    audioPath: string,
    meta?: {
        durationSec?: number;
        waveform?: number[];
        pitchRange?: { min: number; max: number };
    },
) {
    const existing = state.clips.find((clip) => clip.sourcePath === audioPath);
    if (existing) {
        state.selectedClipId = existing.id;
        ensureClipAutomation(state, existing.id);
        if (meta?.waveform) {
            state.clipWaveforms[existing.id] = meta.waveform;
        }
        if (meta?.pitchRange) {
            state.clipPitchRanges[existing.id] = meta.pitchRange;
        }
        return;
    }

    const targetTrackId = state.tracks[0]?.id ?? "track_imported";
    if (!state.tracks[0]) {
        state.tracks.push({
            id: targetTrackId,
            name: "Imported",
            muted: false,
            solo: false,
            volume: 0.9,
        });
    }

    const maxEndBeat = state.clips.reduce(
        (maxBeat, clip) => Math.max(maxBeat, clip.startBeat + clip.lengthBeats),
        0,
    );
    const startBeat = Math.max(0, Math.ceil(maxEndBeat));
    const newClipId = createId("clip");
    const lengthBeats = Math.max(
        1,
        meta?.durationSec ? (meta.durationSec * state.bpm) / 60 : 8,
    );
    state.clips.push({
        id: newClipId,
        trackId: targetTrackId,
        name: basenameFromPath(audioPath),
        startBeat,
        lengthBeats,
        color: "emerald",
        sourcePath: audioPath,
        durationSec: meta?.durationSec,
        gain: 1,
        muted: false,
        trimStartBeat: 0,
        trimEndBeat: 0,
        playbackRate: 1,
        fadeInBeats: 0,
        fadeOutBeats: 0,
    });
    state.selectedClipId = newClipId;
    state.playheadBeat = startBeat;
    state.selectedPointId = null;
    ensureClipAutomation(state, newClipId);
    state.clipWaveforms[newClipId] = meta?.waveform ?? [];
    state.clipPitchRanges[newClipId] = meta?.pitchRange ?? {
        min: -24,
        max: 24,
    };
}

const initialState: SessionState = {
    toolMode: "draw",
    editParam: "pitch",
    bpm: 120,
    beats: 4,
    projectBeats: 64,
    grid: "1/4",

    playheadBeat: 0,
    tracks: [
        {
            id: "track_main",
            name: "Main",
            muted: false,
            solo: false,
            volume: 0.9,
        },
    ],
    clips: [],
    selectedTrackId: "track_main",
    selectedClipId: null,
    clipAutomation: {},
    selectedPointId: null,
    clipWaveforms: {},
    clipPitchRanges: {},

    modelDir: "pc_nsf_hifigan_44.1k_hop512_128bin_2025.02",
    audioPath: "",
    outputPath: "outputs/webview_synth.wav",
    pitchShift: 0,
    playbackClipId: null,
    playbackAnchorBeat: 0,

    runtime: {
        device: "unknown",
        modelLoaded: false,
        audioLoaded: false,
        hasSynthesized: false,
        isPlaying: false,
        playbackTarget: null,
        playbackPositionSec: 0,
        playbackDurationSec: 0,
    },

    selectedTrackSummary: {
        trackId: null,
        clipCount: 0,
        waveformPreview: [],
        pitchRange: { min: -24, max: 24 },
    },

    historyPast: [],
    historyFuture: [],

    busy: false,
    status: "Ready",
};

export const fetchTimeline = createAsyncThunk(
    "session/fetchTimeline",
    async () => {
        return webApi.getTimelineState();
    },
);

export const seekPlayhead = createAsyncThunk(
    "session/seekPlayhead",
    async (beat: number) => {
        return webApi.setTransport({ playheadBeat: beat });
    },
);

export const updateTransportBpm = createAsyncThunk(
    "session/updateTransportBpm",
    async (bpm: number) => {
        return webApi.setTransport({ bpm });
    },
);

export const addTrackRemote = createAsyncThunk(
    "session/addTrackRemote",
    async (payload: { name?: string; parentTrackId?: string | null }) => {
        return webApi.addTrackNested(payload);
    },
);

export const removeTrackRemote = createAsyncThunk(
    "session/removeTrackRemote",
    async (trackId: string) => {
        return webApi.removeTrack(trackId);
    },
);

export const moveTrackRemote = createAsyncThunk(
    "session/moveTrackRemote",
    async (payload: {
        trackId: string;
        targetIndex: number;
        parentTrackId?: string | null;
    }) => {
        return webApi.moveTrack(payload);
    },
);

export const selectTrackRemote = createAsyncThunk(
    "session/selectTrackRemote",
    async (trackId: string) => {
        return webApi.selectTrack(trackId);
    },
);

export const setProjectLengthRemote = createAsyncThunk(
    "session/setProjectLengthRemote",
    async (projectBeats: number) => {
        return webApi.setProjectLength(projectBeats);
    },
);

export const fetchSelectedTrackSummary = createAsyncThunk(
    "session/fetchSelectedTrackSummary",
    async (_, { getState }) => {
        const state = getState() as { session: SessionState };
        return webApi.getTrackSummary(
            state.session.selectedTrackId ?? undefined,
        );
    },
);

export const addClipOnTrack = createAsyncThunk(
    "session/addClipOnTrack",
    async (payload: { trackId?: string }) => {
        return webApi.addClip({ trackId: payload.trackId });
    },
);

export const removeClipRemote = createAsyncThunk(
    "session/removeClipRemote",
    async (clipId: string) => {
        return webApi.removeClip(clipId);
    },
);

export const moveClipRemote = createAsyncThunk(
    "session/moveClipRemote",
    async (payload: {
        clipId: string;
        startBeat: number;
        trackId?: string;
    }) => {
        return webApi.moveClip(payload);
    },
);

export const setClipStateRemote = createAsyncThunk(
    "session/setClipStateRemote",
    async (payload: {
        clipId: string;
        lengthBeats?: number;
        gain?: number;
        muted?: boolean;
        trimStartBeat?: number;
        trimEndBeat?: number;
        playbackRate?: number;
        fadeInBeats?: number;
        fadeOutBeats?: number;
    }) => {
        return webApi.setClipState(payload);
    },
);

export const splitClipRemote = createAsyncThunk(
    "session/splitClipRemote",
    async (payload: { clipId: string; splitBeat: number }) => {
        return webApi.splitClip(payload.clipId, payload.splitBeat);
    },
);

export const glueClipsRemote = createAsyncThunk(
    "session/glueClipsRemote",
    async (clipIds: string[]) => {
        return webApi.glueClips(clipIds);
    },
);

export const selectClipRemote = createAsyncThunk(
    "session/selectClipRemote",
    async (clipId: string | null) => {
        return webApi.selectClip(clipId);
    },
);

export const setTrackStateRemote = createAsyncThunk(
    "session/setTrackStateRemote",
    async (payload: {
        trackId: string;
        muted?: boolean;
        solo?: boolean;
        volume?: number;
    }) => {
        return webApi.setTrackState(payload);
    },
);

export const removeSelectedClipRemote = createAsyncThunk(
    "session/removeSelectedClipRemote",
    async (_, { getState, rejectWithValue }) => {
        const state = getState() as { session: SessionState };
        const selectedClipId = state.session.selectedClipId;
        if (!selectedClipId) {
            return rejectWithValue("no_selected_clip");
        }
        return webApi.removeClip(selectedClipId);
    },
);

export const refreshRuntime = createAsyncThunk(
    "session/refreshRuntime",
    async () => {
        return webApi.getRuntimeInfo();
    },
);

export const loadModel = createAsyncThunk(
    "session/loadModel",
    async (modelDir: string) => {
        return webApi.loadModel(modelDir);
    },
);

export const loadDefaultModel = createAsyncThunk(
    "session/loadDefaultModel",
    async () => {
        return webApi.loadDefaultModel();
    },
);

export const syncPlaybackState = createAsyncThunk(
    "session/syncPlaybackState",
    async () => {
        return webApi.getPlaybackState();
    },
);

export const processAudio = createAsyncThunk(
    "session/processAudio",
    async (audioPath: string) => {
        return webApi.processAudio(audioPath);
    },
);

export const importAudioFromDialog = createAsyncThunk(
    "session/importAudioFromDialog",
    async (_, { dispatch, rejectWithValue }) => {
        const picked = await webApi.openAudioDialog();
        if (!picked.ok) {
            return rejectWithValue("open_audio_dialog_failed");
        }
        if (picked.canceled || !picked.path) {
            return { ok: true, canceled: true };
        }

        dispatch(setAudioPath(picked.path));
        const imported = await webApi.importAudioItem(picked.path);
        if (!(imported as { ok?: boolean }).ok) {
            return rejectWithValue(
                (imported as { error?: { message?: string } }).error?.message ??
                    "import_audio_item_failed",
            );
        }
        return {
            ok: true,
            canceled: false,
            path: picked.path,
            imported,
        };
    },
);

export const importAudioFromPath = createAsyncThunk(
    "session/importAudioFromPath",
    async (audioPath: string, { dispatch, rejectWithValue }) => {
        dispatch(setAudioPath(audioPath));
        const imported = await webApi.importAudioItem(audioPath);
        if (!(imported as { ok?: boolean }).ok) {
            return rejectWithValue(
                (imported as { error?: { message?: string } }).error?.message ??
                    "import_audio_item_failed",
            );
        }
        return {
            ok: true,
            path: audioPath,
            imported,
        };
    },
);

export const importAudioAtPosition = createAsyncThunk(
    "session/importAudioAtPosition",
    async (
        payload: { audioPath: string; trackId?: string; startBeat?: number },
        { dispatch, rejectWithValue },
    ) => {
        dispatch(setAudioPath(payload.audioPath));
        const imported = await webApi.importAudioItem(
            payload.audioPath,
            payload.trackId,
            payload.startBeat,
        );
        if (!(imported as { ok?: boolean }).ok) {
            return rejectWithValue(
                (imported as { error?: { message?: string } }).error?.message ??
                    "import_audio_item_failed",
            );
        }
        return {
            ok: true,
            imported,
        };
    },
);

export const importAudioFileAtPosition = createAsyncThunk(
    "session/importAudioFileAtPosition",
    async (
        payload: { file: File; trackId?: string; startBeat?: number },
        { rejectWithValue },
    ) => {
        try {
            const fileName = String(payload.file.name ?? "dropped-audio");
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = () => reject(new Error("read_failed"));
                reader.onload = () => resolve(String(reader.result ?? ""));
                reader.readAsDataURL(payload.file);
            });

            const base64 = dataUrl.includes(",")
                ? dataUrl.split(",").slice(1).join(",")
                : dataUrl;

            const imported = await webApi.importAudioBytes(
                fileName,
                base64,
                payload.trackId,
                payload.startBeat,
            );
            if (!(imported as { ok?: boolean }).ok) {
                return rejectWithValue(
                    (imported as { error?: { message?: string } }).error
                        ?.message ?? "import_audio_bytes_failed",
                );
            }
            return {
                ok: true,
                imported,
            };
        } catch (err) {
            return rejectWithValue(
                err instanceof Error ? err.message : "import_audio_bytes_failed",
            );
        }
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

export const playOriginal = createAsyncThunk(
    "session/playOriginal",
    async (_, { getState }) => {
        const state = getState() as { session: SessionState };
        const anchorBeat = state.session.playheadBeat;
        const result = await webApi.playOriginal(0);
        return {
            ...result,
            clipId: null,
            anchorBeat,
        };
    },
);

export const playSynthesized = createAsyncThunk(
    "session/playSynthesized",
    async (_, { getState }) => {
        const state = getState() as { session: SessionState };
        const anchorBeat = state.session.playheadBeat;
        const result = await webApi.playSynthesized(0);
        return {
            ...result,
            clipId: null,
            anchorBeat,
        };
    },
);

export const stopAudioPlayback = createAsyncThunk(
    "session/stopAudioPlayback",
    async () => {
        return webApi.stopAudio();
    },
);

const sessionSlice = createSlice({
    name: "session",
    initialState,
    reducers: {
        setToolMode(state, action: PayloadAction<ToolMode>) {
            if (state.toolMode !== action.payload) {
                pushHistory(state);
            }
            state.toolMode = action.payload;
        },
        setEditParam(state, action: PayloadAction<EditParam>) {
            state.editParam = action.payload;
            state.selectedPointId = null;
        },
        setBpm(state, action: PayloadAction<number>) {
            state.bpm = clamp(action.payload, 10, 300);
        },
        setBeats(state, action: PayloadAction<number>) {
            state.beats = clamp(action.payload, 1, 32);
        },
        setGrid(state, action: PayloadAction<GridSize>) {
            state.grid = action.payload;
        },
        setPlayheadBeat(state, action: PayloadAction<number>) {
            state.playheadBeat = Math.max(0, action.payload);
        },
        setModelDir(state, action: PayloadAction<string>) {
            state.modelDir = action.payload;
        },
        setAudioPath(state, action: PayloadAction<string>) {
            state.audioPath = action.payload;
        },
        setOutputPath(state, action: PayloadAction<string>) {
            state.outputPath = action.payload;
        },
        setPitchShift(state, action: PayloadAction<number>) {
            state.pitchShift = action.payload;
        },
        setSelectedClip(state, action: PayloadAction<string | null>) {
            state.selectedClipId = action.payload;
            state.selectedPointId = null;
            if (action.payload) {
                const selectedClip = state.clips.find(
                    (clip) => clip.id === action.payload,
                );
                state.selectedTrackId =
                    selectedClip?.trackId ?? state.selectedTrackId;
                ensureClipAutomation(state, action.payload);
            }
        },
        moveClipStart(
            state,
            action: PayloadAction<{ clipId: string; startBeat: number }>,
        ) {
            const clip = state.clips.find(
                (entry) => entry.id === action.payload.clipId,
            );
            if (clip) {
                clip.startBeat = Math.max(0, action.payload.startBeat);
            }
        },
        moveClipTrack(
            state,
            action: PayloadAction<{ clipId: string; trackId: string }>,
        ) {
            const clip = state.clips.find(
                (entry) => entry.id === action.payload.clipId,
            );
            if (clip) {
                clip.trackId = action.payload.trackId;
            }
        },
        setClipLength(
            state,
            action: PayloadAction<{ clipId: string; lengthBeats: number }>,
        ) {
            const clip = state.clips.find(
                (entry) => entry.id === action.payload.clipId,
            );
            if (clip) {
                clip.lengthBeats = Math.max(0.0, action.payload.lengthBeats);
            }
        },
        setClipTrim(
            state,
            action: PayloadAction<{
                clipId: string;
                trimStartBeat?: number;
                trimEndBeat?: number;
            }>,
        ) {
            const clip = state.clips.find(
                (entry) => entry.id === action.payload.clipId,
            );
            if (!clip) return;
            if (action.payload.trimStartBeat !== undefined) {
                clip.trimStartBeat = Math.max(0, action.payload.trimStartBeat);
            }
            if (action.payload.trimEndBeat !== undefined) {
                clip.trimEndBeat = Math.max(0, action.payload.trimEndBeat);
            }
        },
        setClipFades(
            state,
            action: PayloadAction<{
                clipId: string;
                fadeInBeats?: number;
                fadeOutBeats?: number;
            }>,
        ) {
            const clip = state.clips.find(
                (entry) => entry.id === action.payload.clipId,
            );
            if (!clip) return;
            if (action.payload.fadeInBeats !== undefined) {
                clip.fadeInBeats = Math.max(0, action.payload.fadeInBeats);
            }
            if (action.payload.fadeOutBeats !== undefined) {
                clip.fadeOutBeats = Math.max(0, action.payload.fadeOutBeats);
            }
        },
        setClipGain(
            state,
            action: PayloadAction<{ clipId: string; gain: number }>,
        ) {
            const clip = state.clips.find(
                (entry) => entry.id === action.payload.clipId,
            );
            if (!clip) return;
            clip.gain = clamp(Number(action.payload.gain), 0, 2);
        },
        setClipMuted(
            state,
            action: PayloadAction<{ clipId: string; muted: boolean }>,
        ) {
            const clip = state.clips.find(
                (entry) => entry.id === action.payload.clipId,
            );
            if (!clip) return;
            clip.muted = Boolean(action.payload.muted);
        },
        addClip(state, action: PayloadAction<{ trackId: string }>) {
            pushHistory(state);
            const newClipId = createId("clip");
            state.clips.push({
                id: newClipId,
                trackId: action.payload.trackId,
                name: "New Clip.wav",
                startBeat: Math.max(0, state.playheadBeat),
                lengthBeats: 2,
                color: "emerald",
                gain: 1,
                muted: false,
                trimStartBeat: 0,
                trimEndBeat: 0,
                playbackRate: 1,
                fadeInBeats: 0,
                fadeOutBeats: 0,
            });
            state.selectedClipId = newClipId;
            state.selectedTrackId = action.payload.trackId;
            ensureClipAutomation(state, newClipId);
            state.clipWaveforms[newClipId] = [];
            state.clipPitchRanges[newClipId] = { min: -24, max: 24 };
        },
        removeSelectedClip(state) {
            const selectedId = state.selectedClipId;
            if (!selectedId) {
                return;
            }
            pushHistory(state);
            state.clips = state.clips.filter((clip) => clip.id !== selectedId);
            delete state.clipAutomation[selectedId];
            delete state.clipWaveforms[selectedId];
            delete state.clipPitchRanges[selectedId];
            state.selectedPointId = null;
            state.selectedClipId = state.clips[0]?.id ?? null;
            if (state.selectedClipId) {
                ensureClipAutomation(state, state.selectedClipId);
            }
        },
        toggleTrackMute(state, action: PayloadAction<string>) {
            const track = state.tracks.find(
                (entry) => entry.id === action.payload,
            );
            if (track) {
                track.muted = !track.muted;
            }
        },
        toggleTrackSolo(state, action: PayloadAction<string>) {
            const track = state.tracks.find(
                (entry) => entry.id === action.payload,
            );
            if (track) {
                track.solo = !track.solo;
            }
        },
        setTrackVolume(
            state,
            action: PayloadAction<{ trackId: string; volume: number }>,
        ) {
            const track = state.tracks.find(
                (entry) => entry.id === action.payload.trackId,
            );
            if (track) {
                track.volume = clamp(action.payload.volume, 0, 1);
            }
        },
        addAutomationPoint(
            state,
            action: PayloadAction<{
                param: EditParam;
                beat: number;
                value: number;
            }>,
        ) {
            const clipId = state.selectedClipId;
            if (!clipId) {
                return;
            }
            pushHistory(state);
            ensureClipAutomation(state, clipId);
            const target = state.clipAutomation[clipId][action.payload.param];
            target.push({
                id: createId("pt"),
                beat: Math.max(0, action.payload.beat),
                value: action.payload.value,
            });
            target.sort((left, right) => left.beat - right.beat);
        },
        moveAutomationPoint(
            state,
            action: PayloadAction<{
                param: EditParam;
                pointId: string;
                beat: number;
                value: number;
            }>,
        ) {
            const clipId = state.selectedClipId;
            if (!clipId) {
                return;
            }
            pushHistory(state);
            ensureClipAutomation(state, clipId);
            const target = state.clipAutomation[clipId][action.payload.param];
            const point = target.find(
                (entry) => entry.id === action.payload.pointId,
            );
            if (point) {
                point.beat = Math.max(0, action.payload.beat);
                point.value = action.payload.value;
                target.sort((left, right) => left.beat - right.beat);
            }
        },
        setSelectedPoint(state, action: PayloadAction<string | null>) {
            state.selectedPointId = action.payload;
        },
        removeAutomationPoint(
            state,
            action: PayloadAction<{ param: EditParam; pointId: string }>,
        ) {
            const clipId = state.selectedClipId;
            if (!clipId) {
                return;
            }
            pushHistory(state);
            ensureClipAutomation(state, clipId);
            const target = state.clipAutomation[clipId][action.payload.param];
            state.clipAutomation[clipId][action.payload.param] = target.filter(
                (entry) => entry.id !== action.payload.pointId,
            );
            if (state.selectedPointId === action.payload.pointId) {
                state.selectedPointId = null;
            }
        },
        undo(state) {
            const snapshot = state.historyPast.pop();
            if (!snapshot) {
                return;
            }
            state.historyFuture.push(createSnapshot(state));
            applySnapshot(state, snapshot);
        },
        redo(state) {
            const snapshot = state.historyFuture.pop();
            if (!snapshot) {
                return;
            }
            state.historyPast.push(createSnapshot(state));
            applySnapshot(state, snapshot);
        },
    },
    extraReducers: (builder) => {
        const setPending = (state: SessionState, label: string) => {
            state.busy = true;
            state.status = label;
            state.error = undefined;
        };
        const setRejected = (
            state: SessionState,
            action: { error?: { message?: string } },
        ) => {
            state.busy = false;
            state.error = action.error?.message ?? "Request failed";
            state.status = "Failed";
        };

        builder
            .addCase(refreshRuntime.pending, (state) =>
                setPending(state, "Refreshing runtime..."),
            )
            .addCase(refreshRuntime.fulfilled, (state, action) => {
                state.busy = false;
                if ((action.payload as { ok?: boolean }).ok) {
                    const payload = action.payload as {
                        device: string;
                        model_loaded: boolean;
                        audio_loaded: boolean;
                        has_synthesized: boolean;
                        is_playing?: boolean;
                        playback_target?: string | null;
                        timeline?: TimelineState;
                    };
                    state.runtime = {
                        device: payload.device,
                        modelLoaded: payload.model_loaded,
                        audioLoaded: payload.audio_loaded,
                        hasSynthesized: payload.has_synthesized,
                        isPlaying: payload.is_playing ?? false,
                        playbackTarget: payload.playback_target ?? null,
                        playbackPositionSec: state.runtime.playbackPositionSec,
                        playbackDurationSec: state.runtime.playbackDurationSec,
                    };
                    if (payload.timeline) {
                        applyTimelineState(state, payload.timeline);
                    }
                    state.status = "Runtime updated";
                } else {
                    state.status = "Runtime update failed";
                }
                state.lastResult = action.payload;
            })
            .addCase(refreshRuntime.rejected, setRejected)

            .addCase(loadDefaultModel.pending, (state) =>
                setPending(state, "Loading default model..."),
            )
            .addCase(loadDefaultModel.fulfilled, (state, action) => {
                state.busy = false;
                state.lastResult = action.payload;
                state.status = (action.payload as { ok?: boolean }).ok
                    ? "Default model loaded"
                    : "Load default model failed";
            })
            .addCase(loadDefaultModel.rejected, setRejected)

            .addCase(loadModel.pending, (state) =>
                setPending(state, "Loading model..."),
            )
            .addCase(loadModel.fulfilled, (state, action) => {
                state.busy = false;
                state.lastResult = action.payload;
                state.status = (action.payload as { ok?: boolean }).ok
                    ? "Model loaded"
                    : "Load model failed";
            })
            .addCase(loadModel.rejected, setRejected)

            .addCase(processAudio.pending, (state) =>
                setPending(state, "Processing audio..."),
            )
            .addCase(processAudio.fulfilled, (state, action) => {
                state.busy = false;
                state.lastResult = action.payload;
                const payload = action.payload as {
                    ok?: boolean;
                    audio?: { path?: string; duration_sec?: number };
                    feature?: {
                        waveform_preview?: number[];
                        pitch_range?: { min: number; max: number };
                    };
                    timeline?: TimelineState;
                };
                if (payload.ok && payload.audio?.path) {
                    state.audioPath = payload.audio.path;
                    if (payload.timeline) {
                        applyTimelineState(state, payload.timeline);
                    } else {
                        upsertImportedClip(state, payload.audio.path, {
                            durationSec: payload.audio.duration_sec,
                            waveform: payload.feature?.waveform_preview,
                            pitchRange: payload.feature?.pitch_range,
                        });
                    }
                }
                state.status = payload.ok
                    ? "Audio processed"
                    : "Process audio failed";
            })
            .addCase(processAudio.rejected, setRejected)

            .addCase(importAudioFromDialog.pending, (state) =>
                setPending(state, "Importing audio..."),
            )
            .addCase(importAudioFromDialog.fulfilled, (state, action) => {
                state.busy = false;
                state.lastResult = action.payload;
                const payload = action.payload as {
                    canceled?: boolean;
                    path?: string;
                    imported?: { ok?: boolean } & TimelineState;
                };
                if (payload.canceled) {
                    state.status = "Import canceled";
                    return;
                }
                if (payload.path) {
                    state.audioPath = payload.path;
                    if (payload.imported?.ok) {
                        applyTimelineState(state, payload.imported);
                    }
                }
                state.status = payload.imported?.ok
                    ? "Audio imported"
                    : "Import audio failed";
            })
            .addCase(importAudioFromDialog.rejected, setRejected)

            .addCase(importAudioFromPath.pending, (state) =>
                setPending(state, "Importing dropped audio..."),
            )
            .addCase(importAudioFromPath.fulfilled, (state, action) => {
                state.busy = false;
                state.lastResult = action.payload;
                const payload = action.payload as {
                    path?: string;
                    imported?: { ok?: boolean } & TimelineState;
                };
                if (payload.path) {
                    state.audioPath = payload.path;
                    if (payload.imported?.ok) {
                        applyTimelineState(state, payload.imported);
                    }
                }
                state.status = payload.imported?.ok
                    ? "Dropped audio imported"
                    : "Import audio failed";
            })
            .addCase(importAudioFromPath.rejected, setRejected)

            .addCase(importAudioAtPosition.pending, (state) =>
                setPending(state, "Importing audio..."),
            )
            .addCase(importAudioAtPosition.fulfilled, (state, action) => {
                state.busy = false;
                state.lastResult = action.payload;
                const payload = action.payload as {
                    ok?: boolean;
                    imported?: TimelineState;
                };
                const ok = Boolean(payload.ok);
                state.status = ok ? "Import done" : "Import failed";
                if (
                    ok &&
                    payload.imported &&
                    (payload.imported as any).tracks
                ) {
                    applyTimelineState(state, payload.imported as any);
                }
            })
            .addCase(importAudioAtPosition.rejected, setRejected)

            .addCase(importAudioFileAtPosition.pending, (state) =>
                setPending(state, "Importing audio..."),
            )
            .addCase(importAudioFileAtPosition.fulfilled, (state, action) => {
                state.busy = false;
                state.lastResult = action.payload;
                const payload = action.payload as {
                    ok?: boolean;
                    imported?: TimelineState;
                };
                const ok = Boolean(payload.ok);
                state.status = ok ? "Import done" : "Import failed";
                if (
                    ok &&
                    payload.imported &&
                    (payload.imported as any).tracks
                ) {
                    applyTimelineState(state, payload.imported as any);
                }
            })
            .addCase(importAudioFileAtPosition.rejected, setRejected)

            .addCase(pickOutputPath.pending, (state) =>
                setPending(state, "Selecting output path..."),
            )
            .addCase(pickOutputPath.fulfilled, (state, action) => {
                state.busy = false;
                state.lastResult = action.payload;
                const payload = action.payload as {
                    canceled?: boolean;
                    path?: string;
                };
                if (payload.canceled) {
                    state.status = "Pick output canceled";
                    return;
                }
                if (payload.path) {
                    state.outputPath = payload.path;
                    state.status = "Output path selected";
                }
            })
            .addCase(pickOutputPath.rejected, setRejected)

            .addCase(applyPitchShift.pending, (state) =>
                setPending(state, "Applying pitch shift..."),
            )
            .addCase(applyPitchShift.fulfilled, (state, action) => {
                state.busy = false;
                state.lastResult = action.payload;
                state.status = (action.payload as { ok?: boolean }).ok
                    ? "Pitch shift applied"
                    : "Pitch shift failed";
            })
            .addCase(applyPitchShift.rejected, setRejected)

            .addCase(synthesizeAudio.pending, (state) =>
                setPending(state, "Synthesizing..."),
            )
            .addCase(synthesizeAudio.fulfilled, (state, action) => {
                state.busy = false;
                state.lastResult = action.payload;
                state.status = (action.payload as { ok?: boolean }).ok
                    ? "Synthesis done"
                    : "Synthesis failed";
            })
            .addCase(synthesizeAudio.rejected, setRejected)

            .addCase(exportAudio.pending, (state) =>
                setPending(state, "Exporting WAV..."),
            )
            .addCase(exportAudio.fulfilled, (state, action) => {
                state.busy = false;
                state.lastResult = action.payload;
                state.status = (action.payload as { ok?: boolean }).ok
                    ? "Export done"
                    : "Export failed";
            })
            .addCase(exportAudio.rejected, setRejected)

            .addCase(playOriginal.pending, (state) =>
                setPending(state, "Playing original..."),
            )
            .addCase(playOriginal.fulfilled, (state, action) => {
                state.busy = false;
                state.lastResult = action.payload;
                const payload = action.payload as {
                    ok?: boolean;
                    clipId?: string | null;
                    anchorBeat?: number;
                };
                const ok = Boolean(payload.ok);
                state.runtime.isPlaying = ok;
                state.runtime.playbackTarget = ok ? "original" : null;
                state.playbackClipId = ok ? (payload.clipId ?? null) : null;
                state.playbackAnchorBeat = ok ? (payload.anchorBeat ?? 0) : 0;
                state.status = ok ? "Playing original" : "Play original failed";
            })
            .addCase(playOriginal.rejected, setRejected)

            .addCase(playSynthesized.pending, (state) =>
                setPending(state, "Playing synthesized..."),
            )
            .addCase(playSynthesized.fulfilled, (state, action) => {
                state.busy = false;
                state.lastResult = action.payload;
                const payload = action.payload as {
                    ok?: boolean;
                    clipId?: string | null;
                    anchorBeat?: number;
                };
                const ok = Boolean(payload.ok);
                state.runtime.isPlaying = ok;
                state.runtime.playbackTarget = ok ? "synthesized" : null;
                state.playbackClipId = ok ? (payload.clipId ?? null) : null;
                state.playbackAnchorBeat = ok ? (payload.anchorBeat ?? 0) : 0;
                state.status = ok
                    ? "Playing synthesized"
                    : "Play synthesized failed";
            })
            .addCase(playSynthesized.rejected, setRejected)

            .addCase(stopAudioPlayback.pending, (state) =>
                setPending(state, "Stopping audio..."),
            )
            .addCase(stopAudioPlayback.fulfilled, (state, action) => {
                state.busy = false;
                state.lastResult = action.payload;
                state.runtime.isPlaying = false;
                state.runtime.playbackTarget = null;
                state.runtime.playbackPositionSec = 0;
                state.runtime.playbackDurationSec = 0;
                state.playbackClipId = null;
                state.playbackAnchorBeat = 0;
                state.status = (action.payload as { ok?: boolean }).ok
                    ? "Audio stopped"
                    : "Stop audio failed";
            })
            .addCase(stopAudioPlayback.rejected, setRejected)

            .addCase(syncPlaybackState.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                    is_playing?: boolean;
                    target?: string | null;
                    position_sec?: number;
                    duration_sec?: number;
                };
                if (!payload.ok) {
                    return;
                }

                state.runtime.isPlaying = Boolean(payload.is_playing);
                state.runtime.playbackTarget = payload.target ?? null;
                state.runtime.playbackPositionSec = payload.position_sec ?? 0;
                state.runtime.playbackDurationSec = payload.duration_sec ?? 0;

                if (state.runtime.isPlaying) {
                    const beatPos =
                        ((payload.position_sec ?? 0) * state.bpm) / 60;
                    state.playheadBeat = Math.max(
                        0,
                        state.playbackAnchorBeat + beatPos,
                    );
                } else {
                    state.playbackClipId = null;
                    state.playbackAnchorBeat = 0;
                }
            })

            .addCase(fetchTimeline.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
            })

            .addCase(addClipOnTrack.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
            })

            .addCase(removeClipRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
            })

            .addCase(removeSelectedClipRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
            })

            .addCase(moveClipRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
            })

            .addCase(splitClipRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
            })

            .addCase(glueClipsRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
                state.status = "Glue done";
            })

            .addCase(setClipStateRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
            })

            .addCase(selectClipRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
            })

            .addCase(setTrackStateRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
            })

            .addCase(updateTransportBpm.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                    bpm?: number;
                } & Partial<TimelineState>;
                if (!payload.ok) {
                    return;
                }
                state.bpm = clamp(Number(payload.bpm ?? state.bpm), 10, 300);
                if (payload.tracks && payload.clips) {
                    applyTimelineState(state, payload as TimelineState);
                }
            })

            .addCase(seekPlayhead.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                    playhead_beat?: number;
                } & Partial<TimelineState>;
                if (!payload.ok) {
                    return;
                }
                state.playheadBeat = Math.max(
                    0,
                    Number(payload.playhead_beat ?? state.playheadBeat),
                );
                if (state.runtime.isPlaying) {
                    state.playbackAnchorBeat = state.playheadBeat;
                }
                if (payload.tracks && payload.clips) {
                    applyTimelineState(state, payload as TimelineState);
                }
            })

            .addCase(addTrackRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
            })

            .addCase(removeTrackRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
            })

            .addCase(moveTrackRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
            })

            .addCase(selectTrackRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
            })

            .addCase(setProjectLengthRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
            })

            .addCase(fetchSelectedTrackSummary.fulfilled, (state, action) => {
                const payload = action.payload as
                    | TrackSummaryResult
                    | { ok?: false };
                if (!payload.ok) {
                    return;
                }
                state.selectedTrackSummary = {
                    trackId: payload.track_id,
                    clipCount: payload.clip_count,
                    waveformPreview: payload.waveform_preview,
                    pitchRange: payload.pitch_range,
                };
            });
    },
});

export const {
    setToolMode,
    setEditParam,
    setBpm,
    setBeats,
    setGrid,
    setPlayheadBeat,
    setModelDir,
    setAudioPath,
    setOutputPath,
    setPitchShift,
    setSelectedClip,
    moveClipStart,
    moveClipTrack,
    setClipLength,
    setClipTrim,
    setClipFades,
    setClipGain,
    setClipMuted,
    addClip,
    removeSelectedClip,
    toggleTrackMute,
    toggleTrackSolo,
    setTrackVolume,
    addAutomationPoint,
    moveAutomationPoint,
    setSelectedPoint,
    removeAutomationPoint,
    undo,
    redo,
} = sessionSlice.actions;

export default sessionSlice.reducer;
