/**
 * Piano Roll Per-Clip 波形 Peaks Hook
 *
 * �?Piano Roll 背景波形提供 per-clip �?peaks 数据�?
 * 替代原来对整�?track �?mix 后取波形的方式�?
 * 每个可见 clip 独立获取 peaks，按时间位置叠加绘制�?
 */
import { useEffect, useMemo, useRef, useState } from "react";

import type { ClipInfo } from "../../../features/session/sessionTypes";
import { waveformApi } from "../../../services/api";
import { lruGet, lruSet } from "./peaksCache";

/** 单个 clip 的 peaks 数据条目 */
/** 单个 clip 的 peaks 数据条目 */
export interface ClipPeaksEntry {
    /** clip ID */
    clipId: string;
    /** clip 在 timeline 上的起始位置（秒，来自 ClipInfo.startSec） */
    startSec: number;
    /** clip 的长度（秒，来自 ClipInfo.lengthSec），用于绘制宽度，不影响 peaks 请求 */
    lengthSec: number;
    /** clip 的 sourceStartSec（秒），渲染时用于计算波形偏移 */
    sourceStartSec: number;
    /** source 文件总时长（秒），peaks 覆盖整个 source */
    sourceDurationSec: number;
    /** 播放速率 */
    playbackRate: number;
    peaks: {
        min: number[];
        max: number[];
        startSec: number;
        durSec: number;
        /** peaks 实际列数，用于绘制时避免拉伸 */
        columns: number;
    } | null;
}

/** 缓存条目 */
type CachedEntry = {
    min: number[];
    max: number[];
    startSec: number;
    durSec: number;
    t: number;
};

// 模块级缓存，�?hook 实例共享
const clipPeaksCache = new Map<string, CachedEntry>();
const clipPeaksInflight = new Map<string, Promise<CachedEntry | null>>();
const CLIP_PEAKS_CACHE_LIMIT = 128;
const PEAKS_COLUMNS_PER_SEC = 512;
const PEAKS_COLUMNS_MIN = 96;
const PEAKS_COLUMNS_MAX = 65536;
const PEAKS_COLUMNS_QUANT = 32;

/** 量化秒数，减少重复请�?*/
function qsec(x: number, step = 0.005): number {
    if (!Number.isFinite(x)) return 0;
    return Math.round(x / step) * step;
}

function targetColumnsForClip(clip: ClipInfo): number {
    const lengthSec = Math.max(0, Number(clip.lengthSec ?? 0) || 0);
    // Use fixed density (columns/sec) so total columns scale with clip length.
    const estimated = Math.round(lengthSec * PEAKS_COLUMNS_PER_SEC);
    const clamped = Math.max(PEAKS_COLUMNS_MIN, Math.min(PEAKS_COLUMNS_MAX, estimated || PEAKS_COLUMNS_MIN));
    return Math.max(
        PEAKS_COLUMNS_MIN,
        Math.min(
            PEAKS_COLUMNS_MAX,
            Math.round(clamped / PEAKS_COLUMNS_QUANT) * PEAKS_COLUMNS_QUANT,
        ),
    );
}

/** �?clip 信息转换�?peaks 请求参数 */
function buildClipPeaksRequest(
    clip: ClipInfo,
    targetColumns: number,
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
    if (
        clip.durationFrames &&
        clip.sourceSampleRate &&
        clip.sourceSampleRate > 0
    ) {
        durationSec = clip.durationFrames / clip.sourceSampleRate;
    } else {
        durationSec = Number(clip.durationSec ?? 0);
    }

    if (!Number.isFinite(durationSec) || durationSec <= 0) return null;

    const lengthSec = Math.max(0, Number(clip.lengthSec ?? 0) || 0);
    if (lengthSec <= 1e-9) return null;

    // 固定请求整个 source 文件的 peaks，不依赖 trim 值
    // 这样 trim 拖动不会导致 peaks 重新请求或波形变化
    const startSecQ = 0;
    const durSecQ = Math.max(0.005, qsec(durationSec));

    const columns = Math.max(
        PEAKS_COLUMNS_MIN,
        Math.min(PEAKS_COLUMNS_MAX, Math.round(targetColumns)),
    );

    const cacheKey = `${sourcePath}|${startSecQ.toFixed(3)}|${durSecQ.toFixed(3)}|${columns}`;

    return {
        sourcePath,
        startSec: startSecQ,
        durSec: durSecQ,
        columns,
        cacheKey,
    };
}

/**
 * �?Piano Roll 获取当前 track 下所有可�?clip �?peaks 数据
 *
 * @param args.clips - 当前 track 下的所有 clip
 * @param args.visibleStartSec - 可见区域起始时间（秒）
 * @param args.visibleEndSec - 可见区域结束时间（秒）
 * @returns ClipPeaksEntry 数组，每个 entry 对应一个可见 clip
 */
export function useClipsPeaksForPianoRoll(args: {
    clips: ClipInfo[];
    visibleStartSec: number;
    visibleEndSec: number;
}): ClipPeaksEntry[] {
    const { clips, visibleStartSec, visibleEndSec } = args;
    const [peaksMap, setPeaksMap] = useState<Map<string, CachedEntry>>(
        new Map(),
    );
    const requestIdRef = useRef(0);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    /**
     * 计算稳定的 peaks 请求 key 列表（不含 lengthSec）。
     * trim 拖动只改变 lengthSec，不改变 sourcePath/trimStart/trimEnd/playbackRate。
     * 因此 cacheKey 不变，不会触发重新请求。
     * useMemo 确保只在依赖真正变化时才重新计算，避免每次 render 都调用 buildClipPeaksRequest。
     */
    const peaksRequestKeys = useMemo(
        () =>
            clips
                .filter((clip) => {
                    return (
                        clip.startSec + clip.lengthSec > visibleStartSec &&
                        clip.startSec < visibleEndSec
                    );
                })
                .map((clip) => {
                    const req = buildClipPeaksRequest(
                        clip,
                        targetColumnsForClip(clip),
                    );
                    return req ? `${clip.id}:${req.cacheKey}` : null;
                })
                .filter(Boolean)
                .join(","),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [clips, visibleStartSec, visibleEndSec],
    );

    useEffect(() => {
        // 过滤出与可见区域有交叠的 clip（clip.startSec/lengthSec 是秒，直接比较）
        const visibleClips = clips.filter((clip) => {
            return (
                clip.startSec + clip.lengthSec > visibleStartSec &&
                clip.startSec < visibleEndSec
            );
        });

        if (visibleClips.length === 0) {
            setPeaksMap(new Map());
            return;
        }

        const currentRequestId = ++requestIdRef.current;

        // 先用缓存数据立即更新
        const initialMap = new Map<string, CachedEntry>();
        const toFetch: Array<{
            clip: ClipInfo;
            req: NonNullable<ReturnType<typeof buildClipPeaksRequest>>;
        }> = [];

        for (const clip of visibleClips) {
            // 列数按 clip 时长自适应，长 clip 提升精度，同时保持请求上限。
            const req = buildClipPeaksRequest(
                clip,
                targetColumnsForClip(clip),
            );
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
                                    min: (res.min ?? []).map(
                                        (v) => Number(v) || 0,
                                    ),
                                    max: (res.max ?? []).map(
                                        (v) => Number(v) || 0,
                                    ),
                                    startSec: req.startSec,
                                    durSec: req.durSec,
                                    t: performance.now(),
                                };
                                lruSet(
                                    clipPeaksCache,
                                    req.cacheKey,
                                    entry,
                                    CLIP_PEAKS_CACHE_LIMIT,
                                );
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

            if (
                !mountedRef.current ||
                currentRequestId !== requestIdRef.current
            )
                return;

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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [peaksRequestKeys, visibleStartSec, visibleEndSec]);

    // 构建返回值：过滤可见 clip，附加 peaks 数据。
    // useMemo 确保只在 peaksMap 或可见 clips 真正变化时才返回新数组引用，
    // 避免每次 render 都天然产生新引用导致 PianoRollPanel 的 invalidate effect 每帧执行。
    return useMemo(() => {
        const visibleClips = clips.filter((clip) => {
            return (
                clip.startSec + clip.lengthSec > visibleStartSec &&
                clip.startSec < visibleEndSec
            );
        });

        return visibleClips.map((clip): ClipPeaksEntry => {
            const entry = peaksMap.get(clip.id) ?? null;

            // 计算 source 文件总时长
            let sourceDurationSec: number;
            if (
                clip.durationFrames &&
                clip.sourceSampleRate &&
                clip.sourceSampleRate > 0
            ) {
                sourceDurationSec = clip.durationFrames / clip.sourceSampleRate;
            } else {
                sourceDurationSec = Number(clip.durationSec ?? 0);
            }

            const playbackRate = Number(clip.playbackRate ?? 1);
            const pr =
                Number.isFinite(playbackRate) && playbackRate > 0
                    ? playbackRate
                    : 1;

            return {
                clipId: clip.id,
                startSec: clip.startSec,
                lengthSec: clip.lengthSec,
                sourceStartSec: Math.max(
                    0,
                    Number(clip.sourceStartSec ?? 0) || 0,
                ),
                sourceDurationSec:
                    sourceDurationSec > 0 ? sourceDurationSec : 0,
                playbackRate: pr,
                peaks: entry
                    ? {
                          min: entry.min,
                          max: entry.max,
                          startSec: entry.startSec,
                          durSec: entry.durSec,
                          columns: entry.min.length,
                      }
                    : null,
            };
        });
        // peaksMap 内容变化时才重新计算；可见区域或 clips 变化时同步更新。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [peaksMap, clips, visibleStartSec, visibleEndSec]);
}
