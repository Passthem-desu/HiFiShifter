import React, { useEffect } from "react";

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
    useEffect(() => {
        const scroller = scrollRef.current;
        if (!scroller) return;
        setScrollLeft(scroller.scrollLeft);
    }, [scrollRef, setScrollLeft]);

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
                setScrollLeft((e.currentTarget as HTMLDivElement).scrollLeft);
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

                // Ctrl + wheel: horizontal zoom (time scale)
                if (!e.ctrlKey) {
                    onWheel?.(e);
                    return;
                }
                e.preventDefault();
                const dir = e.deltaY < 0 ? 1 : -1;
                const factor = dir > 0 ? 1.1 : 0.9;
                const scroller = e.currentTarget as HTMLDivElement;
                const bounds = scroller.getBoundingClientRect();
                const pointerX = e.clientX - bounds.left;
                const beatAtPointer =
                    (pointerX + scroller.scrollLeft) / pxPerBeat;

                setPxPerBeat((prev) => {
                    const next = Math.min(
                        MAX_PX_PER_BEAT,
                        Math.max(MIN_PX_PER_BEAT, prev * factor),
                    );

                    // Keep the beat under cursor fixed during zoom.
                    // Defer scrollLeft update to next frame so layout can react to pxPerBeat changes.
                    requestAnimationFrame(() => {
                        const maxScroll = Math.max(
                            0,
                            Math.ceil(
                                Math.max(8, Math.ceil(projectBeats)) * next,
                            ) - scroller.clientWidth,
                        );
                        const nextScrollLeft = Math.min(
                            maxScroll,
                            Math.max(0, beatAtPointer * next - pointerX),
                        );
                        scroller.scrollLeft = nextScrollLeft;
                        setScrollLeft(scroller.scrollLeft);
                    });
                    return next;
                });
            }}
        />
    );
};
