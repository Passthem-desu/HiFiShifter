/**
 * 波形渲染工具模块（Canvas per-pixel 渲染）
 *
 * 本模块负责将已降采样的 peaks 数据绘制到 Canvas 上，是波形可视化的最后一环。
 *
 * ## 数据流
 *   waveformMipmapStore（降采样 / resample）
 *     → applyGainsToPeaks（叠加音量 + 淡入淡出增益）
 *       → renderWaveform（Canvas per-pixel 绘制）
 *
 * ## 坐标系映射链
 *   canvas 本地像素 → clip 全局像素 → timeline 时间 → 源文件时间 → peaks 数据索引
 *
 * ## 导出
 * - {@link WaveformRenderParams} — 渲染参数接口
 * - {@link applyGainsToPeaks}    — 增益应用（音量 × 淡入淡出曲线）
 * - {@link renderWaveform}       — Canvas 绘制（line 竖线 / jitter 抖动线）
 *
 * @module waveformRenderer
 */

import type { FadeCurveType } from "../components/layout/timeline/paths";
import { fadeCurveGain } from "../components/layout/timeline/paths";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 波形渲染参数
 *
 * 包含三类信息：
 * 1. Canvas 物理尺寸（canvasWidth / canvasHeight / centerY）
 * 2. 时间域参数（sourceStartSec / clipDuration / playbackRate / fade 等）
 * 3. 可视区裁剪参数（clipPixelOffset / clipTotalWidthPx，由调用方传入）
 */
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
    // 可视区裁剪参数（由调用方传入）
    // ========================================
    /** 当前 canvas 在 clip 内的像素偏移量（canvas 左边缘对应 clip 的第几个像素） */
    clipPixelOffset?: number;
    /** clip 完整像素宽度（用于将像素位置映射到 timeline 时间） */
    clipTotalWidthPx?: number;
}

// ============================================================================
// applyGainsToPeaks — 增益应用
// ============================================================================

/**
 * 将音量增益和淡入淡出曲线应用到波形 peaks 数据上
 *
 * 对每个采样点：
 *   1. 根据 position 线性插值算出该点对应的 **源文件时间**
 *   2. 将源文件时间映射为 **timeline 时间**（÷ playbackRate）
 *   3. 根据 timeline 时间判断是否处于淡入/淡出区间，计算淡入淡出增益
 *   4. 最终增益 = volumeGain × fadeGain，同时乘到 min 和 max 上
 *
 * 快速路径：若无淡入淡出且 volumeGain ≈ 1，直接复制原数组。
 *
 * @param peaks  - Float32Array，交错格式 [min0, max0, min1, max1, ...]
 * @param params - 渲染参数（需要时间域 + fade 相关字段）
 * @returns 新 Float32Array，与 peaks 等长，已叠加增益
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

// ============================================================================
// renderWaveform — Canvas per-pixel 绘制
// ============================================================================

/**
 * 将 peaks 数据绘制到 Canvas 上（per-pixel 模式）
 *
 * ## 渲染模式
 * - **line**（默认）：per-pixel min/max 竖线 —— DAW 标准做法，每像素列一条从 yTop 到 yBot 的竖线
 * - **jitter**：抖动线 —— 偶数列取包络 25% 位置、奇数列取 75% 位置，连成折线，视觉更平滑
 *
 * ## 核心流程
 * 1. **可视区裁剪**：根据 clipPixelOffset / clipTotalWidthPx 确定 canvas 与 clip 的映射关系，
 *    再与数据的时间范围求交集，只遍历有数据覆盖的像素列
 * 2. **像素→时间→索引**：每个像素列 px 覆盖 [px-0.5, px+0.5) 的时间段，
 *    通过 pxToSourceTime → timeToIndex 映射到 peaks 数据索引范围
 * 3. **滑动指针扫描**：cursor 只前进不后退，保证整体 O(W + N) 复杂度
 * 4. **绘制**：line 模式 moveTo/lineTo 竖线；jitter 模式连续 lineTo 折线
 *
 * ## 性能特性
 * - 数据密度高时自动聚合（多采样点 → 一像素取 min/max）
 * - 数据密度低时优雅降级（相邻像素复用同一采样点）
 * - 静音段保证最小 0.5px 可见高度
 *
 * @param ctx         - Canvas 2D 上下文
 * @param peaks       - Float32Array，交错格式 [min0, max0, min1, max1, ...]
 * @param params      - 渲染参数（含 canvas 尺寸 + 时间域 + 裁剪信息）
 * @param strokeColor - 描边颜色（默认 "currentColor"）
 * @param strokeWidth - 描边宽度（默认 1）
 * @param mode        - 渲染模式："line"（竖线）或 "jitter"（抖动线），默认 "line"
 */
export function renderWaveform(
    ctx: CanvasRenderingContext2D,
    peaks: Float32Array,
    params: WaveformRenderParams,
    strokeColor: string = "currentColor",
    strokeWidth: number = 1,
    mode: "line" | "jitter" = "line",
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
    const globalPxStart = (timelineOverlapStart / clipDuration) * clipTotalW;
    const globalPxEnd = (timelineOverlapEnd / clipDuration) * clipTotalW;

    // 裁剪到当前 canvas 范围 [0, canvasWidth)
    const localPxStart = Math.max(0, Math.floor(globalPxStart - clipPixelOffset));
    const localPxEnd = Math.min(
        canvasWidth - 1,
        Math.ceil(globalPxEnd - clipPixelOffset) - 1,
    );

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
    ctx.lineJoin = "round";
    ctx.lineCap = mode === "jitter" ? "round" : "butt";

    // ========================================
    // 滑动指针优化：O(W + N) 复杂度
    // ========================================
    ctx.beginPath();

    let cursor = 0;
    let jitterStarted = false; // jitter 模式下是否已 moveTo

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

        if (mode === "jitter") {
            // ========================================
            // 抖动线模式：交替取包络内 0.25/0.75 位置，画连续折线
            // ========================================
            const t = px % 2 === 0 ? 0.25 : 0.75;
            const value = pixelMax + (pixelMin - pixelMax) * t;
            const y = centerY - value * amplitudeScale;

            if (!jitterStarted) {
                ctx.moveTo(px, y);
                jitterStarted = true;
            } else {
                ctx.lineTo(px, y);
            }
        } else {
            // ========================================
            // 竖线模式：每像素画 min→max 竖线（DAW 标准做法）
            // ========================================
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
    }

    ctx.stroke();
}



