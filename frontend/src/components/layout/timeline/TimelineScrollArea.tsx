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
    const lastScrollLeftRef = useRef<number | null>(null);

    const pendingZoomRef = useRef<{
        pointerX: number;
        beatAtPointer: number;
        nextPxPerBeat: number;
    } | null>(null);

    function syncScrollLeft(scroller: HTMLDivElement) {
        const next = scroller.scrollLeft;
        if (
            lastScrollLeftRef.current != null &&
            lastScrollLeftRef.current === next
        ) {
            return;
        }
        lastScrollLeftRef.current = next;
        setScrollLeft(next);
    }

    useEffect(() => {
        const scroller = scrollRef.current;
        if (!scroller) return;
        syncScrollLeft(scroller);
    }, [scrollRef, setScrollLeft]);

    useEffect(() => {
        return () => {};
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
        syncScrollLeft(scroller);
    }, [projectBeats, pxPerBeat, scrollRef]);

    useEffect(() => {
        localStorage.setItem("hifishifter.pxPerBeat", String(pxPerBeat));
    }, [pxPerBeat]);

    useEffect(() => {
        localStorage.setItem("hifishifter.rowHeight", String(rowHeight));
    }, [rowHeight]);

    useEffect(() => {
        const scroller = scrollRef.current;
        if (!scroller) return;

        const handler: EventListener = (evt) => {
            const e = evt as globalThis.WheelEvent;

            // Ctrl + wheel: vertical zoom (track height)
            if (e.ctrlKey) {
                e.preventDefault();
                const dir = e.deltaY < 0 ? 1 : -1;
                const factor = dir > 0 ? 1.1 : 0.9;
                setRowHeight((prev) =>
                    Math.round(
                        clamp(prev * factor, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT),
                    ),
                );
                return;
            }

            // Wheel: horizontal zoom (time scale)
            e.preventDefault();
            const dir = e.deltaY < 0 ? 1 : -1;
            const factor = dir > 0 ? 1.1 : 0.9;
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
                (pointerX + scroller.scrollLeft) / Math.max(1e-9, pxPerBeat);
            pendingZoomRef.current = {
                pointerX,
                beatAtPointer,
                nextPxPerBeat: next,
            };
            setPxPerBeat(next);
        };

        scroller.addEventListener("wheel", handler, {
            passive: false,
        } as globalThis.AddEventListenerOptions);
        return () => {
            scroller.removeEventListener("wheel", handler);
        };
    }, [pxPerBeat, scrollRef, setPxPerBeat, setRowHeight]);

    return (
        <div
            {...divProps}
            ref={scrollRef}
            onScroll={(e) => {
                syncScrollLeft(e.currentTarget as HTMLDivElement);
                onScroll?.(e);
            }}
        />
    );
};
