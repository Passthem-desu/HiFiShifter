import { createAsyncThunk } from "@reduxjs/toolkit";
import { webApi } from "../../../services/webviewApi";
import type { TimelineState } from "../../../types/api";
import type { ClipTemplate } from "../sessionTypes";

// 注意：这些 thunk 依赖 SessionState（目前仍在 sessionSlice.ts 内部定义）。
// 我们在此处用 type-only import，避免运行时循环依赖。
import type { SessionState } from "../sessionSlice";

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

export const createClipsRemote = createAsyncThunk(
    "session/createClipsRemote",
    async (
        payload: { templates: ClipTemplate[] },
        { getState, rejectWithValue },
    ) => {
        const state0 = getState() as { session: SessionState };
        const knownIds = new Set(state0.session.clips.map((c) => c.id));

        // 并行创建所有 clip，提升批量操作性能
        const results = await Promise.all(
            payload.templates.map(async (tpl) => {
                const added = await webApi.addClip({
                    trackId: tpl.trackId,
                    name: tpl.name,
                    startBeat: tpl.startBeat,
                    lengthBeats: tpl.lengthBeats,
                    sourcePath: tpl.sourcePath,
                });
                if (!(added as { ok?: boolean }).ok) {
                    throw new Error(
                        (added as { error?: { message?: string } }).error?.message ??
                            "add_clip_failed",
                    );
                }

                const createdId =
                    (added as TimelineState).clips.find((c) => !knownIds.has(c.id))
                        ?.id ?? null;
                if (!createdId) {
                    throw new Error("add_clip_failed");
                }

                const updated = await webApi.setClipState({
                    clipId: createdId,
                    lengthBeats: tpl.lengthBeats,
                    gain: tpl.gain,
                    muted: tpl.muted,
                    trimStartBeat: tpl.trimStartBeat,
                    trimEndBeat: tpl.trimEndBeat,
                    playbackRate: tpl.playbackRate,
                    fadeInBeats: tpl.fadeInBeats,
                    fadeOutBeats: tpl.fadeOutBeats,
                });
                if (!(updated as { ok?: boolean }).ok) {
                    throw new Error(
                        (updated as { error?: { message?: string } }).error?.message ??
                            "set_clip_state_failed",
                    );
                }

                return { createdId, timeline: updated as TimelineState };
            }),
        ).catch((err: unknown) => {
            return rejectWithValue(
                err instanceof Error ? err.message : "create_clips_failed",
            );
        });

        if (!results || !Array.isArray(results)) {
            return results as ReturnType<typeof rejectWithValue>;
        }

        const createdClipIds = results.map((r) => r.createdId);
        // 取最后一个 timeline 作为最终状态（各 clip 的 setClipState 结果）
        const lastTimeline = results[results.length - 1]?.timeline ?? null;
        if (!lastTimeline) {
            return rejectWithValue("create_clips_failed");
        }
        return {
            ...(lastTimeline as object),
            createdClipIds,
        } as TimelineState & { createdClipIds: string[] };
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
    async (payload: { clipId: string; startBeat: number; trackId?: string }) => {
        return webApi.moveClip(payload);
    },
);

export const setClipStateRemote = createAsyncThunk(
    "session/setClipStateRemote",
    async (payload: {
        clipId: string;
        name?: string;
        color?: string;
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
