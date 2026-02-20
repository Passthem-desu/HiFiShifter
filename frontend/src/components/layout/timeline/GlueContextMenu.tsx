import React from "react";

export const GlueContextMenu: React.FC<{
    x: number;
    y: number;
    disabled: boolean;
    onGlue: () => void;
}> = ({ x, y, disabled, onGlue }) => {
    return (
        <div
            data-hs-context-menu="1"
            className="fixed z-50 rounded-sm border border-qt-border bg-qt-window text-qt-text shadow-sm"
            style={{ left: x, top: y }}
        >
            <button
                className="px-3 py-2 text-left w-full hover:bg-qt-button-hover disabled:opacity-40 disabled:hover:bg-transparent"
                disabled={disabled}
                onClick={onGlue}
            >
                胶合
            </button>
        </div>
    );
};
