import { useRef } from "react";
import type { AppDispatch } from "../../../../app/store";
import type { SessionState } from "../../../../features/session/sessionSlice";
import {
    checkpointHistory,
    moveClipRemote,
    moveClipStart,
    setClipFades,
    setClipGain,
    setClipLength,
    setClipPlaybackRate,
    setClipStateRemote,
    setClipTrim,
} from "../../../../features/session/sessionSlice";
import { clamp, gainToDb, dbToGain } from "../math";
import { clipSourceBeats } from "../clipWaveform";

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
    baseStartBeat: number;
    baseLengthBeats: number;
    basePlaybackRate: number;
    baseTrimStartBeat: number;
    baseTrimEndBeat: number;
    baseFadeInBeats: number;
    baseFadeOutBeats: number;
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
        const rightEdgeBeat = clip.startBeat + clip.lengthBeats;

        dispatch(checkpointHistory());

        editDragRef.current = {
            type,
            pointerId: e.pointerId,
            clipId,
            baseStartBeat: clip.startBeat,
            baseLengthBeats: clip.lengthBeats,
            basePlaybackRate: Number(clip.playbackRate ?? 1) || 1,
            baseTrimStartBeat: clip.trimStartBeat,
            baseTrimEndBeat: clip.trimEndBeat,
            baseFadeInBeats: clip.fadeInBeats,
            baseFadeOutBeats: clip.fadeOutBeats,
            baseGain: clip.gain,
            sourceBeats: clipSourceBeats(clip, sessionRef.current.bpm),
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
                const raw = beat - drag.baseStartBeat;
                const next = clamp(raw, 0, Math.max(0, drag.baseLengthBeats));
                dispatch(setClipFades({ clipId: drag.clipId, fadeInBeats: next }));
                return;
            }
            if (drag.type === "fade_out") {
                const raw = drag.rightEdgeBeat - beat;
                const next = clamp(raw, 0, Math.max(0, drag.baseLengthBeats));
                dispatch(setClipFades({ clipId: drag.clipId, fadeOutBeats: next }));
                return;
            }
            if (drag.type === "gain") {
                const movementY = (ev.movementY ?? 0) as number;
                const deltaDb = -movementY * 0.25;
                const nextDb = clamp(gainToDb(clipNow.gain) + deltaDb, -24, 12);
                const nextGain = clamp(dbToGain(nextDb), 0, 2);
                dispatch(setClipGain({ clipId: drag.clipId, gain: nextGain }));
                return;
            }

            if (drag.type === "trim_left") {
                const desiredStart = clamp(beat, 0, drag.rightEdgeBeat - minLen);
                const desiredDelta = desiredStart - drag.baseStartBeat;
                const rate =
                    Number(clipNow.playbackRate ?? 1) > 0
                        ? Number(clipNow.playbackRate ?? 1)
                        : 1;
                let nextTrimStart = drag.baseTrimStartBeat + desiredDelta * rate;
                nextTrimStart = Math.max(0, nextTrimStart);
                const actualDeltaTrim = nextTrimStart - drag.baseTrimStartBeat;
                const actualDeltaTimeline = actualDeltaTrim / rate;
                const nextStart = drag.baseStartBeat + actualDeltaTimeline;
                const nextLen = clamp(drag.baseLengthBeats - actualDeltaTimeline, minLen, 10_000);
                dispatch(moveClipStart({ clipId: drag.clipId, startBeat: nextStart }));
                dispatch(setClipLength({ clipId: drag.clipId, lengthBeats: nextLen }));
                dispatch(setClipTrim({ clipId: drag.clipId, trimStartBeat: nextTrimStart }));
                return;
            }

            if (drag.type === "stretch_left") {
                const desiredStart = clamp(beat, 0, drag.rightEdgeBeat - minLen);
                const nextStart = desiredStart;
                const nextLen = clamp(drag.rightEdgeBeat - nextStart, minLen, 10_000);
                const baseLen = Math.max(1e-6, Number(drag.baseLengthBeats) || 0);
                const baseRate =
                    drag.basePlaybackRate > 0 && Number.isFinite(drag.basePlaybackRate)
                        ? drag.basePlaybackRate
                        : 1;
                const nextRate = clamp((baseRate * baseLen) / Math.max(1e-6, nextLen), 0.1, 10);
                dispatch(moveClipStart({ clipId: drag.clipId, startBeat: nextStart }));
                dispatch(setClipLength({ clipId: drag.clipId, lengthBeats: nextLen }));
                dispatch(setClipPlaybackRate({ clipId: drag.clipId, playbackRate: nextRate }));
                return;
            }

            if (drag.type === "trim_right") {
                const desiredRight = clamp(beat, drag.baseStartBeat + minLen, 10_000);
                const rate =
                    Number(clipNow.playbackRate ?? 1) > 0
                        ? Number(clipNow.playbackRate ?? 1)
                        : 1;
                const desiredLen = desiredRight - drag.baseStartBeat;
                const nextLen = clamp(desiredLen, minLen, 10_000);
                const usedDeltaTimeline = nextLen - drag.baseLengthBeats;
                let nextTrimEnd = drag.baseTrimEndBeat - usedDeltaTimeline * rate;
                nextTrimEnd = Math.max(0, nextTrimEnd);
                dispatch(setClipLength({ clipId: drag.clipId, lengthBeats: nextLen }));
                dispatch(setClipTrim({ clipId: drag.clipId, trimEndBeat: nextTrimEnd }));
                return;
            }

            if (drag.type === "stretch_right") {
                const desiredRight = clamp(beat, drag.baseStartBeat + minLen, 10_000);
                const nextLen = clamp(desiredRight - drag.baseStartBeat, minLen, 10_000);
                const baseLen = Math.max(1e-6, Number(drag.baseLengthBeats) || 0);
                const baseRate =
                    drag.basePlaybackRate > 0 && Number.isFinite(drag.basePlaybackRate)
                        ? drag.basePlaybackRate
                        : 1;
                const nextRate = clamp((baseRate * baseLen) / Math.max(1e-6, nextLen), 0.1, 10);
                dispatch(setClipLength({ clipId: drag.clipId, lengthBeats: nextLen }));
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
                void dispatch(moveClipRemote({ clipId: drag.clipId, startBeat: clipNow.startBeat, trackId: clipNow.trackId }));
                void dispatch(setClipStateRemote({ clipId: drag.clipId, lengthBeats: clipNow.lengthBeats, trimStartBeat: clipNow.trimStartBeat }));
            } else if (drag.type === "trim_right") {
                void dispatch(setClipStateRemote({ clipId: drag.clipId, lengthBeats: clipNow.lengthBeats, trimEndBeat: clipNow.trimEndBeat }));
            } else if (drag.type === "stretch_left") {
                void dispatch(moveClipRemote({ clipId: drag.clipId, startBeat: clipNow.startBeat, trackId: clipNow.trackId }));
                void dispatch(setClipStateRemote({ clipId: drag.clipId, lengthBeats: clipNow.lengthBeats, playbackRate: clipNow.playbackRate }));
            } else if (drag.type === "stretch_right") {
                void dispatch(setClipStateRemote({ clipId: drag.clipId, lengthBeats: clipNow.lengthBeats, playbackRate: clipNow.playbackRate }));
            } else if (drag.type === "fade_in") {
                void dispatch(setClipStateRemote({ clipId: drag.clipId, fadeInBeats: clipNow.fadeInBeats }));
            } else if (drag.type === "fade_out") {
                void dispatch(setClipStateRemote({ clipId: drag.clipId, fadeOutBeats: clipNow.fadeOutBeats }));
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
