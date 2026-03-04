import type { TimelineResult, TrackSummaryResult } from "../../types/api";

import { invoke } from "../invoke";

export const timelineApi = {
    // Undo/Redo (backend-authoritative)
    undoTimeline: () => invoke<TimelineResult>("undo_timeline"),
    redoTimeline: () => invoke<TimelineResult>("redo_timeline"),

    getTimelineState: () => invoke<TimelineResult>("get_timeline_state"),

    // Transport
    setTransport: (payload: { playheadSec?: number; bpm?: number }) =>
        invoke<{ ok: boolean; playhead_sec?: number; bpm?: number }>(
            "set_transport",
            payload.playheadSec,
            payload.bpm,
        ),

    setProjectLength: (projectSec: number) =>
        invoke<TimelineResult>("set_project_length", projectSec),

    // Import
    importAudioItem: (
        audioPath: string,
        trackId?: string | null,
        startSec?: number,
    ) =>
        invoke<TimelineResult>(
            "import_audio_item",
            audioPath,
            trackId,
            startSec,
        ),

    importAudioBytes: (
        fileName: string,
        base64Data: string,
        trackId?: string | null,
        startSec?: number,
    ) =>
        invoke<TimelineResult>(
            "import_audio_bytes",
            fileName,
            base64Data,
            trackId,
            startSec,
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
        color?: string;
    }) =>
        invoke<TimelineResult>(
            "set_track_state",
            payload.trackId,
            payload.muted,
            payload.solo,
            payload.volume,
            payload.composeEnabled,
            payload.pitchAnalysisAlgo,
            payload.color,
        ),

    selectTrack: (trackId: string) =>
        invoke<TimelineResult>("select_track", trackId),

    getTrackSummary: (trackId?: string) =>
        invoke<TrackSummaryResult>("get_track_summary", trackId),

    // Clips
    addClip: (payload: {
        trackId?: string;
        name?: string;
        startSec?: number;
        lengthSec?: number;
        sourcePath?: string;
    }) =>
        invoke<TimelineResult>(
            "add_clip",
            payload.trackId,
            payload.name,
            payload.startSec,
            payload.lengthSec,
            payload.sourcePath,
        ),

    removeClip: (clipId: string) => invoke<TimelineResult>("remove_clip", clipId),

    moveClip: (payload: { clipId: string; startSec: number; trackId?: string }) =>
        invoke<TimelineResult>(
            "move_clip",
            payload.clipId,
            payload.startSec,
            payload.trackId,
        ),

    setClipState: (payload: {
        clipId: string;
        startSec?: number;
        lengthSec?: number;
        gain?: number;
        muted?: boolean;
        trimStartSec?: number;
        trimEndSec?: number;
        playbackRate?: number;
        fadeInSec?: number;
        fadeOutSec?: number;
        color?: string;
    }) =>
        invoke<TimelineResult>(
            "set_clip_state",
            payload.clipId,
            payload.startSec,
            payload.lengthSec,
            payload.gain,
            payload.muted,
            payload.trimStartSec,
            payload.trimEndSec,
            payload.playbackRate,
            payload.fadeInSec,
            payload.fadeOutSec,
            payload.color,
        ),

    splitClip: (clipId: string, splitSec: number) =>
        invoke<TimelineResult>("split_clip", clipId, splitSec),

    glueClips: (clipIds: string[]) =>
        invoke<TimelineResult>("glue_clips", clipIds),

    selectClip: (clipId: string | null) =>
        invoke<TimelineResult>("select_clip", clipId),
};
