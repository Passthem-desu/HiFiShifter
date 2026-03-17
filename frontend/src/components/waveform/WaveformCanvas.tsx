/**
 * 波形画布组件（可视区裁剪优化版）
 * 
 * 使用 mipmapCache（四级固定区间缓存）获取波形数据，
 * 通过 Canvas per-pixel min/max 竖线模式绘制波形（DAW 标准做法）。
 * 
 * 性能优化：
 * - 可视区裁剪：canvas 只渲染屏幕上可见的像素列，放大时性能不再线性增长
 * - 逐像素绘制：每个像素列取对应时间范围内的 min/max，画一条竖线
 * - 无锯齿：无论缩放级别如何，波形始终连贯平滑
 * - 自动适配：数据过多时聚合，数据不足时优雅降级
 * 
 * 缓存特性（Level 编号与后端 hfspeaks_v2 对齐）：
 * - Level 0(5s,  div=128)  特写/高精度
 * - Level 1(10s, div=512)  近景
 * - Level 2(30s, div=2048) 中景
 * - Level 3(60s, div=8192) 远景/全景
 * - 时间参数量化：0.5秒步长，减少缓存抖动
 * - LRU淘汰：基于访问时间淘汰不常用缓存
 * - 时间轴预加载：自动预加载相邻时间区间
 * - 跨区块合并：可视区覆盖多区块时自动拼接数据
 */
import React from "react";
import {
    applyGainsToPeaks,
    renderWaveform,
    type WaveformRenderParams,
} from "../../utils/waveformRenderer";
import { mipmapCache } from "../../utils/mipmapCache";
import type { FadeCurveType } from "../layout/timeline/paths";

/** 缓冲区大小（秒） */
const BUFFER_SEC = 2;

export type WaveformCanvasProps = {
    targetWidthPx: number;
    heightPx: number;
    stroke?: string;
    strokeWidth?: number;
    opacity?: number;

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

    /** 源文件采样率（用于计算 samplesPerPixel） */
    sampleRate?: number;
    /** 每秒像素数（用于计算 samplesPerPixel） */
    pxPerSec?: number;
};

export default function WaveformCanvas(props: WaveformCanvasProps) {
    const {
        targetWidthPx,
        heightPx,
        stroke = "currentColor",
        strokeWidth = 1,
        opacity = 1,
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

    // mipmap 数据状态
    const [peakData, setPeakData] = React.useState<{
        min: number[];
        max: number[];
        mipmapLevel: number;
        divisionFactor: number;
        /** 数据起始时间（秒，源文件坐标系） */
        dataStartSec: number;
        /** 数据持续时间（秒） */
        dataDurationSec: number;
    } | null>(null);

    // 计算 samplesPerPixel
    const samplesPerPixel = React.useMemo(() => {
        if (!props.sampleRate || !props.pxPerSec) {
            return undefined;
        }
        return Math.max(1, Math.round(props.sampleRate / props.pxPerSec));
    }, [props.sampleRate, props.pxPerSec]);

    // ========================================
    // 可视区裁剪：计算 clip 在屏幕上实际可见的部分
    // ========================================
    const visibleInfo = React.useMemo(() => {
        const clipLen = clipDurationSec ?? 0;
        const clipStart = clipStartSec ?? 0;
        const clipEnd = clipStart + clipLen;
        const fullWidthPx = targetWidthPx;

        // 如果没有可视区信息，使用完整宽度（向后兼容）
        if (viewportStartSec === undefined || viewportEndSec === undefined || clipLen <= 0) {
            return {
                /** canvas 渲染的像素宽度（仅可见部分） */
                visibleWidthPx: fullWidthPx,
                /** 可见部分在 clip 内的像素偏移（用于定位 canvas） */
                offsetPx: 0,
                /** 可见部分在 clip 内的起始比例 (0~1) */
                visibleStartRatio: 0,
                /** 可见部分在 clip 内的结束比例 (0~1) */
                visibleEndRatio: 1,
            };
        }

        // 计算可视区与 clip 的交集（加一点 buffer 防止滚动时出现空白）
        const visStart = Math.max(clipStart, viewportStartSec - BUFFER_SEC);
        const visEnd = Math.min(clipEnd, viewportEndSec + BUFFER_SEC);

        if (visEnd <= visStart) {
            return {
                visibleWidthPx: 0,
                offsetPx: 0,
                visibleStartRatio: 0,
                visibleEndRatio: 0,
            };
        }

        const startRatio = (visStart - clipStart) / clipLen;
        const endRatio = (visEnd - clipStart) / clipLen;
        const offsetPx = Math.floor(startRatio * fullWidthPx);
        const visibleWidthPx = Math.max(1, Math.ceil(endRatio * fullWidthPx) - offsetPx);

        return {
            visibleWidthPx,
            offsetPx,
            visibleStartRatio: startRatio,
            visibleEndRatio: endRatio,
        };
    }, [targetWidthPx, clipDurationSec, clipStartSec, viewportStartSec, viewportEndSec]);

    // 计算可视区交集 + 缓冲区
    const viewportInfo = React.useMemo(() => {
        if (!sourcePath || !sourceDurationSec || sourceDurationSec <= 0) {
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
        if (!sourcePath || !samplesPerPixel || !viewportInfo) {
            return;
        }

        const requestId = ++requestIdRef.current;
        
        mipmapCache.getPeaks(
            sourcePath,
            samplesPerPixel,
            viewportInfo.sourceTimeStart,
            viewportInfo.sourceDuration,
            visibleInfo.visibleWidthPx,
        ).then((data) => {
            if (requestId !== requestIdRef.current) return;
            if (data) {
                setPeakData({
                    min: data.min,
                    max: data.max,
                    mipmapLevel: data.mipmapLevel,
                    divisionFactor: data.divisionFactor,
                    dataStartSec: data.startSec,
                    dataDurationSec: data.durationSec,
                });
            }
        });
    }, [viewportInfo, sourcePath, samplesPerPixel, visibleInfo.visibleWidthPx]);

    // 主渲染逻辑
    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        // ========================================
        // 关键优化：canvas 宽度 = 可见宽度（而非整个 clip 宽度）
        // ========================================
        const displayedW = Math.max(1, Math.floor(visibleInfo.visibleWidthPx));
        const displayedH = Math.max(1, Math.floor(heightPx));
        const dpr = Math.max(1, window.devicePixelRatio || 1);

        // 保护极端大的 canvas（优化后这个限制几乎不会触及）
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

        // 使用 mipmap 数据渲染
        if (peakData && peakData.min.length >= 2) {
            const params: WaveformRenderParams = {
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
                dataStartSec: peakData.dataStartSec,
                dataDurationSec: peakData.dataDurationSec,
                // 可视区裁剪参数：告诉 renderWaveform 这个 canvas 对应整个 clip 的哪个部分
                clipPixelOffset: visibleInfo.offsetPx,
                clipTotalWidthPx: targetWidthPx,
            };

            // 直接使用后端数据
            const minData = peakData.min;
            const maxData = peakData.max;

            // 应用增益并渲染
            const peaks = new Float32Array(minData.length * 2);
            for (let i = 0; i < minData.length; i++) {
                peaks[i * 2] = minData[i];
                peaks[i * 2 + 1] = maxData[i];
            }
            const withGains = applyGainsToPeaks(peaks, params);

            // 渲染
            renderWaveform(ctx, withGains, params, stroke, strokeWidth);
            return;
        }

        // 无数据时不渲染
    }, [
        targetWidthPx,
        heightPx,
        stroke,
        strokeWidth,
        opacity,
        sourceStartSec,
        clipDurationSec,
        playbackRate,
        volumeGain,
        fadeInSec,
        fadeOutSec,
        fadeInCurve,
        fadeOutCurve,
        peakData,
        visibleInfo,
    ]);

    // 如果可见宽度为 0，不渲染
    if (visibleInfo.visibleWidthPx <= 0) {
        return null;
    }

    return (
        <div
            style={{
                position: 'relative',
                width: targetWidthPx,
                height: heightPx,
                overflow: 'hidden',
            }}
        >
            <canvas
                ref={canvasRef}
                style={{
                    display: 'block',
                    position: 'absolute',
                    left: visibleInfo.offsetPx,
                    top: 0,
                }}
            />
        </div>
    );
}
