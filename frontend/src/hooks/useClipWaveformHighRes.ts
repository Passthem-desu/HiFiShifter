/**
 * useClipWaveformHighRes - 高精度波形数据 hook
 *
 * 特点：
 * 1. 使用 BasePeaksManager 缓存源文件级别的 base peaks
 * 2. 直接使用后端数据，不再前端降采样（后端 hop=64 提供足够精度）
 * 3. 支持音量增益和淡入淡出曲线应用
 * 4. 高性能：多 clip 共享同一源文件时复用缓存
 */

import React from "react";
import { getBasePeaks, type BasePeaksCache } from "../utils/basePeaksManager";
import {
    applyGainsToPeaks,
    type HighResRenderParams,
} from "../utils/waveformRenderer";
import type { ClipInfo } from "../features/session/sessionTypes";
import type { FadeCurveType } from "../components/layout/timeline/paths";

export interface HighResWaveformResult {
    /** 是否正在加载 */
    loading: boolean;
    /** 处理后的波形数据 [min0, max0, min1, max1, ...] */
    peaks: Float32Array | null;
    /** 是否为预览数据 */
    isPreview: boolean;
    /** 渲染参数 */
    renderParams: HighResRenderParams | null;
}

/**
 * 高精度波形数据 hook
 */
export function useClipWaveformHighRes(
    clip: ClipInfo,
    canvasWidth: number,
    canvasHeight: number,
): HighResWaveformResult {
    const [state, setState] = React.useState<HighResWaveformResult>({
        loading: false,
        peaks: null,
        isPreview: false,
        renderParams: null,
    });

    const basePeaksRef = React.useRef<BasePeaksCache | null>(null);
    const requestIdRef = React.useRef(0);

    // 获取源文件信息
    const sourcePath = clip.sourcePath;
    const sourceDurationSec = clip.durationSec ?? 0;
    const playbackRate = clip.playbackRate ?? 1;
    const volumeGain = clip.gain ?? 1;
    const fadeInSec = clip.fadeInSec ?? 0;
    const fadeOutSec = clip.fadeOutSec ?? 0;
    const fadeInCurve: FadeCurveType = (clip.fadeInCurve as FadeCurveType) ?? "sine";
    const fadeOutCurve: FadeCurveType = (clip.fadeOutCurve as FadeCurveType) ?? "sine";

    // 计算渲染参数
    const renderParams: HighResRenderParams = React.useMemo(() => ({
        canvasWidth,
        canvasHeight,
        centerY: canvasHeight / 2,
        sourceStartSec: Math.max(0, clip.sourceStartSec ?? 0),
        clipDuration: clip.lengthSec ?? 0,
        playbackRate,
        sourceDurationSec,
        volumeGain,
        fadeInSec,
        fadeOutSec,
        fadeInCurve,
        fadeOutCurve,
    }), [
        canvasWidth,
        canvasHeight,
        clip.sourceStartSec,
        clip.lengthSec,
        playbackRate,
        sourceDurationSec,
        volumeGain,
        fadeInSec,
        fadeOutSec,
        fadeInCurve,
        fadeOutCurve,
    ]);

    // 获取 base peaks
    React.useEffect(() => {
        if (!sourcePath || sourceDurationSec <= 0 || canvasWidth <= 0) {
            setState({
                loading: false,
                peaks: null,
                isPreview: false,
                renderParams: null,
            });
            basePeaksRef.current = null;
            return;
        }

        const requestId = ++requestIdRef.current;

        // 立即设置加载状态
        setState((prev) => ({
            loading: true,
            peaks: prev.peaks,
            isPreview: prev.peaks !== null,
            renderParams,
        }));

        // 请求 base peaks
        getBasePeaks(sourcePath, sourceDurationSec).then((peaks) => {
            if (requestId !== requestIdRef.current) return;

            if (peaks) {
                basePeaksRef.current = peaks;

                // 直接应用增益（不再降采样，后端 hop=64 已提供足够精度）
                const withGains = applyGainsToPeaks(peaks.peaks, renderParams);

                setState({
                    loading: false,
                    peaks: withGains,
                    isPreview: false,
                    renderParams,
                });
            } else {
                setState((prev) => ({
                    loading: false,
                    peaks: prev.peaks,
                    isPreview: false,
                    renderParams,
                }));
            }
        });
    }, [
        sourcePath,
        sourceDurationSec,
        canvasWidth,
        renderParams,
    ]);

    // 当增益参数变化时，重新应用增益（不需要重新获取 base peaks）
    React.useEffect(() => {
        if (!basePeaksRef.current) return;

        // 直接应用增益（不再降采样）
        const withGains = applyGainsToPeaks(basePeaksRef.current.peaks, renderParams);

        setState((prev) => ({
            ...prev,
            peaks: withGains,
            renderParams,
        }));
    }, [
        volumeGain,
        fadeInSec,
        fadeOutSec,
        fadeInCurve,
        fadeOutCurve,
        renderParams,
    ]);

    return state;
}
