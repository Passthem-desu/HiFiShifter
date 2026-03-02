import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {
    TimelineClip,
    TimelineState,
    TrackSummaryResult,
} from "../../types/api";
import type {
    AutomationPoint,
    ClipInfo,
    ClipTemplate,
    EditParam,
    FadeCurveType,
    GridSize,
    ToolMode,
    TrackInfo,
} from "./sessionTypes";

import {
    addClipOnTrack,
    addTrackRemote,
    createClipsRemote,
    fetchSelectedTrackSummary,
    glueClipsRemote,
    moveClipRemote,
    moveTrackRemote,
    removeClipRemote,
    removeTrackRemote,
    selectClipRemote,
    selectTrackRemote,
    setClipStateRemote,
    setProjectLengthRemote,
    splitClipRemote,
} from "./thunks/timelineThunks";

import {
    newProjectRemote,
    openProjectFromDialog,
    openProjectFromPath,
    redoRemote,
    saveProjectAsRemote,
    saveProjectRemote,
    undoRemote,
} from "./thunks/projectThunks";

import {
    fetchTimeline,
    playOriginal,
    playSynthesized,
    seekPlayhead,
    stopAudioPlayback,
    syncPlaybackState,
    updateTransportBpm,
} from "./thunks/transportThunks";

import {
    clearWaveformCacheRemote,
    refreshRuntime,
} from "./thunks/runtimeThunks";

import { loadDefaultModel, loadModel } from "./thunks/modelThunks";

import {
    applyPitchShift,
    exportAudio,
    pickOutputPath,
    processAudio,
    synthesizeAudio,
} from "./thunks/audioThunks";

import {
    importAudioAtPosition,
    importAudioFileAtPosition,
    importAudioFromDialog,
    importAudioFromPath,
} from "./thunks/importThunks";

import {
    removeSelectedClipRemote,
    setTrackStateRemote,
} from "./thunks/trackThunks";

export type {
    AutomationPoint,
    ClipInfo,
    ClipTemplate,
    EditParam,
    FadeCurveType,
    GridSize,
    ToolMode,
    TrackInfo,
};

type ClipColor = ClipInfo["color"];
type WaveformPreview = number[] | { l: number[]; r: number[] };

export interface SessionState {
    toolMode: ToolMode;
    editParam: EditParam;
    bpm: number;
    beats: number;
    projectBeats: number;
    grid: GridSize;

    // Monotonic bump token for invalidating parameter curve caches.
    // - Not included in undo/redo snapshots.
    // - Should be bumped on any timeline/undo/redo operation that may affect param rendering.
    paramsEpoch: number;

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
        }
    >;
    selectedPointId: string | null;
    clipWaveforms: Record<string, WaveformPreview>;
    clipPitchRanges: Record<string, { min: number; max: number }>;

    /**
     * 后端推送的 per-clip 音高检测结果（MIDI 曲线）。
     * key: clip_id
     * value: { startFrame, midiCurve, framePeriodMs, sampleRate }
     */
    clipPitchCurves: Record<
        string,
        { startFrame: number; midiCurve: number[]; framePeriodMs: number; sampleRate: number }
    >;

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
    project: {
        name: string;
        path: string | null;
        dirty: boolean;
        recent: string[];
    };

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

        composeEnabled: Boolean((track as any).compose_enabled),
        pitchAnalysisAlgo: String(
            (track as any).pitch_analysis_algo ?? "world_dll",
        ),
    }));

    state.clips = timeline.clips.map((clip: TimelineClip) => {
        const parsed = {
            id: clip.id,
            trackId: clip.track_id,
            name: clip.name,
            startBeat: Number(clip.start_beat ?? 0),
            lengthBeats: Math.max(0.0, Number(clip.length_beats ?? 1)),
            color: normalizeClipColor(clip.color),
            sourcePath: clip.source_path,
            durationSec: Number(clip.duration_sec ?? 0) || undefined,
            durationFrames: clip.duration_frames,
            sourceSampleRate: clip.source_sample_rate,
            gain: clamp(Number(clip.gain ?? 1), 0, 2),
            muted: Boolean(clip.muted),
            // Allow negative trimStartBeat to represent leading silence (slip-edit past source start).
            trimStartBeat: Number(clip.trim_start_beat ?? 0) || 0,
            trimEndBeat: Math.max(0, Number(clip.trim_end_beat ?? 0)),
            playbackRate: clamp(Number(clip.playback_rate ?? 1), 0.1, 10),
            fadeInBeats: Math.max(0, Number(clip.fade_in_beats ?? 0)),
            fadeOutBeats: Math.max(0, Number(clip.fade_out_beats ?? 0)),
            fadeInCurve: "sine" as FadeCurveType,
            fadeOutCurve: "sine" as FadeCurveType,
        };
        
        // DEBUG: 打印每个clip的关键参数
        console.log(`[SessionSlice] Parsed clip ${parsed.id.slice(0, 8)}:`, {
            lengthBeats: parsed.lengthBeats,
            durationSec: parsed.durationSec,
            durationFrames: parsed.durationFrames,
            sourceSampleRate: parsed.sourceSampleRate,
            computedDurSec: parsed.durationFrames && parsed.sourceSampleRate 
                ? (parsed.durationFrames / parsed.sourceSampleRate).toFixed(6)
                : 'N/A',
            sourcePath: parsed.sourcePath?.split(/[/\\]/).pop(),
            startBeat: parsed.startBeat,
            trimStartBeat: parsed.trimStartBeat,
            trimEndBeat: parsed.trimEndBeat,
            playbackRate: parsed.playbackRate,
        });
        
        return parsed;
    });

    state.selectedTrackId = timeline.selected_track_id;
    state.selectedClipId = timeline.selected_clip_id;
    state.bpm = clamp(Number(timeline.bpm ?? state.bpm), 10, 300);
    state.playheadBeat = Math.max(0, Number(timeline.playhead_beat ?? 0));
    state.projectBeats = Math.max(
        4,
        Number(timeline.project_beats ?? state.projectBeats),
    );

    const project = (timeline as any).project as
        | {
              name?: string;
              path?: string | null;
              dirty?: boolean;
              recent?: string[];
          }
        | undefined;
    if (project) {
        state.project = {
            name: String(project.name ?? state.project.name ?? "Untitled"),
            path:
                project.path === undefined
                    ? state.project.path
                    : ((project.path as any) ?? null),
            dirty: Boolean(project.dirty),
            recent: Array.isArray(project.recent)
                ? project.recent
                : state.project.recent,
        };
    }

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

    // Any timeline refresh may change pitch analysis inputs and therefore param curves.
    state.paramsEpoch = (Number(state.paramsEpoch) || 0) + 1;
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

            composeEnabled: true,
            pitchAnalysisAlgo: "world_dll",
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
        fadeInCurve: "sine" as FadeCurveType,
        fadeOutCurve: "sine" as FadeCurveType,
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

    paramsEpoch: 0,

    playheadBeat: 0,
    tracks: [
        {
            id: "track_main",
            name: "Main",
            muted: false,
            solo: false,
            volume: 0.9,

            composeEnabled: true,
            pitchAnalysisAlgo: "world_dll",
        },
    ],
    clips: [],
    selectedTrackId: "track_main",
    selectedClipId: null,
    clipAutomation: {},
    selectedPointId: null,
    clipWaveforms: {},
    clipPitchRanges: {},
    clipPitchCurves: {},

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
    project: {
        name: "Untitled",
        path: null,
        dirty: false,
        recent: [],
    },

    busy: false,
    status: "Ready",
};

export {
    undoRemote,
    redoRemote,
    newProjectRemote,
    openProjectFromDialog,
    openProjectFromPath,
    saveProjectRemote,
    saveProjectAsRemote,
} from "./thunks/projectThunks";

export {
    fetchTimeline,
    seekPlayhead,
    updateTransportBpm,
    syncPlaybackState,
    playOriginal,
    playSynthesized,
    stopAudioPlayback,
} from "./thunks/transportThunks";

export {
    addTrackRemote,
    removeTrackRemote,
    moveTrackRemote,
    selectTrackRemote,
    setProjectLengthRemote,
    fetchSelectedTrackSummary,
    addClipOnTrack,
    createClipsRemote,
    removeClipRemote,
    moveClipRemote,
    setClipStateRemote,
    splitClipRemote,
    glueClipsRemote,
    selectClipRemote,
} from "./thunks/timelineThunks";

export {
    setTrackStateRemote,
    removeSelectedClipRemote,
} from "./thunks/trackThunks";

export {
    refreshRuntime,
    clearWaveformCacheRemote,
} from "./thunks/runtimeThunks";

export {
    loadModel,
    loadDefaultModel,
} from "./thunks/modelThunks";

export {
    processAudio,
    pickOutputPath,
    applyPitchShift,
    synthesizeAudio,
    exportAudio,
} from "./thunks/audioThunks";

export {
    importAudioFromDialog,
    importAudioFromPath,
    importAudioAtPosition,
    importAudioFileAtPosition,
} from "./thunks/importThunks";




const sessionSlice = createSlice({
    name: "session",
    initialState,
    reducers: {
        checkpointHistory(state) {
            pushHistory(state);
            state.paramsEpoch = (Number(state.paramsEpoch) || 0) + 1;
        },
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
        setClipPlaybackRate(
            state,
            action: PayloadAction<{ clipId: string; playbackRate: number }>,
        ) {
            const clip = state.clips.find(
                (entry) => entry.id === action.payload.clipId,
            );
            if (!clip) return;
            clip.playbackRate = clamp(action.payload.playbackRate, 0.1, 10);
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
                clip.trimStartBeat = Number(action.payload.trimStartBeat) || 0;
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
                fadeInCurve?: FadeCurveType;
                fadeOutCurve?: FadeCurveType;
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
            if (action.payload.fadeInCurve !== undefined) {
                clip.fadeInCurve = action.payload.fadeInCurve;
            }
            if (action.payload.fadeOutCurve !== undefined) {
                clip.fadeOutCurve = action.payload.fadeOutCurve;
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
        /** 乐观更新 clip 颜色（立即反映到 UI，后端确认前先行生效） */
        optimisticUpdateClipColor(
            state,
            action: PayloadAction<{ clipId: string; color: ClipColor }>,
        ) {
            const clip = state.clips.find(
                (entry) => entry.id === action.payload.clipId,
            );
            if (!clip) return;
            clip.color = normalizeClipColor(action.payload.color);
        },
        /** 回滚 clip 颜色（后端失败时恢复到旧值） */
        rollbackClipColor(
            state,
            action: PayloadAction<{ clipId: string; color: ClipColor }>,
        ) {
            const clip = state.clips.find(
                (entry) => entry.id === action.payload.clipId,
            );
            if (!clip) return;
            clip.color = normalizeClipColor(action.payload.color);
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
                fadeInCurve: "sine" as FadeCurveType,
                fadeOutCurve: "sine" as FadeCurveType,
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
            delete state.clipPitchCurves[selectedId];
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
        /** 更新某个 clip 的音高曲线（来自后端 clip_pitch_data 事件） */
        setClipPitchData(
            state,
            action: PayloadAction<{
                clipId: string;
                startFrame: number;
                midiCurve: number[];
                framePeriodMs: number;
                sampleRate: number;
            }>,
        ) {
            const { clipId, startFrame, midiCurve, framePeriodMs, sampleRate } =
                action.payload;
            state.clipPitchCurves[clipId] = {
                startFrame,
                midiCurve,
                framePeriodMs,
                sampleRate,
            };
        },
        /** 移除某个 clip 的音高曲线（clip 被删除时清理） */
        removeClipPitchData(state, action: PayloadAction<string>) {
            delete state.clipPitchCurves[action.payload];
        },
        undo(state) {
            const snapshot = state.historyPast.pop();
            if (!snapshot) {
                return;
            }
            state.historyFuture.push(createSnapshot(state));
            applySnapshot(state, snapshot);
            state.paramsEpoch = (Number(state.paramsEpoch) || 0) + 1;
        },
        redo(state) {
            const snapshot = state.historyFuture.pop();
            if (!snapshot) {
                return;
            }
            state.historyPast.push(createSnapshot(state));
            applySnapshot(state, snapshot);
            state.paramsEpoch = (Number(state.paramsEpoch) || 0) + 1;
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

            .addCase(clearWaveformCacheRemote.pending, (state) =>
                setPending(state, "Clearing waveform cache..."),
            )
            .addCase(clearWaveformCacheRemote.fulfilled, (state, action) => {
                state.busy = false;
                const payload = action.payload as {
                    ok?: boolean;
                    removed_files?: number;
                    removed_bytes?: number;
                    dir?: string;
                };
                if (payload.ok) {
                    const n = Number(payload.removed_files ?? 0) || 0;
                    state.status = `Waveform cache cleared (${n} files)`;
                } else {
                    state.status = "Clear waveform cache failed";
                }
            })
            .addCase(clearWaveformCacheRemote.rejected, setRejected)

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
                // Backend playback state reports an absolute clock; anchor beat is no longer needed.
                state.playbackAnchorBeat = 0;
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
                // Backend playback state reports an absolute clock; anchor beat is no longer needed.
                state.playbackAnchorBeat = 0;
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
                    base_sec?: number;
                    position_sec?: number;
                    duration_sec?: number;
                };
                if (!payload.ok) {
                    return;
                }

                const nextIsPlaying = Boolean(payload.is_playing);
                const nextTarget = payload.target ?? null;
                const nextPositionSec = payload.position_sec ?? 0;
                const nextDurationSec = payload.duration_sec ?? 0;

                // 0.5ms 阈值：避免轮询带来的浮点抖动导致无意义的 Redux 更新。
                const EPS_SEC = 0.0005;
                const epsBeat = (state.bpm / 60) * EPS_SEC;

                let nextPlayheadBeat = state.playheadBeat;
                if (nextIsPlaying) {
                    const absSec = (payload.base_sec ?? 0) + nextPositionSec;
                    nextPlayheadBeat = Math.max(0, (absSec * state.bpm) / 60);
                }

                const shouldUpdatePlaybackFields =
                    nextIsPlaying !== state.runtime.isPlaying ||
                    nextTarget !== state.runtime.playbackTarget ||
                    Math.abs(nextPositionSec - state.runtime.playbackPositionSec) >
                        EPS_SEC ||
                    Math.abs(nextDurationSec - state.runtime.playbackDurationSec) >
                        EPS_SEC ||
                    (nextIsPlaying &&
                        Math.abs(nextPlayheadBeat - state.playheadBeat) > epsBeat);

                if (!shouldUpdatePlaybackFields) {
                    // 即使播放已停止，也避免重复写入相同值（Immer 会把赋值视为 mutation）。
                    if (!nextIsPlaying) {
                        if (state.playbackClipId !== null) state.playbackClipId = null;
                        if (state.playbackAnchorBeat !== 0)
                            state.playbackAnchorBeat = 0;
                    }
                    return;
                }

                state.runtime.isPlaying = nextIsPlaying;
                state.runtime.playbackTarget = nextTarget;
                state.runtime.playbackPositionSec = nextPositionSec;
                state.runtime.playbackDurationSec = nextDurationSec;

                if (nextIsPlaying) {
                    state.playheadBeat = nextPlayheadBeat;
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

            .addCase(undoRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) return;
                applyTimelineState(state, payload);
            })

            .addCase(redoRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) return;
                applyTimelineState(state, payload);
            })

            .addCase(newProjectRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) return;
                applyTimelineState(state, payload);
                state.status = "New project";
            })

            .addCase(openProjectFromDialog.fulfilled, (state, action) => {
                const payload = action.payload as
                    | { ok: true; canceled: true }
                    | { ok: true; canceled: false; timeline: TimelineState };
                if (!payload || (payload as any).canceled) {
                    state.status = "Open canceled";
                    return;
                }
                applyTimelineState(state, (payload as any).timeline);
                state.status = "Project opened";
            })

            .addCase(openProjectFromPath.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) return;
                applyTimelineState(state, payload);
                state.status = "Project opened";
            })

            .addCase(saveProjectRemote.fulfilled, (state, action) => {
                const payload = action.payload as any;
                if (payload?.ok && payload?.canceled) {
                    state.status = "Save canceled";
                    return;
                }

                if (payload?.ok && payload?.timeline?.ok) {
                    applyTimelineState(
                        state,
                        payload.timeline as TimelineState,
                    );
                    state.status = "Project saved";
                    return;
                }

                if (payload?.ok && payload?.tracks && payload?.clips) {
                    applyTimelineState(state, payload as TimelineState);
                    state.status = "Project saved";
                    return;
                }

                if (payload?.ok) {
                    state.project.dirty = false;
                    state.status = "Project saved";
                    return;
                }

                state.status = "Save failed";
            })

            .addCase(saveProjectAsRemote.fulfilled, (state, action) => {
                const payload = action.payload as any;
                if (payload?.ok && payload?.canceled) {
                    state.status = "Save As canceled";
                    return;
                }

                if (payload?.ok && payload?.timeline?.ok) {
                    applyTimelineState(
                        state,
                        payload.timeline as TimelineState,
                    );
                    state.status = "Project saved";
                    return;
                }

                if (payload?.ok && payload?.tracks && payload?.clips) {
                    applyTimelineState(state, payload as TimelineState);
                    state.status = "Project saved";
                    return;
                }

                if (payload?.ok) {
                    state.project.dirty = false;
                    state.status = "Project saved";
                    return;
                }

                state.status = "Save As failed";
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

            .addCase(createClipsRemote.fulfilled, (state, action) => {
                const payload = action.payload as {
                    ok?: boolean;
                } & TimelineState;
                if (!payload.ok) {
                    return;
                }
                applyTimelineState(state, payload);
                state.status = "Clips created";
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
                    state.playbackAnchorBeat = 0;
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
    checkpointHistory,
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
    setClipPlaybackRate,
    setClipTrim,
    setClipFades,
    setClipGain,
    setClipMuted,
    optimisticUpdateClipColor,
    rollbackClipColor,
    addClip,
    removeSelectedClip,
    toggleTrackMute,
    toggleTrackSolo,
    setTrackVolume,
    addAutomationPoint,
    moveAutomationPoint,
    setSelectedPoint,
    removeAutomationPoint,
    setClipPitchData,
    removeClipPitchData,
    undo,
    redo,
} = sessionSlice.actions;

export default sessionSlice.reducer;
