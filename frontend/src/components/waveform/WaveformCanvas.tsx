/**
 * 波形画布组件（可视区裁剪优化版）
 *
 * 使用 mipmapCache（四级固定区间缓存）获取波形数据，
 * 通过 waveform-data.js 进行 resample 降采样，
 * 再通过 Canvas per-pixel min/max 竖线模式绘制波形（DAW 标准做法）。
 *
 * 数据流：
 *   mipmapCache → PeaksData → waveform-data resample → applyGainsToPeaks → renderWaveform
 *
 * 性能优化：
 * - 可视区裁剪：canvas 只渲染屏幕上可见的像素列，放大时性能不再线性增长
 * - WaveformData 对象缓存：mipmapCache 获取数据时自动构建 WaveformData 并缓存，
 *   resample 时直接复用，避免每帧重复 JSON 解析 + int16 转换
 * - useMemo 缓存 resample 结果：peakData 或 displayedW 不变时跳过 resample
 * - 数据请求节流：快速滚动时使用 throttle 减少 IPC 调用（~16ms 一帧）
 * - waveform-data resample：利用库的高效降采样算法，保留峰值细节
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
import type { PeaksData } from "../../utils/mipmapCache";
import { resamplePeaks, toInterleavedFloat32 } from "../../utils/waveformDataAdapter";
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
    const requestIdRef = React.useRef<number>(0);

    // 数据请求节流相关 ref
    const throttleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingFetchRef = React.useRef<(() => void) | null>(null);

    // mipmap 原始数据状态（保存完整的 PeaksData，供 waveform-data resample 使用）
    const [peakData, setPeakData] = React.useState<PeaksData | null>(null);

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
        if (viewportStartSec === undefined || viewportEndSec === undefined || clipLen <= 0 || !props.pxPerSec) {
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

        // 缓冲秒数由固定像素缓冲反算，不随缩放膨胀
        const bufferSec = BUFFER_PX / props.pxPerSec;

        // 计算可视区与 clip 的交集（加一点 buffer 防止滚动时出现空白）
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

    // 计算可视区交集 + 缓冲区
    const viewportInfo = React.useMemo(() => {
        if (!sourcePath || !sourceDurationSec || sourceDurationSec <= 0) {
            return null;
        }

        const clipLen = clipDurationSec ?? 0;
        const clipStart = clipStartSec ?? 0;
        const clipEnd = clipStart + clipLen;

        // 如果没有提供可视区信息，默认加载整个 clip
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

        // 缓冲秒数由固定像素缓冲反算
        const bufferSec = BUFFER_PX / props.pxPerSec;

        // 计算可视区与 clip 的交集
        const visibleStart = Math.max(clipStart, viewportStartSec - bufferSec);
        const visibleEnd = Math.min(clipEnd, viewportEndSec + bufferSec);

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
        props.pxPerSec,
    ]);

    // 获取分段数据（带节流：快速滚动时 ~16ms 内最多触发一次 IPC）
    React.useEffect(() => {
        if (!sourcePath || !samplesPerPixel || !viewportInfo) {
            return;
        }

        const doFetch = () => {
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
                    setPeakData(data);
                }
            });
        };

        // 节流逻辑：如果 throttle 定时器正在运行，暂存最新请求
        if (throttleTimerRef.current) {
            pendingFetchRef.current = doFetch;
        } else {
            // 立即执行第一次
            doFetch();
            // 设置 16ms 冷却期
            throttleTimerRef.current = setTimeout(() => {
                throttleTimerRef.current = null;
                // 冷却结束后，如果有待处理的请求，执行最新的那个
                if (pendingFetchRef.current) {
                    const pending = pendingFetchRef.current;
                    pendingFetchRef.current = null;
                    pending();
                }
            }, 16);
        }

        return () => {
            // 清理节流定时器
            if (throttleTimerRef.current) {
                clearTimeout(throttleTimerRef.current);
                throttleTimerRef.current = null;
            }
            pendingFetchRef.current = null;
        };
    }, [viewportInfo, sourcePath, samplesPerPixel, visibleInfo.visibleWidthPx]);

    // ========================================
    // useMemo 缓存 resample 结果：peakData / visibleWidthPx 不变时跳过 resample
    // ========================================
    const displayedW = Math.max(1, Math.floor(visibleInfo.visibleWidthPx));

    const resampleTargetW = displayedW;

    const resampledPeaks = React.useMemo(() => {
        if (!peakData || peakData.min.length < 2) return null;
        const { min, max } = resamplePeaks(peakData, resampleTargetW);
        return toInterleavedFloat32(min, max);
    }, [peakData, resampleTargetW]);

    // 主渲染逻辑
    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        // ========================================
        // 关键优化：canvas 宽度 = 可见宽度（而非整个 clip 宽度）
        // ========================================
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const displayedH = Math.max(1, Math.floor(heightPx));

        // Canvas 内部像素 = CSS 尺寸 × dpr（无需人为限制，因为尺寸已由固定像素缓冲控制）
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

        // 使用缓存的 resample 结果渲染（useMemo 保证 peakData/displayedW 不变时不重复计算）
        if (peakData && resampledPeaks) {
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
                dataStartSec: peakData.startSec,
                dataDurationSec: peakData.durationSec,
                // 可视区裁剪参数：告诉 renderWaveform 这个 canvas 对应整个 clip 的哪个部分
                clipPixelOffset: visibleInfo.offsetPx,
                clipTotalWidthPx: targetWidthPx,
            };

            // 应用增益（音量 + 淡入淡出）
            const withGains = applyGainsToPeaks(resampledPeaks, params);

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
        resampledPeaks,
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
