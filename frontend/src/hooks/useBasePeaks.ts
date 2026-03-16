/**
 * useBasePeaks - 获取源文件的 base peaks 数据
 *
 * 特点：
 * 1. 使用 BasePeaksManager 缓存，多 clip 共享
 * 2. 自动去重请求
 * 3. 支持 preview 模式（拖动时使用已有数据）
 */

import React from "react";
import { getBasePeaks, type BasePeaksCache } from "../utils/basePeaksManager";

export interface UseBasePeaksResult {
    /** 是否正在加载 */
    loading: boolean;
    /** base peaks 数据 */
    peaks: BasePeaksCache | null;
    /** 是否为预览数据（使用上一次的结果） */
    isPreview: boolean;
}

/**
 * 获取源文件的 base peaks
 */
export function useBasePeaks(
    sourcePath: string | undefined,
    durationSec: number | undefined,
): UseBasePeaksResult {
    const [state, setState] = React.useState<UseBasePeaksResult>({
        loading: false,
        peaks: null,
        isPreview: false,
    });

    // 缓存上一次成功的结果，用于预览
    const lastPeaksRef = React.useRef<BasePeaksCache | null>(null);
    const requestIdRef = React.useRef(0);

    React.useEffect(() => {
        if (!sourcePath || !durationSec || durationSec <= 0) {
            setState({ loading: false, peaks: null, isPreview: false });
            lastPeaksRef.current = null;
            return;
        }

        const requestId = ++requestIdRef.current;

        // 立即设置加载状态，如果有上次的数据则作为预览
        setState((prev) => ({
            loading: true,
            peaks: lastPeaksRef.current || prev.peaks,
            isPreview: lastPeaksRef.current !== null,
        }));

        // 请求 base peaks
        getBasePeaks(sourcePath, durationSec).then((peaks) => {
            if (requestId !== requestIdRef.current) return;

            if (peaks) {
                lastPeaksRef.current = peaks;
                setState({
                    loading: false,
                    peaks,
                    isPreview: false,
                });
            } else {
                setState((prev) => ({
                    loading: false,
                    peaks: prev.peaks,
                    isPreview: false,
                }));
            }
        });
    }, [sourcePath, durationSec]);

    return state;
}
