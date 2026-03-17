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
    /** 数据起始时间（秒） */
    startSec: number;
    /** 数据持续时间（秒） */
    durationSec: number;
    /** 缓存时间戳 */
    timestamp: number;
}

/** 全局缓存管理器 */
class MipmapCacheManager {
    /** 缓存键 -> 峰值数据（缓存键格式：filePath|level|startSec|durationSec|columns） */
    private cache = new Map<string, PeaksData>();
    
    /** 正在进行的请求 */
    private pendingRequests = new Map<string, Promise<PeaksData | null>>();
    
    /** 最大缓存条目数 */
    private readonly MAX_ENTRIES = 256;

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
     * 
     * @param sourcePath 源文件路径
     * @param samplesPerPixel 每像素采样数（用于选择 mipmap 级别）
     * @param startSec 起始时间（秒）
     * @param durationSec 时长（秒，用于计算 columns，保持缓存键稳定）
     * @param targetWidthPx 目标显示宽度（像素，保留参数以兼容现有调用）
     */
    async getPeaks(
        sourcePath: string,
        samplesPerPixel: number,
        startSec: number,
        durationSec: number,
        _targetWidthPx: number,  // 保留参数以兼容现有调用，实际 columns 基于 durationSec 计算
    ): Promise<PeaksData | null> {
        const level = this.selectMipmapLevel(samplesPerPixel);
        
        // 基于音频时长计算 columns（保持缓存键稳定）
        // 与 useClipWaveformPeaks.ts 保持一致的计算方式
        const WAVEFORM_COLUMNS_PER_SEC = 1024;
        const QUANT = 32;
        const MIN_COLUMNS = 96;
        const MAX_COLUMNS = 65536;
        
        const secondsBasedColumns = durationSec * WAVEFORM_COLUMNS_PER_SEC;
        const columns = Math.max(
            MIN_COLUMNS,
            Math.min(MAX_COLUMNS, Math.round(secondsBasedColumns / QUANT) * QUANT)
        );
        
        return this.getPeaksAtLevel(sourcePath, level, startSec, durationSec, columns);
    }

    /**
     * 获取指定级别的峰值数据
     */
    async getPeaksAtLevel(
        filePath: string,
        level: number,
        startSec: number,
        durationSec: number,
        columns: number,
    ): Promise<PeaksData | null> {
        console.log(`[MipmapCache Debug] getPeaksAtLevel: filePath=${filePath}, level=${level}, startSec=${startSec}, durationSec=${durationSec}, columns=${columns}`);
        
        // 构建完整缓存键（包含时间范围和列数）
        const cacheKey = `${filePath}|${level}|${startSec.toFixed(3)}|${durationSec.toFixed(3)}|${columns}`;
        
        // 检查缓存
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return cached;
        }

        // 检查正在进行的请求
        const pending = this.pendingRequests.get(cacheKey);
        if (pending) {
            return pending;
        }

        // 发起新请求
        const request = this.fetchPeaks(filePath, level as MipmapLevel, startSec, durationSec, columns);
        this.pendingRequests.set(cacheKey, request);

        try {
            const data = await request;
            if (data) {
                this.addToCache(cacheKey, data);
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
        startSec: number,
        durationSec: number,
        columns: number,
    ): Promise<PeaksData | null> {
        try {
            const response = await waveformApi.getWaveformPeaksV2Level(
                sourcePath,
                startSec,
                durationSec,
                columns,
                level,
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
                startSec: startSec,
                durationSec: durationSec,
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
    private addToCache(cacheKey: string, data: PeaksData): void {
        // LRU 淘汰
        this.evictIfNeeded();
        
        this.cache.set(cacheKey, data);
    }

    /**
     * LRU 淘汰
     */
    private evictIfNeeded(): void {
        if (this.cache.size < this.MAX_ENTRIES) {
            return;
        }

        // 找到最旧的条目（基于 timestamp）
        let oldestKey: string | null = null;
        let oldestTime = Infinity;

        for (const [key, data] of this.cache) {
            if (data.timestamp < oldestTime) {
                oldestTime = data.timestamp;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.cache.delete(oldestKey);
        }
    }

    /**
     * 预加载所有 mipmap 级别（可选优化）
     * 
     * @param sourcePath 源文件路径
     * @param startSec 起始时间（秒）
     * @param durationSec 时长（秒）
     * @param columns 采样列数
     */
    async preloadAllLevels(sourcePath: string, startSec: number, durationSec: number, columns: number): Promise<void> {
        const levels: MipmapLevel[] = [0, 1, 2, 3];
        
        // 并行加载所有级别
        await Promise.all(
            levels.map((level) => this.getPeaksAtLevel(sourcePath, level, startSec, durationSec, columns))
        );
    }

    /**
     * 清除指定文件的缓存
     */
    invalidateFile(sourcePath: string): void {
        // 删除所有以 sourcePath 开头的缓存条目
        for (const key of this.cache.keys()) {
            if (key.startsWith(sourcePath)) {
                this.cache.delete(key);
            }
        }
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
        entries: number;
        estimatedMemory: number;
    } {
        let estimatedMemory = 0;

        for (const [, data] of this.cache) {
            // 每个采样点估算 8 bytes (min + max as float32)
            estimatedMemory += (data.min.length + data.max.length) * 4;
        }

        return {
            entries: this.cache.size,
            estimatedMemory,
        };
    }

    async loadMipmapFile(filePath: string, level: number, startSec: number = 0, durationSec: number = 0, columns: number = 1024) {
        const cacheKey = `${filePath}|${level}|${startSec.toFixed(3)}|${durationSec.toFixed(3)}|${columns}`;
        console.log(`[MipmapCache Debug] Loading mipmap: filePath=${filePath}, level=${level}, startSec=${startSec}, durationSec=${durationSec}, columns=${columns}`);
        
        // 检查缓存
        const cached = this.cache.get(cacheKey);
        if (cached) {
            console.log(`[MipmapCache Debug] Successfully loaded mipmap from cache: filePath=${filePath}, level=${level}, dataLength=${cached.min.length}`);
            return cached;
        }

        // 检查正在进行的请求
        const pending = this.pendingRequests.get(cacheKey);
        if (pending) {
            return pending;
        }

        // 发起新请求
        const request = this.fetchPeaks(filePath, level as MipmapLevel, startSec, durationSec, columns);
        this.pendingRequests.set(cacheKey, request);

        try {
            const data = await request;
            if (data) {
                this.addToCache(cacheKey, data);
                console.log(`[MipmapCache Debug] Successfully loaded mipmap: filePath=${filePath}, level=${level}, dataLength=${data.min.length}`);
            }
            return data;
        } catch {
            console.error(`[MipmapCache Debug] Failed to load mipmap: filePath=${filePath}, level=${level}`);
            return null;
        } finally {
            this.pendingRequests.delete(cacheKey);
        }
    }
}

/** 全局单例 */
export const mipmapCache = new MipmapCacheManager();

/** React Hook：获取峰值数据 */
export function useMipmapPeaks(
    sourcePath: string | undefined,
    samplesPerPixel: number,
    startSec: number,
    durationSec: number,
    targetWidthPx: number,
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
            .getPeaks(sourcePath, samplesPerPixel, startSec, durationSec, targetWidthPx)
            .then((data) => {
                if (requestId !== requestIdRef.current) return;
                setState({ data, loading: false, error: null });
            })
            .catch((error) => {
                if (requestId !== requestIdRef.current) return;
                setState({ data: null, loading: false, error });
            });
    }, [sourcePath, samplesPerPixel, startSec, durationSec, targetWidthPx]);

    return state;
}

// 需要 React 导入
import React from "react";
