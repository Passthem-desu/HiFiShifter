import type { ClipInfo } from "../../../features/session/sessionTypes";
import { clamp } from "./math";

/**
 * 从 waveform 预览采样数组中切出 clip 可见窗口对应的采样段。
 *
 * 所有参数均在**秒域**计算，不依赖 BPM。
 * - trimStartSec / trimEndSec：相对于 source 起点的裁剪量（秒）
 * - durationSec：source 文件总时长（秒）
 * - lengthSec：source 可用窗口长度（秒），用于控制输出采样密度
 *   应传入 (durationSec - trimStart - trimEnd)，与 clip.lengthSec 无关，
 *   这样 trim 拖动时只改变 i0/i1 切片范围，不改变输出密度，波形不缩放。
 */
export function sliceWaveformSamples(
    samples: number[],
    clip: Pick<
        ClipInfo,
        "trimStartSec" | "trimEndSec" | "lengthSec" | "durationSec"
    >,
): number[] {
    if (!Array.isArray(samples) || samples.length < 2) return samples;
    const durationSec = Number(clip.durationSec ?? 0);
    if (!Number.isFinite(durationSec) || durationSec <= 0) return samples;

    const trimStartRaw = Number(clip.trimStartSec ?? 0) || 0;
    const preSilenceSec = Math.max(0, -trimStartRaw);
    const trimStart = Math.max(0, trimStartRaw);
    const trimEnd = Math.max(0, Number(clip.trimEndSec ?? 0) || 0);

    // 切片起止点（秒域）
    const startSec = clamp(trimStart, 0, durationSec);
    const maxEndSec = Math.max(startSec, durationSec - trimEnd);

    // desiredLen：source 可用窗口长度（秒），控制输出采样密度
    // 由调用方传入，应为固定值（不随 trim/BPM 变化）
    const desiredLen = Math.max(0, Number(clip.lengthSec ?? 0) || 0);
    if (desiredLen <= 1e-9) return [];

    const n = samples.length;
    const i0 = clamp(Math.floor((startSec / durationSec) * n), 0, n - 1);
    const i1 = clamp(Math.ceil((maxEndSec / durationSec) * n), i0 + 1, n);
    const cycle = samples.slice(i0, i1);

    // 输出采样数：保持与 source 预览相同的波形密度
    const need = Math.max(2, Math.ceil((desiredLen / durationSec) * n));
    const out = new Array<number>(need).fill(0);

    // 前置静音（负 trimStart）映射到 clip 窗口内
    const samplesPerSec = need / Math.max(1e-9, desiredLen);
    const pre = Math.round(preSilenceSec * samplesPerSec);
    const dst0 = clamp(pre, 0, need);
    const take = Math.min(Math.max(0, need - dst0), cycle.length);
    if (take > 0) {
        for (let i = 0; i < take; i++) {
            out[dst0 + i] = cycle[i];
        }
    }

    return out;
}
