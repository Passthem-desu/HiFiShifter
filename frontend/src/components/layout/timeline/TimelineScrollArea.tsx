import React, { useEffect, useLayoutEffect, useRef } from "react";

import {
    MAX_PX_PER_BEAT,
    MAX_ROW_HEIGHT,
    MIN_PX_PER_BEAT,
    MIN_ROW_HEIGHT,
} from "./constants";
import { clamp } from "./math";

export const TimelineScrollArea: React.FC<
    Omit<React.HTMLAttributes<HTMLDivElement>, "ref"> & {
        scrollRef: React.MutableRefObject<HTMLDivElement | null>;
        projectBeats: number;
        pxPerBeat: number;
        setPxPerBeat: React.Dispatch<React.SetStateAction<number>>;
        rowHeight: number;
        setRowHeight: React.Dispatch<React.SetStateAction<number>>;
        setScrollLeft: React.Dispatch<React.SetStateAction<number>>;
    }
> = ({
    scrollRef,
    projectBeats,
    pxPerBeat,
    setPxPerBeat,
    rowHeight,
    setRowHeight,
    setScrollLeft,
    onScroll,
    onWheel,
    ...divProps
}) => {
    const scrollRafRef = useRef<number | null>(null);
    const pendingScrollLeftRef = useRef(0);

    const pendingZoomRef = useRef<{
        pointerX: number;
        beatAtPointer: number;
        nextPxPerBeat: number;
    } | null>(null);

    function scheduleScrollLeftUpdate(scroller: HTMLDivElement) {
        pendingScrollLeftRef.current = scroller.scrollLeft;
        if (scrollRafRef.current != null) return;
        scrollRafRef.current = requestAnimationFrame(() => {
            scrollRafRef.current = null;
            setScrollLeft(pendingScrollLeftRef.current);
        });
    }

    useEffect(() => {
        const scroller = scrollRef.current;
        if (!scroller) return;
        setScrollLeft(scroller.scrollLeft);
    }, [scrollRef, setScrollLeft]);

    useEffect(() => {
        return () => {
            if (scrollRafRef.current != null) {
                cancelAnimationFrame(scrollRafRef.current);
                scrollRafRef.current = null;
            }
        };
    }, []);

    useLayoutEffect(() => {
        // Apply pending cursor-centered zoom scrollLeft after pxPerBeat has updated
        // (so layout/width calculations are consistent).
        const scroller = scrollRef.current;
        const pending = pendingZoomRef.current;
        if (!scroller || !pending) return;
        if (Math.abs(pending.nextPxPerBeat - pxPerBeat) > 1e-9) return;

        pendingZoomRef.current = null;
        const { beatAtPointer, pointerX } = pending;
        const maxScroll = Math.max(
            0,
            Math.ceil(Math.max(8, Math.ceil(projectBeats)) * pxPerBeat) -
                scroller.clientWidth,
        );
        const nextScrollLeft = Math.min(
            maxScroll,
            Math.max(0, beatAtPointer * pxPerBeat - pointerX),
        );
        scroller.scrollLeft = nextScrollLeft;
        scheduleScrollLeftUpdate(scroller);
    }, [projectBeats, pxPerBeat, scrollRef]);

    useEffect(() => {
        localStorage.setItem("hifishifter.pxPerBeat", String(pxPerBeat));
    }, [pxPerBeat]);

    useEffect(() => {
        localStorage.setItem("hifishifter.rowHeight", String(rowHeight));
    }, [rowHeight]);

    return (
        <div
            {...divProps}
            ref={scrollRef}
            onScroll={(e) => {
                scheduleScrollLeftUpdate(e.currentTarget as HTMLDivElement);
                onScroll?.(e);
            }}
            onWheel={(e) => {
                // Alt + wheel: vertical zoom (track height)
                if (e.altKey) {
                    e.preventDefault();
                    const dir = e.deltaY < 0 ? 1 : -1;
                    const factor = dir > 0 ? 1.1 : 0.9;
                    setRowHeight((prev) =>
                        Math.round(
                            clamp(
                                prev * factor,
                                MIN_ROW_HEIGHT,
                                MAX_ROW_HEIGHT,
                            ),
                        ),
                    );
                    return;
                }

                // Wheel: horizontal zoom (time scale)
                e.preventDefault();
                const dir = e.deltaY < 0 ? 1 : -1;
                const factor = dir > 0 ? 1.1 : 0.9;
                const scroller = e.currentTarget as HTMLDivElement;
                const bounds = scroller.getBoundingClientRect();
                const pointerX = e.clientX - bounds.left;

                const next = clamp(
                    pxPerBeat * factor,
                    MIN_PX_PER_BEAT,
                    MAX_PX_PER_BEAT,
                );
                if (Math.abs(next - pxPerBeat) < 1e-9) return;

                // Compute beat under cursor using the current pxPerBeat and scrollLeft.
                const beatAtPointer =
                    (pointerX + scroller.scrollLeft) /
                    Math.max(1e-9, pxPerBeat);
                pendingZoomRef.current = {
                    pointerX,
                    beatAtPointer,
                    nextPxPerBeat: next,
                };
                setPxPerBeat(next);
            }}
        />
    );
};
