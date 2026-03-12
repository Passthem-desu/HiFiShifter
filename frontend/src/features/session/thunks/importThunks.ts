import { createAsyncThunk } from "@reduxjs/toolkit";
import { webApi } from "../../../services/webviewApi";
import type { SessionState } from "../sessionSlice";

import { addTrackRemote, setClipStateRemote } from "./timelineThunks";

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

        await webApi.beginUndoGroup();
        try {
            let targetTrackId: string | undefined;
            if (payload.trackId === null) {
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

            const result = imported as { clips?: Array<{ id?: string }> };
            const newClipIds = (result.clips ?? [])
                .map((c) => c.id)
                .filter((id): id is string => !!id && !beforeClipIds.has(id));

            // Wait for fulfilled reducer to apply auto-crossfade in-state, then sync fades to backend
            if (newClipIds.length > 0) {
                await new Promise((r) => setTimeout(r, 0));
                const session = (getState() as { session: SessionState }).session;
                if (session.autoCrossfadeEnabled) {
                    const fadePromises: Promise<unknown>[] = [];
                    for (const clipId of newClipIds) {
                        const clip = session.clips.find((c) => c.id === clipId);
                        if (!clip) continue;
                        if (clip.fadeInSec > 0 || clip.fadeOutSec > 0) {
                            fadePromises.push(
                                dispatch(
                                    setClipStateRemote({
                                        clipId,
                                        fadeInSec: clip.fadeInSec,
                                        fadeOutSec: clip.fadeOutSec,
                                    }),
                                ).unwrap(),
                            );
                        }
                    }
                    const sameTrackClips = session.clips.filter(
                        (c) => newClipIds.some((nid) => {
                            const nc = session.clips.find((x) => x.id === nid);
                            return nc && c.trackId === nc.trackId && c.id !== nid;
                        }),
                    );
                    for (const clip of sameTrackClips) {
                        if (clip.fadeInSec > 0 || clip.fadeOutSec > 0) {
                            fadePromises.push(
                                dispatch(
                                    setClipStateRemote({
                                        clipId: clip.id,
                                        fadeInSec: clip.fadeInSec,
                                        fadeOutSec: clip.fadeOutSec,
                                    }),
                                ).unwrap(),
                            );
                        }
                    }
                    await Promise.allSettled(fadePromises);
                }
            }

            return {
                ok: true,
                imported,
                newClipIds,
            };
        } finally {
            void webApi.endUndoGroup();
        }
    },
);

export const importAudioFileAtPosition = createAsyncThunk(
    "session/importAudioFileAtPosition",
    async (
        payload: { file: File; trackId?: string | null; startSec?: number },
        { dispatch, rejectWithValue, getState },
    ) => {
        await webApi.beginUndoGroup();
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
                await new Promise((r) => setTimeout(r, 0));
                const session = (getState() as { session: SessionState }).session;
                if (session.autoCrossfadeEnabled) {
                    const fadePromises: Promise<unknown>[] = [];
                    for (const clipId of newClipIds) {
                        const clip = session.clips.find((c) => c.id === clipId);
                        if (!clip) continue;
                        if (clip.fadeInSec > 0 || clip.fadeOutSec > 0) {
                            fadePromises.push(
                                dispatch(
                                    setClipStateRemote({
                                        clipId,
                                        fadeInSec: clip.fadeInSec,
                                        fadeOutSec: clip.fadeOutSec,
                                    }),
                                ).unwrap(),
                            );
                        }
                    }
                    await Promise.allSettled(fadePromises);
                }
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
        } finally {
            void webApi.endUndoGroup();
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

        await webApi.beginUndoGroup();
        try {
            const beforeClipIds = new Set(
                (getState() as { session: SessionState }).session.clips.map((c) => c.id),
            );

            let lastImported: unknown = null;

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
                    lastImported = imported;
                    const result = imported as { clips?: Array<{ start_sec?: number; length_sec?: number }> };
                    const allClips = result.clips ?? [];
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

            // Sync auto-crossfade to backend within undo group
            if (newClipIds.length > 0) {
                await new Promise((r) => setTimeout(r, 0));
                const session = (getState() as { session: SessionState }).session;
                if (session.autoCrossfadeEnabled) {
                    const fadePromises: Promise<unknown>[] = [];
                    for (const clipId of newClipIds) {
                        const clip = session.clips.find((c) => c.id === clipId);
                        if (!clip) continue;
                        if (clip.fadeInSec > 0 || clip.fadeOutSec > 0) {
                            fadePromises.push(
                                dispatch(
                                    setClipStateRemote({
                                        clipId,
                                        fadeInSec: clip.fadeInSec,
                                        fadeOutSec: clip.fadeOutSec,
                                    }),
                                ).unwrap(),
                            );
                        }
                    }
                    await Promise.allSettled(fadePromises);
                }
            }

            return { ok: true, imported: lastImported, newClipIds };
        } finally {
            void webApi.endUndoGroup();
        }
    },
);
