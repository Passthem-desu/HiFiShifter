/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
    ModelConfigResult,
    PlaybackStateResult,
    ParamFramesPayload,
    ProcessAudioResult,
    RuntimeInfo,
    SynthesizeResult,
    TrackSummaryResult,
    TimelineResult,
    WaveformPeaksSegmentPayload,
} from "../types/api";

declare global {
    interface Window {
        pywebview?: {
            api?: Record<string, (...args: any[]) => Promise<any>>;
        };
        __TAURI__?: {
            core?: {
                invoke?: <T>(
                    cmd: string,
                    args?: Record<string, unknown>,
                ) => Promise<T>;
            };
            invoke?: <T>(
                cmd: string,
                args?: Record<string, unknown>,
            ) => Promise<T>;
        };
    }
}

type PyWebviewApi = Record<string, (...args: any[]) => Promise<any>>;

let pywebviewAvailability: "unknown" | "available" | "unavailable" = "unknown";

async function waitForPyWebviewApi(
    timeoutMs: number,
): Promise<PyWebviewApi | null> {
    const already = window.pywebview?.api;
    if (already) {
        pywebviewAvailability = "available";
        return already as PyWebviewApi;
    }

    if (pywebviewAvailability === "unavailable") {
        return null;
    }

    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
        let done = false;

        function finish() {
            if (done) return;
            done = true;
            window.removeEventListener("pywebviewready", onReady as any);
            document.removeEventListener("pywebviewready", onReady as any);
            clearInterval(pollId);
            clearTimeout(timeoutId);
            resolve();
        }

        function onReady() {
            finish();
        }

        const pollId = window.setInterval(() => {
            if (window.pywebview?.api) finish();
        }, 25);

        const timeoutId = window.setTimeout(
            () => {
                finish();
            },
            Math.max(0, timeoutMs),
        );

        window.addEventListener("pywebviewready", onReady as any, {
            once: true,
        });
        document.addEventListener("pywebviewready", onReady as any, {
            once: true,
        });
    });

    const api = window.pywebview?.api as PyWebviewApi | undefined;
    if (api) {
        pywebviewAvailability = "available";
        return api;
    }

    // If pywebview didn't appear after a meaningful wait, treat it as unavailable
    // to avoid stalling every call in browser/dev mode.
    if (performance.now() - startedAt >= 750) {
        pywebviewAvailability = "unavailable";
    }
    return null;
}

async function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
    const tauriInvoke =
        window.__TAURI__?.core?.invoke ?? window.__TAURI__?.invoke;
    if (typeof tauriInvoke === "function") {
        // Tauri invoke uses a named-argument object; pywebview uses positional args.
        const buildArgs = (
            m: string,
            a: unknown[],
        ): Record<string, unknown> | undefined => {
            switch (m) {
                case "set_transport": {
                    const o: Record<string, unknown> = {};
                    if (a[0] !== undefined) o.playheadBeat = a[0];
                    if (a[1] !== undefined) o.bpm = a[1];
                    return o;
                }
                case "import_audio_item":
                    return {
                        audioPath: a[0],
                        ...(a[1] !== undefined ? { trackId: a[1] } : {}),
                        ...(a[2] !== undefined ? { startBeat: a[2] } : {}),
                    };
                case "import_audio_bytes":
                    return {
                        fileName: a[0],
                        base64Data: a[1],
                        ...(a[2] !== undefined ? { trackId: a[2] } : {}),
                        ...(a[3] !== undefined ? { startBeat: a[3] } : {}),
                    };

                case "add_track":
                    return {
                        name: a[0],
                        parentTrackId: a[1] ?? null,
                        index: a[2],
                    };
                case "remove_track":
                    return { trackId: a[0] };
                case "move_track":
                    return {
                        trackId: a[0],
                        targetIndex: a[1],
                        parentTrackId: a[2] ?? null,
                    };
                case "set_track_state":
                    return {
                        trackId: a[0],
                        muted: a[1],
                        solo: a[2],
                        volume: a[3],
                        composeEnabled: a[4],
                        pitchAnalysisAlgo: a[5],
                    };
                case "select_track":
                    return { trackId: a[0] };
                case "set_project_length":
                    return { projectBeats: a[0] };
                case "get_track_summary":
                    return a[0] === undefined ? undefined : { trackId: a[0] };

                case "add_clip":
                    return {
                        trackId: a[0] ?? null,
                        name: a[1],
                        startBeat: a[2],
                        lengthBeats: a[3],
                        sourcePath: a[4],
                    };
                case "remove_clip":
                    return { clipId: a[0] };
                case "move_clip":
                    return {
                        clipId: a[0],
                        startBeat: a[1],
                        trackId: a[2] ?? null,
                    };
                case "set_clip_state":
                    return {
                        clipId: a[0],
                        lengthBeats: a[1],
                        gain: a[2],
                        muted: a[3],
                        trimStartBeat: a[4],
                        trimEndBeat: a[5],
                        playbackRate: a[6],
                        fadeInBeats: a[7],
                        fadeOutBeats: a[8],
                    };
                case "split_clip":
                    return { clipId: a[0], splitBeat: a[1] };
                case "glue_clips":
                    return { clipIds: a[0] };
                case "select_clip":
                    return { clipId: a[0] };

                case "load_model":
                    return { modelDir: a[0] };
                case "process_audio":
                    return { audioPath: a[0] };
                case "set_pitch_shift":
                    return { semitones: a[0] };
                case "save_synthesized":
                    return { outputPath: a[0] };
                case "play_original":
                case "play_synthesized":
                    return { startSec: a[0] };

                case "open_project":
                    return { projectPath: a[0] };

                case "get_waveform_peaks_segment":
                    return {
                        sourcePath: a[0],
                        startSec: a[1],
                        durationSec: a[2],
                        columns: a[3],
                    };

                case "get_root_mix_waveform_peaks_segment":
                    return {
                        trackId: a[0],
                        startSec: a[1],
                        durationSec: a[2],
                        columns: a[3],
                    };

                case "get_track_mix_waveform_peaks_segment":
                    return {
                        trackId: a[0],
                        startSec: a[1],
                        durationSec: a[2],
                        columns: a[3],
                    };

                case "get_param_frames":
                    return {
                        trackId: a[0],
                        param: a[1],
                        startFrame: a[2],
                        frameCount: a[3],
                        stride: a[4],
                    };

                case "set_param_frames":
                    return {
                        trackId: a[0],
                        param: a[1],
                        startFrame: a[2],
                        values: a[3],
                        checkpoint: a[4],
                    };

                case "restore_param_frames":
                    return {
                        trackId: a[0],
                        param: a[1],
                        startFrame: a[2],
                        frameCount: a[3],
                        checkpoint: a[4],
                    };

                default:
                    return undefined;
            }
        };

        const invokeArgs = buildArgs(method, args);
        if (invokeArgs === undefined) {
            if (args.length > 0) {
                throw new Error(
                    `Tauri backend: method not wired yet: ${method} (args: ${args.length})`,
                );
            }
            return tauriInvoke<T>(method);
        }
        try {
            return await tauriInvoke<T>(method, invokeArgs);
        } catch (err) {
            console.error("Tauri invoke failed", { method, invokeArgs, err });
            throw err;
        }
    }

    const api = (await waitForPyWebviewApi(1500)) ?? null;
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

    // Undo/Redo (backend-authoritative)
    undoTimeline: () => invoke<TimelineResult>("undo_timeline"),
    redoTimeline: () => invoke<TimelineResult>("redo_timeline"),

    // Project
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

    // Waveform peaks
    getWaveformPeaksSegment: (
        sourcePath: string,
        startSec: number,
        durationSec: number,
        columns: number,
    ) =>
        invoke<WaveformPeaksSegmentPayload>(
            "get_waveform_peaks_segment",
            sourcePath,
            startSec,
            durationSec,
            columns,
        ),

    getRootMixWaveformPeaksSegment: (
        trackId: string,
        startSec: number,
        durationSec: number,
        columns: number,
    ) =>
        invoke<WaveformPeaksSegmentPayload>(
            "get_root_mix_waveform_peaks_segment",
            trackId,
            startSec,
            durationSec,
            columns,
        ),

    getTrackMixWaveformPeaksSegment: (
        trackId: string,
        startSec: number,
        durationSec: number,
        columns: number,
    ) =>
        invoke<WaveformPeaksSegmentPayload>(
            "get_track_mix_waveform_peaks_segment",
            trackId,
            startSec,
            durationSec,
            columns,
        ),

    // Param curves (frame-based)
    getParamFrames: (
        trackId: string,
        param: string,
        startFrame: number,
        frameCount: number,
        stride?: number,
    ) =>
        invoke<ParamFramesPayload>(
            "get_param_frames",
            trackId,
            param,
            startFrame,
            frameCount,
            stride,
        ),

    setParamFrames: (
        trackId: string,
        param: string,
        startFrame: number,
        values: number[],
        checkpoint?: boolean,
    ) =>
        invoke<{ ok: boolean }>(
            "set_param_frames",
            trackId,
            param,
            startFrame,
            values,
            checkpoint,
        ),

    restoreParamFrames: (
        trackId: string,
        param: string,
        startFrame: number,
        frameCount: number,
        checkpoint?: boolean,
    ) =>
        invoke<{ ok: boolean }>(
            "restore_param_frames",
            trackId,
            param,
            startFrame,
            frameCount,
            checkpoint,
        ),

    clearWaveformCache: () =>
        invoke<{
            ok: boolean;
            removed_files: number;
            removed_bytes: number;
            dir: string;
        }>("clear_waveform_cache"),
    openProject: (projectPath: string) =>
        invoke<TimelineResult>("open_project", projectPath),
    saveProject: () => invoke<any>("save_project"),
    saveProjectAs: () => invoke<any>("save_project_as"),
    loadDefaultModel: () => invoke<ModelConfigResult>("load_default_model"),
    loadModel: (modelDir: string) =>
        invoke<ModelConfigResult>("load_model", modelDir),
    processAudio: (audioPath: string) =>
        invoke<ProcessAudioResult>("process_audio", audioPath),
    importAudioItem: (
        audioPath: string,
        trackId?: string | null,
        startBeat?: number,
    ) =>
        invoke<TimelineResult>(
            "import_audio_item",
            audioPath,
            trackId,
            startBeat,
        ),
    importAudioBytes: (
        fileName: string,
        base64Data: string,
        trackId?: string | null,
        startBeat?: number,
    ) =>
        invoke<TimelineResult>(
            "import_audio_bytes",
            fileName,
            base64Data,
            trackId,
            startBeat,
        ),
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
        composeEnabled?: boolean;
        pitchAnalysisAlgo?: string;
    }) =>
        invoke<TimelineResult>(
            "set_track_state",
            payload.trackId,
            payload.muted,
            payload.solo,
            payload.volume,
            payload.composeEnabled,
            payload.pitchAnalysisAlgo,
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
        fadeInBeats?: number;
        fadeOutBeats?: number;
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
            payload.fadeInBeats,
            payload.fadeOutBeats,
        ),
    splitClip: (clipId: string, splitBeat: number) =>
        invoke<TimelineResult>("split_clip", clipId, splitBeat),
    glueClips: (clipIds: string[]) =>
        invoke<TimelineResult>("glue_clips", clipIds),
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

    // ========================================
    // 新的 ProjectManager API
    // ========================================

    // 工程管理
    createNewProject: (name = "Untitled Project") =>
        invoke<{ ok: boolean; project: any }>("create_new_project", name),

    getProjectState: () =>
        invoke<{ ok: boolean; project: any }>("get_project_state"),

    saveProjectToFile: (filePath: string) =>
        invoke<{ ok: boolean; file_path: string }>(
            "save_project_to_file",
            filePath,
        ),

    loadProjectFromFile: (filePath: string) =>
        invoke<{ ok: boolean; project: any }>(
            "load_project_from_file",
            filePath,
        ),

    // 轨道管理
    pmAddTrack: (name: string, parentId?: string) =>
        invoke<{ ok: boolean; track: any; project: any }>(
            "pm_add_track",
            name,
            parentId,
        ),

    pmDeleteTrack: (trackId: string) =>
        invoke<{ ok: boolean; project: any }>("pm_delete_track", trackId),

    pmUpdateTrack: (trackId: string, params: Record<string, any>) =>
        invoke<{ ok: boolean; track: any; project: any }>(
            "pm_update_track",
            trackId,
            params,
        ),

    pmMoveTrack: (trackId: string, newOrder: number, newParentId?: string) =>
        invoke<{ ok: boolean; project: any }>(
            "pm_move_track",
            trackId,
            newOrder,
            newParentId,
        ),

    // 音频块管理
    pmImportAudio: (filePath: string, trackId: string, startTime = 0.0) =>
        invoke<{ ok: boolean; clip: any; project: any }>(
            "pm_import_audio",
            filePath,
            trackId,
            startTime,
        ),

    pmDeleteClip: (clipId: string) =>
        invoke<{ ok: boolean; project: any }>("pm_delete_clip", clipId),

    pmUpdateClip: (clipId: string, params: Record<string, any>) =>
        invoke<{ ok: boolean; clip: any; project: any }>(
            "pm_update_clip",
            clipId,
            params,
        ),

    pmGetClipFeatures: (clipId: string) =>
        invoke<{ ok: boolean; features: any }>("pm_get_clip_features", clipId),

    pmUpdateClipF0: (clipId: string, f0Data: number[]) =>
        invoke<{ ok: boolean; clip: any }>("pm_update_clip_f0", clipId, f0Data),

    // 播放和导出
    pmExportAudio: (filePath: string, startTime = 0.0, endTime?: number) =>
        invoke<{ ok: boolean; file_path: string }>(
            "pm_export_audio",
            filePath,
            startTime,
            endTime,
        ),

    pmSetCursorPosition: (position: number) =>
        invoke<{ ok: boolean; cursor_position: number }>(
            "pm_set_cursor_position",
            position,
        ),

    pmSetSelectedTrack: (trackId: string | null) =>
        invoke<{ ok: boolean; selected_track_id: string | null }>(
            "pm_set_selected_track",
            trackId,
        ),
};
