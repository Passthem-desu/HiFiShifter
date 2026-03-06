import type { ParamFramesPayload } from "../../types/api";

import { invoke } from "../invoke";

export const paramsApi = {
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

    pasteVocalShifterClipboard: () =>
        invoke<{ ok: boolean; error?: string; updated?: number }>(
            "paste_vocalshifter_clipboard",
        ),
};
