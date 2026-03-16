import React from "react";
import {
    applyGainsToPeaks,
    downsampleBasePeaks,
    renderHighResWaveform,
    type HighResRenderParams,
} from "../../utils/waveformRenderer";
import { getBasePeaks, type BasePeaksCache } from "../../utils/basePeaksManager";
import type { FadeCurveType } from "../layout/timeline/paths";

export type WaveformCanvasProps = {
    /** 旧版 props（兼容模式） */
    min?: number[];
    max?: number[];
    targetWidthPx: number;
    heightPx: number;
    /** clip 级别的参考峰值（绝对值，0..1）。优先使用以保证缩放时垂直标度一致 */
    clipPeak?: number;
    stroke?: string;
    strokeWidth?: number;
    opacity?: number;

    // 新版 props（高精度模式）
    /** 是否启用高精度模式 */
    highResMode?: boolean;
    /** 源文件路径 */
    sourcePath?: string;
    /** 源文件时长（秒） */
    sourceDurationSec?: number;
    /** clip 在源文件中的起始位置（秒） */
    sourceStartSec?: number;
    /** clip 时长（秒） */
    clipDurationSec?: number;
    /** 播放速度 */
    playbackRate?: number;
    /** clip 音量增益（线性值） */
    volumeGain?: number;
    /** 淡入时长（秒） */
    fadeInSec?: number;
    /** 淡出时长（秒） */
    fadeOutSec?: number;
    /** 淡入曲线类型 */
    fadeInCurve?: FadeCurveType;
    /** 淡出曲线类型 */
    fadeOutCurve?: FadeCurveType;

    // Tile-mode props (保留兼容)
    tileMode?: boolean;
    sourceStartOffsetSec?: number;
    cycleLenSecTimeline?: number;
    pxPerSec?: number;
};

export default function WaveformCanvas(props: WaveformCanvasProps) {
    const {
        min,
        max,
        targetWidthPx,
        heightPx,
        clipPeak,
        stroke = "currentColor",
        strokeWidth = 1,
        opacity = 1,
        highResMode = false,
        sourcePath,
        sourceDurationSec,
        sourceStartSec = 0,
        clipDurationSec,
        playbackRate = 1,
        volumeGain = 1,
        fadeInSec = 0,
        fadeOutSec = 0,
        fadeInCurve = "sine",
        fadeOutCurve = "sine",
    } = props;

    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const requestIdRef = React.useRef<number>(0);

    // 使用 state 管理 basePeaks，确保加载完成时触发重新渲染
    const [basePeaks, setBasePeaks] = React.useState<BasePeaksCache | null>(null);

    // 获取 base peaks（高精度模式）
    React.useEffect(() => {
        if (!highResMode || !sourcePath || !sourceDurationSec || sourceDurationSec <= 0) {
            setBasePeaks(null);
            return;
        }

        const requestId = ++requestIdRef.current;

        getBasePeaks(sourcePath, sourceDurationSec).then((peaks) => {
            if (requestId !== requestIdRef.current) return;
            setBasePeaks(peaks);
        });
    }, [highResMode, sourcePath, sourceDurationSec]);

    // 主渲染逻辑
    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const displayedW = Math.max(1, Math.floor(targetWidthPx));
        const displayedH = Math.max(1, Math.floor(heightPx));
        const dpr = Math.max(1, window.devicePixelRatio || 1);

        // 保护极端大的 canvas
        const MAX_INTERNAL_CANVAS_PX = 32767;
        const internalW = Math.max(
            1,
            Math.min(Math.floor(displayedW * dpr), MAX_INTERNAL_CANVAS_PX),
        );
        const internalH = Math.max(1, Math.floor(displayedH * dpr));

        canvas.width = internalW;
        canvas.height = internalH;
        canvas.style.width = `${displayedW}px`;
        canvas.style.height = `${displayedH}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const scaleX = internalW / Math.max(1, displayedW);
        const scaleY = internalH / Math.max(1, displayedH);
        ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
        ctx.clearRect(0, 0, displayedW, displayedH);
        ctx.globalAlpha = Math.max(0, Math.min(1, Number(opacity) || 0));

        // 高精度模式
        if (highResMode && basePeaks) {
            const params: HighResRenderParams = {
                canvasWidth: displayedW,
                canvasHeight: displayedH,
                centerY: displayedH / 2,
                sourceStartSec,
                clipDuration: clipDurationSec ?? displayedW,
                playbackRate,
                sourceDurationSec: sourceDurationSec ?? 1,
                volumeGain,
                fadeInSec,
                fadeOutSec,
                fadeInCurve,
                fadeOutCurve,
            };

            // 动态降采样：根据 canvas 宽度计算目标采样数
            // 每像素 2 个采样点，保证精度同时控制数据量
            const downsampled = downsampleBasePeaks(basePeaks.peaks, params);
            
            // 应用增益
            const withGains = applyGainsToPeaks(downsampled, params);
            
            // 渲染
            renderHighResWaveform(ctx, withGains, params, stroke, strokeWidth);
            return;
        }

        // 旧版渲染（兼容模式）
        const processedTarget = Math.max(1, Math.floor(internalW / dpr));
        const processed = processWaveformPeaksLegacy({
            min: min!,
            max: max!,
            startSec: 0,
            durSec: 1,
            visibleStartSec: 0,
            visibleDurSec: 1,
            targetWidth: processedTarget,
        });

        const n = Math.min(processed.min.length, processed.max.length);
        if (n === 0) return;

        const centerY = displayedH / 2;
        const fullAmplitude = displayedH / 2;

        const eps = 1e-9;
        let peakAbs = eps;
        if (typeof clipPeak === "number" && isFinite(clipPeak) && clipPeak > 0) {
            peakAbs = Math.max(eps, Math.min(1, Math.abs(clipPeak)));
        } else {
            for (let i = 0; i < n; i++) {
                const ma = Math.abs(processed.max[i] ?? 0);
                const mi = Math.abs(processed.min[i] ?? 0);
                if (ma > peakAbs) peakAbs = ma;
                if (mi > peakAbs) peakAbs = mi;
            }
        }

        const minOccupy = 0.12;
        const occupy = Math.min(1, Math.max(minOccupy, peakAbs));
        const amplitude = fullAmplitude * occupy;

        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const x = n === 1 ? 0 : (i / (n - 1)) * displayedW;
            const top = processed.max[i] ?? 0;
            const bot = processed.min[i] ?? 0;

            const t = i % 2 === 0 ? 0.25 : 0.75;
            const v = top + (bot - top) * t;

            const vNorm = peakAbs > eps ? v / peakAbs : 0;
            const y = centerY - vNorm * amplitude;

            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }

        ctx.strokeStyle = stroke;
        ctx.lineWidth = strokeWidth;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
    }, [
        min,
        max,
        targetWidthPx,
        heightPx,
        stroke,
        strokeWidth,
        opacity,
        clipPeak,
        highResMode,
        sourceStartSec,
        clipDurationSec,
        playbackRate,
        volumeGain,
        fadeInSec,
        fadeOutSec,
        fadeInCurve,
        fadeOutCurve,
        basePeaks, // 添加 basePeaks 到依赖，确保加载完成时触发重新渲染
    ]);

    return <canvas ref={canvasRef} />;
}

/**
 * 旧版降采样算法（保留兼容）
 */
function processWaveformPeaksLegacy(options: {
    min: number[];
    max: number[];
    startSec: number;
    durSec: number;
    visibleStartSec: number;
    visibleDurSec: number;
    targetWidth: number;
}): { min: number[]; max: number[] } {
    const { min, max, targetWidth } = options;
    const n = Math.min(min?.length ?? 0, max?.length ?? 0);
    if (n === 0) return { min: [], max: [] };

    const stride = Math.max(1, Math.min(16, Math.ceil(n / Math.max(1, targetWidth))));

    const resultMin: number[] = [];
    const resultMax: number[] = [];

    for (let i = 0; i < n; i += stride) {
        const windowEnd = Math.min(i + stride, n);
        let wMin = Infinity;
        let wMax = -Infinity;
        for (let j = i; j < windowEnd; j++) {
            const v = min[j] ?? 0;
            if (v < wMin) wMin = v;
            const u = max[j] ?? 0;
            if (u > wMax) wMax = u;
        }
        resultMin.push(wMin === Infinity ? 0 : wMin);
        resultMax.push(wMax === -Infinity ? 0 : wMax);
    }

    return { min: resultMin, max: resultMax };
}
