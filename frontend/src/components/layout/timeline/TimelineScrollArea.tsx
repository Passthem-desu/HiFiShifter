import React, { useEffect, useLayoutEffect, useRef } from "react";

import {
    MAX_PX_PER_SEC,
    MAX_ROW_HEIGHT,
    MIN_PX_PER_SEC,
    MIN_ROW_HEIGHT,
} from "./constants";
import { clamp } from "./math";
import { isModifierActive } from "../../../features/keybindings/keybindingsSlice";
import type { Keybinding } from "../../../features/keybindings/types";

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
        scrollHorizontalKb?: Keybinding;
        scrollVerticalKb?: Keybinding;
        playheadSec?: number;
        playheadZoomEnabled?: boolean;
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
    scrollHorizontalKb,
    scrollVerticalKb,
    playheadSec,
    playheadZoomEnabled,
    ...divProps
}) => {
    const lastScrollLeftRef = useRef<number | null>(null);
    const pxPerSecRef = useRef(pxPerSec);
    const zoomRafRef = useRef<number | null>(null);
    const zoomPendingRef = useRef<{
        pointerX: number;
        secAtPointer: number;
        nextPxPerSec: number;
    } | null>(null);

    // zoom 中心点以秒为基准
    const pendingZoomRef = useRef<{
        pointerX: number;
        secAtPointer: number;
        nextPxPerSec: number;
    } | null>(null);

    useEffect(() => {
        pxPerSecRef.current = pxPerSec;
    }, [pxPerSec]);

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

    useEffect(() => {
        return () => {
            if (zoomRafRef.current != null) {
                cancelAnimationFrame(zoomRafRef.current);
                zoomRafRef.current = null;
            }
        };
    }, []);

    useLayoutEffect(() => {
        // Apply pending cursor-centered zoom scrollLeft after pxPerSec has updated
        const scroller = scrollRef.current;
        const pending = pendingZoomRef.current;
        if (!scroller || !pending) return;
        if (Math.abs(pending.nextPxPerSec - pxPerSec) > 1e-9) return;

        pendingZoomRef.current = null;
        const { secAtPointer, pointerX } = pending;
        // Use the scroller's actual scrollable range so the anchor
        // clamp matches the real content width rendered by TimelinePanel.
        const maxScroll = Math.max(
            0,
            scroller.scrollWidth - scroller.clientWidth,
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

            // Scroll modifier: convert wheel to horizontal scroll
            if (scrollHorizontalKb && isModifierActive(scrollHorizontalKb, e)) {
                e.preventDefault();
                scroller.scrollLeft += e.deltaY;
                syncScrollLeft(scroller);
                return;
            }

            // Scroll modifier: convert wheel to vertical scroll
            if (scrollVerticalKb && isModifierActive(scrollVerticalKb, e)) {
                e.preventDefault();
                scroller.scrollTop += e.deltaY;
                return;
            }

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

            // Playhead-based zoom: use playhead as anchor instead of pointer
            let anchorX: number;
            let anchorSec: number;
            if (playheadZoomEnabled && playheadSec != null) {
                anchorSec = playheadSec;
                anchorX = anchorSec * pxPerSec - scroller.scrollLeft;
                // 如果 playhead 在可视区域外，先将其居中，再以其为锚点缩放
                if (anchorX < 0 || anchorX > bounds.width) {
                    const centeredScrollLeft =
                        anchorSec * pxPerSec - bounds.width / 2;
                    scroller.scrollLeft = Math.max(0, centeredScrollLeft);
                    anchorX = anchorSec * pxPerSec - scroller.scrollLeft;
                }
            } else {
                anchorX = e.clientX - bounds.left;
                anchorSec =
                    (anchorX + scroller.scrollLeft) / Math.max(1e-9, pxPerSec);
            }

            const basePxPerSec =
                zoomPendingRef.current?.nextPxPerSec ?? pxPerSecRef.current;
            const next = clamp(
                basePxPerSec * factor,
                MIN_PX_PER_SEC,
                MAX_PX_PER_SEC,
            );
            if (Math.abs(next - basePxPerSec) < 1e-9) return;

            zoomPendingRef.current = {
                pointerX: anchorX,
                secAtPointer: anchorSec,
                nextPxPerSec: next,
            };

            if (zoomRafRef.current == null) {
                zoomRafRef.current = requestAnimationFrame(() => {
                    zoomRafRef.current = null;
                    const pending = zoomPendingRef.current;
                    if (!pending) return;
                    zoomPendingRef.current = null;
                    pendingZoomRef.current = pending;
                    setPxPerSec(pending.nextPxPerSec);
                });
            }
        };

        scroller.addEventListener("wheel", handler, {
            passive: false,
        } as globalThis.AddEventListenerOptions);
        return () => {
            scroller.removeEventListener("wheel", handler);
        };
    }, [
        pxPerSec,
        scrollRef,
        setPxPerSec,
        setRowHeight,
        scrollHorizontalKb,
        scrollVerticalKb,
        playheadSec,
        playheadZoomEnabled,
    ]);

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
