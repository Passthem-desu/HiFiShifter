import { useRef } from "react";
import type { AppDispatch } from "../../../../app/store";
import type { SessionState } from "../../../../features/session/sessionSlice";
import {
    checkpointHistory,
    setClipStateRemote,
    setClipTrim,
} from "../../../../features/session/sessionSlice";
import { clamp } from "../math";
import { clipSourceBeats } from "../clipWaveform";

export type SlipDragState = {
    pointerId: number;
    anchorClipId: string;
    clipIds: string[];
    initialPointerBeat: number;
    initialById: Record<
        string,
        {
            trimStartBeat: number;
            trimEndBeat: number;
            playbackRate: number;
            sourceBeats: number | null;
            maxSlipBeats: number;
        }
    >;
};

export function useSlipDrag(deps: {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    sessionRef: React.RefObject<SessionState>;
    dispatch: AppDispatch;
    multiSelectedClipIds: string[];
    multiSelectedSet: Set<string>;
    beatFromClientX: (clientX: number, bounds: DOMRect, xScroll: number) => number;
}) {
    const {
        scrollRef,
        sessionRef,
        dispatch,
        multiSelectedClipIds,
        multiSelectedSet,
        beatFromClientX,
    } = deps;

    const slipDragRef = useRef<SlipDragState | null>(null);

    function startSlipDrag(
        e: React.PointerEvent<HTMLDivElement>,
        clipId: string,
    ) {
        if (e.button !== 0) return;
        const anchor = sessionRef.current.clips.find((c) => c.id === clipId);
        if (!anchor) return;
        const scroller = scrollRef.current;
        if (!scroller) return;

        dispatch(checkpointHistory());

        const bounds = scroller.getBoundingClientRect();
        const beatAtPointer = beatFromClientX(e.clientX, bounds, scroller.scrollLeft);

        const clipIds =
            multiSelectedClipIds.length > 0 && multiSelectedSet.has(clipId)
                ? [...multiSelectedClipIds]
                : [clipId];

        const initialById: SlipDragState["initialById"] = {};
        const bpm = Number(sessionRef.current.bpm ?? 120) || 120;
        for (const id of clipIds) {
            const c = sessionRef.current.clips.find((x) => x.id === id);
            if (!c) continue;
            const sourceBeats = clipSourceBeats(c, bpm);
            const trimStartBeat = Number(c.trimStartBeat ?? 0) || 0;
            const trimEndBeat = Math.max(0, Number(c.trimEndBeat ?? 0) || 0);
            const maxSlipBeats =
                sourceBeats != null && Number.isFinite(sourceBeats)
                    ? Math.max(0, Number(sourceBeats))
                    : Math.max(0, Number(c.lengthBeats ?? 0) || 0);
            initialById[id] = {
                trimStartBeat,
                trimEndBeat,
                playbackRate: Number(c.playbackRate ?? 1) || 1,
                sourceBeats,
                maxSlipBeats,
            };
        }

        slipDragRef.current = {
            pointerId: e.pointerId,
            anchorClipId: clipId,
            clipIds,
            initialPointerBeat: beatAtPointer,
            initialById,
        };

        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);

        function onMove(ev: PointerEvent) {
            const drag = slipDragRef.current;
            const el = scrollRef.current;
            if (!drag || drag.pointerId !== e.pointerId || !el) return;
            const b = el.getBoundingClientRect();
            const beatNow = beatFromClientX(ev.clientX, b, el.scrollLeft);
            let deltaBeat = drag.initialPointerBeat - beatNow;

            for (const id of drag.clipIds) {
                const initial = drag.initialById[id];
                if (!initial) continue;
                const rate =
                    initial.playbackRate > 0 && Number.isFinite(initial.playbackRate)
                        ? initial.playbackRate
                        : 1;
                const deltaSrcBeat = deltaBeat * rate;
                let nextTrimStart = initial.trimStartBeat + deltaSrcBeat;
                if (
                    Number.isFinite(initial.maxSlipBeats) &&
                    initial.maxSlipBeats > 1e-6
                ) {
                    nextTrimStart = clamp(
                        nextTrimStart,
                        -initial.maxSlipBeats,
                        initial.maxSlipBeats,
                    );
                }
                dispatch(setClipTrim({ clipId: id, trimStartBeat: nextTrimStart }));
            }
        }

        function end() {
            const drag = slipDragRef.current;
            if (!drag || drag.pointerId !== e.pointerId) return;
            slipDragRef.current = null;

            const session = sessionRef.current;
            for (const id of drag.clipIds) {
                const now = session.clips.find((c) => c.id === id);
                if (!now) continue;
                void dispatch(
                    setClipStateRemote({
                        clipId: id,
                        trimStartBeat: Number(now.trimStartBeat ?? 0) || 0,
                        trimEndBeat: Number(now.trimEndBeat ?? 0) || 0,
                    }),
                );
            }

            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
        }

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
    }

    return { slipDragRef, startSlipDrag };
}
