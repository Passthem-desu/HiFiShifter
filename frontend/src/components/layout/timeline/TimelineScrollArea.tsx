import React, { useEffect, useLayoutEffect, useRef } from "react";

import {
    MAX_PX_PER_SEC,
    MAX_ROW_HEIGHT,
    MIN_PX_PER_SEC,
    MIN_ROW_HEIGHT,
} from "./constants";
import { clamp } from "./math";

export const TimelineScrollArea: React.FC<
    Omit<React.HTMLAttributes<HTMLDivElement>, "ref"> & {
        scrollRef: React.MutableRefObject<HTMLDivElement | null>;
        projectSec: number;
        bpm: number;
        pxPerSec: number;
        setPxPerSec: React.Dispatch<React.SetStateAction<number>>;
        rowHeight: number;
        setRowHeight: React.Dispatch<React.SetStateAction<number>>;
        setScrollLeft: React.Dispatch<React.SetStateAction<number>>;
    }
> = ({
    scrollRef,
    projectSec,
    bpm,
    pxPerSec,
    setPxPerSec,
    rowHeight,
    setRowHeight,
    setScrollLeft,
    onScroll,
    onWheel,
    ...divProps
}) => {
    const lastScrollLeftRef = useRef<number | null>(null);

    // zoom 中心点以秒为基准
    const pendingZoomRef = useRef<{
        pointerX: number;
        secAtPointer: number;
        nextPxPerSec: number;
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
        // Apply pending cursor-centered zoom scrollLeft after pxPerSec has updated
        const scroller = scrollRef.current;
        const pending = pendingZoomRef.current;
        if (!scroller || !pending) return;
        if (Math.abs(pending.nextPxPerSec - pxPerSec) > 1e-9) return;

        pendingZoomRef.current = null;
        const { secAtPointer, pointerX } = pending;
        const secPerBeat = 60 / Math.max(1, bpm);
        const pxPerBeat = pxPerSec * secPerBeat;
        const totalBeats = Math.max(8, Math.ceil(projectSec));
        const maxScroll = Math.max(
            0,
            Math.ceil(totalBeats * pxPerBeat) - scroller.clientWidth,
        );
        const nextScrollLeft = Math.min(
            maxScroll,
            Math.max(0, secAtPointer * pxPerSec - pointerX),
        );
        scroller.scrollLeft = nextScrollLeft;
        syncScrollLeft(scroller);
    }, [projectSec, bpm, pxPerSec, scrollRef]);

    useEffect(() => {
        localStorage.setItem("hifishifter.pxPerSec", String(pxPerSec));
    }, [pxPerSec]);

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
                pxPerSec * factor,
                MIN_PX_PER_SEC,
                MAX_PX_PER_SEC,
            );
            if (Math.abs(next - pxPerSec) < 1e-9) return;

            // 以秒为基准计算光标下的时间点
            const secAtPointer =
                (pointerX + scroller.scrollLeft) / Math.max(1e-9, pxPerSec);
            pendingZoomRef.current = {
                pointerX,
                secAtPointer,
                nextPxPerSec: next,
            };
            setPxPerSec(next);
        };

        scroller.addEventListener("wheel", handler, {
            passive: false,
        } as globalThis.AddEventListenerOptions);
        return () => {
            scroller.removeEventListener("wheel", handler);
        };
    }, [pxPerSec, scrollRef, setPxPerSec, setRowHeight]);

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
