import React from "react";
import type {
    ClipInfo,
    FadeCurveType,
} from "../../../features/session/sessionTypes";
import { useI18n } from "../../../i18n/I18nProvider";

export type ClipColor = "emerald" | "blue" | "violet" | "amber";

const COLOR_OPTIONS: { value: ClipColor; label: string; bg: string }[] = [
    { value: "emerald", label: "绿", bg: "bg-emerald-500" },
    { value: "blue", label: "蓝", bg: "bg-blue-500" },
    { value: "violet", label: "紫", bg: "bg-violet-500" },
    { value: "amber", label: "橙", bg: "bg-amber-500" },
];

// ── 单条菜单项 ──────────────────────────────────────────────────────────────
const MenuItem: React.FC<{
    label: string;
    disabled?: boolean;
    danger?: boolean;
    onClick: () => void;
}> = ({ label, disabled, danger, onClick }) => (
    <button
        className={`px-3 py-1.5 text-left w-full text-[12px] transition-colors
            ${
                disabled
                    ? "opacity-40 cursor-default"
                    : danger
                      ? "hover:bg-red-500/20 text-red-400"
                      : "hover:bg-qt-button-hover"
            }`}
        disabled={disabled}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
            e.stopPropagation();
            onClick();
        }}
    >
        {label}
    </button>
);

const Divider: React.FC = () => (
    <div className="my-1 border-t border-qt-border" />
);

// ── 渐变曲线选项 ────────────────────────────────────────────────────────────
const CURVE_OPTIONS: { value: FadeCurveType; label: string }[] = [
    { value: "linear", label: "线性" },
    { value: "sine", label: "正弦" },
    { value: "exponential", label: "指数" },
    { value: "logarithmic", label: "对数" },
    { value: "scurve", label: "S曲线" },
];

const FadeCurveRow: React.FC<{
    label: string;
    current: FadeCurveType;
    onSelect: (c: FadeCurveType) => void;
}> = ({ label, current, onSelect }) => (
    <div className="px-3 py-1.5 flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] text-qt-text/60 mr-1 shrink-0">
            {label}
        </span>
        {CURVE_OPTIONS.map((opt) => (
            <button
                key={opt.value}
                title={opt.label}
                className={`px-1.5 py-0.5 rounded text-[10px] transition-colors
                    ${
                        current === opt.value
                            ? "bg-qt-highlight text-white"
                            : "bg-qt-button hover:bg-qt-button-hover text-qt-text/80"
                    }`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                    e.stopPropagation();
                    onSelect(opt.value);
                }}
            >
                {opt.label}
            </button>
        ))}
    </div>
);

// ── 颜色子菜单行 ────────────────────────────────────────────────────────────
const ColorRow: React.FC<{
    currentColor: ClipColor;
    onSelect: (c: ClipColor) => void;
}> = ({ currentColor, onSelect }) => (
    <div className="px-3 py-1.5 flex items-center gap-2">
        <span className="text-[11px] text-qt-text/60 mr-1">颜色</span>
        {COLOR_OPTIONS.map((opt) => (
            <button
                key={opt.value}
                title={opt.label}
                className={`w-4 h-4 rounded-full ${opt.bg} transition-transform
                    ${currentColor === opt.value ? "ring-2 ring-white/80 scale-110" : "hover:scale-110"}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                    e.stopPropagation();
                    onSelect(opt.value);
                }}
            />
        ))}
    </div>
);

// ── 主组件 ──────────────────────────────────────────────────────────────────
export const ClipContextMenu: React.FC<{
    x: number;
    y: number;
    /** 右键点击的 clip */
    clip: ClipInfo;
    /** 多个 clip 列表（含 clip 本身），长度 >= 2 时进入多选模式 */
    selectedClips: ClipInfo[];
    /** 播放头是否在 clip 范围内（用于分割按钮启用判断）*/
    playheadInClip: boolean;
    onClose: () => void;
    onDelete: (ids: string[]) => void;
    onMute: (ids: string[], muted: boolean) => void;
    onRename: (clipId: string) => void;
    onCopy: (ids: string[]) => void;
    onSplit: (clipId: string) => void;
    onGlue: (ids: string[]) => void;
    onColorChange: (clipId: string, color: ClipColor) => void;
    onFadeCurveChange?: (
        clipId: string,
        target: "in" | "out",
        curve: FadeCurveType,
    ) => void;
}> = ({
    x,
    y,
    clip,
    selectedClips,
    playheadInClip,
    onClose,
    onDelete,
    onMute,
    onRename,
    onCopy,
    onSplit,
    onGlue,
    onColorChange,
    onFadeCurveChange,
}) => {
    const { t } = useI18n();
    const isMulti = selectedClips.length >= 2;
    const ids = isMulti ? selectedClips.map((c) => c.id) : [clip.id];

    // 胶合：仅同轨且多选时可用
    const glueDisabled =
        !isMulti ||
        (() => {
            const trackId = selectedClips[0]?.trackId;
            return !trackId || selectedClips.some((c) => c.trackId !== trackId);
        })();

    // 多选中是否全部静音
    const allMuted = isMulti ? selectedClips.every((c) => c.muted) : clip.muted;

    function close() {
        onClose();
    }

    return (
        <div
            data-hs-context-menu="1"
            className="fixed z-50 min-w-[140px] rounded border border-qt-border bg-qt-window text-qt-text shadow-lg py-1"
            style={{ left: x, top: y }}
            onPointerDown={(e) => e.stopPropagation()}
        >
            {isMulti ? (
// ── 多选菜单 ──
                <>
                    <div className="px-3 py-1 text-[11px] text-qt-text/50 select-none">
                    已选 {selectedClips.length} 个
                    </div>
                    <Divider />
                    <MenuItem
                        label="删除所有"
                        danger
                        onClick={() => {
                            onDelete(ids);
                            close();
                        }}
                    />
                    <MenuItem
                        label={allMuted ? "取消静音所有" : "静音所有"}
                        onClick={() => {
                            onMute(ids, !allMuted);
                            close();
                        }}
                    />
                    <MenuItem
                        label="复制所有"
                        onClick={() => {
                            onCopy(ids);
                            close();
                        }}
                    />
                    <Divider />
                    <MenuItem
                        label={t("glue")}
                        disabled={glueDisabled}
                        onClick={() => {
                            onGlue(ids);
                            close();
                        }}
                    />
                </>
            ) : (
// ── 单选菜单 ──
                <>
                    <MenuItem
                        label="删除"
                        danger
                        onClick={() => {
                            onDelete([clip.id]);
                            close();
                        }}
                    />
                    <MenuItem
                        label={clip.muted ? t("clip_unmute") : t("clip_mute")}
                        onClick={() => {
                            onMute([clip.id], !clip.muted);
                            close();
                        }}
                    />
                    <MenuItem
                        label="重命名"
                        onClick={() => {
                            onRename(clip.id);
                            close();
                        }}
                    />
                    <MenuItem
                        label="复制"
                        onClick={() => {
                            onCopy([clip.id]);
                            close();
                        }}
                    />
                    <MenuItem
                        label="在播放头处分割"
                        disabled={!playheadInClip}
                        onClick={() => {
                            onSplit(clip.id);
                            close();
                        }}
                    />
                    <Divider />
                    <ColorRow
                        currentColor={clip.color as ClipColor}
                        onSelect={(c) => {
                            onColorChange(clip.id, c);
                            close();
                        }}
                    />
                    {onFadeCurveChange &&
                        (clip.fadeInSec > 0 || clip.fadeOutSec > 0) && (
                            <>
                                <Divider />
                                {clip.fadeInSec > 0 && (
                                    <FadeCurveRow
                                        label="淡入"
                                        current={
                                            (clip.fadeInCurve as FadeCurveType) ??
                                            "sine"
                                        }
                                        onSelect={(c) => {
                                            onFadeCurveChange(clip.id, "in", c);
                                        }}
                                    />
                                )}
                                {clip.fadeOutSec > 0 && (
                                    <FadeCurveRow
                                        label="淡出"
                                        current={
                                            (clip.fadeOutCurve as FadeCurveType) ??
                                            "sine"
                                        }
                                        onSelect={(c) => {
                                            onFadeCurveChange(
                                                clip.id,
                                                "out",
                                                c,
                                            );
                                        }}
                                    />
                                )}
                            </>
                        )}
                </>
            )}
        </div>
    );
};
