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
const SS_KEY_PREFIX = "hs_peaks_v1|";
const SS_CACHE_LIMIT = 512;

/**
 * 模块�?Set，记录已写入 sessionStorage 的完�?key（含前缀）�?
 * 避免 ssSet 每次写入都遍�?sessionStorage.length（O(n)），改为 O(1) 查找�?
 * 页面刷新后会重建，但重建成本极低（仅在首�?ssGet 命中时回填）�?
 */
const ssKeySet = new Set<string>();

/** �?sessionStorage 读取缓存条目（反序列化失败时静默忽略�?*/
function ssGet(key: string): CachedSegment | null {
    try {
        const fullKey = SS_KEY_PREFIX + key;
        const raw = sessionStorage.getItem(fullKey);
        if (!raw) return null;
        // 回填 ssKeySet，保证刷新后 Set �?sessionStorage 保持同步
        ssKeySet.add(fullKey);
        return JSON.parse(raw) as CachedSegment;
    } catch {
        return null;
    }
}

/** 写入 sessionStorage，超�?SS_CACHE_LIMIT 时删除最旧条目（O(1) key 查找�?*/
function ssSet(key: string, seg: CachedSegment) {
    try {
        const fullKey = SS_KEY_PREFIX + key;
        if (ssKeySet.size >= SS_CACHE_LIMIT && !ssKeySet.has(fullKey)) {
            // �?t 升序排序，删除最旧的一�?
            const entries: { k: string; t: number }[] = [];
            for (const k of ssKeySet) {
                try {
                    const v = JSON.parse(sessionStorage.getItem(k) ?? "{}") as { t?: number };
                    entries.push({ k, t: v.t ?? 0 });
                } catch {
                    entries.push({ k, t: 0 });
                }
            }
            entries.sort((a, b) => a.t - b.t);
            const toDelete = entries.slice(0, ssKeySet.size - SS_CACHE_LIMIT + 1);
            for (const { k } of toDelete) {
                sessionStorage.removeItem(k);
                ssKeySet.delete(k);
            }
        }
        sessionStorage.setItem(fullKey, JSON.stringify(seg));
        ssKeySet.add(fullKey);
    } catch {
        // 写入失败（如隐私模式或存储已满）静默忽略
    }
}

function getCachedSegment(key: string): CachedSegment | null {
    // 先查内存 Map
    const hit = peaksSegmentCache.get(key);
    if (hit) {
        peaksSegmentCache.delete(key);
        peaksSegmentCache.set(key, hit);
        return hit;
    }
    // 未命中则�?sessionStorage，命中后回填内存 Map
    const ssHit = ssGet(key);
    if (ssHit) {
        peaksSegmentCache.set(key, ssHit);
        while (peaksSegmentCache.size > PEAKS_CACHE_LIMIT) {
            const oldest = peaksSegmentCache.keys().next().value as string | undefined;
            if (!oldest) break;
            peaksSegmentCache.delete(oldest);
        }
        return ssHit;
    }
    return null;
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
    // 同步写入 sessionStorage 实现跨页面刷新持久化
    ssSet(key, seg);
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
    widthPx: number;
    altPressed?: boolean;
    hasWaveformPreview: boolean;
}) {
    const {
        clip,
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

        // 纯秒域计算，不依赖 BPM
        const timelineLenSec = Math.max(0, Number(clip.lengthSec ?? 0) || 0);
        if (timelineLenSec <= 1e-9) return null;

        const prRaw = Number(clip.playbackRate ?? 1);
        const pr = Number.isFinite(prRaw) && prRaw > 0 ? prRaw : 1;
        // source 域所需长度（秒）= timeline 长度 * playbackRate
        const desiredLenSrc = timelineLenSec * pr;
        if (desiredLenSrc <= 1e-9) return null;

        const trimStartRaw = Number(clip.trimStartSec ?? 0) || 0;
        const preSilenceSecSrc = Math.max(0, -trimStartRaw);
        const trimStart = Math.max(0, trimStartRaw);
        const trimEnd = Math.max(0, Number(clip.trimEndSec ?? 0) || 0);
        const startSec = clamp(trimStart, 0, durationSec);
        const maxEndSec = Math.max(startSec, durationSec - trimEnd);
        const cycleLenSec = Math.max(0, maxEndSec - startSec);
        if (cycleLenSec <= 1e-9) return null;

        // 非循环：超出 source 可用窗口的部分为静音
        // 负 trimStart 引入前置静音，也消耗 clip 时间
        const playableSecSrc = Math.max(0, desiredLenSrc - preSilenceSecSrc);
        const segmentLenSec = Math.min(playableSecSrc, cycleLenSec);
        if (segmentLenSec <= 1e-9) return null;

        if (!Number.isFinite(startSec) || !Number.isFinite(segmentLenSec)) {
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

        // 转换回 timeline 域（秒）
        const leadSilenceBeats = preSilenceSecSrc / Math.max(1e-6, pr);
        const segmentLenBeatsTimeline = segmentLenSec / Math.max(1e-6, pr);

        return {
            sourcePath,
            startSec: startSecQ,
            durationSec: segmentLenSecQ,
            outColumns,
            segmentColumns,
            leadSilenceBeats,
            segmentLenBeatsTimeline,
        };
    // 注意：不依赖 bpm，波形内容基于秒域计算，BPM 变化不影响波形显示
    }, [altPressed, clip, widthPx]);

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

        const buildOutput = (
            segMin: number[],
            segMax: number[],
            isPreview: boolean,
        ): PeaksRenderState => {
            const outCols = clamp(Math.floor(outColumns), 16, 8192);
            const segCols = Math.min(segMin.length, segMax.length);
            const segLen = Math.max(1e-9, Number(segmentLenBeatsTimeline) || 0);
            const denom = Math.max(1, outCols - 1);

            const outMin: number[] = new Array(outCols);
            const outMax: number[] = new Array(outCols);

            const lead = Math.max(0, Number(leadSilenceBeats) || 0);
            // 使用当前请求的实际长度（segLen + lead），而非 clip.lengthSec�?
            // clip.lengthSec �?trim 拖动时持续变化，会导�?buildOutput 每次
            // 用不同的 clipLenBeats 重新映射波形，产生拉�?压缩视觉效果�?
            // 当前请求�?segLen + lead 是稳定的，与 peaks 数据一一对应�?
            const clipLenBeats = Math.max(1e-9, segLen + lead);

            for (let i = 0; i < outCols; i += 1) {
                const t = i / denom;
                const beatAtClip = t * clipLenBeats;
                const beatInSeg = beatAtClip - lead;
                if (beatInSeg < 0 || beatInSeg > segLen) {
                    outMin[i] = 0;
                    outMax[i] = 0;
                    continue;
                }
                const mm = sampleSegmentMinMaxAtBeat(
                    segMin,
                    segMax,
                    segLen,
                    beatInSeg,
                );
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
                isPreview,
            };
        };

        if (cached) {
            setPeaks(buildOutput(cached.min, cached.max, false));
            peaksKeyRef.current = key;
            return;
        }

        const keyChanged = peaksKeyRef.current !== key;
        if (keyChanged) {
            peaksKeyRef.current = key;

            // Preview remap: if we already have a base segment from the previous request,
            // immediately rebuild output with the new timeline mapping while backend peaks load.
            // This avoids waveform flicker during trim/stretch/slip drags.
            // isPreview=false: trim 时波形数据本身是正确的（只是 timeline 映射变了），
            // 不需要降�?opacity，避免视觉闪烁�?
            if (peaks?.ok && peaks.segmentMin.length >= 2 && peaks.segmentMax.length >= 2) {
                setPeaks(buildOutput(peaks.segmentMin, peaks.segmentMax, false));
            } else if (altPressed && hasWaveformPreview) {
                // As a last resort, during slip-edit prefer the import-time waveform preview.
                setPeaks(null);
            }
        } else {
            // Key unchanged but we still lack cache: keep any previous peaks.
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

                setPeaks(buildOutput(segMin, segMax, false));
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [altPressed, hasWaveformPreview, peaksRequest, peaks?.ok, peaks?.segmentMin, peaks?.segmentMax]);

    return peaks;
}
