import type { ClipInfo } from "../../../features/session/sessionSlice";
import { clamp } from "./math";

export function clipSourceBeats(clip: ClipInfo, bpm: number): number | null {
    const durationSec = Number((clip as any).durationSec ?? 0);
    if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
    return (durationSec * bpm) / 60;
}

export function sliceWaveformSamples(
    samples: number[],
    clip: ClipInfo,
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
    const endBeat = clamp(startBeat + desiredLen, startBeat, maxEndBeat);
    if (endBeat - startBeat <= 1e-9) return [];

    const n = samples.length;
    const i0 = clamp(Math.floor((startBeat / sourceBeats) * n), 0, n - 1);
    const i1 = clamp(Math.ceil((endBeat / sourceBeats) * n), i0 + 1, n);
    return samples.slice(i0, i1);
}
