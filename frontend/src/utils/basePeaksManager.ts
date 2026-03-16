/**
 * BasePeaksManager - 源文件级波形峰值数据缓存管理器
 * 
 * 设计目标：
 * 1. 缓存源文件的完整 base peaks（hop=256 帧）
 * 2. 多个 clip 共享同一源文件时复用缓存
 * 3. 内存 LRU + sessionStorage 持久化
 * 4. 高性能：Float32Array 存储，避免重复请求
 */

import { waveformApi } from "../services/api/waveform";

/** Base peaks 缓存条目 */
export interface BasePeaksCache {
    /** min/max 交替存储的 Float32Array: [min0, max0, min1, max1, ...] */
    peaks: Float32Array;
    /** 源文件路径 */
    sourcePath: string;
    /** 源文件时长（秒） */
    durationSec: number;
    /** 总采样点数 = peaks.length / 2 */
    totalSamples: number;
    /** 缓存时间戳 */
    timestamp: number;
}

/** 缓存配置 */
const MEMORY_CACHE_LIMIT = 128;
const SESSION_CACHE_LIMIT = 256;
const SS_KEY_PREFIX = "hs_base_peaks_v2|";

/** 内存缓存：LRU Map */
const memoryCache = new Map<string, BasePeaksCache>();

/** sessionStorage key 集合 */
const ssKeySet = new Set<string>();

/** 正在请求中的 Promise */
const pendingRequests = new Map<string, Promise<BasePeaksCache | null>>();

/** 后端返回的列数常量（与后端 hop=64 对应，提升4倍精度） */
const BASE_COLUMNS_PER_SEC = 4096;

/**
 * 从 sessionStorage 读取缓存
 */
function ssGet(key: string): BasePeaksCache | null {
    try {
        const fullKey = SS_KEY_PREFIX + key;
        const raw = sessionStorage.getItem(fullKey);
        if (!raw) return null;
        ssKeySet.add(fullKey);
        const parsed = JSON.parse(raw);
        // 反序列化 Float32Array
        if (parsed.peaks && Array.isArray(parsed.peaks)) {
            parsed.peaks = new Float32Array(parsed.peaks);
        }
        return parsed as BasePeaksCache;
    } catch {
        return null;
    }
}

/**
 * 写入 sessionStorage
 */
function ssSet(key: string, cache: BasePeaksCache): void {
    try {
        const fullKey = SS_KEY_PREFIX + key;
        // 检查是否需要淘汰旧条目
        if (ssKeySet.size >= SESSION_CACHE_LIMIT && !ssKeySet.has(fullKey)) {
            const entries: { k: string; t: number }[] = [];
            for (const k of ssKeySet) {
                try {
                    const v = JSON.parse(sessionStorage.getItem(k) ?? "{}");
                    entries.push({ k, t: v.timestamp ?? 0 });
                } catch {
                    entries.push({ k, t: 0 });
                }
            }
            entries.sort((a, b) => a.t - b.t);
            const toDelete = entries.slice(0, ssKeySet.size - SESSION_CACHE_LIMIT + 1);
            for (const { k } of toDelete) {
                sessionStorage.removeItem(k);
                ssKeySet.delete(k);
            }
        }
        // 序列化时将 Float32Array 转为数组
        const toStore = {
            ...cache,
            peaks: Array.from(cache.peaks),
        };
        sessionStorage.setItem(fullKey, JSON.stringify(toStore));
        ssKeySet.add(fullKey);
    } catch {
        // 写入失败（隐私模式或存储已满）静默忽略
    }
}

/**
 * 从内存缓存获取
 */
function getFromMemory(key: string): BasePeaksCache | null {
    const hit = memoryCache.get(key);
    if (hit) {
        // LRU: 移到最后
        memoryCache.delete(key);
        memoryCache.set(key, hit);
        return hit;
    }
    return null;
}

/**
 * 写入内存缓存
 */
function setToMemory(key: string, cache: BasePeaksCache): void {
    memoryCache.set(key, cache);
    // LRU 淘汰
    while (memoryCache.size > MEMORY_CACHE_LIMIT) {
        const oldest = memoryCache.keys().next().value;
        if (oldest) memoryCache.delete(oldest);
        else break;
    }
}

/**
 * 获取源文件的 base peaks
 * 
 * @param sourcePath - 源文件路径
 * @param durationSec - 源文件时长（秒）
 * @returns BasePeaksCache 或 null（请求失败时）
 */
export async function getBasePeaks(
    sourcePath: string,
    durationSec: number,
): Promise<BasePeaksCache | null> {
    if (!sourcePath || durationSec <= 0) return null;

    // 计算请求参数：基于时长确定列数
    const columns = Math.max(16, Math.round(durationSec * BASE_COLUMNS_PER_SEC));
    const cacheKey = `${sourcePath}|${durationSec.toFixed(3)}|${columns}`;

    // 1. 先检查内存缓存
    const memoryHit = getFromMemory(cacheKey);
    if (memoryHit) return memoryHit;

    // 2. 检查 sessionStorage
    const ssHit = ssGet(cacheKey);
    if (ssHit) {
        setToMemory(cacheKey, ssHit);
        return ssHit;
    }

    // 3. 检查是否有正在进行的请求（去重）
    const pending = pendingRequests.get(cacheKey);
    if (pending) return pending;

    // 4. 发起新请求
    const request = (async (): Promise<BasePeaksCache | null> => {
        try {
            const res = await waveformApi.getWaveformPeaksSegment(
                sourcePath,
                0,
                durationSec,
                columns,
            );

            if (!res || !res.ok) return null;

            const minArr = res.min ?? [];
            const maxArr = res.max ?? [];
            const n = Math.min(minArr.length, maxArr.length);
            if (n < 2) return null;

            // 合并为 Float32Array: [min0, max0, min1, max1, ...]
            const peaks = new Float32Array(n * 2);
            for (let i = 0; i < n; i++) {
                peaks[i * 2] = Number(minArr[i]) || 0;
                peaks[i * 2 + 1] = Number(maxArr[i]) || 0;
            }

            const cache: BasePeaksCache = {
                peaks,
                sourcePath,
                durationSec,
                totalSamples: n,
                timestamp: performance.now(),
            };

            // 写入缓存
            setToMemory(cacheKey, cache);
            ssSet(cacheKey, cache);

            return cache;
        } catch {
            return null;
        } finally {
            pendingRequests.delete(cacheKey);
        }
    })();

    pendingRequests.set(cacheKey, request);
    return request;
}

/**
 * 批量预取多个源文件的 base peaks
 */
export function prefetchBasePeaks(
    sources: Array<{ path: string; durationSec: number }>,
): void {
    for (const { path, durationSec } of sources) {
        // 不等待，直接触发请求
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        getBasePeaks(path, durationSec);
    }
}

/**
 * 清除所有缓存
 */
export function clearAllCache(): void {
    memoryCache.clear();
    for (const key of ssKeySet) {
        sessionStorage.removeItem(key);
    }
    ssKeySet.clear();
}
