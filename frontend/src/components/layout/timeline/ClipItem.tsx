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
import WaveformCanvas from "../../waveform/WaveformCanvas";
import { useAppTheme } from "../../../theme/AppThemeProvider";
import { getWaveformColors } from "../../../theme/waveformColors";

// 高精度模式开关（可通过 props 或全局配置覆盖）
const HIGH_RES_MODE_ENABLED = true;

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
    // 可见窗口在 lengthSec 坐标系中的起止位置（秒）。
    // peaks.ok 路径：= sourceStartSec/pr 与 sourceEndSec/pr（覆盖完整文件时用于偏移 fade）。
    // fallback 路径：均为默认值 0 / -1（-1 表示使用 lengthSec），无需偏移。
    windowStartSec = 0,
    windowEndSec = -1,
): { min: number[]; max: number[] } {
    const srcN = Math.min(min.length, max.length);
    if (srcN === 0) return { min: [], max: [] };

    const safeLenBeats = Math.max(1e-9, Number(lengthSec) || 0);
    const safeFadeIn = Math.max(0, Number(fadeInSec) || 0);
    const safeFadeOut = Math.max(0, Number(fadeOutSec) || 0);
    const safeWinStart = Math.max(0, windowStartSec);
    const safeWinEnd =
        windowEndSec >= 0 ? Math.min(safeLenBeats, windowEndSec) : safeLenBeats;

    const resultMin = new Array<number>(srcN);
    const resultMax = new Array<number>(srcN);

    for (let i = 0; i < srcN; i++) {
        const t = i / Math.max(1, srcN - 1);
        const beatAt = t * safeLenBeats;

        let mul = ampScale;
        if (safeFadeIn > 1e-9) {
            mul *= fadeCurveGain(
                clamp((beatAt - safeWinStart) / safeFadeIn, 0, 1),
                fadeInCurve,
            );
        }
        if (safeFadeOut > 1e-9) {
            mul *= fadeCurveGain(
                clamp((safeWinEnd - beatAt) / safeFadeOut, 0, 1),
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

export const ClipItem = React.memo(function ClipItem({
    clip,
    rowHeight,
    pxPerSec,
    waveform,
    altPressed = false,
    selected,
    isInMultiSelectedSet,
    multiSelectedCount,
    viewportStartSec,
    viewportEndSec,
    ensureSelected,
    selectClipRemote,
    openContextMenu,
    seekFromClientX,
    startClipDrag,
    startEditDrag,
    toggleClipMuted,
    toggleMultiSelect: _toggleMultiSelect,
    onShiftRangeSelect,
    clearContextMenu,
    triggerRename,
    onRenameCommit,
    onRenameDone,
    onGainCommit,
    trackColor,
}: {
    clip: ClipInfo;
    rowHeight: number;
    pxPerSec: number;
    waveform: WaveformPreview | undefined;
    altPressed?: boolean;
    selected: boolean;
    isInMultiSelectedSet: boolean;
    multiSelectedCount: number;
    /** 可视区开始时间（秒） */
    viewportStartSec?: number;
    /** 可视区结束时间（秒） */
    viewportEndSec?: number;

    ensureSelected: (clipId: string) => void;
    selectClipRemote: (clipId: string) => void;
    openContextMenu: (clipId: string, clientX: number, clientY: number) => void;

    /** 轨道主题色，用于 Clip 背景色和选中边框 */
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
    /** Ctrl+左键多选切换 */
    toggleMultiSelect: (clipId: string) => void;
    /** Shift+点击范围选择（跨轨按包围矩形选中） */
    onShiftRangeSelect: (clipId: string) => void;

    clearContextMenu: () => void;

    /** 外部触发重命名（来自右键菜单�?*/
    triggerRename?: boolean;
    onRenameCommit?: (clipId: string, newName: string) => void;
    onRenameDone?: () => void;
    onGainCommit?: (clipId: string, db: number) => void;
}) {
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

    // source 可用窗口长度（秒）：sourceEnd 减去两端裁剪量。
    // 此值不随 trim/stretch/BPM 变化，用于固定 sliceWaveformSamples 的输出密度，
    // 确保 trim 拖动时波形不缩放（只改变切片起止点），stretch 时由 SVG 自动拉伸。
    const sourceStartRaw = Number(clip.sourceStartSec ?? 0) || 0;
    const sourceStart = Math.max(0, sourceStartRaw);
    const sourceEnd = Number(clip.sourceEndSec ?? 0) || 0;
    const effectiveEnd = sourceEnd;
    const sourceAvailSec = Math.max(0, effectiveEnd - sourceStart);

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
            sourceStartSec: clip.sourceStartSec,
            sourceEndSec: clip.sourceEndSec,
            // 传入 source 可用窗口长度（秒）作为 desiredLen，
            // 使输出采样密度固定，trim 时不缩放波形，stretch 时由 SVG 自动拉伸。
            lengthSec: sourceAvailSec,
            durationSec: clip.durationSec,
        }),
        [
            clip.sourceStartSec,
            clip.sourceEndSec,
            sourceAvailSec,
            clip.durationSec,
        ],
    );

    // peaks 命中时，路径本身与缩放像素宽度无关；
    // 用该值避免缩放时因 width 变化触发全量路径重算。
    const widthForPath = peaks?.ok ? 0 : width;

    const waveformSvgContent = React.useMemo(() => {
        const quantizeCols = (raw: number) =>
            clamp(
                Math.round(clamp(Math.floor(raw), 16, 8192) / 64) * 64,
                16,
                8192,
            );

        const renderCols = peaks?.ok
            ? clamp(Math.floor(peaks.columns), 16, 8192)
            : quantizeCols(widthForPath);

        const w = renderCols;
        const totalH = Math.max(1, bodyHeight);

        // 使用 peaks.cycleLenSecTimeline（稳定值）作为 fade 增益的映射基准，
        // 而非 clip.lengthSec（trim 拖动时持续变化导致波形拉伸）。
        // 对于 fallback 的 waveform preview 路径，仍使用 sourceAvailSec。
        const lenBeats = peaks?.ok
            ? peaks.cycleLenSecTimeline || Number(clip.lengthSec ?? 0) || 0
            : Number(clip.lengthSec ?? 0) || 0;
        const fadeIn = Number(clip.fadeInSec ?? 0) || 0;
        const fadeOut = Number(clip.fadeOutSec ?? 0) || 0;
        const fadeInCurve: FadeCurveType = clip.fadeInCurve ?? "sine";
        const fadeOutCurve: FadeCurveType = clip.fadeOutCurve ?? "sine";

        // 统一样式：从主题配置读取波形颜色
        const stroke = waveformColors.stroke;
        // preview 状态用降低 opacity 表示加载中，不使用虚�?
        const waveformOpacity = peaks?.isPreview ? 0.6 : 1.0;

        let wMin: number[] | null = null;
        let wMax: number[] | null = null;

        if (
            peaks &&
            peaks.ok &&
            peaks.min.length >= 2 &&
            peaks.max.length >= 2
        ) {
            wMin = peaks.min;
            wMax = peaks.max;
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
            // 合并 L/R：取两个声道的 max 极值
            // waveform_preview 是绝对值数据（0~1），需要镜像为对称的 min/max
            const n = Math.min(leftEnv.max.length, rightEnv.max.length);
            wMax = new Array(n);
            wMin = new Array(n);
            for (let i = 0; i < n; i++) {
                const peak = Math.max(leftEnv.max[i], rightEnv.max[i]);
                wMax[i] = peak;
                wMin[i] = -peak;
            }
        } else if (Array.isArray(waveform) && waveform.length > 0) {
            const mono = sliceWaveformSamples(waveform, clipForWaveform);
            if (mono.length < 2) return null;
            const env = minMaxEnvelopeFromSamples(mono, w);
            // waveform_preview 是绝对值数据（0~1），需要镜像为对称的 min/max
            wMax = env.max;
            wMin = env.max.map((v) => -v);
        } else {
            return null;
        }

        // 应用淡入淡出效果到波形数据。
        // peaks.ok 路径：peaks 覆盖完整 source 文件（0 → durationSec），
        // fade 需相对于 clip 可见窗口（sourceStartSec/pr → sourceEndSec/pr）定位，
        // 否则 trim 后 fade 渐变会落在被 overflow-hidden 裁掉的不可见区域。
        const pr = Math.max(1e-6, Number(clip.playbackRate ?? 1) || 1);
        const fadeWindowStartSec = peaks?.ok
            ? Math.max(0, Number(clip.sourceStartSec ?? 0) || 0) / pr
            : 0;
        const rawSourceEnd = Number(clip.sourceEndSec ?? 0) || 0;
        const fadeWindowEndSec =
            peaks?.ok && rawSourceEnd > 0 ? rawSourceEnd / pr : -1;
        const faded = applyFadeGainToPeaks(
            wMin,
            wMax,
            waveformVisualAmpScale,
            lenBeats,
            fadeIn,
            fadeOut,
            fadeInCurve,
            fadeOutCurve,
            fadeWindowStartSec,
            fadeWindowEndSec,
        );

        // 使用 Canvas 绘制单条细线（不填充内部），并基于 faded 数据计算稳定的 clipPeak
        const canvasWidthPx = peaks?.ok
            ? Math.max(1, Math.floor((peaks.cycleLenSecTimeline || 0) * pxPerSec))
            : Math.max(1, Math.floor(width));

        const TILE_THRESHOLD = 4096;

        // compute clip-level absolute peak from faded envelope (already includes ampScale)
        let clipPeakAbs = 0;
        for (let i = 0; i < faded.min.length; i++) {
            const a = Math.abs(faded.min[i] ?? 0);
            const b = Math.abs(faded.max[i] ?? 0);
            if (a > clipPeakAbs) clipPeakAbs = a;
            if (b > clipPeakAbs) clipPeakAbs = b;
        }

        // If very wide, switch to tileMode which requests per-tile segments and
        // uses a worker to downsample on the background thread.
        // 高精度模式：使用 BasePeaksManager 缓存 + 前端降采样
        if (HIGH_RES_MODE_ENABLED && clip.sourcePath && clip.durationSec && clip.durationSec > 0) {
            return (
                <div style={{ width: canvasWidthPx, height: totalH }}>
                    <WaveformCanvas
                        targetWidthPx={canvasWidthPx}
                        heightPx={totalH}
                        stroke={stroke}
                        strokeWidth={1}
                        opacity={waveformOpacity}
                        clipPeak={clipPeakAbs}
                        highResMode={true}
                        sourcePath={clip.sourcePath}
                        sourceDurationSec={clip.durationSec}
                        sourceStartSec={Number(clip.sourceStartSec ?? 0) || 0}
                        clipDurationSec={Number(clip.lengthSec ?? 0) || 0}
                        playbackRate={Number(clip.playbackRate ?? 1) || 1}
                        volumeGain={Number(clip.gain ?? 1) || 1}
                        fadeInSec={Number(clip.fadeInSec ?? 0) || 0}
                        fadeOutSec={Number(clip.fadeOutSec ?? 0) || 0}
                        fadeInCurve={(clip.fadeInCurve as FadeCurveType) ?? "sine"}
                        fadeOutCurve={(clip.fadeOutCurve as FadeCurveType) ?? "sine"}
                        viewportStartSec={viewportStartSec}
                        viewportEndSec={viewportEndSec}
                        clipStartSec={clip.startSec}
                    />
                </div>
            );
        }

        if (canvasWidthPx > TILE_THRESHOLD && clip.sourcePath) {
            return (
                <div style={{ width: canvasWidthPx, height: totalH }}>
                    <WaveformCanvas
                        targetWidthPx={canvasWidthPx}
                        heightPx={totalH}
                        stroke={stroke}
                        strokeWidth={1}
                        opacity={waveformOpacity}
                        clipPeak={clipPeakAbs}
                        tileMode={true}
                        sourcePath={clip.sourcePath}
                        sourceStartOffsetSec={Number(clip.sourceStartSec ?? 0) || 0}
                        cycleLenSecTimeline={peaks?.cycleLenSecTimeline}
                        pxPerSec={pxPerSec}
                        playbackRate={Number(clip.playbackRate ?? 1) || 1}
                    />
                </div>
            );
        }

        // Default single-pass render
        return (
            <div style={{ width: canvasWidthPx, height: totalH }}>
                <WaveformCanvas
                    min={faded.min}
                    max={faded.max}
                    targetWidthPx={canvasWidthPx}
                    heightPx={totalH}
                    stroke={stroke}
                    strokeWidth={1}
                    opacity={waveformOpacity}
                    clipPeak={clipPeakAbs}
                />
            </div>
        );
    }, [
        clipForWaveform,
        clip.fadeInSec,
        clip.fadeOutSec,
        clip.fadeInCurve,
        clip.fadeOutCurve,
        clip.lengthSec,
        clip.playbackRate,
        clip.sourceStartSec,
        clip.sourceEndSec,
        peaks,
        widthForPath,
        stereo,
        waveform,
        waveformAmpScale,
        waveformVisualAmpScale,
        pxPerSec,
        rowHeight,
    ]);

    // 波形 SVG 固定宽度 = source 可用窗口的 timeline 像素宽度。
    // trim 拖动时此值不变，外层 overflow-hidden 裁掉超出部分，波形不拉伸。
    const waveformSvgWidthPx = peaks?.ok
        ? peaks.cycleLenSecTimeline * pxPerSec
        : width;

    const startDeferredFadeEditDrag = React.useCallback(
        (
            e: React.PointerEvent<HTMLDivElement>,
            type: "fade_in" | "fade_out",
        ) => {
            e.preventDefault();
            e.stopPropagation();
            clearContextMenu();

            if (multiSelectedCount === 0 || !isInMultiSelectedSet) {
                ensureSelected(clip.id);
            }
            selectClipRemote(clip.id);

            const startX = e.clientX;
            const startY = e.clientY;
            const pointerId = e.pointerId;
            const targetEl = e.currentTarget as HTMLElement;
            let dragStarted = false;

            const onMove = (ev: PointerEvent) => {
                if (ev.pointerId !== pointerId || dragStarted) return;
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (dx * dx + dy * dy < 9) return;
                dragStarted = true;
                startEditDrag(
                    {
                        button: 0,
                        pointerId,
                        currentTarget: targetEl,
                    } as unknown as React.PointerEvent,
                    clip.id,
                    type,
                );
            };

            const onEnd = (ev: PointerEvent) => {
                if (ev.pointerId !== pointerId) return;
                window.removeEventListener("pointermove", onMove, true);
                window.removeEventListener("pointerup", onEnd, true);
                window.removeEventListener("pointercancel", onEnd, true);
                if (!dragStarted) {
                    seekFromClientX(ev.clientX, true);
                }
            };

            window.addEventListener("pointermove", onMove, true);
            window.addEventListener("pointerup", onEnd, true);
            window.addEventListener("pointercancel", onEnd, true);
        },
        [
            clearContextMenu,
            clip.id,
            ensureSelected,
            isInMultiSelectedSet,
            multiSelectedCount,
            seekFromClientX,
            selectClipRemote,
            startEditDrag,
        ],
    );

    return (
        <div
            data-hs-clip-item="1"
            className={`absolute cursor-pointer overflow-visible group ${clip.muted ? "opacity-60 grayscale" : "opacity-95"}`}
            style={{
                left,
                width,
                top: 0,
                height: rowHeight - CLIP_BODY_PADDING_Y,
                // 选中或 hover 时提升 z-index，确保 fade 手柄不被相邻 clip 遮挡
                zIndex: selected ? 2 : undefined,
            }}
            onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.zIndex = "2";
            }}
            onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.zIndex = selected
                    ? "2"
                    : "";
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const keepExistingMultiSelection =
                    multiSelectedCount > 0 && isInMultiSelectedSet;
                if (!keepExistingMultiSelection) {
                    ensureSelected(clip.id);
                    selectClipRemote(clip.id);
                }
                openContextMenu(clip.id, e.clientX, e.clientY);
            }}
            onPointerDown={(e) => {
                if (e.button !== 0) return;

                const alt = Boolean(
                    altPressed ||
                    e.altKey ||
                    e.nativeEvent.getModifierState?.("Alt"),
                );

                if (e.shiftKey && !alt && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    clearContextMenu();
                    onShiftRangeSelect(clip.id);
                    return;
                }

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
                seekFromClientX={seekFromClientX}
                startEditDrag={startEditDrag}
            />

            <ClipHeader
                clip={clip}
                clipWidthPx={width}
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
                    {/* left-[10px]：避开左侧 edge handle 的 10px 宽度，确保两者不重叠 */}
                    <div
                        className="absolute left-[10px] top-0 w-[20px] h-[20px] z-[55]"
                        style={{ cursor: "nwse-resize" }}
                        onPointerDown={(e) => {
                            startDeferredFadeEditDrag(e, "fade_in");
                        }}
                        title={t("fade_in")}
                    />
                    {/* right-[10px]：避开右侧 edge handle 的 10px 宽度，确保两者不重叠 */}
                    <div
                        className="absolute right-[10px] top-0 w-[20px] h-[20px] z-[55]"
                        style={{ cursor: "nesw-resize" }}
                        onPointerDown={(e) => {
                            startDeferredFadeEditDrag(e, "fade_out");
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
                                startDeferredFadeEditDrag(e, "fade_in");
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
                                startDeferredFadeEditDrag(e, "fade_out");
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

                    <div className="absolute inset-0 opacity-80 overflow-hidden">
                        {/* 内层容器：通过负 marginLeft 将 trimStart 对应位置的波形对齐到容器左边缘。
                            peaks 数据覆盖整个 source 文件（0 → durationSec），SVG 固定宽度 = durationSec/pr*pxPerSec，
                            外层 overflow-hidden 裁掉左侧 trim 和右侧超出部分。 */}
                        <div
                            style={{
                                height: "100%",
                                width: waveformSvgWidthPx,
                                marginLeft: peaks?.ok
                                    ? -(
                                          Math.max(
                                              0,
                                              Number(
                                                  clip.sourceStartSec ?? 0,
                                              ) || 0,
                                          ) /
                                          Math.max(
                                              1e-6,
                                              Number(clip.playbackRate ?? 1) ||
                                                  1,
                                          )
                                      ) * pxPerSec
                                    : 0,
                            }}
                        >
                            {waveformSvgContent}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
});
