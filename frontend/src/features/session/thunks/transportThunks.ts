import { createAsyncThunk } from "@reduxjs/toolkit";
import { webApi } from "../../../services/webviewApi";

import type { SessionState } from "../sessionSlice";

export const fetchTimeline = createAsyncThunk(
    "session/fetchTimeline",
    async () => {
        return webApi.getTimelineState();
    },
);

export const stopAudioPlayback = createAsyncThunk(
    "session/stopAudioPlayback",
    async (options: { restoreAnchor?: boolean } | void, { getState }) => {
        const restoreAnchor = Boolean((options as any)?.restoreAnchor);
        const state = getState() as { session: SessionState };
        const anchorSec = state.session.playbackAnchorSec;
        const result = await webApi.stopAudio();
        // If restoreAnchor, sync backend transport to the anchor position
        if (restoreAnchor && anchorSec > 0) {
            await webApi.setTransport({ playheadSec: anchorSec });
        }
        return { ...result, restoreAnchor };
    },
);

export const seekPlayhead = createAsyncThunk(
    "session/seekPlayhead",
    async (beat: number, { getState, dispatch }) => {
        const state = getState() as { session: SessionState };
        if (state.session.runtime.isPlaying) {
            try {
                await dispatch(stopAudioPlayback()).unwrap();
            } catch {
                // Best-effort: still seek even if stopping fails.
            }
        }
        return webApi.setTransport({ playheadSec: beat });
    },
);

export const updateTransportBpm = createAsyncThunk(
    "session/updateTransportBpm",
    async (bpm: number) => {
        return webApi.setTransport({ bpm });
    },
);

export const syncPlaybackState = createAsyncThunk(
    "session/syncPlaybackState",
    async () => {
        return webApi.getPlaybackState();
    },
);

export const playOriginal = createAsyncThunk(
    "session/playOriginal",
    async (_, { getState }) => {
        const state = getState() as { session: SessionState };
        const anchorBeat = state.session.playheadSec;
        // Ensure backend transport is in sync before starting playback.
        await webApi.setTransport({ playheadSec: anchorBeat });
        const result = await webApi.playOriginal(0);
        return {
            ...result,
            clipId: null,
            anchorBeat,
        };
    },
);


