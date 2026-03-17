/**
 * HFSPeaks v2 Mipmap 缓存管理器
 * 
 * 实现类似 Reaper 的多级分辨率峰值缓存。
 * 
 * Level 编号与后端 hfspeaks_v2.rs 对齐：
 *   Level 0 → division_factor=256   → 高精度/特写  （区块 5s）
 *   Level 1 → division_factor=1024  → 中等缩放      （区块 10s）
 *   Level 2 → division_factor=4096  → 小缩放        （区块 30s）
 *   Level 3 → division_factor=16384 → 远景/全景      （区块 60s）
 * 
 * 核心特性：
 * - 四级固定区间缓存：每个级别使用固定的区块时长
 * - 时间参数量化：避免高精度时间参数导致的缓存抖动
 * - LRU淘汰策略：基于访问时间淘汰不常用的缓存块
 * - 时间轴预加载：预加载相邻时间区间，优化平移体验
 * - 跨区块合并：自动拼接可视区覆盖的多个缓存区块
 */

import { waveformApi } from "../services/api/waveform";
import type { MipmapLevel } from "../types/api";

// ============================================
// 类型定义
// ============================================

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
    /** 最后访问时间（用于LRU） */
    lastAccessTime: number;
}

/** 缓存级别配置 */
interface CacheLevelConfig {
    /** 区块时长（秒） */
    blockDuration: number;
    /** samplesPerPixel 阈值 */
    samplesPerPixelThreshold: number;
    /** 描述 */
    description: string;
}

/** 预加载任务 */
interface PreloadTask {
    sourcePath: string;
    level: MipmapLevel;
    blockIndex: number;
    priority: number; // 越小优先级越高
}

// ============================================
// 常量配置
// ============================================

/** 时间量化步长（秒） */
const TIME_QUANT_STEP = 0.5;

/**
 * 后端 DEFAULT_DIVISION_FACTORS，与 hfspeaks_v2.rs 保持一致。
 * Level 索引 → division_factor 一一对应。
 */
const DIVISION_FACTORS: readonly number[] = [256, 1024, 4096, 16384];

/**
 * 四级缓存配置（与后端 Level 索引对齐：L0=高精度 → L3=远景）
 */
const CACHE_LEVEL_CONFIGS: Record<MipmapLevel, CacheLevelConfig> = {
    0: { blockDuration: 5,  samplesPerPixelThreshold: 0,    description: "特写 (div=256)" },
    1: { blockDuration: 10, samplesPerPixelThreshold: 512,  description: "近景 (div=1024)" },
    2: { blockDuration: 30, samplesPerPixelThreshold: 2048, description: "中景 (div=4096)" },
    3: { blockDuration: 60, samplesPerPixelThreshold: 8192, description: "远景 (div=16384)" },
};

/** 最大缓存条目数 */
const MAX_CACHE_ENTRIES = 256;

/** 预加载队列最大长度 */
const MAX_PRELOAD_QUEUE = 10;

/** 波形列数计算常量（精度再减半：512→256，进一步降低数据量提升性能） */
const WAVEFORM_COLUMNS_PER_SEC = 256;
const COLUMNS_QUANT = 32;
const MIN_COLUMNS = 96;
const MAX_COLUMNS = 65536;

// ============================================
// 工具函数
// ============================================

/**
 * 量化时间值
 * 将时间值对齐到固定步长的整数倍
 */
function quantizeTime(timeSec: number, stepSec: number = TIME_QUANT_STEP): number {
    return Math.floor(timeSec / stepSec) * stepSec;
}

/**
 * 计算时间点所在的区块索引
 */
function getBlockIndex(timeSec: number, blockDuration: number): number {
    return Math.floor(quantizeTime(timeSec) / blockDuration);
}

/**
 * 根据区块索引计算区块起始时间
 */
function getBlockStartTime(blockIndex: number, blockDuration: number): number {
    return blockIndex * blockDuration;
}

/**
 * 计算波形列数
 */
function calculateColumns(durationSec: number): number {
    const secondsBasedColumns = durationSec * WAVEFORM_COLUMNS_PER_SEC;
    return Math.max(
        MIN_COLUMNS,
        Math.min(MAX_COLUMNS, Math.round(secondsBasedColumns / COLUMNS_QUANT) * COLUMNS_QUANT)
    );
}

// ============================================
// 缓存管理器
// ============================================

/**
 * 全局缓存管理器
 * 
 * 实现分级固定区间缓存，每个级别使用固定的区块时长，
 * 通过量化时间参数减少缓存键数量，提高缓存复用率。
 */
class MipmapCacheManager {
    /** 缓存键 -> 峰值数据 */
    private cache = new Map<string, PeaksData>();
    
    /** 正在进行的请求 */
    private pendingRequests = new Map<string, Promise<PeaksData | null>>();
    
    /** 预加载队列 */
    private preloadQueue: PreloadTask[] = [];
    
    /** 预加载是否正在进行 */
    private isPreloading = false;

    /**
     * 根据 samplesPerPixel 选择最佳 mipmap 级别
     * 
     * 使用与后端 select_mipmap_level 相同的"最近匹配"算法：
     *   target = samplesPerPixel * 2
     *   找 DIVISION_FACTORS 中与 target 绝对差最小的级别索引
     * 
     * 结果：
     * - Level 0 (div=128,  特写): samplesPerPixel 较小
     * - Level 3 (div=8192, 远景): samplesPerPixel 较大
     */
    selectMipmapLevel(samplesPerPixel: number): MipmapLevel {
        const target = samplesPerPixel * 2;
        let bestIdx = 0;
        let bestDiff = Infinity;
        for (let i = 0; i < DIVISION_FACTORS.length; i++) {
            const diff = Math.abs(DIVISION_FACTORS[i] - target);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestIdx = i;
            }
        }
        return bestIdx as MipmapLevel;
    }

    /**
     * 获取峰值数据（自动选择 mipmap 级别，支持跨区块合并）
     * 
     * 当可视区跨越多个缓存区块时，会并行请求所有覆盖区块并合并数据。
     * 
     * @param sourcePath 源文件路径
     * @param samplesPerPixel 每像素采样数（用于选择 mipmap 级别）
     * @param startSec 起始时间（秒）
     * @param durationSec 时长（秒）
     * @param _targetWidthPx 目标显示宽度（保留参数以兼容现有调用）
     */
    async getPeaks(
        sourcePath: string,
        samplesPerPixel: number,
        startSec: number,
        durationSec: number,
        _targetWidthPx: number,
    ): Promise<PeaksData | null> {
        const level = this.selectMipmapLevel(samplesPerPixel);
        const config = CACHE_LEVEL_CONFIGS[level];
        
        // 计算可视区覆盖的所有区块
        const startBlock = getBlockIndex(startSec, config.blockDuration);
        const endBlock = getBlockIndex(startSec + durationSec, config.blockDuration);
        
        // 预加载首尾外侧相邻区块
        this.schedulePreload(sourcePath, level, startBlock);
        if (endBlock !== startBlock) {
            this.schedulePreload(sourcePath, level, endBlock);
        }
        
        // 单区块快速路径
        if (startBlock === endBlock) {
            return this.getBlockData(sourcePath, level, startBlock);
        }
        
        // 多区块：并行请求所有覆盖区块
        const promises: Promise<PeaksData | null>[] = [];
        for (let i = startBlock; i <= endBlock; i++) {
            promises.push(this.getBlockData(sourcePath, level, i));
        }
        const blocks = await Promise.all(promises);
        
        // 合并多区块数据
        return this.mergeBlocks(blocks, startSec, durationSec);
    }
    
    /**
     * 合并多个区块的峰值数据
     * 
     * 将多个区块的 min/max 数组顺序拼接，
     * 并更新 startSec / durationSec 为合并后的完整范围。
     */
    private mergeBlocks(blocks: (PeaksData | null)[], _startSec: number, _durationSec: number): PeaksData | null {
        const validBlocks = blocks.filter((b): b is PeaksData => b !== null);
        if (validBlocks.length === 0) return null;
        if (validBlocks.length === 1) return validBlocks[0];
        
        // 按 startSec 排序（保证顺序正确）
        validBlocks.sort((a, b) => a.startSec - b.startSec);
        
        const mergedMin: number[] = [];
        const mergedMax: number[] = [];
        
        for (const block of validBlocks) {
            mergedMin.push(...block.min);
            mergedMax.push(...block.max);
        }
        
        const now = performance.now();
        const mergedStartSec = validBlocks[0].startSec;
        const lastBlock = validBlocks[validBlocks.length - 1];
        const mergedEndSec = lastBlock.startSec + lastBlock.durationSec;
        
        return {
            min: mergedMin,
            max: mergedMax,
            sampleRate: validBlocks[0].sampleRate,
            divisionFactor: validBlocks[0].divisionFactor,
            mipmapLevel: validBlocks[0].mipmapLevel,
            startSec: mergedStartSec,
            durationSec: mergedEndSec - mergedStartSec,
            timestamp: now,
            lastAccessTime: now,
        };
    }

    /**
     * 获取指定区块的数据
     * 
     * 这是核心的缓存获取方法，使用固定区块时长构建稳定的缓存键
     */
    private async getBlockData(
        sourcePath: string,
        level: MipmapLevel,
        blockIndex: number,
    ): Promise<PeaksData | null> {
        const config = CACHE_LEVEL_CONFIGS[level];
        const startTime = getBlockStartTime(blockIndex, config.blockDuration);
        const columns = calculateColumns(config.blockDuration);
        
        // 构建稳定的缓存键（使用区块索引而非精确时间）
        const cacheKey = `${sourcePath}|L${level}|B${blockIndex}`;
        
        console.log(`[MipmapCache] getBlockData: level=${level}, block=${blockIndex}, start=${startTime}s, duration=${config.blockDuration}s`);
        
        // 检查缓存
        const cached = this.cache.get(cacheKey);
        if (cached) {
            // 更新访问时间（用于LRU）
            cached.lastAccessTime = performance.now();
            return cached;
        }

        // 检查正在进行的请求
        const pending = this.pendingRequests.get(cacheKey);
        if (pending) {
            return pending;
        }

        // 发起新请求
        const request = this.fetchPeaks(sourcePath, level, startTime, config.blockDuration, columns);
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

            const now = performance.now();
            return {
                min: response.min.map((v) => Number(v) || 0),
                max: response.max.map((v) => Number(v) || 0),
                sampleRate: response.sample_rate,
                divisionFactor: response.division_factor,
                mipmapLevel: response.mipmap_level,
                startSec: response.actual_start_sec,
                durationSec: response.actual_duration_sec,
                timestamp: now,
                lastAccessTime: now,
            };
        } catch (error) {
            console.error("[MipmapCache] Failed to fetch peaks:", { sourcePath, level, error });
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
     * LRU 淘汰策略
     * 基于 lastAccessTime 淘汰最久未访问的缓存块
     */
    private evictIfNeeded(): void {
        if (this.cache.size < MAX_CACHE_ENTRIES) {
            return;
        }

        // 找到最久未访问的条目
        let oldestKey: string | null = null;
        let oldestTime = Infinity;

        for (const [key, data] of this.cache) {
            if (data.lastAccessTime < oldestTime) {
                oldestTime = data.lastAccessTime;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            this.cache.delete(oldestKey);
            console.log(`[MipmapCache] LRU evicted: ${oldestKey}`);
        }
    }

    /**
     * 调度预加载任务
     * 预加载当前区块前后各一个区块
     */
    private schedulePreload(sourcePath: string, level: MipmapLevel, currentBlockIndex: number): void {
        // 添加前后区块到预加载队列
        const preloadIndices = [currentBlockIndex - 1, currentBlockIndex + 1];
        
        for (let i = 0; i < preloadIndices.length; i++) {
            const blockIndex = preloadIndices[i];
            if (blockIndex < 0) continue;
            
            // 检查是否已在缓存或队列中
            const cacheKey = `${sourcePath}|L${level}|B${blockIndex}`;
            if (this.cache.has(cacheKey)) continue;
            if (this.preloadQueue.some(t => t.sourcePath === sourcePath && t.level === level && t.blockIndex === blockIndex)) continue;
            
            // 添加到队列（优先级：距离当前区块越近优先级越高）
            this.preloadQueue.push({
                sourcePath,
                level,
                blockIndex,
                priority: i + 1,
            });
        }
        
        // 限制队列长度
        if (this.preloadQueue.length > MAX_PRELOAD_QUEUE) {
            this.preloadQueue.sort((a, b) => a.priority - b.priority);
            this.preloadQueue = this.preloadQueue.slice(0, MAX_PRELOAD_QUEUE);
        }
        
        // 触发预加载
        this.processPreloadQueue();
    }

    /**
     * 处理预加载队列
     */
    private async processPreloadQueue(): Promise<void> {
        if (this.isPreloading || this.preloadQueue.length === 0) {
            return;
        }
        
        this.isPreloading = true;
        
        while (this.preloadQueue.length > 0) {
            const task = this.preloadQueue.shift();
            if (!task) break;
            
            // 检查是否已缓存
            const cacheKey = `${task.sourcePath}|L${task.level}|B${task.blockIndex}`;
            if (this.cache.has(cacheKey)) continue;
            
            // 执行预加载
            try {
                await this.getBlockData(task.sourcePath, task.level, task.blockIndex);
            } catch {
                // 预加载失败不处理
            }
        }
        
        this.isPreloading = false;
    }

    /**
     * 预加载所有 mipmap 级别（可选优化）
     * 
     * @param sourcePath 源文件路径
     * @param startSec 起始时间（秒）
     * @param durationSec 时长（秒）
     * @param columns 采样列数（保留参数）
     */
    async preloadAllLevels(sourcePath: string, startSec: number, _durationSec: number, _columns: number): Promise<void> {
        const levels: MipmapLevel[] = [0, 1, 2, 3];
        
        // 对于每个级别，预加载起始区块
        await Promise.all(
            levels.map((level) => {
                const config = CACHE_LEVEL_CONFIGS[level];
                const blockIndex = getBlockIndex(startSec, config.blockDuration);
                return this.getBlockData(sourcePath, level, blockIndex);
            })
        );
    }

    /**
     * 清除指定文件的缓存
     */
    invalidateFile(sourcePath: string): void {
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
        this.preloadQueue = [];
    }

    /**
     * 获取缓存统计
     */
    getStats(): {
        entries: number;
        estimatedMemory: number;
        preloadQueue: number;
    } {
        let estimatedMemory = 0;

        for (const [, data] of this.cache) {
            estimatedMemory += (data.min.length + data.max.length) * 4;
        }

        return {
            entries: this.cache.size,
            estimatedMemory,
            preloadQueue: this.preloadQueue.length,
        };
    }

    /**
     * 获取级别配置（用于调试）
     */
    getLevelConfig(level: MipmapLevel): CacheLevelConfig {
        return CACHE_LEVEL_CONFIGS[level];
    }
}

/** 全局单例 */
export const mipmapCache = new MipmapCacheManager();

// ============================================
// React Hook
// ============================================

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
