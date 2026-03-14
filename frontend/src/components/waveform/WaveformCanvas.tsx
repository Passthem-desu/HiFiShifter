import React from "react";
import { processWaveformPeaks } from "../../utils/waveformRenderer";
import { waveformApi } from "../../services/api/waveform";

// Tile & worker settings
const TILE_PX = 4096; // CSS px per tile
const WAVEFORM_COLUMNS_PER_SEC = 1024; // must match useClipWaveformPeaks
const WAVEFORM_COLUMNS_MIN = 16;
const WAVEFORM_COLUMNS_MAX = 8192;
const WAVEFORM_COLUMNS_QUANT = 32;

export type WaveformCanvasProps = {
    min?: number[];
    max?: number[];
    targetWidthPx: number;
    heightPx: number;
    /** clip 级别的参考峰值（绝对值，0..1）。优先使用以保证缩放时垂直标度一致 */
    clipPeak?: number;
    stroke?: string;
    strokeWidth?: number;
    opacity?: number;
    // Tile-mode props (optional)
    tileMode?: boolean;
    sourcePath?: string;
    sourceStartOffsetSec?: number;
    cycleLenSecTimeline?: number;
    pxPerSec?: number;
    playbackRate?: number;
};

export default function WaveformCanvas(props: WaveformCanvasProps) {
    const {
        min,
        max,
        targetWidthPx,
        heightPx,
        clipPeak,
        stroke = "currentColor",
        strokeWidth = 1,
        opacity = 1,
    } = props;

    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    // Worker / tile-mode refs
    const workerRef = React.useRef<Worker | null>(null);
    const pendingRef = React.useRef<Map<number, (msg: any) => void>>(new Map());
    const requestIdRef = React.useRef<number>(0);
    const taskIdRef = React.useRef<number>(1);
    const tileCacheRef = React.useRef<Map<string, { min: Float32Array; max: Float32Array }>>(new Map());

    // Cleanup worker on unmount
    React.useEffect(() => {
        return () => {
            if (workerRef.current) {
                try {
                    workerRef.current.terminate();
                } catch (e) {
                    // ignore
                }
                workerRef.current = null;
            }
        };
    }, []);

    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const displayedW = Math.max(1, Math.floor(targetWidthPx));
        const displayedH = Math.max(1, Math.floor(heightPx));
        const dpr = Math.max(1, window.devicePixelRatio || 1);

        // Protect against extremely large canvas internal sizes which crash or
        // render incorrectly in browsers for very long clips at high zoom.
        const MAX_INTERNAL_CANVAS_PX = 32767; // safe upper bound for many browsers

        const internalW = Math.max(
            1,
            Math.min(Math.floor(displayedW * dpr), MAX_INTERNAL_CANVAS_PX),
        );
        const internalH = Math.max(1, Math.floor(displayedH * dpr));

        // Set DOM CSS size to the displayed width/height so layout stays correct,
        // but cap internal backing store to `internalW`/`internalH` to avoid overflow.
        canvas.width = internalW;
        canvas.height = internalH;
        canvas.style.width = `${displayedW}px`;
        canvas.style.height = `${displayedH}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // Map drawing coordinates in CSS pixels -> internal pixels.
        const scaleX = internalW / Math.max(1, displayedW);
        const scaleY = internalH / Math.max(1, displayedH);
        ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
        ctx.clearRect(0, 0, displayedW, displayedH);
        ctx.globalAlpha = Math.max(0, Math.min(1, Number(opacity) || 0));

        // To limit memory usage, downsample to the internal horizontal resolution
        // (in CSS px) rather than the full displayed width when we've clamped.
        const processedTarget = Math.max(1, Math.floor(internalW / dpr));
        // If tileMode requested and sourcePath provided, render by requesting
        // tiles from backend and processing them in the worker.
        if (props.tileMode && props.sourcePath && props.pxPerSec && props.playbackRate) {
            // ensure worker exists
            if (!workerRef.current) {
                try {
                    workerRef.current = new Worker(new URL("../../workers/waveformProcessor.worker.ts", import.meta.url), { type: "module" });
                    workerRef.current.onmessage = (ev: MessageEvent) => {
                        const d = ev.data as any;
                        const id = d?.id;
                        if (!id) return;
                        const resolver = pendingRef.current.get(id);
                        if (resolver) {
                            resolver(d);
                            pendingRef.current.delete(id);
                        }
                    };
                } catch (e) {
                    // Worker creation failed — fallback to synchronous path below
                    console.warn("Waveform worker create failed:", e);
                }
            }

            const requestId = ++requestIdRef.current;
            // compute peakAbs from provided clipPeak or fallback to 1
            const eps = 1e-9;
            let peakAbs = eps;
            if (typeof props.clipPeak === "number" && isFinite(props.clipPeak) && props.clipPeak > 0) {
                peakAbs = Math.max(eps, Math.min(1, Math.abs(props.clipPeak)));
            }
            const minOccupy = 0.12;
            const amplitude = (displayedH / 2) * Math.min(1, Math.max(minOccupy, peakAbs));

            // For each tile, fetch segment from backend, then ask worker to downsample
            const tiles = Math.ceil(displayedW / TILE_PX);

            // helper to process one tile
            const processTile = async (tileIndex: number) => {
                const tileStartPx = tileIndex * TILE_PX;
                const tileDisplayedWidth = Math.min(TILE_PX, Math.max(1, Math.floor(displayedW - tileStartPx)));
                const tileTimelineStartSec = tileStartPx / props.pxPerSec!;
                const tileTimelineDurSec = tileDisplayedWidth / props.pxPerSec!;

                const sourceStartSec = (props.sourceStartOffsetSec || 0) + tileTimelineStartSec * props.playbackRate!;
                const sourceDurSec = Math.max(1e-6, tileTimelineDurSec * props.playbackRate!);

                // compute columns to request for this tile
                const rawCols = Math.round(sourceDurSec * WAVEFORM_COLUMNS_PER_SEC);
                const quantCols = Math.max(WAVEFORM_COLUMNS_MIN, Math.min(WAVEFORM_COLUMNS_MAX, Math.round(rawCols / WAVEFORM_COLUMNS_QUANT) * WAVEFORM_COLUMNS_QUANT));
                const cols = Math.max(16, quantCols);

                const cacheKey = `${props.sourcePath}|${sourceStartSec.toFixed(3)}|${sourceDurSec.toFixed(3)}|${cols}`;
                if (tileCacheRef.current.has(cacheKey)) {
                    const cached = tileCacheRef.current.get(cacheKey)!;
                    drawProcessedTile(cached.min, cached.max, tileStartPx, tileDisplayedWidth, amplitude, peakAbs, requestId);
                    return;
                }

                try {
                    const res = await waveformApi.getWaveformPeaksSegment(props.sourcePath!, sourceStartSec, sourceDurSec, cols);
                    if (!res || !res.ok) return;
                    const segMin = new Float32Array((res.min ?? []).map((v: any) => Number(v) || 0));
                    const segMax = new Float32Array((res.max ?? []).map((v: any) => Number(v) || 0));

                    if (workerRef.current && typeof workerRef.current.postMessage === "function") {
                        const id = taskIdRef.current++;
                        const p = new Promise<any>((resolve) => {
                            pendingRef.current.set(id, resolve);
                        });
                        // Transfer buffers to worker to avoid copy
                        try {
                            workerRef.current.postMessage({ id, type: "process", min: segMin, max: segMax, targetWidth: tileDisplayedWidth }, [segMin.buffer, segMax.buffer]);
                        } catch (e) {
                            // Fallback: send without transfer
                            workerRef.current.postMessage({ id, type: "process", min: segMin.slice(), max: segMax.slice(), targetWidth: tileDisplayedWidth });
                        }
                        const out = await p;
                        if (!out || requestIdRef.current !== requestId) return; // stale
                        const oMin = new Float32Array(out.min);
                        const oMax = new Float32Array(out.max);
                        tileCacheRef.current.set(cacheKey, { min: oMin, max: oMax });
                        drawProcessedTile(oMin, oMax, tileStartPx, tileDisplayedWidth, amplitude, peakAbs, requestId);
                    } else {
                        // No worker: fallback to synchronous downsample
                        const proc = processWaveformPeaks({
                            min: Array.from(segMin),
                            max: Array.from(segMax),
                            startSec: 0,
                            durSec: 1,
                            visibleStartSec: 0,
                            visibleDurSec: 1,
                            targetWidth: tileDisplayedWidth,
                        });
                        const oMin = new Float32Array(proc.min);
                        const oMax = new Float32Array(proc.max);
                        tileCacheRef.current.set(cacheKey, { min: oMin, max: oMax });
                        drawProcessedTile(oMin, oMax, tileStartPx, tileDisplayedWidth, amplitude, peakAbs, requestId);
                    }
                } catch (e) {
                    // ignore
                }
            };

            const drawProcessedTile = (procMin: Float32Array, procMax: Float32Array, tileStartPx: number, tileDisplayedWidth: number, amplitude: number, peakAbsVal: number, reqId: number) => {
                if (reqId !== requestIdRef.current) return; // stale
                const n2 = Math.min(procMin.length, procMax.length);
                if (n2 <= 0) return;
                ctx.beginPath();
                const centerY = displayedH / 2;
                for (let i = 0; i < n2; i++) {
                    const x = tileStartPx + (n2 === 1 ? 0 : (i / (n2 - 1)) * tileDisplayedWidth);
                    const top = procMax[i] ?? 0;
                    const bot = procMin[i] ?? 0;
                    const t = i % 2 === 0 ? 0.25 : 0.75;
                    const v = top + (bot - top) * t;
                    const vNorm = peakAbsVal > eps ? v / peakAbsVal : 0;
                    const y = centerY - vNorm * amplitude;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.strokeStyle = stroke;
                ctx.lineWidth = strokeWidth;
                ctx.lineJoin = "round";
                ctx.lineCap = "round";
                ctx.stroke();
            };

            // clear cache if display size changed significantly
            tileCacheRef.current.clear();

            // kick off tile processing in parallel but don't await all here
            for (let ti = 0; ti < tiles; ti++) {
                // eslint-disable-next-line @typescript-eslint/no-floating-promises
                processTile(ti);
            }

            return;
        }

        // fallback synchronous path (no tileMode)
        const processed = processWaveformPeaks({
            min: min!,
            max: max!,
            startSec: 0,
            durSec: 1,
            visibleStartSec: 0,
            visibleDurSec: 1,
            targetWidth: processedTarget,
        });

        const n = Math.min(processed.min.length, processed.max.length);
        if (n === 0) return;

        const centerY = displayedH / 2;
        const fullAmplitude = displayedH / 2; // full half-height

        // Determine peakAbs: prefer provided clip-level reference (stable across zoom),
        // fallback to processed local peak.
        const eps = 1e-9;
        let peakAbs = eps;
        if (typeof props.clipPeak === "number" && isFinite(props.clipPeak) && props.clipPeak > 0) {
            peakAbs = Math.max(eps, Math.min(1, Math.abs(props.clipPeak)));
        } else {
            for (let i = 0; i < n; i++) {
                const ma = Math.abs(processed.max[i] ?? 0);
                const mi = Math.abs(processed.min[i] ?? 0);
                if (ma > peakAbs) peakAbs = ma;
                if (mi > peakAbs) peakAbs = mi;
            }
        }

        // Map peakAbs (0..1) to a visual occupancy ratio in [minOccupy,1].
        // We use a slight perceptual curve so low-level clips remain visible.
        const minOccupy = 0.12; // leave small inset so line not flush to edges
        const occupy = Math.min(1, Math.max(minOccupy, peakAbs));
        const amplitude = fullAmplitude * occupy;

        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const x = n === 1 ? 0 : (i / (n - 1)) * displayedW;
            const top = processed.max[i] ?? 0;
            const bot = processed.min[i] ?? 0;

            // Deterministic fine-grain jitter: alternate sampling inside envelope
            const t = i % 2 === 0 ? 0.25 : 0.75;
            const v = top + (bot - top) * t;

            // Normalize by peakAbs to keep shape, then scale by amplitude occupancy
            const vNorm = peakAbs > eps ? v / peakAbs : 0;
            const y = centerY - vNorm * amplitude;

            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }

        ctx.strokeStyle = stroke;
        ctx.lineWidth = strokeWidth;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
    }, [min, max, targetWidthPx, heightPx, stroke, strokeWidth, opacity, clipPeak]);

    return <canvas ref={canvasRef} />;
}
