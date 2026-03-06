import React from "react";

export const ClipEdgeHandles: React.FC<{
    clipId: string;
    altPressed: boolean;
    multiSelectedCount: number;
    isInMultiSelectedSet: boolean;
    ensureSelected: (clipId: string) => void;
    selectClipRemote: (clipId: string) => void;
    startEditDrag: (
        e: React.PointerEvent,
        clipId: string,
        type: "trim_left" | "trim_right" | "stretch_left" | "stretch_right",
    ) => void;
}> = ({
    clipId,
    altPressed,
    multiSelectedCount,
    isInMultiSelectedSet,
    ensureSelected,
    selectClipRemote,
    startEditDrag,
}) => {
    const yStyle: React.CSSProperties = {
        top: 0,
        bottom: 0,
    };

    return (
        <>
            {/* Left/Right edge handles (trim or time-stretch). Extend into the header area. */}
            <div
                className="absolute left-0 w-[10px] z-[60] opacity-0 group-hover:opacity-100 transition-opacity"
                style={{
                    ...yStyle,
                    cursor: altPressed ? "col-resize" : "ew-resize",
                }}
                onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (multiSelectedCount === 0 || !isInMultiSelectedSet) {
                        ensureSelected(clipId);
                    }
                    selectClipRemote(clipId);
                    startEditDrag(
                        e,
                        clipId,
                        altPressed ? "stretch_left" : "trim_left",
                    );
                }}
            />
            <div
                className="absolute right-0 w-[10px] z-[60] opacity-0 group-hover:opacity-100 transition-opacity"
                style={{
                    ...yStyle,
                    cursor: altPressed ? "col-resize" : "ew-resize",
                }}
                onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (multiSelectedCount === 0 || !isInMultiSelectedSet) {
                        ensureSelected(clipId);
                    }
                    selectClipRemote(clipId);
                    startEditDrag(
                        e,
                        clipId,
                        altPressed ? "stretch_right" : "trim_right",
                    );
                }}
            />
        </>
    );
};
