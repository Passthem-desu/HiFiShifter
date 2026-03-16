/**
 * HFSPeaks v2 Mipmap 缓存管理器
 * 
 * 实现类似 Reaper 的多级分辨率峰值缓存
 */

import { waveformApi } from "../services/api/waveform";
import type { MipmapLevel } from "../types/api";

/** 峰值数据结构 */
export interface PeaksData {
    min: number[];
    max: number[];
    sampleRate: number;
    divisionFactor: number;
    mipmapLevel: number;
    /** 缓存时间戳 */
    timestamp: number;
}

/** 单个文件的 mipmap 缓存 */
interface FileMipmapCache {
    /** 各级 mipmap 数据 */
    levels: Map<number, PeaksData>;
    /** 元数据 */
    meta?: {
        sampleRate: number;
        channels: number;
        totalFrames: number;
    };
    /** 最后访问时间 */
    lastAccess: number;
}

/** 全局缓存管理器 */
class MipmapCacheManager {
    /** 文件路径 -> mipmap 缓存 */
    private cache = new Map<string, FileMipmapCache>();
    
    /** 正在进行的请求 */
    private pendingRequests = new Map<string, Promise<PeaksData | null>>();
    
    /** 最大缓存文件数 */
    private readonly MAX_FILES = 32;

    /**
     * 根据 samplesPerPixel 选择最佳 mipmap 级别
     * 
     * 判断逻辑：
     * - Level 0 (div ~128):   samplesPerPixel < 256    放大显示
     * - Level 1 (div ~512):   samplesPerPixel < 1024   中等缩放
     * - Level 2 (div ~2048):  samplesPerPixel < 4096   小缩放
     * - Level 3 (div ~8192):  samplesPerPixel >= 4096  全景视图
     */
    selectMipmapLevel(samplesPerPixel: number): MipmapLevel {
        if (samplesPerPixel < 256) return 0;
        if (samplesPerPixel < 1024) return 1;
        if (samplesPerPixel < 4096) return 2;
        return 3;
    }

    /**
     * 获取峰值数据（自动选择 mipmap 级别）
     */
    async getPeaks(
        sourcePath: string,
        samplesPerPixel: number,
        timeRangeStart?: number,
        timeRangeEnd?: number,
    ): Promise<PeaksData | null> {
        const level = this.selectMipmapLevel(samplesPerPixel);
        return this.getPeaksAtLevel(sourcePath, level, timeRangeStart, timeRangeEnd);
    }

    /**
     * 获取指定级别的峰值数据
     */
    async getPeaksAtLevel(
        sourcePath: string,
        level: MipmapLevel,
        timeRangeStart?: number,
        timeRangeEnd?: number,
    ): Promise<PeaksData | null> {
        // 检查缓存
        const fileCache = this.cache.get(sourcePath);
        if (fileCache) {
            const cached = fileCache.levels.get(level);
            if (cached) {
                fileCache.lastAccess = performance.now();
                return cached;
            }
        }

        // 检查正在进行的请求
        const cacheKey = `${sourcePath}|${level}|${timeRangeStart ?? 0}|${timeRangeEnd ?? 0}`;
        const pending = this.pendingRequests.get(cacheKey);
        if (pending) {
            return pending;
        }

        // 发起新请求
        const request = this.fetchPeaks(sourcePath, level, timeRangeStart, timeRangeEnd);
        this.pendingRequests.set(cacheKey, request);

        try {
            const data = await request;
            if (data) {
                this.addToCache(sourcePath, level, data);
            }
            return data;
        } finally {
            this.pendingRequests.delete(cacheKey);
        }
    }

    /**
     * 从后端获取峰值数据
     */
    private async fetchPeaks(
        sourcePath: string,
        level: MipmapLevel,
        timeRangeStart?: number,
        timeRangeEnd?: number,
    ): Promise<PeaksData | null> {
        try {
            const response = await waveformApi.getWaveformPeaksV2Level(
                sourcePath,
                level,
                timeRangeStart,
                timeRangeEnd,
            );

            if (!response || !response.ok) {
                return null;
            }

            return {
                min: response.min.map((v) => Number(v) || 0),
                max: response.max.map((v) => Number(v) || 0),
                sampleRate: response.sample_rate,
                divisionFactor: response.division_factor,
                mipmapLevel: response.mipmap_level,
                timestamp: performance.now(),
            };
        } catch (error) {
            console.error("Failed to fetch peaks:", { sourcePath, level, error });
            return null;
        }
    }

    /**
     * 添加到缓存
     */
    private addToCache(sourcePath: string, level: number, data: PeaksData): void {
        let fileCache = this.cache.get(sourcePath);
        if (!fileCache) {
            // LRU 淘汰
            this.evictIfNeeded();
            
            fileCache = {
                levels: new Map(),
                lastAccess: performance.now(),
            };
            this.cache.set(sourcePath, fileCache);
        }

        fileCache.levels.set(level, data);
        fileCache.lastAccess = performance.now();
    }

    /**
     * LRU 淘汰
     */
    private evictIfNeeded(): void {
        if (this.cache.size < this.MAX_FILES) {
            return;
        }

        // 找到最久未访问的文件
        let oldest: string | null = null;
        let oldestTime = Infinity;

        for (const [path, cache] of this.cache) {
            if (cache.lastAccess < oldestTime) {
                oldestTime = cache.lastAccess;
                oldest = path;
            }
        }

        if (oldest) {
            this.cache.delete(oldest);
        }
    }

    /**
     * 预加载所有 mipmap 级别（可选优化）
     */
    async preloadAllLevels(sourcePath: string): Promise<void> {
        const levels: MipmapLevel[] = [0, 1, 2, 3];
        
        // 并行加载所有级别
        await Promise.all(
            levels.map((level) => this.getPeaksAtLevel(sourcePath, level))
        );
    }

    /**
     * 清除指定文件的缓存
     */
    invalidateFile(sourcePath: string): void {
        this.cache.delete(sourcePath);
    }

    /**
     * 清除所有缓存
     */
    clear(): void {
        this.cache.clear();
        this.pendingRequests.clear();
    }

    /**
     * 获取缓存统计
     */
    getStats(): {
        files: number;
        totalLevels: number;
        estimatedMemory: number;
    } {
        let totalLevels = 0;
        let estimatedMemory = 0;

        for (const [, fileCache] of this.cache) {
            totalLevels += fileCache.levels.size;
            for (const [, data] of fileCache.levels) {
                // 每个采样点估算 8 bytes (min + max as float32)
                estimatedMemory += (data.min.length + data.max.length) * 4;
            }
        }

        return {
            files: this.cache.size,
            totalLevels,
            estimatedMemory,
        };
    }
}

/** 全局单例 */
export const mipmapCache = new MipmapCacheManager();

/** React Hook：获取峰值数据 */
export function useMipmapPeaks(
    sourcePath: string | undefined,
    samplesPerPixel: number,
    timeRangeStart?: number,
    timeRangeEnd?: number,
): {
    data: PeaksData | null;
    loading: boolean;
    error: Error | null;
} {
    const [state, setState] = React.useState<{
        data: PeaksData | null;
        loading: boolean;
        error: Error | null;
    }>({
        data: null,
        loading: false,
        error: null,
    });

    const requestIdRef = React.useRef(0);

    React.useEffect(() => {
        if (!sourcePath) {
            setState({ data: null, loading: false, error: null });
            return;
        }

        const requestId = ++requestIdRef.current;
        setState((prev) => ({ ...prev, loading: true }));

        mipmapCache
            .getPeaks(sourcePath, samplesPerPixel, timeRangeStart, timeRangeEnd)
            .then((data) => {
                if (requestId !== requestIdRef.current) return;
                setState({ data, loading: false, error: null });
            })
            .catch((error) => {
                if (requestId !== requestIdRef.current) return;
                setState({ data: null, loading: false, error });
            });
    }, [sourcePath, samplesPerPixel, timeRangeStart, timeRangeEnd]);

    return state;
}

// 需要 React 导入
import React from "react";
