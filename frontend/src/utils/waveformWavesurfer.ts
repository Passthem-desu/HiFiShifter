/**
 * waveformWavesurfer.ts
 *
 * 为 wavesurfer.js v7 提供的适配器工具。
 *
 * 目的：把后端 HFSPeaks v2（min/max）响应转换为 wavesurfer v7 可接受的
 * `peaks` + `duration` 格式（每通道为 Float32Array 或 number[]），并提供
 * 一个便捷的 fetch helper，从后端获取数据并返回转换结果。
 *
 * 说明：wavesurfer v7 接受 `options.peaks` 为 `Array<Float32Array | number[]>`
 *（按通道），以及 `duration`（秒）。当我们没有可用已解码音频数据时，
 * 将预计算的峰值传给 wavesurfer 可以让 renderer 直接绘制波形。
 */

import type { WaveformPeaksV2Payload, MipmapLevel } from "../types/api";
import { waveformApi } from "../services/api/waveform";
import { convertMinMaxToPeaks } from "./waveformAdapter";

export interface WaveSurferPeaksResult {
    peaks: Array<Float32Array | number[]>;
    duration: number;
    sampleRate?: number;
    divisionFactor?: number;
    mipmapLevel?: number;
    startSec?: number;
    actualDurationSec?: number;
}

/**
 * 将 v2 min/max 响应转换为 wavesurfer 可用的 peaks。返回单通道（mono）。
 * 如果需要 stereo，可在此处扩展为生成两个通道数组。
 */
export function buildWaveSurferPeaksFromV2(
    resp: WaveformPeaksV2Payload,
    fallbackDuration?: number,
): WaveSurferPeaksResult {
    const mins = (resp.min || []).map((v) => Number(v) || 0);
    const maxs = (resp.max || []).map((v) => Number(v) || 0);
    // 使用已有的转换函数以保留更多波形信息：interleaved (min,max)
    const { interleaved } = convertMinMaxToPeaks(mins, maxs);

    // Prefer interleaved representation (min,max pairs) as a single channel so
    // the renderer sees signed samples and can draw a visible waveform.
    const channelData = interleaved;

    const duration = resp.actual_duration_sec || fallbackDuration || 1;

    return {
        peaks: [channelData],
        duration,
        sampleRate: resp.sample_rate,
        divisionFactor: resp.division_factor,
        mipmapLevel: resp.mipmap_level,
        startSec: resp.actual_start_sec,
        actualDurationSec: resp.actual_duration_sec,
    };
}

/**
 * 从后端请求 v2 峰值（指定 mipmap level），并返回 wavesurfer 格式的结果。
 */
export async function fetchWaveSurferPeaksFromV2(
    sourcePath: string,
    startSec: number,
    durationSec: number,
    columns: number,
    level: MipmapLevel = 0,
): Promise<WaveSurferPeaksResult | null> {
    const resp = await waveformApi.getWaveformPeaksV2Level(
        sourcePath,
        startSec,
        durationSec,
        columns,
        level,
    );
    if (!resp || !resp.ok) return null;
    return buildWaveSurferPeaksFromV2(resp, durationSec);
}

export default buildWaveSurferPeaksFromV2;
