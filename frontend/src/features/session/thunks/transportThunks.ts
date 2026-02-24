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
    async () => {
        return webApi.stopAudio();
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
        return webApi.setTransport({ playheadBeat: beat });
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
        const anchorBeat = state.session.playheadBeat;
        // Ensure backend transport is in sync before starting playback.
        await webApi.setTransport({ playheadBeat: anchorBeat });
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
        // Ensure backend transport is in sync before starting playback.
        await webApi.setTransport({ playheadBeat: anchorBeat });
        const result = await webApi.playSynthesized(0);
        return {
            ...result,
            clipId: null,
            anchorBeat,
        };
    },
);
