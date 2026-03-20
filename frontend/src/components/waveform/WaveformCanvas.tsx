/**
 * 波形画布组件（可视区裁剪优化版，v2 mipmap 缓存架构）
 *
 * 使用 waveformMipmapStore（三级整文件 mipmap 缓存）获取波形数据，
 * 通过内置 resample 降采样后，以 Canvas per-pixel min/max 竖线模式绘制波形。
 *
 * 数据流：
 *   waveformMipmapStore.getResampledSlice() → interleaved Float32Array → applyGainsToPeaks → renderWaveform
 *
 * 性能优化：
 * - 可视区裁剪：canvas 只渲染屏幕上可见的像素列，放大时性能不再线性增长
 * - 整文件级缓存：无 IPC 请求，数据已在前端内存中
 * - Float32Array 零拷贝切片：无需每帧分配新 buffer
 * - 逐像素绘制：每个像素列取对应时间范围内的 min/max，画一条竖线
 * - 无锯齿：无论缩放级别如何，波形始终连贯平滑
 *
 * 缓存特性（三级 mipmap）：
 * - L0 (div=64):   精细级，spp ≤ 256
 * - L1 (div=512):  中间级，256 < spp ≤ 2048
 * - L2 (div=4096): 全局级，spp > 2048
 */
import React from "react";
import {
    applyGainsToPeaks,
    renderWaveform,
    type WaveformRenderParams,
} from "../../utils/waveformRenderer";
import { waveformMipmapStore } from "../../utils/waveformMipmapStore";
import type { FadeCurveType } from "../layout/timeline/paths";

/** 可视区缓冲（像素），防止滚动时出现空白；固定像素数，不随缩放膨胀 */
const BUFFER_PX = 500;

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

    // 强制重绘计数器（mipmap 数据加载完成时 +1 触发重绘）
    const [redrawTick, setRedrawTick] = React.useState(0);

    // 计算 samplesPerPixel
    const samplesPerPixel = React.useMemo(() => {
        if (!props.sampleRate || !props.pxPerSec) {
            return undefined;
        }
        return Math.max(1, Math.round(props.sampleRate / props.pxPerSec));
    }, [props.sampleRate, props.pxPerSec]);

    // 监听 mipmap 缓存加载完成
    React.useEffect(() => {
        if (!sourcePath) return;
        const unsub = waveformMipmapStore.addListener((path, status) => {
            if (status === "done" && path === sourcePath) {
                setRedrawTick((t) => t + 1);
            }
        });
        return unsub;
    }, [sourcePath]);

    // ========================================
    // 可视区裁剪：计算 clip 在屏幕上实际可见的部分
    // ========================================
    const visibleInfo = React.useMemo(() => {
        const clipLen = clipDurationSec ?? 0;
        const clipStart = clipStartSec ?? 0;
        const clipEnd = clipStart + clipLen;
        const fullWidthPx = targetWidthPx;

        if (viewportStartSec === undefined || viewportEndSec === undefined || clipLen <= 0 || !props.pxPerSec) {
            return {
                visibleWidthPx: fullWidthPx,
                offsetPx: 0,
                visibleStartRatio: 0,
                visibleEndRatio: 1,
            };
        }

        const bufferSec = BUFFER_PX / props.pxPerSec;
        const visStart = Math.max(clipStart, viewportStartSec - bufferSec);
        const visEnd = Math.min(clipEnd, viewportEndSec + bufferSec);

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
    }, [targetWidthPx, clipDurationSec, clipStartSec, viewportStartSec, viewportEndSec, props.pxPerSec]);

    // 计算可视区对应的源文件时间范围
    const viewportInfo = React.useMemo(() => {
        if (!sourcePath || !sourceDurationSec || sourceDurationSec <= 0) {
            return null;
        }

        const clipLen = clipDurationSec ?? 0;
        const clipStart = clipStartSec ?? 0;
        const clipEnd = clipStart + clipLen;

        if (viewportStartSec === undefined || viewportEndSec === undefined || !props.pxPerSec) {
            const pr = Math.max(1e-6, playbackRate);
            const sourceAvailSec = sourceDurationSec;
            const sourceTimeStart = Math.max(0, sourceStartSec);
            const sourceTimeEnd = Math.min(sourceAvailSec, sourceStartSec + clipLen * pr);
            return {
                sourceTimeStart,
                sourceDuration: Math.max(0.1, sourceTimeEnd - sourceTimeStart),
            };
        }

        const bufferSec = BUFFER_PX / props.pxPerSec;
        const visibleStart = Math.max(clipStart, viewportStartSec - bufferSec);
        const visibleEnd = Math.min(clipEnd, viewportEndSec + bufferSec);

        if (visibleEnd <= visibleStart) {
            return null;
        }

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
        props.pxPerSec,
    ]);

    const displayedW = Math.max(1, Math.floor(visibleInfo.visibleWidthPx));

    // 主渲染逻辑
    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const displayedH = Math.max(1, Math.floor(heightPx));

        const internalW = Math.max(1, Math.floor(displayedW * dpr));
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

        // 从 mipmap 缓存获取 resample 后的数据
        if (sourcePath && samplesPerPixel && viewportInfo) {
            const result = waveformMipmapStore.getResampledSlice(
                sourcePath,
                samplesPerPixel,
                viewportInfo.sourceTimeStart,
                viewportInfo.sourceDuration,
                displayedW,
            );

            if (result && result.interleaved.length >= 4) {
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
                    dataStartSec: result.dataStartSec,
                    dataDurationSec: result.dataDurationSec,
                    clipPixelOffset: visibleInfo.offsetPx,
                    clipTotalWidthPx: targetWidthPx,
                };

                const withGains = applyGainsToPeaks(result.interleaved, params);
                renderWaveform(ctx, withGains, params, stroke, strokeWidth);
            }
        }
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
        sourcePath,
        samplesPerPixel,
        viewportInfo,
        visibleInfo,
        displayedW,
        redrawTick,
    ]);

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
