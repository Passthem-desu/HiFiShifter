/**
 * waveformAdapter
 *
 * 将后端返回的 min/max 峰值数据转换为 wavesurfer.js 可接受的 peaks 格式。
 * 提供两种输出：
 * - interleaved: Float32Array 格式 [min0, max0, min1, max1, ...]（与本仓库现有 renderer 保持一致）
 * - mono: Float32Array 单值幅度数组 [absPeak0, absPeak1, ...]，适配需要单值 peaks 的 API
 *
 * 该模块不依赖具体 wavesurfer 版本，调用端可根据运行时能力选择合适格式。
 */

/**
 * 转换 min/max 数组为 wavesurfer 可用的 peaks
 * @param min 最小值数组
 * @param max 最大值数组
 */
export function convertMinMaxToPeaks(min: number[], max: number[]) {
    const n = Math.min(min.length, max.length);
    const interleaved = new Float32Array(n * 2);
    const mono = new Float32Array(n);

    for (let i = 0; i < n; i++) {
        const mi = Number(min[i] ?? 0);
        const ma = Number(max[i] ?? 0);
        interleaved[i * 2] = mi;
        interleaved[i * 2 + 1] = ma;
        mono[i] = Math.max(Math.abs(mi), Math.abs(ma));
    }

    return { interleaved, mono };
}

export default convertMinMaxToPeaks;
