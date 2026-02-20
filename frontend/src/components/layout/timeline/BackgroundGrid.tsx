import React from "react";
import { gridStepBeats } from "./grid";

export const BackgroundGrid: React.FC<{
    contentWidth: number;
    contentHeight: number;
    pxPerBeat: number;
    grid: string;
    beatsPerBar: number;
}> = ({ contentWidth, contentHeight, pxPerBeat, grid, beatsPerBar }) => {
    return (
        <>
            <div
                className="absolute left-0 top-0 pointer-events-none"
                style={{
                    width: contentWidth,
                    height: contentHeight,
                    backgroundImage: [
                        "linear-gradient(to right, var(--qt-graph-grid-weak) 1px, transparent 1px)",
                        "linear-gradient(to right, var(--qt-graph-grid-strong) 3px, transparent 3px)",
                    ].join(", "),
                    backgroundSize: [
                        `${pxPerBeat * gridStepBeats(grid)}px 100%`,
                        `${pxPerBeat * beatsPerBar}px 100%`,
                    ].join(", "),
                    opacity: 0.9,
                }}
            />

            <div
                className="absolute top-0 bottom-0 w-px z-20"
                style={{
                    left: contentWidth - 1,
                    backgroundColor: "var(--qt-highlight)",
                    opacity: 0.9,
                }}
            />
        </>
    );
};
