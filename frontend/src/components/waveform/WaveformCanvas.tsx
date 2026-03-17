/**
 * 波形画布组件
 * 统一使用 mipmapCache（四级缓存）获取波形数据
 */
import React from "react";
import {
    applyGainsToPeaks,
    renderHighResWaveform,
    type HighResRenderParams,
} from "../../utils/waveformRenderer";
import { mipmapCache } from "../../utils/mipmapCache";
import type { FadeCurveType } from "../layout/timeline/paths";

/** 分段缓存 */
interface SegmentCache {
    min: number[];
    max: number[];
    sourceTimeStart: number;
    sourceDuration: number;
    timestamp: number;
}

/** 缓冲区大小（秒） */
const BUFFER_SEC = 2;

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
    /** 是否使用 v2 mipmap API（优先于 highResMode） */
    v2Mode?: boolean;
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

    /** 可视区开始时间（秒，timeline 坐标系） */
    viewportStartSec?: number;
    /** 可视区结束时间（秒，timeline 坐标系） */
    viewportEndSec?: number;
    /** clip 在 timeline 上的起始时间（秒） */
    clipStartSec?: number;

    /** 源文件采样率（用于 v2 模式计算 samplesPerPixel） */
    sampleRate?: number;
    /** 每秒像素数（用于 v2 模式计算 samplesPerPixel） */
    pxPerSec?: number;

    // Tile-mode props (保留兼容)
    tileMode?: boolean;
    sourceStartOffsetSec?: number;
    cycleLenSecTimeline?: number;
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
        viewportStartSec,
        viewportEndSec,
        clipStartSec = 0,
    } = props;

    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const requestIdRef = React.useRef<number>(0);

    // 分段数据状态
    const [segmentData, setSegmentData] = React.useState<{
        min: number[];
        max: number[];
        sourceTimeStart: number;
        sourceDuration: number;
    } | null>(null);

// v2 模式状态
    const [v2Data, setV2Data] = React.useState<{
        min: number[];
        max: number[];
        mipmapLevel: number;
        divisionFactor: number;
        /** 数据起始时间（秒，源文件坐标系） */
        dataStartSec: number;
        /** 数据持续时间（秒） */
        dataDurationSec: number;
    } | null>(null);

    // 计算 v2 模式的 samplesPerPixel
    const samplesPerPixel = React.useMemo(() => {
        if (!props.v2Mode || !props.sampleRate || !props.pxPerSec) {
            return undefined;
        }
        // samplesPerPixel = sampleRate / pxPerSec
        return Math.max(1, Math.round(props.sampleRate / props.pxPerSec));
    }, [props.v2Mode, props.sampleRate, props.pxPerSec]);

    // 计算可视区交集 + 缓冲区
    const viewportInfo = React.useMemo(() => {
        if (!highResMode || !sourcePath || !sourceDurationSec || sourceDurationSec <= 0) {
            return null;
        }

        const clipLen = clipDurationSec ?? 0;
        const clipStart = clipStartSec ?? 0;
        const clipEnd = clipStart + clipLen;

        // 如果没有提供可视区信息，默认加载整个 clip
        if (viewportStartSec === undefined || viewportEndSec === undefined) {
            const pr = Math.max(1e-6, playbackRate);
            const sourceAvailSec = sourceDurationSec;
            const sourceTimeStart = Math.max(0, sourceStartSec);
            const sourceTimeEnd = Math.min(sourceAvailSec, sourceStartSec + clipLen * pr);
            return {
                sourceTimeStart,
                sourceDuration: Math.max(0.1, sourceTimeEnd - sourceTimeStart),
            };
        }

        // 计算可视区与 clip 的交集
        const visibleStart = Math.max(clipStart, viewportStartSec - BUFFER_SEC);
        const visibleEnd = Math.min(clipEnd, viewportEndSec + BUFFER_SEC);

        if (visibleEnd <= visibleStart) {
            return null; // clip 不在可视区内
        }

        // 映射到源文件时间
        const pr = Math.max(1e-6, playbackRate);
        const ratioStart = (visibleStart - clipStart) / Math.max(1e-6, clipLen);
        const ratioEnd = (visibleEnd - clipStart) / Math.max(1e-6, clipLen);

        const sourceAvailSec = sourceDurationSec;
        const stretchedDuration = (sourceAvailSec - sourceStartSec) / pr;
        
        const sourceTimeStart = Math.max(0, sourceStartSec + ratioStart * stretchedDuration * pr);
        const sourceTimeEnd = Math.min(sourceAvailSec, sourceStartSec + ratioEnd * stretchedDuration * pr);
        const sourceDuration = Math.max(0.1, sourceTimeEnd - sourceTimeStart);

        return {
            sourceTimeStart,
            sourceDuration,
        };
    }, [
        highResMode,
        sourcePath,
        sourceDurationSec,
        sourceStartSec,
        clipDurationSec,
        playbackRate,
        viewportStartSec,
        viewportEndSec,
        clipStartSec,
    ]);

    // 获取分段数据
    React.useEffect(() => {
        // v2 模式优先处理
        if (props.v2Mode && sourcePath && samplesPerPixel && viewportInfo) {
            const requestId = ++requestIdRef.current;
            
            mipmapCache.getPeaks(
                sourcePath,
                samplesPerPixel,
                viewportInfo.sourceTimeStart,
                viewportInfo.sourceDuration,
                targetWidthPx,
            ).then((data) => {
                if (requestId !== requestIdRef.current) return;
if (data) {
                    setV2Data({
                        min: data.min,
                        max: data.max,
                        mipmapLevel: data.mipmapLevel,
                        divisionFactor: data.divisionFactor,
                        dataStartSec: data.startSec,
                        dataDurationSec: data.durationSec,
                    });
                    setSegmentData(null); // 清除旧数据
                }
            });
            return;
        }

        // highResMode 原有逻辑：直接使用 mipmapCache
        if (!viewportInfo || !sourcePath) {
            setSegmentData(null);
            return;
        }

        const { sourceTimeStart, sourceDuration } = viewportInfo;
        const requestId = ++requestIdRef.current;

        // 计算 samplesPerPixel（假设采样率 44100）
        const ASSUMED_SAMPLE_RATE = 44100;
        const localSamplesPerPixel = Math.max(1, Math.round(ASSUMED_SAMPLE_RATE / (targetWidthPx / sourceDuration)));

        mipmapCache.getPeaks(
            sourcePath,
            localSamplesPerPixel,
            sourceTimeStart,
            sourceDuration,
            targetWidthPx,
        ).then((data) => {
            if (requestId !== requestIdRef.current) return;
            if (data) {
                const newCache: SegmentCache = {
                    min: data.min,
                    max: data.max,
                    sourceTimeStart,
                    sourceDuration,
                    timestamp: performance.now(),
                };
                setSegmentData(newCache);
            }
        });
    }, [viewportInfo, sourcePath, props.v2Mode, samplesPerPixel, targetWidthPx]);

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

// v2 模式：使用多级 mipmap 数据渲染
        if (props.v2Mode && v2Data && v2Data.min.length >= 2) {
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
                dataStartSec: v2Data.dataStartSec,
                dataDurationSec: v2Data.dataDurationSec,
            };

            // 根据显示宽度决定是否降采样
            const targetSamples = displayedW * 2;
            let minData = v2Data.min;
            let maxData = v2Data.max;

            if (minData.length > targetSamples) {
                const downsampled = downsamplePeaks(minData, maxData, targetSamples);
                minData = downsampled.min;
                maxData = downsampled.max;
            }

            // 应用增益并渲染
            const peaks = new Float32Array(minData.length * 2);
            for (let i = 0; i < minData.length; i++) {
                peaks[i * 2] = minData[i];
                peaks[i * 2 + 1] = maxData[i];
            }
            const withGains = applyGainsToPeaks(peaks, params);

            // 渲染
            renderHighResWaveform(ctx, withGains, params, stroke, strokeWidth);
            return;
        }

        // 高精度模式：使用分段数据渲染
        if (highResMode && segmentData && segmentData.min.length >= 2) {
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

            // 根据显示宽度决定是否降采样
            // 每像素需要 2 个采样点（min + max）
            const targetSamples = displayedW * 2;
            let minData = segmentData.min;
            let maxData = segmentData.max;

            if (minData.length > targetSamples) {
                // 降采样到目标宽度
                const downsampled = downsamplePeaks(minData, maxData, targetSamples);
                minData = downsampled.min;
                maxData = downsampled.max;
            }

            // 应用增益并渲染
            const peaks = new Float32Array(minData.length * 2);
            for (let i = 0; i < minData.length; i++) {
                peaks[i * 2] = minData[i];
                peaks[i * 2 + 1] = maxData[i];
            }
            const withGains = applyGainsToPeaks(peaks, params);

            // 渲染
            renderHighResWaveform(ctx, withGains, params, stroke, strokeWidth);
            return;
        }

        // 旧版渲染（兼容模式）
        if (!min || !max) return;

        const processedTarget = Math.max(1, Math.floor(internalW / dpr));
        const processed = processWaveformPeaksLegacy({
            min: min,
            max: max,
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
        segmentData,
        v2Data,
    ]);

    return <canvas ref={canvasRef} style={{ display: 'block' }} />;
}

/**
 * 降采样峰值数据到目标采样数
 */
function downsamplePeaks(
    min: number[],
    max: number[],
    targetSamples: number
): { min: number[]; max: number[] } {
    const n = Math.min(min.length, max.length);
    if (n <= targetSamples) {
        return { min: [...min], max: [...max] };
    }

    const stride = Math.max(1, Math.ceil(n / targetSamples));
    const resultMin: number[] = [];
    const resultMax: number[] = [];

    for (let i = 0; i < n; i += stride) {
        const windowEnd = Math.min(i + stride, n);
        let wMin = Infinity;
        let wMax = -Infinity;
        for (let j = i; j < windowEnd; j++) {
            const minVal = min[j] ?? 0;
            const maxVal = max[j] ?? 0;
            if (minVal < wMin) wMin = minVal;
            if (maxVal > wMax) wMax = maxVal;
        }
        resultMin.push(wMin === Infinity ? 0 : wMin);
        resultMax.push(wMax === -Infinity ? 0 : wMax);
    }

    return { min: resultMin, max: resultMax };
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
