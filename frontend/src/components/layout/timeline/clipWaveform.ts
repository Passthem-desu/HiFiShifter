import type { ClipInfo } from "../../../features/session/sessionSlice";
import { clamp } from "./math";

export function clipSourceBeats(clip: ClipInfo, bpm: number): number | null {
    const durationSec = Number((clip as any).durationSec ?? 0);
    if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
    return (durationSec * bpm) / 60;
}

export function sliceWaveformSamples(
    samples: number[],
    clip: Pick<
        ClipInfo,
        "trimStartBeat" | "trimEndBeat" | "lengthBeats" | "durationSec"
    >,
    bpm: number,
): number[] {
    if (!Array.isArray(samples) || samples.length < 2) return samples;
    const durationSec = Number((clip as any).durationSec ?? 0);
    if (!Number.isFinite(durationSec) || durationSec <= 0) return samples;
    const safeBpm = Math.max(1e-6, Number(bpm) || 120);
    const sourceBeats = (durationSec * safeBpm) / 60;
    if (!Number.isFinite(sourceBeats) || sourceBeats <= 1e-6) return samples;

    const trimStart = Math.max(0, Number(clip.trimStartBeat ?? 0) || 0);
    const trimEnd = Math.max(0, Number(clip.trimEndBeat ?? 0) || 0);
    const startBeat = clamp(trimStart, 0, sourceBeats);
    const maxEndBeat = Math.max(startBeat, sourceBeats - trimEnd);
    const desiredLen = Math.max(0, Number(clip.lengthBeats ?? 0) || 0);

    const cycleLen = Math.max(0, maxEndBeat - startBeat);
    if (cycleLen <= 1e-9 || desiredLen <= 1e-9) return [];

    const n = samples.length;
    const i0 = clamp(Math.floor((startBeat / sourceBeats) * n), 0, n - 1);
    const i1 = clamp(Math.ceil((maxEndBeat / sourceBeats) * n), i0 + 1, n);
    const cycle = samples.slice(i0, i1);
    if (cycle.length < 2) return [];

    // We want samples proportional to desiredLen at the same density as the cycle.
    const need = Math.max(2, Math.ceil((desiredLen / cycleLen) * cycle.length));
    if (need <= cycle.length) {
        return cycle.slice(0, need);
    }

    const out: number[] = [];
    out.length = 0;
    while (out.length < need) {
        const remaining = need - out.length;
        if (remaining >= cycle.length) {
            out.push(...cycle);
        } else {
            out.push(...cycle.slice(0, remaining));
        }
    }
    return out;
}
