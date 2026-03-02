/**
 * 波形渲染工具模块
 *
 * 提供统一的波形数据处理和渲染接口，支持 Canvas 和 SVG 两种输出格式。
 * 用于 Piano Roll 背景波形和时间轴 Clip 波形的统一渲染。
 *
 * @module waveformRenderer
 *
 * @example
 * ```typescript
 * // Canvas 渲染（用于 Piano Roll）
 * const processed = processWaveformPeaks({
 *   min: peaksData.min,
 *   max: peaksData.max,
 *   startSec: peaksData.startSec,
 *   durSec: peaksData.durSec,
 *   visibleStartSec: 0,
 *   visibleDurSec: 10,
 *   targetWidth: 800
 * });
 * renderWaveformCanvas(ctx, processed, {
 *   width: 800,
 *   height: 400,
 *   fillColor: 'rgba(255,255,255,0.2)',
 *   strokeColor: 'rgba(255,255,255,0.7)'
 * });
 *
 * // SVG 渲染（用于 Clip）
 * const svgPath = renderWaveformSvg(processed, {
 *   width: 100,
 *   height: 24,
 *   centerY: 12,
 *   halfHeight: 5
 * });
 * ```
 */

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
        strokeColor: _strokeColor = "rgba(255,255,255,0.7)",
        barWidth: _barWidth = 1.5,
    } = options;

    const centerY = options.centerY ?? height * 0.5;
    const amplitude = options.amplitude ?? height * 0.45;

    const { min, max, timestamps } = data;
    const n = timestamps.length;
    if (n === 0) return;

    const visibleStartSec = timestamps[0];
    const visibleEndSec = timestamps[timestamps.length - 1];
    const visibleDurSec = Math.max(1e-9, visibleEndSec - visibleStartSec);

    // 绘制连续折线路径（类似 SVG 的闭合路径）
    ctx.beginPath();

    // 1. 正向遍历 max 值，绘制上边缘折线
    for (let i = 0; i < n; i++) {
        const t = timestamps[i];
        const x = ((t - visibleStartSec) / visibleDurSec) * width;
        const ma = max[i] ?? 0;
        const y = centerY - ma * amplitude;

        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }

    // 2. 反向遍历 min 值，绘制下边缘折线
    for (let i = n - 1; i >= 0; i--) {
        const t = timestamps[i];
        const x = ((t - visibleStartSec) / visibleDurSec) * width;
        const mi = min[i] ?? 0;
        const y = centerY - mi * amplitude;

        ctx.lineTo(x, y);
    }

    // 3. 闭合路径
    ctx.closePath();

    // 4. 填充路径
    ctx.fillStyle = fillColor;
    ctx.fill();
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
    const y0 = centerY - halfHeight;
    const y1 = centerY + halfHeight;

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

        // 限制在 viewBox 范围内
        top = Math.max(y0, Math.min(y1, top));
        bot = Math.max(y0, Math.min(y1, bot));

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
