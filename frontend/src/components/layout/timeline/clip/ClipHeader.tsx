import React from "react";
import type { ClipInfo } from "../../../../features/session/sessionTypes";
import { CLIP_HEADER_HEIGHT } from "../constants";
import { gainToDb } from "../math";
import { useI18n } from "../../../../i18n/I18nProvider";
export const ClipHeader: React.FC<{
    clip: ClipInfo;
    ensureSelected: (clipId: string) => void;
    selectClipRemote: (clipId: string) => void;
    startEditDrag: (
        e: React.PointerEvent,
        clipId: string,
        type: "gain",
    ) => void;
    toggleClipMuted: (clipId: string, nextMuted: boolean) => void;
    isInMultiSelectedSet: boolean;
    multiSelectedCount: number;
}> = ({
    clip,
    ensureSelected,
    selectClipRemote,
    startEditDrag,
    toggleClipMuted,
    isInMultiSelectedSet,
    multiSelectedCount,
}) => {
    const { t } = useI18n();

    return (
        <div
            className="absolute left-1 right-1 flex items-center gap-1 z-50 select-none"
            style={{
                top: 1,
                height: CLIP_HEADER_HEIGHT,
            }}
        >
            <button
                className={`w-5 h-4 rounded text-[10px] border transition-all ${clip.muted ? "bg-qt-danger-bg text-qt-danger-text border-qt-danger-border" : "bg-qt-button text-qt-text border-transparent hover:border-qt-danger-border hover:bg-qt-danger-bg hover:text-qt-danger-text"}`}
                onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                }}
                onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const next = !Boolean(clip.muted);
                    toggleClipMuted(clip.id, next);
                }}
                title={clip.muted ? t("clip_unmute") : t("clip_mute")}
            >
                M
            </button>

            <div
                title={`${gainToDb(clip.gain).toFixed(1)} dB`}
                style={{
                    cursor: "ns-resize",
                }}
                onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (multiSelectedCount === 0 || !isInMultiSelectedSet) {
                        ensureSelected(clip.id);
                    }
                    selectClipRemote(clip.id);
                    startEditDrag(e, clip.id, "gain");
                }}
            >
                <div className="w-4 h-4 rounded-full border border-white/60 bg-white/10" />
            </div>

            <div className="flex-1 min-w-0">
                <div className="text-[10px] text-white font-medium drop-shadow-md truncate">
                    {clip.name}
                </div>
            </div>

            <div className="text-[10px] text-white/80 drop-shadow-md">
                {gainToDb(clip.gain) >= 0 ? "+" : ""}
                {gainToDb(clip.gain).toFixed(1)}dB
            </div>
        </div>
    );
};
