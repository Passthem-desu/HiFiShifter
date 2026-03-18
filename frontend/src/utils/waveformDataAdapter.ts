/**
 * waveformDataAdapter.ts
 *
 * 将后端 mipmapCache 返回的 min/max 峰值数据转换为 waveform-data.js 的 WaveformData 对象。
 * 提供 resample 和数据提取的便捷方法，作为 waveform-data.js 与项目数据格式之间的桥梁。
 *
 * 数据流：
 *   mipmapCache (min[], max[]) → buildWaveformData() → WaveformData
 *   WaveformData.resample({ width }) → channel(0).min_array() / max_array()
 *   → applyGainsToPeaks → renderWaveform
 */

import WaveformData from "waveform-data";
import type { JsonWaveformData } from "waveform-data";
import type { PeaksData } from "./mipmapCache";

/**
 * 从 mipmapCache 的 PeaksData 构建 WaveformData 对象
 *
 * 将后端返回的独立 min[] / max[] 数组转换为 waveform-data.js 要求的
 * interleaved 格式：[min0, max0, min1, max1, ...]
 *
 * @param peaksData - mipmapCache 返回的峰值数据
 * @returns WaveformData 实例
 */
export function buildWaveformData(peaksData: PeaksData): WaveformData {
    const { min, max, sampleRate, divisionFactor } = peaksData;
    const length = Math.min(min.length, max.length);

    // waveform-data.js 的 JSON 格式要求 interleaved: [min0, max0, min1, max1, ...]
    // 注意：waveform-data 内部使用 int8/int16 存储，但通过 JSON 接口传入时
    // 会自动处理缩放。我们的后端数据是 float [-1, 1] 范围，需要缩放到 int16 范围。
    const SCALE_FACTOR = 32767; // int16 最大值
    const interleaved = new Array<number>(length * 2);
    for (let i = 0; i < length; i++) {
        // 钳制到 [-1, 1] 后缩放到 int16 范围
        const minVal = Math.max(-1, Math.min(1, min[i] ?? 0));
        const maxVal = Math.max(-1, Math.min(1, max[i] ?? 0));
        interleaved[i * 2] = Math.round(minVal * SCALE_FACTOR);
        interleaved[i * 2 + 1] = Math.round(maxVal * SCALE_FACTOR);
    }

    const jsonData: JsonWaveformData = {
        version: 2,
        channels: 1,
        sample_rate: sampleRate || 44100,
        // samples_per_pixel = divisionFactor / 2（后端的 division_factor 是总的，
        // 而 waveform-data 需要的是每像素的采样数）
        samples_per_pixel: Math.max(1, Math.floor(divisionFactor / 2)),
        bits: 16,
        length,
        data: interleaved,
    };

    return WaveformData.create(jsonData);
}

/**
 * 从原始 min/max 数组构建 WaveformData 对象（不需要完整的 PeaksData）
 *
 * 适用于 PianoRoll 等场景，peaks 数据来自 useClipsPeaksForPianoRoll hook，
 * 不包含 sampleRate / divisionFactor 等元信息。
 *
 * @param min - 最小值数组（float [-1, 1]）
 * @param max - 最大值数组（float [-1, 1]）
 * @param columns - 数据列数（用于计算 samples_per_pixel）
 * @param sampleRate - 采样率（默认 44100）
 * @returns WaveformData 实例
 */
export function buildWaveformDataFromRaw(
    min: number[],
    max: number[],
    columns: number = min.length,
    sampleRate: number = 44100,
): WaveformData {
    const length = Math.min(min.length, max.length);

    const SCALE_FACTOR = 32767;
    const interleaved = new Array<number>(length * 2);
    for (let i = 0; i < length; i++) {
        const minVal = Math.max(-1, Math.min(1, min[i] ?? 0));
        const maxVal = Math.max(-1, Math.min(1, max[i] ?? 0));
        interleaved[i * 2] = Math.round(minVal * SCALE_FACTOR);
        interleaved[i * 2 + 1] = Math.round(maxVal * SCALE_FACTOR);
    }

    const jsonData: JsonWaveformData = {
        version: 2,
        channels: 1,
        sample_rate: sampleRate,
        // 使用默认值 256，因为原始数据没有 divisionFactor 信息
        samples_per_pixel: Math.max(1, Math.floor(sampleRate / Math.max(1, columns))),
        bits: 16,
        length,
        data: interleaved,
    };

    return WaveformData.create(jsonData);
}

/**
 * 从 WaveformData 中提取 min/max 数组（float [-1, 1] 范围）
 *
 * waveform-data.js 内部存储为 int16，需要反向缩放回 float 范围。
 *
 * @param waveformData - WaveformData 实例
 * @param channelIndex - 通道索引（默认 0）
 * @returns { min: number[], max: number[] }
 */
export function extractMinMax(
    waveformData: WaveformData,
    channelIndex: number = 0,
): { min: number[]; max: number[] } {
    const channel = waveformData.channel(channelIndex);
    const minArray = channel.min_array();
    const maxArray = channel.max_array();

    // waveform-data 内部存储为 int16 [-32768, 32767]，反向缩放到 float [-1, 1]
    const SCALE_FACTOR = 32767;
    const min = minArray.map((v) => v / SCALE_FACTOR);
    const max = maxArray.map((v) => v / SCALE_FACTOR);

    return { min, max };
}

/**
 * 线性插值上采样：将少量数据点平滑插值到更多像素点
 *
 * 当放大倍率很高时，原始数据点数 < 目标像素宽度，
 * 需要在相邻数据点之间进行线性插值，避免出现"粗条状"波形。
 *
 * @param source - 原始 { min, max } 数据
 * @param targetWidth - 目标像素宽度
 * @returns { min: number[], max: number[] } 插值后的数据
 */
function linearInterpolate(
    source: { min: number[]; max: number[] },
    targetWidth: number,
): { min: number[]; max: number[] } {
    const srcLen = source.min.length;
    if (srcLen <= 1) {
        // 只有 0 或 1 个数据点，直接填充
        const val = srcLen === 1 ? source.min[0] : 0;
        const valMax = srcLen === 1 ? source.max[0] : 0;
        return {
            min: new Array(targetWidth).fill(val),
            max: new Array(targetWidth).fill(valMax),
        };
    }

    const minOut = new Array<number>(targetWidth);
    const maxOut = new Array<number>(targetWidth);

    for (let i = 0; i < targetWidth; i++) {
        // 将目标像素位置映射回源数据索引（浮点数）
        const srcPos = (i / (targetWidth - 1)) * (srcLen - 1);
        const srcIdx = Math.floor(srcPos);
        const frac = srcPos - srcIdx;

        if (srcIdx >= srcLen - 1) {
            // 到达末尾
            minOut[i] = source.min[srcLen - 1];
            maxOut[i] = source.max[srcLen - 1];
        } else {
            // 线性插值
            minOut[i] = source.min[srcIdx] * (1 - frac) + source.min[srcIdx + 1] * frac;
            maxOut[i] = source.max[srcIdx] * (1 - frac) + source.max[srcIdx + 1] * frac;
        }
    }

    return { min: minOut, max: maxOut };
}

/**
 * 从 mipmapCache 数据构建 WaveformData 并 resample 到目标宽度
 *
 * 这是最常用的便捷方法，一步完成：
 * 1. 复用 PeaksData 上已缓存的 WaveformData（若有），否则新建
 * 2. 当 targetWidth <= 数据长度时：使用 waveform-data.js 的 resample 降采样
 * 3. 当 targetWidth > 数据长度时：使用线性插值上采样，避免"粗条状"波形
 * 4. 提取 float min/max 数组
 *
 * 性能关键：mipmapCache 在获取数据时已自动执行 ensureWaveformData()，
 * 因此大多数场景下 peaksData._waveformData 已存在，此处直接复用。
 *
 * @param peaksData - mipmapCache 返回的峰值数据
 * @param targetWidth - 目标渲染宽度（像素）
 * @returns { min: number[], max: number[] } float [-1, 1] 范围
 */
export function resamplePeaks(
    peaksData: PeaksData,
    targetWidth: number,
): { min: number[]; max: number[] } {
    // 优先复用已缓存的 WaveformData，避免重复 JSON 解析 + int16 转换
    const waveformData = peaksData._waveformData ?? buildWaveformData(peaksData);

    const width = Math.max(1, targetWidth);

    // 上采样场景：目标宽度 > 数据点数，需要线性插值
    if (width >= waveformData.length) {
        const rawData = extractMinMax(waveformData);
        // 如果目标宽度与数据长度相同，无需插值
        if (width === waveformData.length) {
            return rawData;
        }
        return linearInterpolate(rawData, width);
    }

    // 降采样场景：目标宽度 < 数据点数，使用 waveform-data.js 高效降采样
    const resampled = waveformData.resample({ width });
    return extractMinMax(resampled);
}

/**
 * 将 min/max 数组转换为 interleaved Float32Array
 *
 * 格式：[min0, max0, min1, max1, ...]
 * 这是 applyGainsToPeaks 和 renderWaveform 期望的输入格式。
 *
 * @param min - 最小值数组
 * @param max - 最大值数组
 * @returns Float32Array interleaved 格式
 */
export function toInterleavedFloat32(
    min: number[],
    max: number[],
): Float32Array {
    const length = Math.min(min.length, max.length);
    const result = new Float32Array(length * 2);
    for (let i = 0; i < length; i++) {
        result[i * 2] = min[i];
        result[i * 2 + 1] = max[i];
    }
    return result;
}
