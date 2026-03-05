import { useRef } from "react";
import type { AppDispatch } from "../../../../app/store";
import type { SessionState } from "../../../../features/session/sessionSlice";
import {
    checkpointHistory,
    moveClipStart,
    setClipFades,
    setClipGain,
    setClipLength,
    setClipPlaybackRate,
    setClipStateRemote,
    setClipTrim,
} from "../../../../features/session/sessionSlice";
import { clamp, gainToDb, dbToGain } from "../math";

export type EditDragType =
    | "trim_left"
    | "trim_right"
    | "stretch_left"
    | "stretch_right"
    | "fade_in"
    | "fade_out"
    | "gain";

export type EditDragState = {
    type: EditDragType;
    pointerId: number;
    clipId: string;
    basestartSec: number;
    baselengthSec: number;
    basePlaybackRate: number;
    baseTrimStartSec: number;
    basetrimEndSec: number;
    basefadeInSec: number;
    basefadeOutSec: number;
    baseGain: number;
    sourceBeats: number | null;
    rightEdgeBeat: number;
};

export function useEditDrag(deps: {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    sessionRef: React.RefObject<SessionState>;
    dispatch: AppDispatch;
    snapBeat: (beat: number) => number;
    beatFromClientX: (clientX: number, bounds: DOMRect, xScroll: number) => number;
}) {
    const { scrollRef, sessionRef, dispatch, snapBeat, beatFromClientX } = deps;

    const editDragRef = useRef<EditDragState | null>(null);

    function startEditDrag(
        e: React.PointerEvent,
        clipId: string,
        type: EditDragType,
    ) {
        if (e.button !== 0) return;
        const clip = sessionRef.current.clips.find((c) => c.id === clipId);
        if (!clip) return;
        const scroller = scrollRef.current;
        if (!scroller) return;
        const rightEdgeBeat = clip.startSec + clip.lengthSec;

        dispatch(checkpointHistory());

        editDragRef.current = {
            type,
            pointerId: e.pointerId,
            clipId,
            basestartSec: clip.startSec,
            baselengthSec: clip.lengthSec,
            basePlaybackRate: Number(clip.playbackRate ?? 1) || 1,
            baseTrimStartSec: clip.trimStartSec,
            basetrimEndSec: clip.trimEndSec,
            basefadeInSec: clip.fadeInSec,
            basefadeOutSec: clip.fadeOutSec,
            baseGain: clip.gain,
            sourceBeats: null,
            rightEdgeBeat,
        };

        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

        function onMove(ev: PointerEvent) {
            const drag = editDragRef.current;
            const el = scrollRef.current;
            if (!drag || drag.pointerId !== e.pointerId || !el) return;
            const b = el.getBoundingClientRect();
            let beat = beatFromClientX(ev.clientX, b, el.scrollLeft);
            const shouldSnap =
                drag.type === "trim_left" ||
                drag.type === "trim_right" ||
                drag.type === "stretch_left" ||
                drag.type === "stretch_right";
            if (shouldSnap && !ev.shiftKey) beat = snapBeat(beat);

            const clipNow = sessionRef.current.clips.find((c) => c.id === drag.clipId);
            if (!clipNow) return;

            const minLen = 0.0;
            if (drag.type === "fade_in") {
                const raw = beat - drag.basestartSec;
                const next = clamp(raw, 0, Math.max(0, drag.baselengthSec));
                dispatch(setClipFades({ clipId: drag.clipId, fadeInSec: next }));
                return;
            }
            if (drag.type === "fade_out") {
                const raw = drag.rightEdgeBeat - beat;
                const next = clamp(raw, 0, Math.max(0, drag.baselengthSec));
                dispatch(setClipFades({ clipId: drag.clipId, fadeOutSec: next }));
                return;
            }
            if (drag.type === "gain") {
                const movementY = (ev.movementY ?? 0) as number;
                const deltaDb = -movementY * 0.25;
                const nextDb = clamp(gainToDb(clipNow.gain) + deltaDb, -12, 12);
                const nextGain = clamp(dbToGain(nextDb), dbToGain(-12), dbToGain(12));
                dispatch(setClipGain({ clipId: drag.clipId, gain: nextGain }));
                return;
            }

            if (drag.type === "trim_left") {
                const desiredStart = clamp(beat, 0, drag.rightEdgeBeat - minLen);
                const desiredDelta = desiredStart - drag.basestartSec;
                const rate =
                    Number(clipNow.playbackRate ?? 1) > 0
                        ? Number(clipNow.playbackRate ?? 1)
                        : 1;
                let nextTrimStart = drag.baseTrimStartSec + desiredDelta * rate;
                nextTrimStart = Math.max(0, nextTrimStart);
                const actualDeltaTrim = nextTrimStart - drag.baseTrimStartSec;
                const actualDeltaTimeline = actualDeltaTrim / rate;
                const nextStart = drag.basestartSec + actualDeltaTimeline;
                const nextLen = clamp(drag.baselengthSec - actualDeltaTimeline, minLen, 10_000);
                dispatch(moveClipStart({ clipId: drag.clipId, startSec: nextStart }));
                dispatch(setClipLength({ clipId: drag.clipId, lengthSec: nextLen }));
                dispatch(setClipTrim({ clipId: drag.clipId, trimStartSec: nextTrimStart }));
                return;
            }

            if (drag.type === "stretch_left") {
                const desiredStart = clamp(beat, 0, drag.rightEdgeBeat - minLen);
                const nextStart = desiredStart;
                const nextLen = clamp(drag.rightEdgeBeat - nextStart, minLen, 10_000);
                const baseLen = Math.max(1e-6, Number(drag.baselengthSec) || 0);
                const baseRate =
                    drag.basePlaybackRate > 0 && Number.isFinite(drag.basePlaybackRate)
                        ? drag.basePlaybackRate
                        : 1;
                const nextRate = clamp((baseRate * baseLen) / Math.max(1e-6, nextLen), 0.1, 10);
                dispatch(moveClipStart({ clipId: drag.clipId, startSec: nextStart }));
                dispatch(setClipLength({ clipId: drag.clipId, lengthSec: nextLen }));
                dispatch(setClipPlaybackRate({ clipId: drag.clipId, playbackRate: nextRate }));
                return;
            }

            if (drag.type === "trim_right") {
                const desiredRight = clamp(beat, drag.basestartSec + minLen, 10_000);
                const rate =
                    Number(clipNow.playbackRate ?? 1) > 0
                        ? Number(clipNow.playbackRate ?? 1)
                        : 1;
                const desiredLen = desiredRight - drag.basestartSec;
                const nextLen = clamp(desiredLen, minLen, 10_000);
                const usedDeltaTimeline = nextLen - drag.baselengthSec;
                let nextTrimEnd = drag.basetrimEndSec - usedDeltaTimeline * rate;
                nextTrimEnd = Math.max(0, nextTrimEnd);
                dispatch(setClipLength({ clipId: drag.clipId, lengthSec: nextLen }));
                dispatch(setClipTrim({ clipId: drag.clipId, trimEndSec: nextTrimEnd }));
                return;
            }

            if (drag.type === "stretch_right") {
                const desiredRight = clamp(beat, drag.basestartSec + minLen, 10_000);
                const nextLen = clamp(desiredRight - drag.basestartSec, minLen, 10_000);
                const baseLen = Math.max(1e-6, Number(drag.baselengthSec) || 0);
                const baseRate =
                    drag.basePlaybackRate > 0 && Number.isFinite(drag.basePlaybackRate)
                        ? drag.basePlaybackRate
                        : 1;
                const nextRate = clamp((baseRate * baseLen) / Math.max(1e-6, nextLen), 0.1, 10);
                dispatch(setClipLength({ clipId: drag.clipId, lengthSec: nextLen }));
                dispatch(setClipPlaybackRate({ clipId: drag.clipId, playbackRate: nextRate }));
            }
        }

        function end() {
            const drag = editDragRef.current;
            if (!drag || drag.pointerId !== e.pointerId) return;
            editDragRef.current = null;

            const clipNow = sessionRef.current.clips.find((c) => c.id === drag.clipId);
            if (!clipNow) return;

            if (drag.type === "trim_left") {
                void dispatch(setClipStateRemote({ clipId: drag.clipId, startSec: clipNow.startSec, lengthSec: clipNow.lengthSec, trimStartSec: clipNow.trimStartSec }));
            } else if (drag.type === "trim_right") {
                void dispatch(setClipStateRemote({ clipId: drag.clipId, lengthSec: clipNow.lengthSec, trimEndSec: clipNow.trimEndSec }));
            } else if (drag.type === "stretch_left") {
                void dispatch(setClipStateRemote({ clipId: drag.clipId, startSec: clipNow.startSec, lengthSec: clipNow.lengthSec, playbackRate: clipNow.playbackRate }));
            } else if (drag.type === "stretch_right") {
                void dispatch(setClipStateRemote({ clipId: drag.clipId, lengthSec: clipNow.lengthSec, playbackRate: clipNow.playbackRate }));
            } else if (drag.type === "fade_in") {
                void dispatch(setClipStateRemote({ clipId: drag.clipId, fadeInSec: clipNow.fadeInSec }));
            } else if (drag.type === "fade_out") {
                void dispatch(setClipStateRemote({ clipId: drag.clipId, fadeOutSec: clipNow.fadeOutSec }));
            } else if (drag.type === "gain") {
                void dispatch(setClipStateRemote({ clipId: drag.clipId, gain: clipNow.gain }));
            }

            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
        }

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
    }

    return { editDragRef, startEditDrag };
}
