import { createAsyncThunk } from "@reduxjs/toolkit";
import { webApi } from "../../../services/webviewApi";
import type { SessionState } from "../sessionSlice";

import { addTrackRemote } from "./timelineThunks";

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
        return {
            ok: true,
            imported,
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
            return {
                ok: true,
                imported,
            };
        } catch (err) {
            return rejectWithValue(
                err instanceof Error ? err.message : "import_audio_bytes_failed",
            );
        }
    },
);
