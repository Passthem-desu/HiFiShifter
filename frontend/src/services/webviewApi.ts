/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
    ModelConfigResult,
    PlaybackStateResult,
    ProcessAudioResult,
    RuntimeInfo,
    SynthesizeResult,
    TrackSummaryResult,
    TimelineResult,
} from "../types/api";

declare global {
    interface Window {
        pywebview?: {
            api?: Record<string, (...args: any[]) => Promise<any>>;
        };
    }
}

async function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
    const api = window.pywebview?.api;
    if (!api || typeof api[method] !== "function") {
        throw new Error(`Python API not available: ${method}`);
    }
    return api[method](...args) as Promise<T>;
}

export const webApi = {
    ping: () => invoke<{ ok: boolean; message: string }>("ping"),
    getRuntimeInfo: () => invoke<RuntimeInfo>("get_runtime_info"),
    getPlaybackState: () => invoke<PlaybackStateResult>("get_playback_state"),
    openAudioDialog: () =>
        invoke<{ ok: boolean; canceled?: boolean; path?: string }>(
            "open_audio_dialog",
        ),
    pickOutputPath: () =>
        invoke<{ ok: boolean; canceled?: boolean; path?: string }>(
            "pick_output_path",
        ),
    closeWindow: () => invoke<{ ok: boolean }>("close_window"),
    loadDefaultModel: () => invoke<ModelConfigResult>("load_default_model"),
    loadModel: (modelDir: string) =>
        invoke<ModelConfigResult>("load_model", modelDir),
    processAudio: (audioPath: string) =>
        invoke<ProcessAudioResult>("process_audio", audioPath),
    setPitchShift: (semitones: number) =>
        invoke<{ ok: boolean; pitch_shift?: number; frames?: number }>(
            "set_pitch_shift",
            semitones,
        ),
    synthesize: () => invoke<SynthesizeResult>("synthesize"),
    saveSynthesized: (outputPath: string) =>
        invoke<{
            ok: boolean;
            path?: string;
            sample_rate?: number;
            num_samples?: number;
        }>("save_synthesized", outputPath),
    playOriginal: (startSec = 0) =>
        invoke<{ ok: boolean; playing?: string; start_sec?: number }>(
            "play_original",
            startSec,
        ),
    playSynthesized: (startSec = 0) =>
        invoke<{ ok: boolean; playing?: string; start_sec?: number }>(
            "play_synthesized",
            startSec,
        ),
    stopAudio: () => invoke<{ ok: boolean }>("stop_audio"),
    getTimelineState: () => invoke<TimelineResult>("get_timeline_state"),
    addTrack: (name?: string) => invoke<TimelineResult>("add_track", name),
    addTrackNested: (payload: {
        name?: string;
        parentTrackId?: string | null;
        index?: number;
    }) =>
        invoke<TimelineResult>(
            "add_track",
            payload.name,
            payload.parentTrackId ?? null,
            payload.index,
        ),
    removeTrack: (trackId: string) =>
        invoke<TimelineResult>("remove_track", trackId),
    moveTrack: (payload: {
        trackId: string;
        targetIndex: number;
        parentTrackId?: string | null;
    }) =>
        invoke<TimelineResult>(
            "move_track",
            payload.trackId,
            payload.targetIndex,
            payload.parentTrackId ?? null,
        ),
    setTrackState: (payload: {
        trackId: string;
        muted?: boolean;
        solo?: boolean;
        volume?: number;
    }) =>
        invoke<TimelineResult>(
            "set_track_state",
            payload.trackId,
            payload.muted,
            payload.solo,
            payload.volume,
        ),
    selectTrack: (trackId: string) =>
        invoke<TimelineResult>("select_track", trackId),
    getTrackSummary: (trackId?: string) =>
        invoke<TrackSummaryResult>("get_track_summary", trackId),
    addClip: (payload: {
        trackId?: string;
        name?: string;
        startBeat?: number;
        lengthBeats?: number;
        sourcePath?: string;
    }) =>
        invoke<TimelineResult>(
            "add_clip",
            payload.trackId,
            payload.name,
            payload.startBeat,
            payload.lengthBeats,
            payload.sourcePath,
        ),
    removeClip: (clipId: string) =>
        invoke<TimelineResult>("remove_clip", clipId),
    moveClip: (payload: {
        clipId: string;
        startBeat: number;
        trackId?: string;
    }) =>
        invoke<TimelineResult>(
            "move_clip",
            payload.clipId,
            payload.startBeat,
            payload.trackId,
        ),
    setClipState: (payload: {
        clipId: string;
        lengthBeats?: number;
        gain?: number;
        muted?: boolean;
        trimStartBeat?: number;
        trimEndBeat?: number;
        playbackRate?: number;
    }) =>
        invoke<TimelineResult>(
            "set_clip_state",
            payload.clipId,
            payload.lengthBeats,
            payload.gain,
            payload.muted,
            payload.trimStartBeat,
            payload.trimEndBeat,
            payload.playbackRate,
        ),
    selectClip: (clipId: string | null) =>
        invoke<TimelineResult>("select_clip", clipId),
    setTransport: (payload: { playheadBeat?: number; bpm?: number }) =>
        invoke<{
            ok: boolean;
            playhead_beat?: number;
            bpm?: number;
        }>("set_transport", payload.playheadBeat, payload.bpm),
    setProjectLength: (projectBeats: number) =>
        invoke<TimelineResult>("set_project_length", projectBeats),
};
