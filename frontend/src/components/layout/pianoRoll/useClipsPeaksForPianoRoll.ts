/**
 * Piano Roll Per-Clip 波形 Peaks Hook
 *
 * 为 Piano Roll 背景波形提供 per-clip 的 peaks 数据，
 * 替代原来对整个 track 做 mix 后取波形的方式。
 * 每个可见 clip 独立获取 peaks，按时间位置叠加绘制。
 */
import { useEffect, useRef, useState } from "react";

import type { ClipInfo } from "../../../features/session/sessionTypes";
import { waveformApi } from "../../../services/api";
import { lruGet, lruSet } from "./peaksCache";

/** 单个 clip 的 peaks 数据条目 */
export interface ClipPeaksEntry {
    /** clip ID */
    clipId: string;
    /** clip 在 timeline 上的起始 beat */
    startBeat: number;
    /** clip 的长度（beats） */
    lengthBeats: number;
    /** peaks 数据，未加载时为 null */
    peaks: { min: number[]; max: number[]; startSec: number; durSec: number } | null;
}

/** 缓存条目 */
type CachedEntry = {
    min: number[];
    max: number[];
    startSec: number;
    durSec: number;
    t: number;
};

// 模块级缓存，跨 hook 实例共享
const clipPeaksCache = new Map<string, CachedEntry>();
const clipPeaksInflight = new Map<string, Promise<CachedEntry | null>>();
const CLIP_PEAKS_CACHE_LIMIT = 128;

/** 量化秒数，减少重复请求 */
function qsec(x: number, step = 0.005): number {
    if (!Number.isFinite(x)) return 0;
    return Math.round(x / step) * step;
}

/** 将 clip 信息转换为 peaks 请求参数 */
function buildClipPeaksRequest(
    clip: ClipInfo,
    secPerBeat: number,
    widthPx: number,
): {
    sourcePath: string;
    startSec: number;
    durSec: number;
    columns: number;
    cacheKey: string;
} | null {
    const sourcePath = clip.sourcePath;
    if (!sourcePath) return null;

    // 优先使用精确的frame计算
    let durationSec: number;
    if (clip.durationFrames && clip.sourceSampleRate && clip.sourceSampleRate > 0) {
        durationSec = clip.durationFrames / clip.sourceSampleRate;
    } else {
        durationSec = Number(clip.durationSec ?? 0);
    }
    
    if (!Number.isFinite(durationSec) || durationSec <= 0) return null;

    const lengthBeats = Math.max(0, Number(clip.lengthBeats ?? 0) || 0);
    if (lengthBeats <= 1e-9) return null;

    console.log(`[ClipPeaks] Building request for clip ${clip.id.slice(0, 8)}:`, {
        durationFrames: clip.durationFrames,
        sourceSampleRate: clip.sourceSampleRate,
        computedDurSec: durationSec.toFixed(6),
        legacyDurationSec: clip.durationSec,
        lengthBeats: lengthBeats,
        secPerBeat: secPerBeat,
        trimStartBeat: clip.trimStartBeat,
        trimEndBeat: clip.trimEndBeat,
        playbackRate: clip.playbackRate,
    });

    const playbackRate = Number(clip.playbackRate ?? 1);
    const pr = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;

    // 计算 clip 在源文件中的起始时间
    // sourceBeats = durationSec / secPerBeat（源文件总 beats）
    const sourceBeats = durationSec / Math.max(1e-6, secPerBeat);
    const trimStart = Math.max(0, Number(clip.trimStartBeat ?? 0) || 0);
    const trimEnd = Math.max(0, Number(clip.trimEndBeat ?? 0) || 0);
    const startBeat = Math.min(trimStart, sourceBeats);
    const endBeat = Math.max(startBeat, sourceBeats - trimEnd);

    const startSec = (startBeat / Math.max(1e-6, sourceBeats)) * durationSec;
    const segLenBeats = Math.min(lengthBeats * pr, endBeat - startBeat);
    const segLenSec = (segLenBeats / Math.max(1e-6, sourceBeats)) * durationSec;

    if (!Number.isFinite(startSec) || !Number.isFinite(segLenSec) || segLenSec <= 0) {
        return null;
    }

    const startSecQ = qsec(startSec);
    const durSecQ = Math.max(0.005, qsec(segLenSec));

    // columns 按 64 量化，与 ClipItem 保持一致
    const rawCols = Math.max(16, Math.min(8192, Math.floor(widthPx)));
    const columns = Math.max(16, Math.min(8192, Math.round(rawCols / 64) * 64));

    const cacheKey = `${sourcePath}|${startSecQ.toFixed(3)}|${durSecQ.toFixed(3)}|${columns}`;

    return { sourcePath, startSec: startSecQ, durSec: durSecQ, columns, cacheKey };
}

/**
 * 为 Piano Roll 获取当前 track 下所有可见 clip 的 peaks 数据
 *
 * @param args.clips - 当前 track 下的所有 clip
 * @param args.visibleStartBeat - 可见区域起始 beat
 * @param args.visibleEndBeat - 可见区域结束 beat
 * @param args.pxPerBeat - 每 beat 的像素宽度
 * @param args.secPerBeat - 每 beat 的秒数
 * @returns ClipPeaksEntry 数组，每个 entry 对应一个可见 clip
 */
export function useClipsPeaksForPianoRoll(args: {
    clips: ClipInfo[];
    visibleStartBeat: number;
    visibleEndBeat: number;
    pxPerBeat: number;
    secPerBeat: number;
}): ClipPeaksEntry[] {
    const { clips, visibleStartBeat, visibleEndBeat, pxPerBeat, secPerBeat } = args;

    const [peaksMap, setPeaksMap] = useState<Map<string, CachedEntry>>(new Map());
    const requestIdRef = useRef(0);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    useEffect(() => {
        // 过滤出与可见区域有交叠的 clip
        const visibleClips = clips.filter((clip) => {
            const clipEnd = clip.startBeat + clip.lengthBeats;
            return clipEnd > visibleStartBeat && clip.startBeat < visibleEndBeat;
        });

        if (visibleClips.length === 0) {
            setPeaksMap(new Map());
            return;
        }

        const currentRequestId = ++requestIdRef.current;

        // 先用缓存数据立即更新
        const initialMap = new Map<string, CachedEntry>();
        const toFetch: Array<{ clip: ClipInfo; req: NonNullable<ReturnType<typeof buildClipPeaksRequest>> }> = [];

        for (const clip of visibleClips) {
            const widthPx = clip.lengthBeats * pxPerBeat;
            const req = buildClipPeaksRequest(clip, secPerBeat, widthPx);
            if (!req) continue;

            const cached = lruGet(clipPeaksCache, req.cacheKey);
            if (cached) {
                initialMap.set(clip.id, cached);
            } else {
                toFetch.push({ clip, req });
            }
        }

        if (initialMap.size > 0) {
            setPeaksMap(new Map(initialMap));
        }

        if (toFetch.length === 0) return;

        // 异步获取未缓存的 clip peaks
        void (async () => {
            const results = await Promise.allSettled(
                toFetch.map(async ({ clip, req }) => {
                    // inflight 去重
                    let p = clipPeaksInflight.get(req.cacheKey);
                    if (!p) {
                        p = waveformApi
                            .getWaveformPeaksSegment(
                                req.sourcePath,
                                req.startSec,
                                req.durSec,
                                req.columns,
                            )
                            .then((res) => {
                                if (!res?.ok) return null;
                                const entry: CachedEntry = {
                                    min: (res.min ?? []).map((v) => Number(v) || 0),
                                    max: (res.max ?? []).map((v) => Number(v) || 0),
                                    startSec: req.startSec,
                                    durSec: req.durSec,
                                    t: performance.now(),
                                };
                                lruSet(clipPeaksCache, req.cacheKey, entry, CLIP_PEAKS_CACHE_LIMIT);
                                return entry;
                            })
                            .finally(() => {
                                clipPeaksInflight.delete(req.cacheKey);
                            });
                        clipPeaksInflight.set(req.cacheKey, p);
                    }

                    const entry = await p;
                    return { clipId: clip.id, entry };
                }),
            );

            if (!mountedRef.current || currentRequestId !== requestIdRef.current) return;

            setPeaksMap((prev) => {
                const next = new Map(prev);
                for (const result of results) {
                    if (result.status === "fulfilled" && result.value) {
                        const { clipId, entry } = result.value;
                        if (entry) {
                            next.set(clipId, entry);
                        }
                    }
                }
                return next;
            });
        })();
    }, [clips, visibleStartBeat, visibleEndBeat, pxPerBeat, secPerBeat]);

    // 构建返回值：过滤可见 clip，附加 peaks 数据
    const visibleClips = clips.filter((clip) => {
        const clipEnd = clip.startBeat + clip.lengthBeats;
        return clipEnd > visibleStartBeat && clip.startBeat < visibleEndBeat;
    });

    return visibleClips.map((clip): ClipPeaksEntry => {
        const entry = peaksMap.get(clip.id) ?? null;
        return {
            clipId: clip.id,
            startBeat: clip.startBeat,
            lengthBeats: clip.lengthBeats,
            peaks: entry
                ? { min: entry.min, max: entry.max, startSec: entry.startSec, durSec: entry.durSec }
                : null,
        };
    });
}
