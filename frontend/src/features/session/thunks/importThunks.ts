import { createAsyncThunk } from "@reduxjs/toolkit";
import { webApi } from "../../../services/webviewApi";
import type { SessionState } from "../sessionSlice";

import { addTrackRemote, setClipStateRemote } from "./timelineThunks";
import { computeAutoCrossfadeFromPayload } from "../../../components/layout/timeline/hooks/autoCrossfade";

const setAudioPathAction = (path: string) => ({
    type: "session/setAudioPath" as const,
    payload: path,
});
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

        dispatch(setAudioPathAction(picked.path));
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

export const importMultipleAudioFilesAtPosition = createAsyncThunk(
    "session/importMultipleAudioFilesAtPosition",
    async (
        payload: {
            files: File[];
            mode: "across-time" | "across-tracks";
            trackId?: string | null;
            startSec?: number;
        },
        { dispatch, rejectWithValue, getState },
    ) => {
        const { files, mode, startSec = 0 } = payload;
        if (!files || files.length === 0) return { ok: true };

        // Single file → delegate
        if (files.length === 1) {
            return dispatch(
                importAudioFileAtPosition({ file: files[0], trackId: payload.trackId, startSec }),
            ).unwrap();
        }

        dispatch({ type: "session/checkpointHistory" });
        await webApi.beginUndoGroup();
        try {
            const beforeClipIds = new Set(
                (getState() as { session: SessionState }).session.clips.map((c) => c.id),
            );

            const accumulatedNewClipIds: string[] = [];
            let lastImported: unknown = null;
            let firstImported: unknown = null;

            if (mode === "across-time") {
                let cursor = startSec;
                let targetTrackId: string | undefined;

                if (payload.trackId === null) {
                    const state = getState() as { session: SessionState };
                    const beforeIds = new Set(state.session.tracks.map((t) => t.id));
                    try {
                        const added = await dispatch(addTrackRemote({ name: undefined, parentTrackId: null })).unwrap();
                        targetTrackId =
                            added.tracks.find((t) => !beforeIds.has(t.id))?.id ??
                            added.selected_track_id ??
                            added.tracks[added.tracks.length - 1]?.id ??
                            undefined;
                    } catch {
                        return rejectWithValue("add_track_failed");
                    }
                } else {
                    targetTrackId = payload.trackId ?? undefined;
                }

                for (const file of files) {
                    const fileName = String(file.name ?? "dropped-audio");
                    const dataUrl = await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onerror = () => reject(new Error("read_failed"));
                        reader.onload = () => resolve(String(reader.result ?? ""));
                        reader.readAsDataURL(file);
                    });
                    const base64 = dataUrl.includes(",") ? dataUrl.split(",").slice(1).join(",") : dataUrl;

                    try {
                        const imported = await webApi.importAudioBytes(fileName, base64, targetTrackId, cursor);
                        if (!(imported as { ok?: boolean }).ok) continue;
                        if (!firstImported) firstImported = imported;
                        lastImported = imported;
                        const result = imported as { clips?: Array<{ id?: string; start_sec?: number; length_sec?: number }> };
                        for (const c of result.clips ?? []) if (c.id) accumulatedNewClipIds.push(c.id);
                        const newClip = result.clips?.find((c) => Math.abs((c.start_sec ?? 0) - cursor) < 0.01);
                        cursor += newClip?.length_sec ?? 0;
                    } catch {
                        // continue
                    }
                }
            } else {
                // across-tracks
                const state = getState() as { session: SessionState };
                const rootTracks = state.session.tracks.filter((t) => !t.parentId);
                let startIdx = 0;
                if (payload.trackId) {
                    const idx = rootTracks.findIndex((t) => t.id === payload.trackId);
                    if (idx >= 0) startIdx = idx;
                }

                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    const trackIdx = startIdx + i;
                    let targetTrackId: string | undefined;

                    if (trackIdx < rootTracks.length) {
                        targetTrackId = rootTracks[trackIdx].id;
                    } else {
                        const curState = getState() as { session: SessionState };
                        const beforeTrackIds = new Set(curState.session.tracks.map((t) => t.id));
                        try {
                            const added = await dispatch(addTrackRemote({ name: undefined, parentTrackId: null })).unwrap();
                            targetTrackId =
                                added.tracks.find((t) => !beforeTrackIds.has(t.id))?.id ??
                                added.selected_track_id ??
                                added.tracks[added.tracks.length - 1]?.id ??
                                undefined;
                        } catch {
                            continue;
                        }
                    }

                    const fileName = String(file.name ?? "dropped-audio");
                    const dataUrl = await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onerror = () => reject(new Error("read_failed"));
                        reader.onload = () => resolve(String(reader.result ?? ""));
                        reader.readAsDataURL(file);
                    });
                    const base64 = dataUrl.includes(",") ? dataUrl.split(",").slice(1).join(",") : dataUrl;

                    try {
                        const imported = await webApi.importAudioBytes(fileName, base64, targetTrackId, startSec);
                        if ((imported as { ok?: boolean }).ok) {
                            if (!firstImported) firstImported = imported;
                            lastImported = imported;
                            const result = imported as { clips?: Array<{ id?: string }> };
                            for (const c of result.clips ?? []) if (c.id) accumulatedNewClipIds.push(c.id);
                        }
                    } catch {
                        // continue
                    }
                }
            }

            const newClipIds = accumulatedNewClipIds.filter((id) => !!id && !beforeClipIds.has(id));

            if (newClipIds.length > 0) {
                const session = (getState() as { session: SessionState }).session;
                if (session.autoCrossfadeEnabled) {
                    const allClips = (lastImported as any)?.clips ?? [];
                    const fadeUpdates = computeAutoCrossfadeFromPayload(allClips, newClipIds);
                    if (fadeUpdates.length > 0) {
                        const fadePromises = fadeUpdates.map((u) =>
                            dispatch(
                                setClipStateRemote({ clipId: u.clipId, fadeInSec: u.fadeInSec, fadeOutSec: u.fadeOutSec }),
                            ).unwrap(),
                        );
                        await Promise.allSettled(fadePromises);
                    }
                }
            }

            return { ok: true, imported: firstImported ?? lastImported, newClipIds };
        } finally {
            void webApi.endUndoGroup();
        }
    },
);

export const importAudioFromPath = createAsyncThunk(
    "session/importAudioFromPath",
    async (audioPath: string, { dispatch, rejectWithValue }) => {
        dispatch(setAudioPathAction(audioPath));
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
        payload: {
            audioPath: string;
            trackId?: string | null;
            startSec?: number;
        },
        { dispatch, rejectWithValue, getState },
    ) => {
        dispatch(setAudioPathAction(payload.audioPath));

        let targetTrackId: string | undefined;
        if (payload.trackId === null) {
            // Explicit null means: create a new track and import into it.
            const state = getState() as { session: SessionState };
            const beforeIds = new Set(state.session.tracks.map((t) => t.id));
            try {
                const added = await dispatch(
                    addTrackRemote({ name: undefined, parentTrackId: null }),
                ).unwrap();
                const createdId =
                    added.tracks.find((t) => !beforeIds.has(t.id))?.id ??
                    added.selected_track_id ??
                    added.tracks[added.tracks.length - 1]?.id ??
                    null;
                if (!createdId) {
                    return rejectWithValue("add_track_failed");
                }
                targetTrackId = createdId;
            } catch (err) {
                return rejectWithValue(
                    err instanceof Error ? err.message : "add_track_failed",
                );
            }
        } else {
            targetTrackId = payload.trackId ?? undefined;
        }

        const beforeClipIds = new Set(
            (getState() as { session: SessionState }).session.clips.map((c) => c.id),
        );

        const imported = await webApi.importAudioItem(
            payload.audioPath,
            targetTrackId,
            payload.startSec,
        );
        if (!(imported as { ok?: boolean }).ok) {
            return rejectWithValue(
                (imported as { error?: { message?: string } }).error?.message ??
                    "import_audio_item_failed",
            );
        }

        // Detect newly created clip IDs for auto-crossfade after state update
        const result = imported as { clips?: Array<{ id?: string }> };
        const newClipIds = (result.clips ?? [])
            .map((c) => c.id)
            .filter((id): id is string => !!id && !beforeClipIds.has(id));

        // After the fulfilled reducer applies auto-crossfade in-state,
        // sync the fade values to the backend on the next tick.
        if (newClipIds.length > 0) {
            setTimeout(() => {
                const session = (getState() as { session: SessionState }).session;
                if (!session.autoCrossfadeEnabled) return;

                const toSync = new Set<string>();
                for (const clipId of newClipIds) {
                    const clip = session.clips.find((c) => c.id === clipId);
                    if (!clip) continue;
                    if (clip.fadeInSec > 0 || clip.fadeOutSec > 0) {
                        toSync.add(clipId);
                    }
                }

                // include neighboring clips on the same tracks
                for (const nid of newClipIds) {
                    const nc = session.clips.find((c) => c.id === nid);
                    if (!nc) continue;
                    const neighbors = session.clips.filter(
                        (c) => c.trackId === nc.trackId && c.id !== nid,
                    );
                    for (const n of neighbors) {
                        if (n.fadeInSec > 0 || n.fadeOutSec > 0) toSync.add(n.id);
                    }
                }

                for (const clipId of Array.from(toSync)) {
                    const clip = session.clips.find((c) => c.id === clipId);
                    if (!clip) continue;
                    void dispatch(
                        setClipStateRemote({
                            clipId,
                            fadeInSec: clip.fadeInSec,
                            fadeOutSec: clip.fadeOutSec,
                        }),
                    );
                }
            }, 0);
        }

        return {
            ok: true,
            imported,
            newClipIds,
        };
    },
);

export const importAudioFileAtPosition = createAsyncThunk(
    "session/importAudioFileAtPosition",
    async (
        payload: { file: File; trackId?: string | null; startSec?: number },
        { dispatch, rejectWithValue, getState },
    ) => {
        try {
            let targetTrackId: string | undefined;
            if (payload.trackId === null) {
                const state = getState() as { session: SessionState };
                const beforeIds = new Set(state.session.tracks.map((t) => t.id));
                const added = await dispatch(
                    addTrackRemote({ name: undefined, parentTrackId: null }),
                ).unwrap();
                const createdId =
                    added.tracks.find((t) => !beforeIds.has(t.id))?.id ??
                    added.selected_track_id ??
                    added.tracks[added.tracks.length - 1]?.id ??
                    null;
                if (!createdId) {
                    return rejectWithValue("add_track_failed");
                }
                targetTrackId = createdId;
            } else {
                targetTrackId = payload.trackId ?? undefined;
            }

            const beforeClipIds = new Set(
                (getState() as { session: SessionState }).session.clips.map((c) => c.id),
            );

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
                targetTrackId,
                payload.startSec,
            );
            if (!(imported as { ok?: boolean }).ok) {
                return rejectWithValue(
                    (imported as { error?: { message?: string } }).error?.message ??
                        "import_audio_bytes_failed",
                );
            }

            const result = imported as { clips?: Array<{ id?: string }> };
            const newClipIds = (result.clips ?? [])
                .map((c) => c.id)
                .filter((id): id is string => !!id && !beforeClipIds.has(id));

            if (newClipIds.length > 0) {
                setTimeout(() => {
                    const session = (getState() as { session: SessionState }).session;
                    if (!session.autoCrossfadeEnabled) return;
                    for (const clipId of newClipIds) {
                        const clip = session.clips.find((c) => c.id === clipId);
                        if (!clip) continue;
                        if (clip.fadeInSec > 0 || clip.fadeOutSec > 0) {
                            void dispatch(
                                setClipStateRemote({
                                    clipId,
                                    fadeInSec: clip.fadeInSec,
                                    fadeOutSec: clip.fadeOutSec,
                                }),
                            );
                        }
                    }
                }, 0);
            }

            return {
                ok: true,
                imported,
                newClipIds,
            };
        } catch (err) {
            return rejectWithValue(
                err instanceof Error ? err.message : "import_audio_bytes_failed",
            );
        }
    },
);

/**
 * 多文件导入，支持两种模式:
 * - "across-time": 在同一轨道依次排列（按顺序首尾相连）
 * - "across-tracks": 每个文件分配到不同的新轨道，起始位置相同
 */
export const importMultipleAudioAtPosition = createAsyncThunk(
    "session/importMultipleAudioAtPosition",
    async (
        payload: {
            audioPaths: string[];
            mode: "across-time" | "across-tracks";
            trackId?: string | null;
            startSec?: number;
        },
        { dispatch, rejectWithValue, getState },
    ) => {
        const { audioPaths, mode, startSec = 0 } = payload;
        if (audioPaths.length === 0) return { ok: true };

        // Single file → delegate to importAudioAtPosition
        if (audioPaths.length === 1) {
            return dispatch(
                importAudioAtPosition({
                    audioPath: audioPaths[0],
                    trackId: payload.trackId,
                    startSec,
                }),
            ).unwrap();
        }

        // Create a single undo checkpoint for the entire batch
        dispatch({ type: "session/checkpointHistory" });

        const beforeClipIds = new Set(
            (getState() as { session: SessionState }).session.clips.map((c) => c.id),
        );

        let lastImported: unknown = null;
        let firstImported: unknown = null;

        if (mode === "across-time") {
            // Import files sequentially on the same track
            let cursor = startSec;
            let targetTrackId: string | undefined;

            if (payload.trackId === null) {
                // Create a new track
                const state = getState() as { session: SessionState };
                const beforeIds = new Set(state.session.tracks.map((t) => t.id));
                try {
                    const added = await dispatch(
                        addTrackRemote({ name: undefined, parentTrackId: null }),
                    ).unwrap();
                    targetTrackId =
                        added.tracks.find((t) => !beforeIds.has(t.id))?.id ??
                        added.selected_track_id ??
                        added.tracks[added.tracks.length - 1]?.id ??
                        undefined;
                } catch {
                    return rejectWithValue("add_track_failed");
                }
            } else {
                targetTrackId = payload.trackId ?? undefined;
            }

                for (const audioPath of audioPaths) {
                const imported = await webApi.importAudioItem(
                    audioPath,
                    targetTrackId,
                    cursor,
                );
                if (!(imported as { ok?: boolean }).ok) continue;
                if (!firstImported) firstImported = imported;
                lastImported = imported;
                // Find the newly imported clip to advance cursor
                const result = imported as { clips?: Array<{ start_sec?: number; length_sec?: number }> };
                const allClips = result.clips ?? [];
                // The last clip at cursor position is likely the one just imported
                const newClip = allClips.find(
                    (c) => Math.abs((c.start_sec ?? 0) - cursor) < 0.01,
                );
                cursor += newClip?.length_sec ?? 0;
            }
        } else {
            // "across-tracks" — each file on a new track at the same start position
            for (const audioPath of audioPaths) {
                const state = getState() as { session: SessionState };
                const beforeTrackIds = new Set(state.session.tracks.map((t) => t.id));
                try {
                    const added = await dispatch(
                        addTrackRemote({ name: undefined, parentTrackId: null }),
                    ).unwrap();
                    const newTrackId =
                        added.tracks.find((t) => !beforeTrackIds.has(t.id))?.id ??
                        added.selected_track_id ??
                        added.tracks[added.tracks.length - 1]?.id ??
                        undefined;
                    const imported = await webApi.importAudioItem(audioPath, newTrackId, startSec);
                    if ((imported as { ok?: boolean }).ok) lastImported = imported;
                } catch {
                    // Continue with remaining files
                }
            }
        }

        // Detect all new clips created during the batch
        const afterState = getState() as { session: SessionState };
        const newClipIds = afterState.session.clips
            .map((c) => c.id)
            .filter((id) => !beforeClipIds.has(id));

        if (newClipIds.length > 0) {
            setTimeout(() => {
                const session = (getState() as { session: SessionState }).session;
                if (!session.autoCrossfadeEnabled) return;
                for (const clipId of newClipIds) {
                    const clip = session.clips.find((c) => c.id === clipId);
                    if (!clip) continue;
                    if (clip.fadeInSec > 0 || clip.fadeOutSec > 0) {
                        void dispatch(
                            setClipStateRemote({
                                clipId,
                                fadeInSec: clip.fadeInSec,
                                fadeOutSec: clip.fadeOutSec,
                            }),
                        );
                    }
                }
            }, 0);
        }

        // Prefer returning the first import response so playhead remains at the
        // first imported clip's start (backend timeline.playhead_sec),
        // which matches user expectation.
        return { ok: true, imported: firstImported ?? lastImported, newClipIds };
    },
);
