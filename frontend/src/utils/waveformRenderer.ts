/**
 * 波形渲染工具模块（重写版）
 *
 * 核心改进：
 * 1. 高精度降采样：每像素至少 4 个采样点，移除 stride<=16 的限制
 * 2. 支持增益应用：clip 音量 + 淡入淡出曲线
 * 3. 高性能：Float32Array 存储，避免频繁内存分配
 * 4. per-pixel min/max 竖线模式：DAW 标准波形渲染，无锯齿
 *
 * @module waveformRenderer
 */

import type { FadeCurveType } from "../components/layout/timeline/paths";
import { fadeCurveGain } from "../components/layout/timeline/paths";

/** 波形峰值数据（原始格式） */
export interface WavePeaksData {
    /** 最小值数组（负振幅） */
    min: number[];
    /** 最大值数组（正振幅） */
    max: number[];
    /** 数据起始时间（秒） */
    startSec: number;
    /** 数据持续时间（秒） */
    durSec: number;
}

/** 处理后的波形数据 */
export interface ProcessedWaveformData {
    /** 处理后的最小值数组 */
    min: number[];
    /** 处理后的最大值数组 */
    max: number[];
    /** 每个数据点对应的时间戳（秒） */
    timestamps: number[];
    /** 采样步长 */
    stride: number;
}

/** 波形处理配置 */
export interface WaveformProcessOptions {
    /** 原始最小值数组 */
    min: number[];
    /** 原始最大值数组 */
    max: number[];
    /** 数据起始时间（秒） */
    startSec: number;
    /** 数据持续时间（秒） */
    durSec: number;
    /** 可见区域起始时间（秒） */
    visibleStartSec: number;
    /** 可见区域持续时间（秒） */
    visibleDurSec: number;
    /** 目标渲染宽度（像素），用于计算最优采样 */
    targetWidth: number;
}

/** Canvas 渲染配置 */
export interface CanvasRenderOptions {
    /** Canvas 宽度 */
    width: number;
    /** Canvas 高度 */
    height: number;
    /** 填充颜色 */
    fillColor?: string;
    /** 描边颜色 */
    strokeColor?: string;
    /** 渲染模式：'bars'（默认填充条）|'stroke'（边缘线）|'stroke-jitter'（交替抖动细线） */
    mode?: "bars" | "stroke" | "stroke-jitter";
    /** 描边宽度（像素） */
    strokeWidth?: number;
    /** 竖条宽度（像素） */
    barWidth?: number;
    /** 中心 Y 坐标（默认 height * 0.5） */
    centerY?: number;
    /** 振幅范围（默认 height * 0.45） */
    amplitude?: number;
}

/** SVG 渲染配置 */
export interface SvgRenderOptions {
    /** viewBox 宽度 */
    width: number;
    /** viewBox 高度 */
    height: number;
    /** 中心 Y 坐标 */
    centerY: number;
    /** 半高（振幅范围的一半） */
    halfHeight: number;
    /** 振幅缩放系数（默认 1.0） */
    amplitudeScale?: number;
}

/**
 * 处理波形峰值数据
 *
 * 根据可见时间范围和目标宽度对原始 peaks 数据进行采样、裁剪和归一化。
 *
 * @param options - 处理配置
 * @returns 处理后的波形数据
 *
 * @example
 * ```typescript
 * const processed = processWaveformPeaks({
 *   min: [-0.5, -0.3, -0.8],
 *   max: [0.6, 0.4, 0.9],
 *   startSec: 0,
 *   durSec: 3,
 *   visibleStartSec: 0,
 *   visibleDurSec: 3,
 *   targetWidth: 300
 * });
 * ```
 */
export function processWaveformPeaks(
    options: WaveformProcessOptions,
): ProcessedWaveformData {
    const {
        min,
        max,
        startSec,
        durSec,
        visibleStartSec,
        visibleDurSec,
        targetWidth,
    } = options;

    const n = Math.min(min.length, max.length);
    if (n === 0) {
        return { min: [], max: [], timestamps: [], stride: 1 };
    }

    const v0 = visibleStartSec;
    const v1 = visibleStartSec + Math.max(1e-9, visibleDurSec);
    const endSec = startSec + Math.max(1e-9, durSec);

    // 第一步：将时间范围映射到数组索引，找到可见区域的 startIdx / endIdx
    // 每个数据点 i 对应时间区间 [startSec + i/n*durSec, startSec + (i+1)/n*durSec)
    const startIdx = Math.max(
        0,
        Math.floor(((v0 - startSec) / Math.max(1e-9, endSec - startSec)) * n),
    );
    const endIdx = Math.min(
        n,
        Math.ceil(((v1 - startSec) / Math.max(1e-9, endSec - startSec)) * n),
    );

    const visiblePoints = endIdx - startIdx;
    if (visiblePoints <= 0) {
        return { min: [], max: [], timestamps: [], stride: 1 };
    }

    // 第二步：基于可见点数和目标宽度计算 stride（上限 16，防止极端情况）
    const stride = Math.max(
        1,
        Math.min(16, Math.ceil(visiblePoints / Math.max(1, targetWidth))),
    );

    const resultMin: number[] = [];
    const resultMax: number[] = [];
    const resultTimestamps: number[] = [];

    // 第三步：窗口聚合采样——每个窗口内取 min/max，保留峰值细节
    for (let i = startIdx; i < endIdx; i += stride) {
        const windowEnd = Math.min(i + stride, endIdx);

        let wMin = Infinity;
        let wMax = -Infinity;
        for (let j = i; j < windowEnd; j++) {
            const v = min[j] ?? 0;
            if (v < wMin) wMin = v;
            const u = max[j] ?? 0;
            if (u > wMax) wMax = u;
        }

        // 窗口中心点对应的时间戳
        const midIdx = (i + windowEnd) / 2;
        const t = startSec + (midIdx / n) * durSec;

        resultMin.push(wMin === Infinity ? 0 : wMin);
        resultMax.push(wMax === -Infinity ? 0 : wMax);
        resultTimestamps.push(t);
    }

    return {
        min: resultMin,
        max: resultMax,
        timestamps: resultTimestamps,
        stride,
    };
}

/**
 * 在 Canvas 上渲染波形
 *
 * 使用 fillRect 绘制竖条形式的波形，支持自定义颜色和描边。
 *
 * @param ctx - Canvas 2D 渲染上下文
 * @param data - 处理后的波形数据
 * @param options - 渲染配置
 *
 * @example
 * ```typescript
 * const ctx = canvas.getContext('2d')!;
 * renderWaveformCanvas(ctx, processedData, {
 *   width: 800,
 *   height: 400,
 *   fillColor: 'rgba(255,255,255,0.2)',
 *   strokeColor: 'rgba(255,255,255,0.7)',
 *   barWidth: 1.5
 * });
 * ```
 */
export function renderWaveformCanvas(
    ctx: CanvasRenderingContext2D,
    data: ProcessedWaveformData,
    options: CanvasRenderOptions,
): void {
    const {
        width,
        height,
        fillColor = "rgba(255,255,255,0.2)",
        strokeColor = "rgba(255,255,255,0.7)",
        barWidth: _barWidth = 1.5,
        mode = "bars",
        strokeWidth = 1,
    } = options;

    const centerY = options.centerY ?? height * 0.5;
    const amplitude = options.amplitude ?? height * 0.45;

    const { min, max } = data;
    const n = min.length;
    if (n === 0) return;

    // 使用均匀分布 x 坐标：第一个点在 x=0，最后一个点在 x=width
    const xOf = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * width);

    if (mode === "bars") {
        // 原有填充行为：构建闭合路径并填充
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const x = xOf(i);
            const ma = max[i] ?? 0;
            const y = centerY - ma * amplitude;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        for (let i = n - 1; i >= 0; i--) {
            const x = xOf(i);
            const mi = min[i] ?? 0;
            const y = centerY - mi * amplitude;
            ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = fillColor;
        ctx.fill();
        return;
    }

    // stroke 或 stroke-jitter: 仅绘制一条细线（无填充），在 visual 上呈现快速上下抖动
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
        const x = xOf(i);
        const top = max[i] ?? 0;
        const bot = min[i] ?? 0;
        // jitter: 在包络内交替采样，产生快速上下抖动的线条
        const t = mode === "stroke-jitter" ? (i % 2 === 0 ? 0.25 : 0.75) : 0.5;
        const v = top + (bot - top) * t;
        const y = centerY - v * amplitude;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
}

/**
 * 生成 SVG 波形路径
 *
 * 生成闭合的 SVG path `d` 属性字符串，用于波形面积填充。
 * 路径先正向遍历 max 值，再反向遍历 min 值，形成闭合多边形。
 *
 * @param data - 处理后的波形数据
 * @param options - 渲染配置
 * @returns SVG path `d` 属性字符串
 *
 * @example
 * ```typescript
 * const pathD = renderWaveformSvg(processedData, {
 *   width: 100,
 *   height: 24,
 *   centerY: 12,
 *   halfHeight: 5,
 *   amplitudeScale: 1.0
 * });
 * // 使用: <path d={pathD} fill="rgba(255,255,255,0.2)" />
 * ```
 */
export function renderWaveformSvg(
    data: ProcessedWaveformData,
    options: SvgRenderOptions,
): string {
    const {
        width,
        height,
        centerY,
        halfHeight,
        amplitudeScale = 1.0,
    } = options;

    const { min, max, timestamps } = data;
    const n = Math.min(min.length, max.length);
    if (n === 0) return "";

    const scale = halfHeight * amplitudeScale;

    // 处理均匀分布的数据点（Clip场景）或基于时间戳的数据点（Piano Roll场景）
    const useTimestamp = timestamps.length > 0 && timestamps.length === n;
    let visibleStartSec = 0;
    let visibleDurSec = 1;

    if (useTimestamp) {
        visibleStartSec = timestamps[0];
        const visibleEndSec = timestamps[timestamps.length - 1];
        visibleDurSec = Math.max(1e-9, visibleEndSec - visibleStartSec);
    }

    const yMax: number[] = new Array(n);
    const yMin: number[] = new Array(n);
    const xCoords: number[] = new Array(n);

    for (let i = 0; i < n; i++) {
        // 计算 X 坐标：使用时间戳或均匀分布
        let x: number;
        if (useTimestamp) {
            const t = timestamps[i];
            x = ((t - visibleStartSec) / visibleDurSec) * width;
        } else {
            // 均匀分布（用于 Clip）
            x = (i / Math.max(1, n - 1)) * width;
        }

        const mi = min[i] ?? 0;
        const ma = max[i] ?? 0;

        // 计算 Y 坐标（中心对齐）
        let top = centerY - ma * scale;
        let bot = centerY - mi * scale;

        // 静音段最小可见高度
        if (Math.abs(bot - top) < 0.75) {
            bot = top + (bot >= top ? 0.75 : -0.75);
        }

        xCoords[i] = x;
        yMax[i] = Math.max(0, Math.min(height, top));
        yMin[i] = Math.max(0, Math.min(height, bot));
    }

    // 生成闭合路径：正向遍历 max，反向遍历 min
    let d = `M${xCoords[0]} ${yMax[0]}`;
    for (let i = 1; i < n; i++) {
        d += `L${xCoords[i]} ${yMax[i]}`;
    }
    for (let i = n - 1; i >= 0; i--) {
        d += `L${xCoords[i]} ${yMin[i]}`;
    }
    d += "Z";

    return d;
}

// ============================================================================
// 增益应用和波形渲染
// ============================================================================

/** 波形渲染参数 */
export interface WaveformRenderParams {
    /** canvas 宽度（像素） */
    canvasWidth: number;
    /** canvas 高度（像素） */
    canvasHeight: number;
    /** 波形中心 Y 坐标 */
    centerY: number;
    /** clip 在源文件中的起始位置（秒） */
    sourceStartSec: number;
    /** clip 时长（秒，考虑 playbackRate 后） */
    clipDuration: number;
    /** 播放速度 */
    playbackRate: number;
    /** 源文件时长（秒） */
    sourceDurationSec: number;
    /** clip 音量增益（线性值，0~2） */
    volumeGain: number;
    /** 淡入时长（秒） */
    fadeInSec: number;
    /** 淡出时长（秒） */
    fadeOutSec: number;
    /** 淡入曲线类型 */
    fadeInCurve: FadeCurveType;
    /** 淡出曲线类型 */
    fadeOutCurve: FadeCurveType;
    /** 数据起始时间（秒，源文件坐标系） */
    dataStartSec?: number;
    /** 数据持续时间（秒） */
    dataDurationSec?: number;

    // ========================================
    // 可视区裁剪参数（由 WaveformCanvas 传入）
    // ========================================
    /** 当前 canvas 在 clip 内的像素偏移量（canvas 左边缘对应 clip 的第几个像素） */
    clipPixelOffset?: number;
    /** clip 完整像素宽度（用于将像素位置映射到 timeline 时间） */
    clipTotalWidthPx?: number;
}

/**
 * 从 base peaks 中降采样提取指定时间范围的波形数据
 *
 * 修复：使用时间域映射 + 插值，确保目标采样数不超过源数据范围
 *
 * @param basePeaks - Float32Array，格式 [min0, max0, min1, max1, ...]
 * @param params - 渲染参数
 * @returns Float32Array 格式的降采样后数据 [min0, max0, min1, max1, ...]
 */


/**
 * 应用增益（音量 + 淡入淡出）到波形数据
 *
 * @param peaks - Float32Array 格式的波形数据 [min0, max0, min1, max1, ...]
 * @param params - 渲染参数
 * @returns 应用增益后的 Float32Array
 */
export function applyGainsToPeaks(
    peaks: Float32Array,
    params: WaveformRenderParams,
): Float32Array {
    const {
        sourceStartSec,
        clipDuration,
        playbackRate,
        volumeGain,
        fadeInSec,
        fadeOutSec,
        fadeInCurve,
        fadeOutCurve,
        dataStartSec,
        dataDurationSec,
    } = params;

    const result = new Float32Array(peaks.length);
    const totalSamples = peaks.length / 2;

    // 计算数据的时间范围（与 renderWaveform 保持一致）
    const effectiveDataStartSec = dataStartSec ?? sourceStartSec;
    const effectiveDataDurationSec = dataDurationSec ?? (clipDuration * playbackRate);

    // 快速路径：无淡入淡出且增益为 1 时直接复制
    const hasFade = (fadeInSec > 0) || (fadeOutSec > 0);
    if (!hasFade && Math.abs(volumeGain - 1) < 1e-6) {
        result.set(peaks);
        return result;
    }

    for (let i = 0; i < totalSamples; i++) {
        const position = totalSamples > 1 ? i / (totalSamples - 1) : 0; // 0~1
        
        // 计算采样点对应的源文件时间
        const sourceTime = effectiveDataStartSec + position * effectiveDataDurationSec;
        
        // 计算该时间在 timeline 上的位置（秒）
        const time = (sourceTime - sourceStartSec) / playbackRate;

        // 计算综合增益
        let gain = volumeGain;

        // 淡入：时间 0 -> fadeInSec，增益 0 -> 1
        if (fadeInSec > 0 && time < fadeInSec) {
            const fadeInProgress = time / fadeInSec;
            gain *= fadeCurveGain(fadeInProgress, fadeInCurve);
        }

        // 淡出：时间 (clipDuration - fadeOutSec) -> clipDuration，增益 1 -> 0
        if (fadeOutSec > 0) {
            const fadeOutStart = clipDuration - fadeOutSec;
            if (time > fadeOutStart) {
                const fadeOutProgress = (time - fadeOutStart) / fadeOutSec;
                gain *= 1 - fadeCurveGain(fadeOutProgress, fadeOutCurve);
            }
        }

        // 应用增益
        result[i * 2] = peaks[i * 2] * gain;
        result[i * 2 + 1] = peaks[i * 2 + 1] * gain;
    }

    return result;
}

/**
 * 波形渲染（Canvas，per-pixel min/max 竖线模式）
 *
 * 核心算法（DAW 标准做法）：
 * - 遍历画布的每个像素列
 * - 计算该像素列对应的源文件时间范围
 * - 在数据中找到该时间范围覆盖的所有采样点
 * - 取这些采样点的 min/max，画一条竖线
 *
 * 优点：
 * - 无论数据密度如何，每像素恰好一条竖线，无锯齿
 * - 数据过多时自动聚合（多个采样点合并到一个像素）
 * - 数据不足时优雅降级（相邻像素复用同一采样点）
 * - 支持数据裁剪：只渲染数据与 clip 范围重叠的部分
 *
 * @param ctx - Canvas 2D 上下文
 * @param peaks - Float32Array 格式的波形数据 [min0, max0, min1, max1, ...]
 * @param params - 渲染参数
 * @param strokeColor - 描边颜色
 * @param strokeWidth - 描边宽度
 */
export function renderWaveform(
    ctx: CanvasRenderingContext2D,
    peaks: Float32Array,
    params: WaveformRenderParams,
    strokeColor: string = "currentColor",
    strokeWidth: number = 1,
): void {
    const {
        canvasWidth, canvasHeight, centerY,
        sourceStartSec, clipDuration, playbackRate,
        dataStartSec, dataDurationSec,
        clipPixelOffset = 0, clipTotalWidthPx,
    } = params;
    const totalSamples = peaks.length / 2;

    if (totalSamples < 2 || canvasWidth < 1) return;

    // ========================================
    // 可视区裁剪核心逻辑
    // ========================================
    // clipTotalWidthPx: clip 完整像素宽度（用于时间→像素映射）
    // clipPixelOffset: 当前 canvas 在 clip 内的偏移
    // canvasWidth: 当前 canvas 的实际宽度（仅渲染可见部分）
    //
    // 映射关系：canvas 像素 px → clip 全局像素 = px + clipPixelOffset
    //          clip 全局像素 gpx → timeline 时间 = (gpx / clipTotalW) * clipDuration
    const clipTotalW = clipTotalWidthPx ?? canvasWidth;

    // 振幅比例：0 电平在中心（静音），±1 电平占满整个高度
    const amplitudeScale = canvasHeight / 2;

    // 计算数据的时间范围（源文件坐标系）
    const effectiveDataStartSec = dataStartSec ?? sourceStartSec;
    const effectiveDataDurationSec = dataDurationSec ?? (clipDuration * playbackRate);
    const dataEndSec = effectiveDataStartSec + effectiveDataDurationSec;

    // 计算 clip 在源文件中的时间范围
    const clipSourceStartSec = sourceStartSec;
    const clipSourceEndSec = sourceStartSec + clipDuration * playbackRate;

    // 计算数据与 clip 的重叠范围（在源文件坐标系中）
    const overlapStartSec = Math.max(effectiveDataStartSec, clipSourceStartSec);
    const overlapEndSec = Math.min(dataEndSec, clipSourceEndSec);

    // 如果没有重叠，不渲染
    if (overlapEndSec <= overlapStartSec) {
        return;
    }

    // 重叠范围映射到 timeline 时间
    const timelineOverlapStart = (overlapStartSec - sourceStartSec) / playbackRate;
    const timelineOverlapEnd = (overlapEndSec - sourceStartSec) / playbackRate;

    // 重叠范围映射到 clip 全局像素
    const globalPxStart = Math.floor((timelineOverlapStart / clipDuration) * clipTotalW);
    const globalPxEnd = Math.ceil((timelineOverlapEnd / clipDuration) * clipTotalW);

    // 裁剪到当前 canvas 范围 [0, canvasWidth)
    const localPxStart = Math.max(0, globalPxStart - clipPixelOffset);
    const localPxEnd = Math.min(canvasWidth - 1, globalPxEnd - clipPixelOffset);

    if (localPxEnd <= localPxStart) return;

    // 辅助函数：源文件时间 → 数据索引（浮点数）
    const timeToIndex = (srcTimeSec: number): number => {
        const ratio = (srcTimeSec - effectiveDataStartSec) / effectiveDataDurationSec;
        return ratio * (totalSamples - 1);
    };

    // 辅助函数：canvas 本地像素 → 对应的源文件时间（秒）
    // 先转为 clip 全局像素，再映射到 timeline 时间，最后映射到源文件时间
    const pxToSourceTime = (localPx: number): number => {
        const globalPx = localPx + clipPixelOffset;
        const timelineTime = (globalPx / clipTotalW) * clipDuration;
        return sourceStartSec + timelineTime * playbackRate;
    };

    // 设置绘制样式
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = "butt";

    // ========================================
    // 滑动指针优化：O(W + N) 复杂度
    // ========================================
    ctx.beginPath();

    let cursor = 0;

    for (let px = localPxStart; px <= localPxEnd; px++) {
        // 计算该像素列覆盖的源文件时间范围
        const srcTimeLeft = pxToSourceTime(px - 0.5);
        const srcTimeRight = pxToSourceTime(px + 0.5);

        // 映射到数据索引
        const idxLeft = Math.max(0, timeToIndex(Math.max(srcTimeLeft, effectiveDataStartSec)));
        const idxRight = Math.min(totalSamples - 1, timeToIndex(Math.min(srcTimeRight, dataEndSec)));

        // 取该范围内所有采样点的 min/max
        const iStart = Math.max(0, Math.floor(idxLeft));
        const iEnd = Math.min(totalSamples - 1, Math.ceil(idxRight));

        // 滑动游标：确保 cursor 不回退，只前进
        if (iStart > cursor) {
            cursor = iStart;
        }

        let pixelMin = Infinity;
        let pixelMax = -Infinity;

        const scanStart = Math.min(cursor, iStart);
        for (let i = scanStart; i <= iEnd; i++) {
            const sMin = peaks[i * 2];
            const sMax = peaks[i * 2 + 1];
            if (sMin < pixelMin) pixelMin = sMin;
            if (sMax > pixelMax) pixelMax = sMax;
        }

        cursor = iEnd;

        if (pixelMin === Infinity) continue;

        // 映射到 canvas Y 坐标
        const yTop = centerY - pixelMax * amplitudeScale;
        const yBot = centerY - pixelMin * amplitudeScale;

        // 确保静音段至少有最小可见高度（0.5px）
        const minHeight = 0.5;
        const midY = (yTop + yBot) / 2;

        if (yBot - yTop < minHeight) {
            ctx.moveTo(px, midY - minHeight / 2);
            ctx.lineTo(px, midY + minHeight / 2);
        } else {
            ctx.moveTo(px, yTop);
            ctx.lineTo(px, yBot);
        }
    }

    ctx.stroke();
}


