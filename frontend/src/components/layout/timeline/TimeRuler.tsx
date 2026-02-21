import React from "react";
import { Box } from "@radix-ui/themes";

export const TimeRuler: React.FC<{
    contentWidth: number;
    scrollLeft: number;
    bars: Array<{ beat: number; label: string }>;
    pxPerBeat: number;
    playheadBeat: number;
    onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
    contentRef?: React.Ref<HTMLDivElement>;
}> = ({
    contentWidth,
    scrollLeft,
    bars,
    pxPerBeat,
    playheadBeat,
    onMouseDown,
    contentRef,
}) => {
    const boundaryLeft = contentWidth - 1;

    // If the parent passes a ref, it may be doing imperative scroll syncing
    // (e.g. updating transform every scroll event). In that case, avoid
    // re-applying a potentially stale transform during React renders.
    const useManualTransform = contentRef != null;

    return (
        <Box
            className="h-6 bg-qt-window border-b border-qt-border relative overflow-hidden shrink-0 select-none"
            onMouseDown={(e) => {
                if (e.button === 1) {
                    e.preventDefault();
                    return;
                }
                onMouseDown(e);
            }}
            onAuxClick={(e) => {
                if (e.button === 1) e.preventDefault();
            }}
            onWheel={(e) => {
                // Prevent the ruler from becoming a separate scroll source.
                e.preventDefault();
            }}
        >
            <div
                ref={contentRef}
                className="absolute inset-0 will-change-transform"
                style={
                    useManualTransform
                        ? undefined
                        : { transform: `translateX(${-scrollLeft}px)` }
                }
            >
                {bars.map((m) => (
                    <div
                        key={m.beat}
                        className="absolute top-0 bottom-0 text-[10px] text-gray-500 pt-1"
                        style={{ left: m.beat * pxPerBeat }}
                    >
                        <div className="pl-1 border-l border-gray-600 h-2">
                            {m.label}
                        </div>
                    </div>
                ))}

                {Number.isFinite(boundaryLeft) && boundaryLeft >= -2 ? (
                    <div
                        className="absolute top-0 bottom-0 w-px z-20"
                        style={{
                            left: boundaryLeft,
                            backgroundColor: "var(--qt-highlight)",
                            opacity: 0.9,
                        }}
                    />
                ) : null}

                {/* Playhead (content-coordinates; container is shifted) */}
                <div
                    className="absolute top-0 bottom-0 w-px bg-red-500 z-20"
                    style={{ left: playheadBeat * pxPerBeat }}
                />
                <div
                    className="absolute top-0 z-30"
                    style={{
                        left: playheadBeat * pxPerBeat,
                        transform: "translateX(-6px)",
                    }}
                >
                    <div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] border-t-red-500" />
                </div>
            </div>
        </Box>
    );
};
