import React from "react";
import type {
    ClipInfo,
    FadeCurveType,
} from "../../../features/session/sessionTypes";
import { useI18n } from "../../../i18n/I18nProvider";
import type { MessageKey } from "../../../i18n/messages";

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
const CURVE_OPTION_KEYS: { value: FadeCurveType; key: MessageKey }[] = [
    { value: "linear", key: "fade_curve_linear" },
    { value: "sine", key: "fade_curve_sine" },
    { value: "exponential", key: "fade_curve_exponential" },
    { value: "logarithmic", key: "fade_curve_logarithmic" },
    { value: "scurve", key: "fade_curve_scurve" },
];

const FadeCurveRow: React.FC<{
    label: string;
    current: FadeCurveType;
    onSelect: (c: FadeCurveType) => void;
    t: (key: MessageKey) => string;
}> = ({ label, current, onSelect, t }) => (
    <div className="px-3 py-1.5 flex items-center gap-1.5 flex-wrap">
        <span className="text-[11px] text-qt-text/60 mr-1 shrink-0">
            {label}
        </span>
        {CURVE_OPTION_KEYS.map((opt) => (
            <button
                key={opt.value}
                title={t(opt.key)}
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
                {t(opt.key)}
            </button>
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
    onNormalize: (ids: string[]) => void;
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
    onNormalize,
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
                    {t("ctx_selected_n").replace("{n}", String(selectedClips.length))}
                    </div>
                    <Divider />
                    <MenuItem
                        label={t("ctx_delete_all")}
                        danger
                        onClick={() => {
                            onDelete(ids);
                            close();
                        }}
                    />
                    <MenuItem
                        label={allMuted ? t("ctx_unmute_all") : t("ctx_mute_all")}
                        onClick={() => {
                            onMute(ids, !allMuted);
                            close();
                        }}
                    />
                    <MenuItem
                        label={t("ctx_copy_all")}
                        onClick={() => {
                            onCopy(ids);
                            close();
                        }}
                    />
                    <MenuItem
                        label={t("ctx_normalize_all")}
                        onClick={() => {
                            onNormalize(ids);
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
                        label={t("ctx_delete")}
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
                        label={t("ctx_rename")}
                        onClick={() => {
                            onRename(clip.id);
                            close();
                        }}
                    />
                    <MenuItem
                        label={t("ctx_copy")}
                        onClick={() => {
                            onCopy([clip.id]);
                            close();
                        }}
                    />
                    <MenuItem
                        label={t("ctx_split_at_playhead")}
                        disabled={!playheadInClip}
                        onClick={() => {
                            onSplit(clip.id);
                            close();
                        }}
                    />
                    <MenuItem
                        label={t("ctx_normalize")}
                        onClick={() => {
                            onNormalize([clip.id]);
                            close();
                        }}
                    />
                    {onFadeCurveChange &&
                        (clip.fadeInSec > 0 || clip.fadeOutSec > 0) && (
                            <>
                                <Divider />
                                {clip.fadeInSec > 0 && (
                                    <FadeCurveRow
                                        label={t("fade_in")}
                                        current={
                                            (clip.fadeInCurve as FadeCurveType) ??
                                            "sine"
                                        }
                                        onSelect={(c) => {
                                            onFadeCurveChange(clip.id, "in", c);
                                        }}
                                        t={t}
                                    />
                                )}
                                {clip.fadeOutSec > 0 && (
                                    <FadeCurveRow
                                        label={t("fade_out")}
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
                                        t={t}
                                    />
                                )}
                            </>
                        )}
                </>
            )}
        </div>
    );
};
