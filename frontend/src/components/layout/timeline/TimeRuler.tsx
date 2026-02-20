import React from "react";
import { Box } from "@radix-ui/themes";

export const TimeRuler: React.FC<{
    contentWidth: number;
    scrollLeft: number;
    bars: Array<{ beat: number; label: string }>;
    pxPerBeat: number;
    playheadBeat: number;
    onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
}> = ({
    contentWidth,
    scrollLeft,
    bars,
    pxPerBeat,
    playheadBeat,
    onMouseDown,
}) => {
    return (
        <Box
            className="h-6 bg-qt-window border-b border-qt-border relative overflow-hidden shrink-0 select-none"
            onMouseDown={onMouseDown}
        >
            <div
                className="absolute inset-0 will-change-transform"
                style={{
                    width: contentWidth,
                    transform: `translateX(${-scrollLeft}px)`,
                }}
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
