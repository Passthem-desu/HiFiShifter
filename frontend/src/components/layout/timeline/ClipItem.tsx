import React from "react";

import { useI18n } from "../../../i18n/I18nProvider";
import type { ClipInfo } from "../../../features/session/sessionTypes";
import { CLIP_BODY_PADDING_Y, CLIP_HEADER_HEIGHT } from "./constants";
import { clamp } from "./math";
import { fadeInAreaPath, fadeOutAreaPath, fadeCurveGain } from "./paths";
import type { FadeCurveType } from "./paths";
import { sliceWaveformSamples } from "./clipWaveform";
import { ClipEdgeHandles } from "./clip/ClipEdgeHandles";
import { ClipHeader } from "./clip/ClipHeader";
import { useClipWaveformPeaks } from "./clip/useClipWaveformPeaks";
import { renderWaveformSvg } from "../../../utils/waveformRenderer";
import { useAppTheme } from "../../../theme/AppThemeProvider";
import { getWaveformColors } from "../../../theme/waveformColors";

type WaveformPreview = number[] | { l: number[]; r: number[] };

/**
 * 对波形peaks数据应用淡入淡出增益曲线
 *
 * @param min - 最小值数�?
 * @param max - 最大值数�?
 * @param ampScale - 振幅缩放系数
 * @param lengthSec - Clip长度（秒）
 * @param fadeInSec - 淡入长度（秒）
 * @param fadeOutSec - 淡出长度（秒） * @param fadeInCurve - 淡入曲线类型
 * @param fadeOutCurve - 淡出曲线类型
 * @returns 应用淡入淡出后的 min/max 数组
 */
function applyFadeGainToPeaks(
    min: number[],
    max: number[],
    ampScale: number,
    lengthSec: number,
    fadeInSec: number,
    fadeOutSec: number,
    fadeInCurve: FadeCurveType,
    fadeOutCurve: FadeCurveType,
): { min: number[]; max: number[] } {
    const srcN = Math.min(min.length, max.length);
    if (srcN === 0) return { min: [], max: [] };

    const safeLenBeats = Math.max(1e-9, Number(lengthSec) || 0);
    const safeFadeIn = Math.max(0, Number(fadeInSec) || 0);
    const safeFadeOut = Math.max(0, Number(fadeOutSec) || 0);

    const resultMin = new Array<number>(srcN);
    const resultMax = new Array<number>(srcN);

    for (let i = 0; i < srcN; i++) {
        const t = i / Math.max(1, srcN - 1);
        const beatAt = t * safeLenBeats;

        let mul = ampScale;
        if (safeFadeIn > 1e-9) {
            mul *= fadeCurveGain(clamp(beatAt / safeFadeIn, 0, 1), fadeInCurve);
        }
        if (safeFadeOut > 1e-9) {
            mul *= fadeCurveGain(
                clamp((safeLenBeats - beatAt) / safeFadeOut, 0, 1),
                fadeOutCurve,
            );
        }

        resultMin[i] = (min[i] ?? 0) * mul;
        resultMax[i] = (max[i] ?? 0) * mul;
    }

    return { min: resultMin, max: resultMax };
}

function minMaxEnvelopeFromSamples(
    samples: number[],
    columns: number,
): {
    min: number[];
    max: number[];
} {
    const srcN = samples.length;
    const n = Math.max(1, Math.floor(columns));
    const outMin: number[] = new Array(n);
    const outMax: number[] = new Array(n);
    if (srcN <= 0) {
        outMin.fill(0);
        outMax.fill(0);
        return { min: outMin, max: outMax };
    }

    // Partition samples into N buckets and take min/max in each bucket.
    for (let x = 0; x < n; x += 1) {
        const s0 = Math.floor((x * srcN) / n);
        const s1 = Math.floor(((x + 1) * srcN) / n);
        const start = clamp(s0, 0, srcN - 1);
        const end = clamp(Math.max(s1, start + 1), 0, srcN);

        let mn = Number.POSITIVE_INFINITY;
        let mx = Number.NEGATIVE_INFINITY;
        for (let i = start; i < end; i += 1) {
            const v = Number(samples[i] ?? 0);
            if (v < mn) mn = v;
            if (v > mx) mx = v;
        }
        if (!Number.isFinite(mn) || !Number.isFinite(mx)) {
            const v = Number(samples[start] ?? 0);
            mn = v;
            mx = v;
        }
        outMin[x] = mn;
        outMax[x] = mx;
    }

    return { min: outMin, max: outMax };
}

export const ClipItem: React.FC<{
    clip: ClipInfo;
    rowHeight: number;
    pxPerSec: number;
    waveform: WaveformPreview | undefined;
    altPressed?: boolean;
    selected: boolean;
    isInMultiSelectedSet: boolean;
    multiSelectedCount: number;

    ensureSelected: (clipId: string) => void;
    selectClipRemote: (clipId: string) => void;
    openContextMenu: (clipId: string, clientX: number, clientY: number) => void;

    /** 轨道主题色，用于 Clip 背景色和选中边框�?*/
    trackColor?: string;

    seekFromClientX: (clientX: number, commit: boolean) => void;
    startClipDrag: (
        e: React.PointerEvent<HTMLDivElement>,
        clipId: string,
        clipstartSec: number,
        altPressedHint?: boolean,
    ) => void;
    startEditDrag: (
        e: React.PointerEvent,
        clipId: string,
        type:
            | "trim_left"
            | "trim_right"
            | "stretch_left"
            | "stretch_right"
            | "fade_in"
            | "fade_out"
            | "gain",
    ) => void;
    toggleClipMuted: (clipId: string, nextMuted: boolean) => void;

    clearContextMenu: () => void;

    /** 外部触发重命名（来自右键菜单�?*/
    triggerRename?: boolean;
    onRenameCommit?: (clipId: string, newName: string) => void;
    onRenameDone?: () => void;
    onGainCommit?: (clipId: string, db: number) => void;
}> = ({
    clip,
    rowHeight,
    pxPerSec,
    waveform,
    altPressed = false,
    selected,
    isInMultiSelectedSet,
    multiSelectedCount,
    ensureSelected,
    selectClipRemote,
    openContextMenu,
    seekFromClientX,
    startClipDrag,
    startEditDrag,
    toggleClipMuted,
    clearContextMenu,
    triggerRename,
    onRenameCommit,
    onRenameDone,
    onGainCommit,
    trackColor,
}) => {
    const { t } = useI18n();
    const { mode: themeMode } = useAppTheme();
    const waveformColors = React.useMemo(
        () => getWaveformColors(themeMode),
        [themeMode],
    );

    const left = Math.max(0, clip.startSec * pxPerSec);
    const width = Math.max(1, clip.lengthSec * pxPerSec);
    const bodyHeight = Math.max(
        1,
        rowHeight - CLIP_BODY_PADDING_Y - CLIP_HEADER_HEIGHT,
    );

    // source 可用窗口长度（秒）：durationSec 减去两端裁剪量。
    // 此值不随 trim/stretch/BPM 变化，用于固定 sliceWaveformSamples 的输出密度，
    // 确保 trim 拖动时波形不缩放（只改变切片起止点），stretch 时由 SVG 自动拉伸。
    const durationSec = Math.max(0, Number(clip.durationSec ?? 0) || 0);
    const trimStartRaw = Number(clip.trimStartSec ?? 0) || 0;
    const trimStart = Math.max(0, trimStartRaw);
    const trimEnd = Math.max(0, Number(clip.trimEndSec ?? 0) || 0);
    const sourceAvailSec = Math.max(0, durationSec - trimStart - trimEnd);

    const showRepeatMarker = false;
    const repeatMarkerX = 0;

    const waveformAmpScale = clip.muted
        ? 0
        : clamp(Number(clip.gain ?? 1), 0, 4);

    // Map full-scale audio (|v|�?) to the band boundary. Keep gain applied.
    const waveformVisualAmpScale = waveformAmpScale;

    const hasWaveformPreview = waveform != null;

    const peaks = useClipWaveformPeaks({
        clip,
        widthPx: width,
        altPressed,
        hasWaveformPreview,
    });

    const stereo =
        waveform &&
        typeof waveform === "object" &&
        !Array.isArray(waveform) &&
        "l" in waveform &&
        "r" in waveform;

    const clipForWaveform = React.useMemo(
        () => ({
            trimStartSec: clip.trimStartSec,
            trimEndSec: clip.trimEndSec,
            // 传入 source 可用窗口长度（秒）作为 desiredLen，
            // 使输出采样密度固定，trim 时不缩放波形，stretch 时由 SVG 自动拉伸。
            lengthSec: sourceAvailSec,
            durationSec: clip.durationSec,
        }),
        [
            clip.trimStartSec,
            clip.trimEndSec,
            sourceAvailSec,
            clip.durationSec,
        ],
    );

    const waveformSvg = React.useMemo(() => {
        const quantizeCols = (raw: number) =>
            clamp(
                Math.round(clamp(Math.floor(raw), 16, 8192) / 64) * 64,
                16,
                8192,
            );

        const renderCols = peaks?.ok
            ? clamp(Math.floor(peaks.columns), 16, 8192)
            : quantizeCols(width);

        const w = renderCols;
        const totalH = 24;
        const gap = 2;
        const bandH = (totalH - gap) / 2;
        const halfH = bandH / 2;
        const centerTop = halfH;
        const centerBot = bandH + gap + halfH;

        const lenBeats = Number(clip.lengthSec ?? 0) || 0;
        const fadeIn = Number(clip.fadeInSec ?? 0) || 0;
        const fadeOut = Number(clip.fadeOutSec ?? 0) || 0;
        const fadeInCurve: FadeCurveType = clip.fadeInCurve ?? "sine";
        const fadeOutCurve: FadeCurveType = clip.fadeOutCurve ?? "sine";

        // 统一样式：从主题配置读取波形颜色
        const fill = waveformColors.fill;
        const stroke = waveformColors.stroke;
        // preview 状态用降低 opacity 表示加载中，不使用虚�?
        const waveformOpacity = peaks?.isPreview ? 0.6 : 1.0;

        let topMin: number[] | null = null;
        let topMax: number[] | null = null;
        let botMin: number[] | null = null;
        let botMax: number[] | null = null;

        if (
            peaks &&
            peaks.ok &&
            peaks.min.length >= 2 &&
            peaks.max.length >= 2
        ) {
            // Backend peaks are currently mono; duplicate into two bands for DAW-style look.
            topMin = peaks.min;
            topMax = peaks.max;
            botMin = peaks.min;
            botMax = peaks.max;
        } else if (stereo) {
            const wf = waveform as { l: number[]; r: number[] };
            const leftSamples = sliceWaveformSamples(
                wf.l ?? [],
                clipForWaveform,
            );
            const rightSamples = sliceWaveformSamples(
                wf.r ?? [],
                clipForWaveform,
            );
            const leftEnv = minMaxEnvelopeFromSamples(leftSamples, w);
            const rightEnv = minMaxEnvelopeFromSamples(rightSamples, w);
            topMin = leftEnv.min;
            topMax = leftEnv.max;
            botMin = rightEnv.min;
            botMax = rightEnv.max;
        } else if (Array.isArray(waveform) && waveform.length > 0) {
            const mono = sliceWaveformSamples(waveform, clipForWaveform);
            if (mono.length < 2) return null;
            const env = minMaxEnvelopeFromSamples(mono, w);
            topMin = env.min;
            topMax = env.max;
            botMin = env.min;
            botMax = env.max;
        } else {
            return null;
        }

        // 应用淡入淡出效果到波形数�?
        const topFaded = applyFadeGainToPeaks(
            topMin,
            topMax,
            waveformVisualAmpScale,
            lenBeats,
            fadeIn,
            fadeOut,
            fadeInCurve,
            fadeOutCurve,
        );
        const botFaded = applyFadeGainToPeaks(
            botMin,
            botMax,
            waveformVisualAmpScale,
            lenBeats,
            fadeIn,
            fadeOut,
            fadeInCurve,
            fadeOutCurve,
        );

        // 使用共享渲染函数生成 SVG 路径
        const topD = renderWaveformSvg(
            {
                min: topFaded.min,
                max: topFaded.max,
                timestamps: [], // 空数组表示使用均匀分布
                stride: 1,
            },
            {
                width: w,
                height: totalH,
                centerY: centerTop,
                halfHeight: halfH,
                amplitudeScale: 1.0, // 振幅已在 applyFadeGainToPeaks 中处�?
            },
        );

        const botD = renderWaveformSvg(
            {
                min: botFaded.min,
                max: botFaded.max,
                timestamps: [],
                stride: 1,
            },
            {
                width: w,
                height: totalH,
                centerY: centerBot,
                halfHeight: halfH,
                amplitudeScale: 1.0,
            },
        );

        if (!topD && !botD) return null;
        return (
            <svg
                viewBox={`0 0 ${w} ${totalH}`}
                preserveAspectRatio="none"
                className="w-full h-full"
                style={{ opacity: waveformOpacity }}
            >
                {topD ? (
                    <path
                        d={topD}
                        fill={fill}
                        stroke={stroke}
                        strokeWidth="1"
                        vectorEffect="non-scaling-stroke"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                    />
                ) : null}
                {botD ? (
                    <path
                        d={botD}
                        fill={fill}
                        stroke={stroke}
                        strokeWidth="1"
                        vectorEffect="non-scaling-stroke"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                    />
                ) : null}
            </svg>
        );
    }, [
        clipForWaveform,
        clip.fadeInSec,
        clip.fadeOutSec,
        clip.fadeInCurve,
        clip.fadeOutCurve,
        clip.lengthSec,
        peaks,
        stereo,
        waveform,
        waveformAmpScale,
        waveformVisualAmpScale,
        // 注意：不依赖 width，trim 拖动时 width 变化不应触发波形重渲染。
        // peaks?.ok 时 w = peaks.columns（固定值），与 width 无关。
        // peaks 为 null 时 quantizeCols(width) 只影响初始占位列数，可接受延迟更新。
        // 不依赖 bpm：波形内容基于秒域计算，BPM 变化不影响波形显示。
    ]);

    return (
        <div
            className={`absolute cursor-pointer overflow-visible group ${clip.muted ? "opacity-60 grayscale" : "opacity-95"}`}
            style={{
                left,
                width,
                top: 0,
                height: rowHeight - CLIP_BODY_PADDING_Y,
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!isInMultiSelectedSet) {
                    ensureSelected(clip.id);
                }
                selectClipRemote(clip.id);
                openContextMenu(clip.id, e.clientX, e.clientY);
            }}
            onPointerDown={(e) => {
                if (e.button !== 0) return;

                const alt = Boolean(
                    altPressed ||
                    e.altKey ||
                    e.nativeEvent.getModifierState?.("Alt"),
                );

                // Seek should happen on click, not on drag.
                // Track whether the pointer moved beyond a small deadzone.
                const allowSeek = !alt && !e.ctrlKey && !e.metaKey;
                const startX = e.clientX;
                const startY = e.clientY;
                let moved = false;

                function onMove(ev: PointerEvent) {
                    if (ev.pointerId !== e.pointerId) return;
                    const dx = ev.clientX - startX;
                    const dy = ev.clientY - startY;
                    if (dx * dx + dy * dy >= 9) moved = true;
                }

                function onUp(ev: PointerEvent) {
                    if (ev.pointerId !== e.pointerId) return;
                    window.removeEventListener("pointermove", onMove, true);
                    window.removeEventListener("pointerup", onUp, true);
                    window.removeEventListener("pointercancel", onUp, true);
                    if (!moved && allowSeek) {
                        seekFromClientX(ev.clientX, true);
                    }
                }

                window.addEventListener("pointermove", onMove, true);
                window.addEventListener("pointerup", onUp, true);
                window.addEventListener("pointercancel", onUp, true);

                e.preventDefault();
                e.stopPropagation();
                clearContextMenu();

                if (multiSelectedCount === 0 || !isInMultiSelectedSet) {
                    ensureSelected(clip.id);
                }
                selectClipRemote(clip.id);
                startClipDrag(e, clip.id, clip.startSec, alt);
            }}
            title={clip.sourcePath ?? clip.name}
        >
            <ClipEdgeHandles
                clipId={clip.id}
                altPressed={altPressed}
                multiSelectedCount={multiSelectedCount}
                isInMultiSelectedSet={isInMultiSelectedSet}
                ensureSelected={ensureSelected}
                selectClipRemote={selectClipRemote}
                startEditDrag={startEditDrag}
            />

            <ClipHeader
                clip={clip}
                ensureSelected={ensureSelected}
                selectClipRemote={selectClipRemote}
                startEditDrag={startEditDrag}
                toggleClipMuted={toggleClipMuted}
                isInMultiSelectedSet={isInMultiSelectedSet}
                multiSelectedCount={multiSelectedCount}
                triggerRename={triggerRename}
                onRenameCommit={onRenameCommit}
                onRenameDone={onRenameDone}
                onGainCommit={onGainCommit}
            />

            {/* Body block (does not fill the entire track row; leaves header lane above) */}
            <div
                className={`absolute left-0 right-0 bottom-0 rounded-sm shadow-sm overflow-visible border transition-colors ${
                    selected
                        ? "border-white/90"
                        : "border-transparent group-hover:border-white/30"
                }`}
                style={{
                    top: CLIP_HEADER_HEIGHT,
                    backgroundColor: trackColor
                        ? `color-mix(in oklab, ${trackColor} 30%, transparent)`
                        : "color-mix(in oklab, var(--qt-highlight) 35%, transparent)",
                }}
            >
                {/* Body (waveform + edit handles) */}
                <div className="absolute inset-0">
                    {/* Fade 角落 handle：始终存在，位于 body 左上�?右上角，用于�?0 开始拖拽出渐变 */}
                    {/* left-[10px]：避开左侧 edge handle �?10px 宽度，确保两者不重叠 */}
                    <div
                        className="absolute left-[10px] top-0 w-[14px] h-[14px] z-[55]"
                        style={{ cursor: "nwse-resize" }}
                        onPointerDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (multiSelectedCount === 0 || !isInMultiSelectedSet) {
                                ensureSelected(clip.id);
                            }
                            selectClipRemote(clip.id);
                            startEditDrag(e, clip.id, "fade_in");
                        }}
                        title={t("fade_in")}
                    />
                    {/* right-[10px]：避开右侧 edge handle �?10px 宽度，确保两者不重叠 */}
                    <div
                        className="absolute right-[10px] top-0 w-[14px] h-[14px] z-[55]"
                        style={{ cursor: "nesw-resize" }}
                        onPointerDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (multiSelectedCount === 0 || !isInMultiSelectedSet) {
                                ensureSelected(clip.id);
                            }
                            selectClipRemote(clip.id);
                            startEditDrag(e, clip.id, "fade_out");
                        }}
                        title={t("fade_out")}
                    />

                    {/* Fade handles: 操作区覆盖整�?fade 区域（fadeBeats > 0 时显示） */}
                    {(clip.fadeInSec ?? 0) > 0 && (
                        <div
className="absolute left-0 top-0 h-full z-[40] cursor-nwse-resize"
                            style={{
                                width: Math.min(
                                    width,
                                    (clip.fadeInSec ?? 0) * pxPerSec,
                                ),
                            }}
                            onPointerDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (
                                    multiSelectedCount === 0 ||
                                    !isInMultiSelectedSet
                                ) {
                                    ensureSelected(clip.id);
                                }
                                selectClipRemote(clip.id);
                                startEditDrag(e, clip.id, "fade_in");
                            }}
                            title={t("fade_in")}
                        >
                            {/* 全区域条带：与可交互区域完全重合，右边缘竖线表示可拖拽边�?*/}
                            <div
                                className={
                                    "absolute inset-0 rounded-l-sm bg-white/8 border-r transition-opacity " +
                                    (selected
                                        ? "opacity-100 border-white/70"
                                        : "opacity-30 border-white/40 group-hover:opacity-100")
                                }
                            />
                        </div>
                    )}
                    {(clip.fadeOutSec ?? 0) > 0 && (
                        <div
className="absolute right-0 top-0 h-full z-[40] cursor-nesw-resize"
                            style={{
                                width: Math.min(
                                    width,
                                    (clip.fadeOutSec ?? 0) * pxPerSec,
                                ),
                            }}
                            onPointerDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (
                                    multiSelectedCount === 0 ||
                                    !isInMultiSelectedSet
                                ) {
                                    ensureSelected(clip.id);
                                }
                                selectClipRemote(clip.id);
                                startEditDrag(e, clip.id, "fade_out");
                            }}
                            title={t("fade_out")}
                        >
                            {/* 全区域条带：与可交互区域完全重合，左边缘竖线表示可拖拽边�?*/}
                            <div
                                className={
                                    "absolute inset-0 rounded-r-sm bg-white/8 border-l transition-opacity " +
                                    (selected
                                        ? "opacity-100 border-white/70"
                                        : "opacity-30 border-white/40 group-hover:opacity-100")
                                }
                            />
                        </div>
                    )}

                    <div className="absolute inset-0 pointer-events-none z-30">
                        {showRepeatMarker ? (
                            <div
                                className="absolute top-0 bottom-0"
                                style={{
                                    left: Math.max(
                                        0,
                                        Math.min(width - 1, repeatMarkerX),
                                    ),
                                    width: 1,
                                    backgroundColor: "rgba(255,255,255,0.35)",
                                }}
                                title={t("repeat")}
                            />
                        ) : null}
                        {clip.fadeInSec > 0 ? (
                            <svg
                                className="absolute left-0 top-0 h-full"
                                width={Math.min(
                                    width,
                                    clip.fadeInSec * pxPerSec,
                                )}
                                height={bodyHeight}
                                viewBox={`0 0 ${Math.max(1, Math.min(width, clip.fadeInSec * pxPerSec))} ${Math.max(1, bodyHeight)}`}
                                preserveAspectRatio="none"
                            >
                                <path
                                    d={fadeInAreaPath(
                                        Math.max(
                                            1,
                                            Math.min(
                                                width,
                                                clip.fadeInSec * pxPerSec,
                                            ),
                                        ),
                                        Math.max(1, bodyHeight),
                                        24,
                                        clip.fadeInCurve ?? "sine",
                                    )}
                                    fill="rgba(255,255,255,0.14)"
                                    stroke="rgba(255,255,255,0.55)"
                                    strokeWidth="1"
                                    vectorEffect="non-scaling-stroke"
                                />
                            </svg>
                        ) : null}
                        {clip.fadeOutSec > 0 ? (
                            <svg
                                className="absolute right-0 top-0 h-full"
                                width={Math.min(
                                    width,
                                    clip.fadeOutSec * pxPerSec,
                                )}
                                height={bodyHeight}
                                viewBox={`0 0 ${Math.max(1, Math.min(width, clip.fadeOutSec * pxPerSec))} ${Math.max(1, bodyHeight)}`}
                                preserveAspectRatio="none"
                            >
                                <path
                                    d={fadeOutAreaPath(
                                        Math.max(
                                            1,
                                            Math.min(
                                                width,
                                                clip.fadeOutSec * pxPerSec,
                                            ),
                                        ),
                                        Math.max(1, bodyHeight),
                                        24,
                                        clip.fadeOutCurve ?? "sine",
                                    )}
                                    fill="rgba(255,255,255,0.14)"
                                    stroke="rgba(255,255,255,0.55)"
                                    strokeWidth="1"
                                    vectorEffect="non-scaling-stroke"
                                />
                            </svg>
                        ) : null}
                    </div>

                    <div className="absolute inset-x-0 inset-y-1 opacity-80">
                        {waveformSvg}
                    </div>
                </div>
            </div>
        </div>
    );
};
