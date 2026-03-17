/**
 * 波形峰值数据处理 Hook
 * 
 * 使用 mipmapCache（四级固定区间缓存）获取波形数据
 * 缓存特性：
 * - 四级固定区间：Level 0(60s) | Level 1(30s) | Level 2(10s) | Level 3(5s)
 * - 时间参数量化：0.5秒步长，减少缓存抖动
 * - LRU淘汰：基于访问时间淘汰不常用缓存
 * - 时间轴预加载：自动预加载相邻时间区间
 */
import React from "react";

import type { ClipInfo } from "../../../../features/session/sessionTypes";
import { mipmapCache } from "../../../../utils/mipmapCache";
import { clamp } from "../math";

export type PeaksRenderState = {
    ok: boolean;
    min: number[];
    max: number[];
    columns: number;
    // Base segment peaks used for preview remapping while new peaks are loading.
    segmentMin: number[];
    segmentMax: number[];
    segmentLenSec: number;
    segmentColumns: number;
    // Leading silence in CLIP domain (timeline sec).
    leadSilenceSec: number;
    isPreview?: boolean;
    // source 可用窗口在 timeline 域的长度（秒），用于固定波形 SVG 宽度
    cycleLenSecTimeline: number;
};

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function sampleSegmentMinMaxAtTime(
    segmentMin: number[],
    segmentMax: number[],
    segmentLenSec: number,
    sec: number,
): { min: number; max: number } {
    const srcN = Math.min(segmentMin.length, segmentMax.length);
    if (srcN <= 0) return { min: 0, max: 0 };
    if (srcN === 1) {
        const vMin = Number(segmentMin[0] ?? 0);
        const vMax = Number(segmentMax[0] ?? 0);
        return { min: vMin, max: vMax };
    }

    const len = Math.max(1e-9, Number(segmentLenSec) || 0);
    const t = clamp(sec / len, 0, 1);
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

const WAVEFORM_COLUMNS_PER_SEC = 256; // 精度再减半：512→256，进一步降低数据量提升性能
const WAVEFORM_COLUMNS_MIN = 96;
const WAVEFORM_COLUMNS_MAX = 65536;
const WAVEFORM_COLUMNS_QUANT = 32;
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
        widthPx: _widthPx,
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

        const sourceStartRaw = Number(clip.sourceStartSec ?? 0) || 0;
        const preSilenceSecSrc = Math.max(0, -sourceStartRaw);
        // peaks 覆盖整个 source 文件（startSec=0, segmentLenSec=durationSec），
        // 这样无论 trim_left 还是 trim_right 拖动，peaks 请求参数都完全稳定。
        const startSec = 0;
        const cycleLenSec = durationSec;
        if (cycleLenSec <= 1e-9) return null;

        const segmentLenSec = cycleLenSec;
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

        // Request columns by seconds density (columns per second), so longer clips
        // always carry proportionally more detail regardless viewport zoom.
        const secondsBasedColumns = durationSec * WAVEFORM_COLUMNS_PER_SEC;
        const rawColumns = clamp(
            Math.round(secondsBasedColumns),
            WAVEFORM_COLUMNS_MIN,
            WAVEFORM_COLUMNS_MAX,
        );
        const outColumns = clamp(
            Math.round(rawColumns / WAVEFORM_COLUMNS_QUANT) *
                WAVEFORM_COLUMNS_QUANT,
            WAVEFORM_COLUMNS_MIN,
            WAVEFORM_COLUMNS_MAX,
        );
        const segmentColumns = altPressed
            ? clamp(Math.round(outColumns / 4), 16, 2048)
            : outColumns;

        // 计算 samplesPerPixel 用于 mipmap 级别选择
        // 假设采样率为 44100 Hz（标准 CD 音质）
        const ASSUMED_SAMPLE_RATE = 44100;
        // 每秒像素数 = 显示宽度 / timeline 长度
        const pxPerSec = _widthPx / Math.max(1e-6, timelineLenSec);
        // samplesPerPixel = 采样率 / 每秒像素数
        const samplesPerPixel = Math.max(1, Math.round(ASSUMED_SAMPLE_RATE / pxPerSec));

        // 转换回 timeline 域（秒）
        const leadSilenceSec = preSilenceSecSrc / Math.max(1e-6, pr);
        const segmentLenSecTimeline = segmentLenSec / Math.max(1e-6, pr);
        // source 可用窗口在 timeline 域的长度（秒），用于固定波形 SVG 宽度
        const cycleLenSecTimeline = cycleLenSec / Math.max(1e-6, pr);

        return {
            sourcePath,
            startSec: startSecQ,
            durationSec: segmentLenSecQ,
            outColumns,
            segmentColumns,
            leadSilenceSec,
            segmentLenSecTimeline,
            cycleLenSecTimeline,
            // mipmap 相关参数
            samplesPerPixel,
            widthPx: _widthPx,
        };
    // 注意：不依赖 bpm，波形内容基于秒域计算，BPM 变化不影响波形显示
    }, [altPressed, clip, _widthPx]);

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
            leadSilenceSec,
            segmentLenSecTimeline,
            cycleLenSecTimeline,
        } = peaksRequest;

        const key = `${sourcePath}|${startSec.toFixed(3)}|${segSec.toFixed(3)}`;

        const buildOutput = (
            segMin: number[],
            segMax: number[],
            isPreview: boolean,
        ): PeaksRenderState => {
            const outCols = clamp(
                Math.floor(outColumns),
                WAVEFORM_COLUMNS_MIN,
                WAVEFORM_COLUMNS_MAX,
            );
            const segCols = Math.min(segMin.length, segMax.length);
            const segLen = Math.max(1e-9, Number(segmentLenSecTimeline) || 0);
            const denom = Math.max(1, outCols - 1);

            const outMin: number[] = new Array(outCols);
            const outMax: number[] = new Array(outCols);

            const lead = Math.max(0, Number(leadSilenceSec) || 0);
            // 使用当前请求的实际长度（segLen + lead），而非 clip.lengthSec。
            // clip.lengthSec 在 trim 拖动时持续变化，会导致 buildOutput 每次
            // 用不同的 clipLenBeats 重新映射波形，产生拉伸/压缩视觉效果。
            // 当前请求的 segLen + lead 是稳定的，与 peaks 数据一一对应。
            const clipLenBeats = Math.max(1e-9, segLen + lead);

            for (let i = 0; i < outCols; i += 1) {
                const t = i / denom;
                const secAtClip = t * clipLenBeats;
                const secInSeg = secAtClip - lead;
                if (secInSeg < 0 || secInSeg > segLen) {
                    outMin[i] = 0;
                    outMax[i] = 0;
                    continue;
                }
                const mm = sampleSegmentMinMaxAtTime(
                    segMin,
                    segMax,
                    segLen,
                    secInSeg,
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
                segmentLenSec: segLen,
                segmentColumns: segCols,
                leadSilenceSec: lead,
                isPreview,
                cycleLenSecTimeline,
            };
        };

        const keyChanged = peaksKeyRef.current !== key;
        if (keyChanged) {
            peaksKeyRef.current = key;

            // Preview remap: if we already have a base segment from the previous request,
            // immediately rebuild output with the new timeline mapping while backend peaks load.
            // This avoids waveform flicker during trim/stretch/slip drags.
            // isPreview=false: trim 时波形数据本身是正确的（只是 timeline 映射变了），
            // 不需要降低 opacity，避免视觉闪烁。
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
                // 直接使用 mipmapCache（四级缓存）
                const mipmapData = await mipmapCache.getPeaks(
                    sourcePath,
                    peaksRequest.samplesPerPixel,
                    startSec,
                    segSec,
                    peaksRequest.widthPx,
                );

                if (requestId !== peaksRequestIdRef.current) return;

                if (mipmapData && mipmapData.min.length >= 2 && mipmapData.max.length >= 2) {
                    const segMin = mipmapData.min;
                    const segMax = mipmapData.max;
                    setPeaks(buildOutput(segMin, segMax, false));
                }
                // mipmapCache 未返回有效数据，静默失败
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
    }, [altPressed, hasWaveformPreview, peaksRequest, peaks?.ok, peaks?.segmentMin, peaks?.segmentMax, peaksRequest?.samplesPerPixel, peaksRequest?.widthPx]);
    return peaks;
}
