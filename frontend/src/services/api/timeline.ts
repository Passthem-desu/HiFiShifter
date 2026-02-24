import type { TimelineResult, TrackSummaryResult } from "../../types/api";

import { invoke } from "../invoke";

export const timelineApi = {
    // Undo/Redo (backend-authoritative)
    undoTimeline: () => invoke<TimelineResult>("undo_timeline"),
    redoTimeline: () => invoke<TimelineResult>("redo_timeline"),

    getTimelineState: () => invoke<TimelineResult>("get_timeline_state"),

    // Transport
    setTransport: (payload: { playheadBeat?: number; bpm?: number }) =>
        invoke<{ ok: boolean; playhead_beat?: number; bpm?: number }>(
            "set_transport",
            payload.playheadBeat,
            payload.bpm,
        ),

    setProjectLength: (projectBeats: number) =>
        invoke<TimelineResult>("set_project_length", projectBeats),

    // Import
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

    // Tracks
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

    // Clips
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

    removeClip: (clipId: string) => invoke<TimelineResult>("remove_clip", clipId),

    moveClip: (payload: { clipId: string; startBeat: number; trackId?: string }) =>
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
};
