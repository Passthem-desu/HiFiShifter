/**
 * WaveSurferWaveform.tsx
 *
 * 使用 wavesurfer.js 渲染波形（渲染层替换）；保留后端播放与时间线控制。
 * 使用 wavesurfer 渲染；不再回退到 `WaveformCanvas`，初始化失败时渲染空容器。
 *
 * 设计原则：最小入侵 — 使用现有的 `mipmapCache` 与后端 HFSPeaks v2 接口获取峰值，
 * 对接 `applyGainsToPeaks` 以保持增益/淡入淡出一致性，然后把处理后的峰值传给 wavesurfer。
 */

import React from "react";
import type { WaveformCanvasProps } from "./WaveformCanvas";
import { fetchWaveSurferPeaksFromV2 } from "../../utils/waveformWavesurfer";
// Note: we will convert min/max to a simple mono channel array for WaveSurfer
import WaveSurfer from "wavesurfer.js";

type Props = WaveformCanvasProps & {
    // 未来可扩展额外配置
};

export default function WaveSurferWaveform(props: Props) {
    const {
        targetWidthPx,
        heightPx,
        stroke = "currentColor",
        sourcePath,
        sourceDurationSec,
        sourceStartSec = 0,
        clipDurationSec,
        viewportStartSec,
        viewportEndSec,
        clipStartSec = 0,
    } = props;

    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const wsRef = React.useRef<any>(null);
    const requestIdRef = React.useRef(0);

    // 在组件挂载时初始化 WaveSurfer，一次性创建并在卸载时销毁。
    React.useEffect(() => {
        if (!containerRef.current) return;
        try {
            console.log(
                "[WaveSurferWaveform] creating WaveSurfer instance (mount)",
                containerRef.current,
            );
            wsRef.current = WaveSurfer.create({
                container: containerRef.current,
                waveColor: stroke,
                progressColor: stroke,
                cursorWidth: 0,
                height: heightPx,
                interact: false,
                normalize: false,
            });
            console.log(
                "[WaveSurferWaveform] WaveSurfer created (mount)",
                wsRef.current,
            );
        } catch (e) {
            console.error("[WaveSurferWaveform] init error (mount)", e);
            wsRef.current = null;
        }

        return () => {
            try {
                wsRef.current?.destroy();
            } catch (_) {
                /* ignore */
            }
            wsRef.current = null;
        };
    }, [stroke, heightPx]);

    // visibleInfo 复用 WaveformCanvas 的策略（简化版）
    const visibleInfo = React.useMemo(() => {
        const clipLen = clipDurationSec ?? 0;
        const clipStart = clipStartSec ?? 0;
        const clipEnd = clipStart + clipLen;
        const fullWidthPx = targetWidthPx;

        if (
            viewportStartSec === undefined ||
            viewportEndSec === undefined ||
            clipLen <= 0
        ) {
            return {
                visibleWidthPx: fullWidthPx,
                offsetPx: 0,
                visibleStartRatio: 0,
                visibleEndRatio: 1,
            };
        }

        const visStart = Math.max(clipStart, viewportStartSec - 2);
        const visEnd = Math.min(clipEnd, viewportEndSec + 2);
        if (visEnd <= visStart)
            return {
                visibleWidthPx: 0,
                offsetPx: 0,
                visibleStartRatio: 0,
                visibleEndRatio: 0,
            };

        const startRatio = (visStart - clipStart) / clipLen;
        const endRatio = (visEnd - clipStart) / clipLen;
        const offsetPx = Math.floor(startRatio * fullWidthPx);
        const visibleWidthPx = Math.max(
            1,
            Math.ceil(endRatio * fullWidthPx) - offsetPx,
        );

        return {
            visibleWidthPx,
            offsetPx,
            visibleStartRatio: startRatio,
            visibleEndRatio: endRatio,
        };
    }, [
        targetWidthPx,
        clipDurationSec,
        clipStartSec,
        viewportStartSec,
        viewportEndSec,
    ]);

    // （保留可视区参数，但不进行复杂裁剪计算）

    // ----------------------------
    // 方案：将渲染完全交给 wavesurfer
    // - 首先请求低分辨率的全局 peaks（mipmapCache）并设置到 WaveSurfer
    // - 当需要高精度（可视区缩小/放大）时，按需从后端拉取 level=0 的高分块并合并到全局 peaks
    // - 合并后重新计算带增益的 peaks，并调用 ws.setPeaks(...) 更新渲染
    // ----------------------------

    // 简化版：直接从后端请求 level=0 的峰值并设置到 WaveSurfer（不做本地优化或合并）
    React.useEffect(() => {
        if (!sourcePath) return;
        if (!sourceDurationSec || sourceDurationSec <= 0) return;

        const requestId = ++requestIdRef.current;
        let canceled = false;

        (async () => {
            try {
                const cols = Math.max(96, Math.round(targetWidthPx || 256));
                const res = await fetchWaveSurferPeaksFromV2(
                    sourcePath,
                    sourceStartSec ?? 0,
                    sourceDurationSec,
                    cols,
                    0,
                );

                if (canceled || requestId !== requestIdRef.current) return;
                if (!res) return;

                console.log(
                    "[WaveSurferWaveform] fetched peaks for WaveSurfer",
                    {
                        samples: (res.peaks[0] as Float32Array).length,
                        duration: res.duration,
                        preview: Array.from(
                            (res.peaks[0] as Float32Array).slice(0, 10),
                        ),
                    },
                );

                const ws = wsRef.current;
                if (ws) {
                    try {
                        console.log(
                            "[WaveSurferWaveform] loading peaks into WaveSurfer",
                            {
                                peaksLen: (res.peaks[0] as Float32Array).length,
                                duration: res.duration,
                            },
                        );
                        // Prefer calling `load('', peaks, duration)` which will create decodedData
                        // and let WaveSurfer's renderer render it. Fall back to setOptions + manual
                        // renderer.render when load is not available.
                        if (typeof ws.load === "function") {
                            await ws.load(
                                "",
                                res.peaks,
                                res.duration as number,
                            );
                            console.log(
                                "[WaveSurferWaveform] WaveSurfer.load completed and should be rendered",
                            );
                        } else if (typeof ws.setOptions === "function") {
                            ws.setOptions({
                                peaks: res.peaks,
                                duration: res.duration,
                            });
                            // try to trigger a render from decoded data
                            const decoded =
                                typeof ws.getDecodedData === "function"
                                    ? ws.getDecodedData()
                                    : ws.decodedData;
                            if (
                                decoded &&
                                ws.renderer &&
                                typeof ws.renderer.render === "function"
                            ) {
                                try {
                                    ws.renderer.render(decoded);
                                    console.log(
                                        "[WaveSurferWaveform] renderer.render invoked (fallback)",
                                    );
                                } catch (err) {
                                    console.warn(
                                        "[WaveSurferWaveform] renderer.render failed",
                                        err,
                                    );
                                }
                            }
                        } else {
                            console.warn(
                                "[WaveSurferWaveform] no compatible load/setOptions API on WaveSurfer instance",
                            );
                        }
                    } catch (e) {
                        console.error(
                            "[WaveSurferWaveform] failed to load peaks into WaveSurfer",
                            e,
                        );
                    }
                }
            } catch (e) {
                console.error(
                    "[WaveSurferWaveform] backend peaks fetch error",
                    e,
                );
            }
        })();

        return () => {
            canceled = true;
        };
    }, [
        sourcePath,
        sourceStartSec,
        sourceDurationSec,
        targetWidthPx,
        heightPx,
        stroke,
    ]);

    // 清理
    React.useEffect(() => {
        return () => {
            try {
                wsRef.current?.destroy();
            } catch (_) {}
            wsRef.current = null;
        };
    }, []);

    if (visibleInfo.visibleWidthPx <= 0) return null;

    // 始终渲染 wavesurfer 容器（不再回退到 WaveformCanvas）
    const containerStyle: React.CSSProperties = {
        position: "relative",
        width: targetWidthPx,
        height: heightPx,
        overflow: "hidden",
    };

    const innerStyle: React.CSSProperties = {
        position: "absolute",
        left: visibleInfo.offsetPx,
        top: 0,
        width: visibleInfo.visibleWidthPx,
        height: heightPx,
    };

    // 即使初始化失败也渲染容器（可能为空）；不再回退到 WaveformCanvas。

    return (
        <div style={containerStyle}>
            <div style={innerStyle}>
                <div
                    ref={containerRef}
                    style={{ width: "100%", height: "100%" }}
                />
            </div>
        </div>
    );
}
