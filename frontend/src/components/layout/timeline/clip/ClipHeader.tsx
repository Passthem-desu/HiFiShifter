import React, { useRef, useState } from "react";
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
    /** 触发内联重命名（由 ClipContextMenu 的"重命名"菜单项调用） */
    triggerRename?: boolean;
    onRenameCommit?: (clipId: string, newName: string) => void;
    onRenameDone?: () => void;
    /** 增益双击输入框提交（dB 值，已 clamp 到 -24~+12） */
    onGainCommit?: (clipId: string, db: number) => void;
}> = ({
    clip,
    ensureSelected,
    selectClipRemote,
    startEditDrag,
    toggleClipMuted,
    isInMultiSelectedSet,
    multiSelectedCount,
    triggerRename = false,
    onRenameCommit,
    onRenameDone,
    onGainCommit,
}) => {
    const { t } = useI18n();

    // ── 增益双击输入框 ──────────────────────────────────────────────────────
    const [gainEditing, setGainEditing] = useState(false);
    const [gainInputVal, setGainInputVal] = useState("");
    const gainInputRef = useRef<HTMLInputElement>(null);

    function openGainEditor() {
        setGainInputVal(gainToDb(clip.gain).toFixed(1));
        setGainEditing(true);
        setTimeout(() => {
            gainInputRef.current?.select();
        }, 0);
    }

    function commitGainEdit() {
        const parsed = parseFloat(gainInputVal);
        if (!isNaN(parsed)) {
            // clamp 到 -12 ~ +12 dB
            const clamped = Math.min(12, Math.max(-12, parsed));
            onGainCommit?.(clip.id, clamped);
        }
        setGainEditing(false);
    }

    function cancelGainEdit() {
        setGainEditing(false);
    }

    // ── 名称内联编辑 ────────────────────────────────────────────────────────
    const [nameEditing, setNameEditing] = useState(false);
    const [nameInputVal, setNameInputVal] = useState("");
    const nameInputRef = useRef<HTMLInputElement>(null);

    // 外部触发重命名（来自右键菜单）
    React.useEffect(() => {
        if (triggerRename && !nameEditing) {
            setNameInputVal(clip.name);
            setNameEditing(true);
            setTimeout(() => {
                nameInputRef.current?.select();
            }, 0);
        }
    }, [triggerRename]);

    function commitNameEdit() {
        const trimmed = nameInputVal.trim();
        const finalName = trimmed.length > 0 ? trimmed : clip.name;
        onRenameCommit?.(clip.id, finalName);
        setNameEditing(false);
        onRenameDone?.();
    }

    function cancelNameEdit() {
        setNameEditing(false);
        onRenameDone?.();
    }

    return (
        <div
            className="absolute left-1 right-1 flex items-center gap-1 z-50 select-none"
            style={{
                top: 1,
                height: CLIP_HEADER_HEIGHT,
            }}
        >
            {/* 静音按钮 */}
            <button
                className={`w-5 h-4 rounded flex items-center justify-center border transition-all text-[10px] font-bold ${clip.muted ? "bg-qt-danger-bg text-qt-danger-text border-qt-danger-border" : "bg-qt-button text-qt-text border-transparent hover:border-qt-danger-border hover:bg-qt-danger-bg hover:text-qt-danger-text"}`}
                onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                }}
                onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleClipMuted(clip.id, !Boolean(clip.muted));
                }}
                title={clip.muted ? t("clip_unmute") : t("clip_mute")}
            >
                M
            </button>

            {/* 增益拖拽把手 */}
            <div
                title="上下拖拽调节增益 / 双击输入精确值"
                style={{ cursor: "ns-resize" }}
                onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (multiSelectedCount === 0 || !isInMultiSelectedSet) {
                        ensureSelected(clip.id);
                    }
                    selectClipRemote(clip.id);
                    startEditDrag(e, clip.id, "gain");
                }}
                onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openGainEditor();
                }}
            >
                <div className="w-4 h-4 rounded-full border border-white/60 bg-white/10" />
            </div>

            {/* Clip 名称区域 */}
            <div className="flex-1 min-w-0">
                {nameEditing ? (
                    <input
                        ref={nameInputRef}
                    className="w-full text-xs text-white font-medium bg-black/50 border border-white/40 rounded px-1 outline-none"
                        value={nameInputVal}
                        onChange={(e) => setNameInputVal(e.target.value)}
                        onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") commitNameEdit();
                            if (e.key === "Escape") cancelNameEdit();
                        }}
                        onBlur={commitNameEdit}
                        onPointerDown={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                    />
                ) : (
                    <div
                        className="text-xs text-white font-medium drop-shadow-md truncate cursor-text"
                        onDoubleClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setNameInputVal(clip.name);
                            setNameEditing(true);
                            setTimeout(() => nameInputRef.current?.select(), 0);
                        }}
                    >
                        {clip.name}
                    </div>
                )}
            </div>

            {/* 增益数值显示 / 输入框 */}
            {gainEditing ? (
                <input
                    ref={gainInputRef}
                    className="w-14 text-xs text-white bg-black/50 border border-white/40 rounded px-1 outline-none text-right"
                    value={gainInputVal}
                    onChange={(e) => setGainInputVal(e.target.value)}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitGainEdit();
                        if (e.key === "Escape") cancelGainEdit();
                    }}
                    onBlur={commitGainEdit}
                    onPointerDown={(e) => e.stopPropagation()}
                />
            ) : (
                <div
                    className="text-xs text-white/80 drop-shadow-md cursor-ns-resize"
                    title="上下拖拽调节增益 / 双击输入精确值"
                    onDoubleClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openGainEditor();
                    }}
                >
                    {gainToDb(clip.gain) >= 0 ? "+" : ""}
                    {gainToDb(clip.gain).toFixed(1)}dB
                </div>
            )}
        </div>
    );
};
