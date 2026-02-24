import React from "react";

import type { WaveformPeaksSegmentPayload } from "../../../../types/api";
import type { ClipInfo } from "../../../../features/session/sessionTypes";
import { waveformApi } from "../../../../services/api";
import { clamp } from "../math";
type CachedSegment = {
    min: number[];
    max: number[];
    t: number;
};

export type PeaksRenderState = {
    ok: boolean;
    min: number[];
    max: number[];
    columns: number;
    // Base segment peaks used for preview remapping while new peaks are loading.
    segmentMin: number[];
    segmentMax: number[];
    segmentLenBeats: number;
    segmentColumns: number;
    // Leading silence in CLIP domain (timeline beats).
    leadSilenceBeats: number;
    isPreview?: boolean;
};

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function sampleSegmentMinMaxAtBeat(
    segmentMin: number[],
    segmentMax: number[],
    segmentLenBeats: number,
    beat: number,
): { min: number; max: number } {
    const srcN = Math.min(segmentMin.length, segmentMax.length);
    if (srcN <= 0) return { min: 0, max: 0 };
    if (srcN === 1) {
        const vMin = Number(segmentMin[0] ?? 0);
        const vMax = Number(segmentMax[0] ?? 0);
        return { min: vMin, max: vMax };
    }

    const len = Math.max(1e-9, Number(segmentLenBeats) || 0);
    const t = clamp(beat / len, 0, 1);
    const x = t * (srcN - 1);
    const i0 = Math.floor(x);
    const i1 = Math.min(srcN - 1, i0 + 1);
    const f = x - i0;
    const mn0 = Number(segmentMin[i0] ?? 0);
    const mn1 = Number(segmentMin[i1] ?? 0);
    const mx0 = Number(segmentMax[i0] ?? 0);
    const mx1 = Number(segmentMax[i1] ?? 0);
    return { min: lerp(mn0, mn1, f), max: lerp(mx0, mx1, f) };
}

const peaksSegmentCache = new Map<string, CachedSegment>();
const peaksSegmentInflight = new Map<
    string,
    Promise<WaveformPeaksSegmentPayload>
>();
const PEAKS_CACHE_LIMIT = 256;

function getCachedSegment(key: string): CachedSegment | null {
    const hit = peaksSegmentCache.get(key);
    if (!hit) return null;
    peaksSegmentCache.delete(key);
    peaksSegmentCache.set(key, hit);
    return hit;
}

function setCachedSegment(key: string, seg: CachedSegment) {
    peaksSegmentCache.set(key, seg);
    while (peaksSegmentCache.size > PEAKS_CACHE_LIMIT) {
        const oldest = peaksSegmentCache.keys().next().value as
            | string
            | undefined;
        if (!oldest) break;
        peaksSegmentCache.delete(oldest);
    }
}

function hasTauriInvoke(): boolean {
    const w = window as unknown as {
        __TAURI__?: { core?: { invoke?: unknown }; invoke?: unknown };
    };
    return (
        typeof w.__TAURI__?.core?.invoke === "function" ||
        typeof w.__TAURI__?.invoke === "function"
    );
}

export function useClipWaveformPeaks(args: {
    clip: ClipInfo;
    bpm: number;
    widthPx: number;
    altPressed?: boolean;
    hasWaveformPreview: boolean;
}) {
    const {
        clip,
        bpm,
        widthPx,
        altPressed = false,
        hasWaveformPreview,
    } = args;

    const peaksRequest = React.useMemo(() => {
        if (!hasTauriInvoke()) return null;
        const sourcePath = clip.sourcePath;
        if (!sourcePath) return null;

        const durationSec = Number(clip.durationSec ?? 0);
        if (!Number.isFinite(durationSec) || durationSec <= 0) return null;

        const safeBpm = Math.max(1e-6, Number(bpm) || 120);
        const sourceBeats = (durationSec * safeBpm) / 60;
        if (!Number.isFinite(sourceBeats) || sourceBeats <= 1e-6) return null;

        const timelineLenBeats = Math.max(
            0,
            Number(clip.lengthBeats ?? 0) || 0,
        );
        if (timelineLenBeats <= 1e-9) return null;

        const prRaw = Number(clip.playbackRate ?? 1);
        const pr = Number.isFinite(prRaw) && prRaw > 0 ? prRaw : 1;
        const desiredLenBeats = timelineLenBeats * pr;
        if (desiredLenBeats <= 1e-9) return null;

        const trimStartRaw = Number(clip.trimStartBeat ?? 0) || 0;
        const preSilenceBeatsSrc = Math.max(0, -trimStartRaw);
        const trimStart = Math.max(0, trimStartRaw);
        const trimEnd = Math.max(0, Number(clip.trimEndBeat ?? 0) || 0);
        const startBeat = clamp(trimStart, 0, sourceBeats);
        const maxEndBeat = Math.max(startBeat, sourceBeats - trimEnd);
        const cycleLenBeats = Math.max(0, maxEndBeat - startBeat);
        if (cycleLenBeats <= 1e-9) return null;

        // Non-repeating: lengths beyond the available source window are silence.
        // Negative trimStart introduces leading silence that also consumes clip time.
        const playableBeatsSrc = Math.max(
            0,
            desiredLenBeats - preSilenceBeatsSrc,
        );
        const segmentLenBeats = Math.min(playableBeatsSrc, cycleLenBeats);
        if (segmentLenBeats <= 1e-9) return null;

        const startSec = (startBeat / sourceBeats) * durationSec;
        const segmentLenSec = (segmentLenBeats / sourceBeats) * durationSec;
        if (
            !Number.isFinite(startSec) ||
            !Number.isFinite(segmentLenSec) ||
            segmentLenSec <= 0
        ) {
            return null;
        }

        // During Alt+drag slip-edit, peaks requests can become very high frequency and
        // backend rendering might lag. Quantize and downsample the request so UI stays responsive.
        const quantStepSec = altPressed ? 0.02 : 0.005; // 20ms vs 5ms
        const qsec = (x: number) => {
            if (!Number.isFinite(x)) return 0;
            const step = Math.max(1e-6, quantStepSec);
            return Math.round(x / step) * step;
        };
        const startSecQ = qsec(startSec);
        const segmentLenSecQ = Math.max(quantStepSec, qsec(segmentLenSec));

        // Request columns in coarse steps so trim drags don't spam unique requests.
        // We render at the current pixel width anyway (interpolated), so request resolution
        // only needs to be "good enough" and stable.
        const rawColumns = clamp(Math.floor(widthPx), 16, 8192);
        const outColumns = clamp(Math.round(rawColumns / 64) * 64, 16, 8192);
        const segmentColumns = altPressed
            ? clamp(Math.round(outColumns / 4), 16, 2048)
            : outColumns;

        const leadSilenceBeats = preSilenceBeatsSrc / Math.max(1e-6, pr);
        const segmentLenBeatsTimeline = segmentLenBeats / Math.max(1e-6, pr);

        return {
            sourcePath,
            startSec: startSecQ,
            durationSec: segmentLenSecQ,
            outColumns,
            segmentColumns,
            leadSilenceBeats,
            segmentLenBeatsTimeline,
        };
    }, [altPressed, bpm, clip, widthPx]);

    const [peaks, setPeaks] = React.useState<PeaksRenderState | null>(null);

    const peaksKeyRef = React.useRef<string | null>(null);
    const peaksDebounceRef = React.useRef<number | null>(null);
    const peaksRequestIdRef = React.useRef(0);

    React.useEffect(() => {
        if (!peaksRequest) {
            setPeaks(null);
            peaksKeyRef.current = null;
            return;
        }

        const {
            sourcePath,
            startSec,
            durationSec: segSec,
            outColumns,
            segmentColumns,
            leadSilenceBeats,
            segmentLenBeatsTimeline,
        } = peaksRequest;

        const key = `${sourcePath}|${startSec.toFixed(3)}|${segSec.toFixed(3)}|${segmentColumns}`;
        const cached = getCachedSegment(key);

        if (peaksKeyRef.current !== key) {
            peaksKeyRef.current = key;

            // Prefer immediate, local waveform preview during slip-edit drags.
            // Otherwise we may keep showing a stale peaks buffer until the backend responds.
            if (altPressed && hasWaveformPreview && !cached) {
                setPeaks(null);
            }
        }

        const buildOutput = (segMin: number[], segMax: number[]): PeaksRenderState => {
            const outCols = clamp(Math.floor(outColumns), 16, 8192);
            const segCols = Math.min(segMin.length, segMax.length);
            const segLen = Math.max(1e-9, Number(segmentLenBeatsTimeline) || 0);
            const denom = Math.max(1, outCols - 1);

            const outMin: number[] = new Array(outCols);
            const outMax: number[] = new Array(outCols);

            const clipLenBeats = Math.max(1e-9, Number(clip.lengthBeats ?? 0) || 0);
            const lead = Math.max(0, Number(leadSilenceBeats) || 0);

            for (let i = 0; i < outCols; i += 1) {
                const t = i / denom;
                const beatAtClip = t * clipLenBeats;
                const beatInSeg = beatAtClip - lead;
                if (beatInSeg < 0 || beatInSeg > segLen) {
                    outMin[i] = 0;
                    outMax[i] = 0;
                    continue;
                }
                const mm = sampleSegmentMinMaxAtBeat(segMin, segMax, segLen, beatInSeg);
                outMin[i] = mm.min;
                outMax[i] = mm.max;
            }

            return {
                ok: true,
                min: outMin,
                max: outMax,
                columns: outCols,
                segmentMin: segMin,
                segmentMax: segMax,
                segmentLenBeats: segLen,
                segmentColumns: segCols,
                leadSilenceBeats: lead,
                isPreview: false,
            };
        };

        if (cached) {
            setPeaks(buildOutput(cached.min, cached.max));
            return;
        }

        if (peaksDebounceRef.current != null) {
            window.clearTimeout(peaksDebounceRef.current);
        }

        const requestId = ++peaksRequestIdRef.current;
        const debounceMs = altPressed ? 75 : 25;
        peaksDebounceRef.current = window.setTimeout(async () => {
            try {
                let p = peaksSegmentInflight.get(key);
                if (!p) {
                    p = waveformApi
                        .getWaveformPeaksSegment(
                            sourcePath,
                            startSec,
                            segSec,
                            segmentColumns,
                        )
                        .finally(() => {
                            peaksSegmentInflight.delete(key);
                        });
                    peaksSegmentInflight.set(key, p);
                }

                const res = await p;

                if (requestId !== peaksRequestIdRef.current) return;
                if (!res || !res.ok) return;

                const segMin = (res.min ?? []).map((v) => Number(v) || 0);
                const segMax = (res.max ?? []).map((v) => Number(v) || 0);
                if (segMin.length < 2 || segMax.length < 2) return;

                setCachedSegment(key, {
                    min: segMin,
                    max: segMax,
                    t: performance.now(),
                });

                setPeaks(buildOutput(segMin, segMax));
            } catch {
                // Ignore peaks failures; fallback waveform preview may still render.
            }
        }, debounceMs);

        return () => {
            if (peaksDebounceRef.current != null) {
                window.clearTimeout(peaksDebounceRef.current);
                peaksDebounceRef.current = null;
            }
        };
    }, [altPressed, hasWaveformPreview, peaksRequest]);

    return peaks;
}
