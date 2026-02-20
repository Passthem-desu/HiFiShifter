import React from "react";
import type { ClipInfo } from "../../../features/session/sessionSlice";
import { webApi } from "../../../services/webviewApi";
import { CLIP_BODY_PADDING_Y, CLIP_HEADER_HEIGHT } from "./constants";
import { clamp } from "./math";
import { fadeInAreaPath, fadeOutAreaPath } from "./paths";
import { sliceWaveformSamples } from "./clipWaveform";
import { ClipEdgeHandles } from "./clip/ClipEdgeHandles";
import { ClipHeader } from "./clip/ClipHeader";

type WaveformPreview = number[] | { l: number[]; r: number[] };

type WaveformPeaksSegmentPayload = {
    ok: boolean;
    min: number[];
    max: number[];
    sample_rate: number;
    hop: number;
};

type CachedSegment = {
    min: number[];
    max: number[];
    t: number;
};

type PeaksRenderState = {
    ok: boolean;
    min: number[];
    max: number[];
    columns: number;
    // Base segment peaks used for preview remapping while new peaks are loading.
    segmentMin: number[];
    segmentMax: number[];
    segmentLenBeats: number;
    segmentColumns: number;
    startBeat: number;
    cycleLenBeats: number;
    repeat: boolean;
    isPreview?: boolean;
};

function safeMod(x: number, m: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(m) || m <= 1e-9) return 0;
    const r = x % m;
    return r < 0 ? r + m : r;
}

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

function buildPreviewPeaks(
    prev: PeaksRenderState,
    next: {
        desiredLenBeats: number;
        startBeat: number;
        cycleLenBeats: number;
        repeat: boolean;
        outColumns: number;
    },
): PeaksRenderState {
    const outColumns = clamp(Math.floor(next.outColumns), 16, 8192);
    const desiredLenBeats = Math.max(1e-9, Number(next.desiredLenBeats) || 0);
    const denom = Math.max(1, outColumns - 1);

    const outMin: number[] = new Array(outColumns);
    const outMax: number[] = new Array(outColumns);

    const prevStart = Number(prev.startBeat) || 0;
    const prevCycle = Math.max(0, Number(prev.cycleLenBeats) || 0);
    const prevSegLen = Math.max(1e-9, Number(prev.segmentLenBeats) || 0);

    for (let i = 0; i < outColumns; i += 1) {
        const t = i / denom;
        const clipBeat = t * desiredLenBeats;
        const srcBeat =
            (Number(next.startBeat) || 0) +
            (next.repeat
                ? safeMod(
                      clipBeat,
                      Math.max(1e-9, Number(next.cycleLenBeats) || 0),
                  )
                : clipBeat);

        const rel = srcBeat - prevStart;
        const phase = prev.repeat
            ? safeMod(rel, Math.max(1e-9, prevCycle))
            : clamp(rel, 0, prevSegLen);

        const mm = sampleSegmentMinMaxAtBeat(
            prev.segmentMin,
            prev.segmentMax,
            prevSegLen,
            phase,
        );
        outMin[i] = mm.min;
        outMax[i] = mm.max;
    }

    return {
        ...prev,
        ok: true,
        min: outMin,
        max: outMax,
        columns: outColumns,
        isPreview: true,
    };
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
    const anyWindow = window as any;
    return (
        typeof anyWindow?.__TAURI__?.core?.invoke === "function" ||
        typeof anyWindow?.__TAURI__?.invoke === "function"
    );
}

function areaPathFromMinMaxBand(
    min: number[],
    max: number[],
    w: number,
    totalH: number,
    centerY: number,
    halfH: number,
    ampScale: number,
    lengthBeats: number,
    fadeInBeats: number,
    fadeOutBeats: number,
): string {
    const srcN = Math.min(min.length, max.length);
    const n = Math.max(1, Math.floor(w));
    if (srcN <= 0 || n <= 0) return "";

    const bandHalf = Math.max(0.5, Number(halfH) || 0);
    const y0 = centerY - bandHalf;
    const y1 = centerY + bandHalf;
    const scale = bandHalf * Math.max(0, ampScale);

    const denom = Math.max(1, n - 1);
    const srcDenom = Math.max(1, srcN - 1);
    const safeLenBeats = Math.max(1e-9, Number(lengthBeats) || 0);
    const safeFadeIn = Math.max(0, Number(fadeInBeats) || 0);
    const safeFadeOut = Math.max(0, Number(fadeOutBeats) || 0);

    const yMax: number[] = new Array(n);
    const yMin: number[] = new Array(n);

    for (let x = 0; x < n; x += 1) {
        const t = x / denom;
        const srcT = t * srcDenom;
        const i0 = Math.floor(srcT);
        const i1 = Math.min(srcN - 1, i0 + 1);
        const f = srcT - i0;

        const mi0 = Number(min[i0] ?? 0);
        const mi1 = Number(min[i1] ?? 0);
        const ma0 = Number(max[i0] ?? 0);
        const ma1 = Number(max[i1] ?? 0);
        const mi = mi0 + (mi1 - mi0) * f;
        const ma = ma0 + (ma1 - ma0) * f;

        let mul = 1;
        const beatAtX = t * safeLenBeats;
        if (safeFadeIn > 1e-9) mul *= clamp(beatAtX / safeFadeIn, 0, 1);
        if (safeFadeOut > 1e-9)
            mul *= clamp((safeLenBeats - beatAtX) / safeFadeOut, 0, 1);

        const top = clamp(centerY - ma * mul * scale, y0, y1);
        const bot = clamp(centerY - mi * mul * scale, y0, y1);
        yMax[x] = clamp(top, 0, totalH);
        yMin[x] = clamp(bot, 0, totalH);
    }

    let d = `M0 ${yMax[0]}`;
    for (let x = 1; x < n; x += 1) d += `L${x} ${yMax[x]}`;
    for (let x = n - 1; x >= 0; x -= 1) d += `L${x} ${yMin[x]}`;
    d += "Z";
    return d;
}

function minMaxEnvelopeFromSamples(
    samples: number[],
    columns: number,
): {
    min: number[];
    max: number[];
} {
    const srcN = samples.length;
    const n = Math.max(1, Math.floor(columns));
    const outMin: number[] = new Array(n);
    const outMax: number[] = new Array(n);
    if (srcN <= 0) {
        outMin.fill(0);
        outMax.fill(0);
        return { min: outMin, max: outMax };
    }

    // Partition samples into N buckets and take min/max in each bucket.
    for (let x = 0; x < n; x += 1) {
        const s0 = Math.floor((x * srcN) / n);
        const s1 = Math.floor(((x + 1) * srcN) / n);
        const start = clamp(s0, 0, srcN - 1);
        const end = clamp(Math.max(s1, start + 1), 0, srcN);

        let mn = Number.POSITIVE_INFINITY;
        let mx = Number.NEGATIVE_INFINITY;
        for (let i = start; i < end; i += 1) {
            const v = Number(samples[i] ?? 0);
            if (v < mn) mn = v;
            if (v > mx) mx = v;
        }
        if (!Number.isFinite(mn) || !Number.isFinite(mx)) {
            const v = Number(samples[start] ?? 0);
            mn = v;
            mx = v;
        }
        outMin[x] = mn;
        outMax[x] = mx;
    }

    return { min: outMin, max: outMax };
}

export const ClipItem: React.FC<{
    clip: ClipInfo;
    rowHeight: number;
    pxPerBeat: number;
    bpm: number;
    waveform: WaveformPreview | undefined;
    altPressed?: boolean;
    selected: boolean;
    isInMultiSelectedSet: boolean;
    multiSelectedCount: number;

    ensureSelected: (clipId: string) => void;
    selectClipRemote: (clipId: string) => void;
    openContextMenu: (clipId: string, clientX: number, clientY: number) => void;

    seekFromClientX: (clientX: number, commit: boolean) => void;
    startClipDrag: (
        e: React.PointerEvent<HTMLDivElement>,
        clipId: string,
        clipStartBeat: number,
        altPressedHint?: boolean,
    ) => void;
    startEditDrag: (
        e: React.PointerEvent,
        clipId: string,
        type:
            | "trim_left"
            | "trim_right"
            | "stretch_left"
            | "stretch_right"
            | "fade_in"
            | "fade_out"
            | "gain",
    ) => void;
    toggleClipMuted: (clipId: string, nextMuted: boolean) => void;

    clearContextMenu: () => void;
}> = ({
    clip,
    rowHeight,
    pxPerBeat,
    bpm,
    waveform,
    altPressed = false,
    selected,
    isInMultiSelectedSet,
    multiSelectedCount,
    ensureSelected,
    selectClipRemote,
    openContextMenu,
    seekFromClientX,
    startClipDrag,
    startEditDrag,
    toggleClipMuted,
    clearContextMenu,
}) => {
    const left = Math.max(0, clip.startBeat * pxPerBeat);
    const width = Math.max(1, clip.lengthBeats * pxPerBeat);
    const bodyHeight = Math.max(
        1,
        rowHeight - CLIP_BODY_PADDING_Y - CLIP_HEADER_HEIGHT,
    );

    // For time-stretch: timeline length changes, but the source window length should remain
    // consistent. Our trimming math stores trim beats in *source* beat-domain.
    // Convert timeline beats -> source beats using playbackRate.
    const playbackRateRaw = Number((clip as any).playbackRate ?? 1);
    const playbackRate =
        Number.isFinite(playbackRateRaw) && playbackRateRaw > 0
            ? playbackRateRaw
            : 1;
    const sourceWindowLenBeats =
        Math.max(0, Number(clip.lengthBeats ?? 0) || 0) * playbackRate;

    const durationSec = Number((clip as any).durationSec ?? 0);
    const sourceBeats =
        Number.isFinite(durationSec) && durationSec > 0
            ? (durationSec * Math.max(1e-6, Number(bpm) || 120)) / 60
            : null;
    const trimStart = Math.max(0, Number(clip.trimStartBeat ?? 0) || 0);
    const trimEnd = Math.max(0, Number(clip.trimEndBeat ?? 0) || 0);
    const cycleLenBeats =
        sourceBeats == null
            ? null
            : Math.max(
                  0,
                  Math.max(
                      clamp(trimStart, 0, sourceBeats),
                      sourceBeats - trimEnd,
                  ) - clamp(trimStart, 0, sourceBeats),
              );
    const showRepeatMarker =
        cycleLenBeats != null &&
        cycleLenBeats > 1e-6 &&
        sourceWindowLenBeats > cycleLenBeats + 1e-6;
    const repeatMarkerX =
        showRepeatMarker && cycleLenBeats != null
            ? (cycleLenBeats / Math.max(1e-6, playbackRate)) * pxPerBeat
            : 0;

    const waveformAmpScale = clip.muted
        ? 0
        : clamp(Number(clip.gain ?? 1), 0, 4);

    // Map full-scale audio (|v|≈1) to the band boundary. Keep gain applied.
    const waveformVisualAmpScale = waveformAmpScale;

    const peaksRequest = React.useMemo(() => {
        if (!hasTauriInvoke()) return null;
        const sourcePath = clip.sourcePath;
        if (!sourcePath) return null;

        const durationSec = Number((clip as any).durationSec ?? 0);
        if (!Number.isFinite(durationSec) || durationSec <= 0) return null;

        const safeBpm = Math.max(1e-6, Number(bpm) || 120);
        const sourceBeats = (durationSec * safeBpm) / 60;
        if (!Number.isFinite(sourceBeats) || sourceBeats <= 1e-6) return null;

        const timelineLenBeats = Math.max(
            0,
            Number(clip.lengthBeats ?? 0) || 0,
        );
        if (timelineLenBeats <= 1e-9) return null;

        const prRaw = Number((clip as any).playbackRate ?? 1);
        const pr = Number.isFinite(prRaw) && prRaw > 0 ? prRaw : 1;
        const desiredLenBeats = timelineLenBeats * pr;
        if (desiredLenBeats <= 1e-9) return null;

        const trimStart = Math.max(0, Number(clip.trimStartBeat ?? 0) || 0);
        const trimEnd = Math.max(0, Number(clip.trimEndBeat ?? 0) || 0);
        const startBeat = clamp(trimStart, 0, sourceBeats);
        const maxEndBeat = Math.max(startBeat, sourceBeats - trimEnd);
        const cycleLenBeats = Math.max(0, maxEndBeat - startBeat);
        if (cycleLenBeats <= 1e-9) return null;

        const repeat = desiredLenBeats > cycleLenBeats + 1e-6;
        const segmentLenBeats = repeat
            ? cycleLenBeats
            : Math.min(desiredLenBeats, cycleLenBeats);

        const startSec = (startBeat / sourceBeats) * durationSec;
        const segmentLenSec = (segmentLenBeats / sourceBeats) * durationSec;
        if (
            !Number.isFinite(startSec) ||
            !Number.isFinite(segmentLenSec) ||
            segmentLenSec <= 0
        ) {
            return null;
        }

        // Request columns in coarse steps so trim drags don't spam unique requests.
        // We render at the current pixel width anyway (interpolated), so request resolution
        // only needs to be "good enough" and stable.
        const rawColumns = clamp(Math.floor(width), 16, 8192);
        const outColumns = clamp(Math.round(rawColumns / 64) * 64, 16, 8192);
        const segmentColumns = repeat
            ? clamp(
                  Math.floor((segmentLenBeats / desiredLenBeats) * outColumns),
                  16,
                  outColumns,
              )
            : outColumns;

        return {
            sourcePath,
            startSec,
            durationSec: segmentLenSec,
            outColumns,
            segmentColumns,
            repeat,
            startBeat,
            desiredLenBeats,
            cycleLenBeats,
            segmentLenBeats,
        };
    }, [bpm, clip, width]);

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
            repeat,
            startBeat,
            desiredLenBeats,
            cycleLenBeats,
            segmentLenBeats,
        } = peaksRequest;

        const key = `${sourcePath}|${startSec.toFixed(3)}|${segSec.toFixed(3)}|${segmentColumns}`;
        const cached = getCachedSegment(key);

        // Avoid flashing on trim drags: if we don't have a cache hit yet, generate a
        // fast preview by remapping the previous segment peaks into the new clip domain.
        if (peaksKeyRef.current !== key) {
            peaksKeyRef.current = key;
            if (!cached) {
                setPeaks((prev) => {
                    if (!prev || !prev.ok) return prev;
                    if (
                        prev.segmentMin.length < 2 ||
                        prev.segmentMax.length < 2
                    )
                        return prev;
                    return buildPreviewPeaks(prev, {
                        desiredLenBeats,
                        startBeat,
                        cycleLenBeats,
                        repeat,
                        outColumns,
                    });
                });
            }
        }

        const buildOutput = (
            segMin: number[],
            segMax: number[],
        ): PeaksRenderState => {
            const segCols = Math.min(segMin.length, segMax.length);
            const segLen = Math.max(1e-9, Number(segmentLenBeats) || 0);
            if (!repeat) {
                return {
                    ok: true,
                    min: segMin,
                    max: segMax,
                    columns: outColumns,
                    segmentMin: segMin,
                    segmentMax: segMax,
                    segmentLenBeats: segLen,
                    segmentColumns: segCols,
                    startBeat,
                    cycleLenBeats,
                    repeat,
                    isPreview: false,
                };
            }

            const outMin: number[] = [];
            const outMax: number[] = [];
            const need = outColumns;

            while (outMin.length < need) {
                const remaining = need - outMin.length;
                if (remaining >= segMin.length) {
                    outMin.push(...segMin);
                    outMax.push(...segMax);
                } else {
                    outMin.push(...segMin.slice(0, remaining));
                    outMax.push(...segMax.slice(0, remaining));
                }
            }
            return {
                ok: true,
                min: outMin,
                max: outMax,
                columns: outColumns,
                segmentMin: segMin,
                segmentMax: segMax,
                segmentLenBeats: segLen,
                segmentColumns: segCols,
                startBeat,
                cycleLenBeats,
                repeat,
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
        peaksDebounceRef.current = window.setTimeout(async () => {
            try {
                let p = peaksSegmentInflight.get(key);
                if (!p) {
                    p = webApi
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
        }, 25);

        return () => {
            if (peaksDebounceRef.current != null) {
                window.clearTimeout(peaksDebounceRef.current);
                peaksDebounceRef.current = null;
            }
        };
    }, [peaksRequest]);

    const stereo =
        waveform &&
        typeof waveform === "object" &&
        !Array.isArray(waveform) &&
        "l" in waveform &&
        "r" in waveform;

    const clipForWaveform = React.useMemo(
        () => ({
            trimStartBeat: clip.trimStartBeat,
            trimEndBeat: clip.trimEndBeat,
            // Use source-domain window length so stretching changes visuals.
            lengthBeats: sourceWindowLenBeats,
            durationSec: clip.durationSec,
        }),
        [
            clip.trimStartBeat,
            clip.trimEndBeat,
            sourceWindowLenBeats,
            clip.durationSec,
        ],
    );

    const waveformSvg = React.useMemo(() => {
        const quantizeCols = (raw: number) =>
            clamp(
                Math.round(clamp(Math.floor(raw), 16, 8192) / 64) * 64,
                16,
                8192,
            );

        const renderCols = peaks?.ok
            ? clamp(Math.floor(peaks.columns), 16, 8192)
            : quantizeCols(width);

        const w = renderCols;
        const totalH = 24;
        const gap = 2;
        const bandH = (totalH - gap) / 2;
        const halfH = bandH / 2;
        const centerTop = halfH;
        const centerBot = bandH + gap + halfH;

        const lenBeats = Number(clip.lengthBeats ?? 0) || 0;
        const fadeIn = Number(clip.fadeInBeats ?? 0) || 0;
        const fadeOut = Number(clip.fadeOutBeats ?? 0) || 0;

        // Keep existing color tokens (no palette adjustments): just change geometry.
        const fill = peaks
            ? "rgba(255,255,255,0.22)"
            : "rgba(255,255,255,0.18)";
        const stroke = peaks
            ? "rgba(255,255,255,0.75)"
            : "rgba(255,255,255,0.65)";

        let topMin: number[] | null = null;
        let topMax: number[] | null = null;
        let botMin: number[] | null = null;
        let botMax: number[] | null = null;

        if (
            peaks &&
            peaks.ok &&
            peaks.min.length >= 2 &&
            peaks.max.length >= 2
        ) {
            // Backend peaks are currently mono; duplicate into two bands for DAW-style look.
            topMin = peaks.min;
            topMax = peaks.max;
            botMin = peaks.min;
            botMax = peaks.max;
        } else if (stereo) {
            const wf = waveform as { l: number[]; r: number[] };
            const leftSamples = sliceWaveformSamples(
                wf.l ?? [],
                clipForWaveform,
                bpm,
            );
            const rightSamples = sliceWaveformSamples(
                wf.r ?? [],
                clipForWaveform,
                bpm,
            );
            const leftEnv = minMaxEnvelopeFromSamples(leftSamples, w);
            const rightEnv = minMaxEnvelopeFromSamples(rightSamples, w);
            topMin = leftEnv.min;
            topMax = leftEnv.max;
            botMin = rightEnv.min;
            botMax = rightEnv.max;
        } else if (Array.isArray(waveform) && waveform.length > 0) {
            const mono = sliceWaveformSamples(waveform, clipForWaveform, bpm);
            if (mono.length < 2) return null;
            const env = minMaxEnvelopeFromSamples(mono, w);
            topMin = env.min;
            topMax = env.max;
            botMin = env.min;
            botMax = env.max;
        } else {
            return null;
        }

        const topD =
            topMin && topMax
                ? areaPathFromMinMaxBand(
                      topMin,
                      topMax,
                      w,
                      totalH,
                      centerTop,
                      halfH,
                      waveformVisualAmpScale,
                      lenBeats,
                      fadeIn,
                      fadeOut,
                  )
                : "";
        const botD =
            botMin && botMax
                ? areaPathFromMinMaxBand(
                      botMin,
                      botMax,
                      w,
                      totalH,
                      centerBot,
                      halfH,
                      waveformVisualAmpScale,
                      lenBeats,
                      fadeIn,
                      fadeOut,
                  )
                : "";

        if (!topD && !botD) return null;
        return (
            <svg
                viewBox={`0 0 ${w} ${totalH}`}
                preserveAspectRatio="none"
                className="w-full h-full"
            >
                {topD ? (
                    <path
                        d={topD}
                        fill={fill}
                        stroke={stroke}
                        strokeWidth="1"
                        vectorEffect="non-scaling-stroke"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                    />
                ) : null}
                {botD ? (
                    <path
                        d={botD}
                        fill={fill}
                        stroke={stroke}
                        strokeWidth="1"
                        vectorEffect="non-scaling-stroke"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                    />
                ) : null}
            </svg>
        );
    }, [
        bpm,
        clipForWaveform,
        clip.fadeInBeats,
        clip.fadeOutBeats,
        clip.lengthBeats,
        peaks,
        stereo,
        waveform,
        waveformAmpScale,
        waveformVisualAmpScale,
        width,
    ]);

    return (
        <div
            className={`absolute cursor-pointer overflow-visible group ${clip.muted ? "opacity-60 grayscale" : "opacity-95"}`}
            style={{
                left,
                width,
                top: 0,
                height: rowHeight - CLIP_BODY_PADDING_Y,
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!isInMultiSelectedSet) {
                    ensureSelected(clip.id);
                }
                selectClipRemote(clip.id);
                openContextMenu(clip.id, e.clientX, e.clientY);
            }}
            onPointerDown={(e) => {
                if (e.button !== 0) return;

                const alt = Boolean(
                    altPressed ||
                        e.altKey ||
                        (e.nativeEvent as any)?.getModifierState?.("Alt"),
                );

                // Seek should happen on click, not on drag.
                // Track whether the pointer moved beyond a small deadzone.
                const allowSeek = !alt && !e.ctrlKey && !e.metaKey;
                const startX = e.clientX;
                const startY = e.clientY;
                let moved = false;

                function onMove(ev: PointerEvent) {
                    if (ev.pointerId !== e.pointerId) return;
                    const dx = ev.clientX - startX;
                    const dy = ev.clientY - startY;
                    if (dx * dx + dy * dy >= 9) moved = true;
                }

                function onUp(ev: PointerEvent) {
                    if (ev.pointerId !== e.pointerId) return;
                    window.removeEventListener("pointermove", onMove, true);
                    window.removeEventListener("pointerup", onUp, true);
                    window.removeEventListener("pointercancel", onUp, true);
                    if (!moved && allowSeek) {
                        seekFromClientX(ev.clientX, true);
                    }
                }

                window.addEventListener("pointermove", onMove, true);
                window.addEventListener("pointerup", onUp, true);
                window.addEventListener("pointercancel", onUp, true);

                e.preventDefault();
                e.stopPropagation();
                clearContextMenu();

                if (multiSelectedCount === 0 || !isInMultiSelectedSet) {
                    ensureSelected(clip.id);
                }
                selectClipRemote(clip.id);
                startClipDrag(e, clip.id, clip.startBeat, alt);
            }}
            title={clip.sourcePath ?? clip.name}
        >
            <ClipEdgeHandles
                clipId={clip.id}
                altPressed={altPressed}
                multiSelectedCount={multiSelectedCount}
                isInMultiSelectedSet={isInMultiSelectedSet}
                ensureSelected={ensureSelected}
                selectClipRemote={selectClipRemote}
                startEditDrag={startEditDrag}
            />

            <ClipHeader
                clip={clip}
                ensureSelected={ensureSelected}
                selectClipRemote={selectClipRemote}
                startEditDrag={startEditDrag}
                toggleClipMuted={toggleClipMuted}
                isInMultiSelectedSet={isInMultiSelectedSet}
                multiSelectedCount={multiSelectedCount}
            />

            {/* Body block (does not fill the entire track row; leaves header lane above) */}
            <div
                className={`absolute left-0 right-0 bottom-0 rounded-sm shadow-sm overflow-visible border ${selected ? "border-white" : "border-qt-highlight"}`}
                style={{
                    top: CLIP_HEADER_HEIGHT,
                    backgroundColor:
                        "color-mix(in oklab, var(--qt-highlight) 35%, transparent)",
                }}
            >
                {/* Body (waveform + edit handles) */}
                <div className="absolute inset-0">
                    <div
                        className="absolute left-0 top-0 w-[14px] h-[14px] z-[70]"
                        style={{ cursor: "nwse-resize" }}
                        onPointerDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (
                                multiSelectedCount === 0 ||
                                !isInMultiSelectedSet
                            ) {
                                ensureSelected(clip.id);
                            }
                            selectClipRemote(clip.id);
                            startEditDrag(e, clip.id, "fade_in");
                        }}
                    />
                    <div
                        className="absolute right-0 top-0 w-[14px] h-[14px] z-[70]"
                        style={{ cursor: "nesw-resize" }}
                        onPointerDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (
                                multiSelectedCount === 0 ||
                                !isInMultiSelectedSet
                            ) {
                                ensureSelected(clip.id);
                            }
                            selectClipRemote(clip.id);
                            startEditDrag(e, clip.id, "fade_out");
                        }}
                    />

                    <div className="absolute inset-0 pointer-events-none z-30">
                        {showRepeatMarker ? (
                            <div
                                className="absolute top-0 bottom-0"
                                style={{
                                    left: Math.max(
                                        0,
                                        Math.min(width - 1, repeatMarkerX),
                                    ),
                                    width: 1,
                                    backgroundColor: "rgba(255,255,255,0.35)",
                                }}
                                title="Repeat"
                            />
                        ) : null}
                        {clip.fadeInBeats > 0 ? (
                            <svg
                                className="absolute left-0 top-0 h-full"
                                width={Math.min(
                                    width,
                                    clip.fadeInBeats * pxPerBeat,
                                )}
                                height={bodyHeight}
                                viewBox={`0 0 ${Math.max(1, Math.min(width, clip.fadeInBeats * pxPerBeat))} ${Math.max(1, bodyHeight)}`}
                                preserveAspectRatio="none"
                            >
                                <path
                                    d={fadeInAreaPath(
                                        Math.max(
                                            1,
                                            Math.min(
                                                width,
                                                clip.fadeInBeats * pxPerBeat,
                                            ),
                                        ),
                                        Math.max(1, bodyHeight),
                                    )}
                                    fill="rgba(255,255,255,0.14)"
                                    stroke="rgba(255,255,255,0.55)"
                                    strokeWidth="1"
                                    vectorEffect="non-scaling-stroke"
                                />
                            </svg>
                        ) : null}
                        {clip.fadeOutBeats > 0 ? (
                            <svg
                                className="absolute right-0 top-0 h-full"
                                width={Math.min(
                                    width,
                                    clip.fadeOutBeats * pxPerBeat,
                                )}
                                height={bodyHeight}
                                viewBox={`0 0 ${Math.max(1, Math.min(width, clip.fadeOutBeats * pxPerBeat))} ${Math.max(1, bodyHeight)}`}
                                preserveAspectRatio="none"
                            >
                                <path
                                    d={fadeOutAreaPath(
                                        Math.max(
                                            1,
                                            Math.min(
                                                width,
                                                clip.fadeOutBeats * pxPerBeat,
                                            ),
                                        ),
                                        Math.max(1, bodyHeight),
                                    )}
                                    fill="rgba(255,255,255,0.14)"
                                    stroke="rgba(255,255,255,0.55)"
                                    strokeWidth="1"
                                    vectorEffect="non-scaling-stroke"
                                />
                            </svg>
                        ) : null}
                    </div>

                    <div className="absolute inset-x-0 inset-y-1 opacity-80">
                        {waveformSvg}
                    </div>
                </div>
            </div>
        </div>
    );
};
