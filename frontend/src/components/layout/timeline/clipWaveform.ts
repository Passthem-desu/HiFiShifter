import type { ClipInfo } from "../../../features/session/sessionTypes";
import { clamp } from "./math";

export function clipSourceBeats(clip: ClipInfo, bpm: number): number | null {
    const durationSec = Number(clip.durationSec ?? 0);
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
    const durationSec = Number(clip.durationSec ?? 0);
    if (!Number.isFinite(durationSec) || durationSec <= 0) return samples;
    const safeBpm = Math.max(1e-6, Number(bpm) || 120);
    const sourceBeats = (durationSec * safeBpm) / 60;
    if (!Number.isFinite(sourceBeats) || sourceBeats <= 1e-6) return samples;

    const trimStartRaw = Number(clip.trimStartBeat ?? 0) || 0;
    const preSilenceBeats = Math.max(0, -trimStartRaw);
    const trimStart = Math.max(0, trimStartRaw);
    const trimEnd = Math.max(0, Number(clip.trimEndBeat ?? 0) || 0);
    const startBeat = clamp(trimStart, 0, sourceBeats);
    const maxEndBeat = Math.max(startBeat, sourceBeats - trimEnd);
    const desiredLen = Math.max(0, Number(clip.lengthBeats ?? 0) || 0);

    if (desiredLen <= 1e-9) return [];

    const n = samples.length;
    const i0 = clamp(Math.floor((startBeat / sourceBeats) * n), 0, n - 1);
    const i1 = clamp(Math.ceil((maxEndBeat / sourceBeats) * n), i0 + 1, n);
    const cycle = samples.slice(i0, i1);

    // Output length: keep the same waveform density as the source preview.
    const need = Math.max(2, Math.ceil((desiredLen / sourceBeats) * n));
    const out = new Array<number>(need).fill(0);

    // Leading silence (negative trimStart) maps into the clip window.
    const samplesPerBeat = need / Math.max(1e-9, desiredLen);
    const pre = Math.round(preSilenceBeats * samplesPerBeat);
    const dst0 = clamp(pre, 0, need);
    const take = Math.min(Math.max(0, need - dst0), cycle.length);
    if (take > 0) {
        for (let i = 0; i < take; i++) {
            out[dst0 + i] = cycle[i];
        }
    }

    return out;
}
