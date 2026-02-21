import type {
    ParamName,
    ParamViewSegment,
    ValueViewport,
    WavePeaksSegment,
} from "./types";
import { clamp } from "../timeline";
import { AXIS_W, PITCH_MAX_MIDI, PITCH_MIN_MIDI } from "./constants";

function isBlackKey(midi: number): boolean {
    const pc = ((midi % 12) + 12) % 12;
    return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

function midiToLabel(midi: number): string {
    const octave = Math.floor(midi / 12) - 1;
    return `C${octave}`;
}

function drawCurveTimed(args: {
    ctx: CanvasRenderingContext2D;
    values: number[];
    param: ParamName;
    w: number;
    h: number;
    startFrame: number;
    stride: number;
    framePeriodMs: number;
    visibleStartSec: number;
    visibleDurSec: number;
    valueToY: (param: ParamName, v: number, h: number) => number;
}) {
    const {
        ctx,
        values,
        param,
        w,
        h,
        startFrame,
        stride,
        framePeriodMs,
        visibleStartSec,
        visibleDurSec,
        valueToY,
    } = args;

    if (values.length < 2) return;
    const fp = Math.max(1e-6, framePeriodMs);
    const step = Math.max(1, Math.floor(stride));
    const denom = Math.max(1e-9, visibleDurSec);

    let started = false;
    ctx.beginPath();
    for (let i = 0; i < values.length; i += 1) {
        const frame = startFrame + i * step;
        const tSec = (frame * fp) / 1000;
        if (tSec < visibleStartSec || tSec > visibleStartSec + visibleDurSec) {
            started = false;
            continue;
        }
        const x = ((tSec - visibleStartSec) / denom) * w;
        const y = valueToY(param, values[i] ?? 0, h);
        if (!started) {
            ctx.moveTo(x, y);
            started = true;
        } else {
            ctx.lineTo(x, y);
        }
    }
    ctx.stroke();
}

export function drawPianoRoll(args: {
    axisCanvas: HTMLCanvasElement | null;
    canvas: HTMLCanvasElement | null;
    viewSize: { w: number; h: number };
    editParam: ParamName;
    pitchView: ValueViewport;
    tensionView: ValueViewport;
    valueToY: (param: ParamName, v: number, h: number) => number;
    wavePeaks: WavePeaksSegment | null;
    paramView: ParamViewSegment | null;
    overlayText?: string | null;
    liveEditOverride: { key: string; edit: number[] } | null;
    selection: { aBeat: number; bBeat: number } | null;
    pxPerBeat: number;
    scrollLeft: number;
    secPerBeat: number;
    playheadBeat: number;
}) {
    const {
        axisCanvas,
        canvas,
        viewSize,
        editParam,
        pitchView,
        tensionView,
        valueToY,
        wavePeaks,
        paramView,
        overlayText,
        liveEditOverride,
        selection,
        pxPerBeat,
        scrollLeft,
        secPerBeat,
        playheadBeat,
    } = args;

    // Draw axis (left labels)
    if (axisCanvas) {
        const ctx = axisCanvas.getContext("2d");
        if (ctx) {
            const h = viewSize.h;
            const w = AXIS_W;
            const dpr = Math.max(1, window.devicePixelRatio || 1);
            const cw = Math.max(1, Math.floor(w * dpr));
            const ch = Math.max(1, Math.floor(h * dpr));
            if (axisCanvas.width !== cw || axisCanvas.height !== ch) {
                axisCanvas.width = cw;
                axisCanvas.height = ch;
                axisCanvas.style.width = `${w}px`;
                axisCanvas.style.height = `${h}px`;
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            ctx.strokeStyle = "rgba(255,255,255,0.08)";
            ctx.beginPath();
            ctx.moveTo(w - 0.5, 0);
            ctx.lineTo(w - 0.5, h);
            ctx.stroke();

            if (editParam === "pitch") {
                const absMin = PITCH_MIN_MIDI;
                const absMax = PITCH_MAX_MIDI;
                const view = pitchView;
                const span = clamp(view.span, 1e-6, absMax - absMin);
                const min = clamp(
                    view.center - span / 2,
                    absMin,
                    absMax - span,
                );
                const max = min + span;
                const startMidi = clamp(Math.floor(min), absMin, absMax);
                const endMidi = clamp(Math.ceil(max), absMin, absMax);
                for (let midi = startMidi; midi < endMidi; midi += 1) {
                    const y0 = valueToY("pitch", midi, h);
                    const y1 = valueToY("pitch", midi + 1, h);
                    const top = Math.min(y0, y1);
                    const bottom = Math.max(y0, y1);
                    const keyH = Math.max(1, bottom - top);

                    // White key bed
                    ctx.fillStyle = "rgb(255,255,255)";
                    ctx.fillRect(0, top, w, keyH);

                    // Black key overlay (shorter)
                    if (isBlackKey(midi)) {
                        ctx.fillStyle = "rgb(0,0,0)";
                        ctx.fillRect(0, top, w * 0.72, keyH);
                    }

                    const pc = ((midi % 12) + 12) % 12;
                    if (pc === 0) {
                        ctx.fillStyle = "rgba(0,0,0,0.85)";
                        ctx.font = "10px sans-serif";
                        ctx.textBaseline = "middle";
                        ctx.fillText(midiToLabel(midi), 6, top + keyH / 2);
                    }

                    // horizontal separators in axis
                    ctx.strokeStyle =
                        pc === 0 ? "rgba(0,0,0,0.22)" : "rgba(0,0,0,0.12)";
                    ctx.beginPath();
                    ctx.moveTo(0, top + 0.5);
                    ctx.lineTo(w, top + 0.5);
                    ctx.stroke();
                }
            } else {
                // tension axis labels
                ctx.fillStyle = "rgba(255,255,255,0.55)";
                ctx.font = "10px sans-serif";
                ctx.textBaseline = "middle";
                const marks = [1, 0.5, 0];
                for (const m of marks) {
                    const y = valueToY("tension", m, h);
                    ctx.fillText(String(m), 6, y);
                    ctx.strokeStyle = "rgba(255,255,255,0.10)";
                    ctx.beginPath();
                    ctx.moveTo(0, y + 0.5);
                    ctx.lineTo(w, y + 0.5);
                    ctx.stroke();
                }
            }
        }
    }

    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { w, h } = viewSize;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cw = Math.max(1, Math.floor(w * dpr));
    const ch = Math.max(1, Math.floor(h * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const visibleStartBeat = scrollLeft / Math.max(1e-9, pxPerBeat);
    const visibleDurBeats = w / Math.max(1e-9, pxPerBeat);
    const visibleStartSec = visibleStartBeat * secPerBeat;
    const visibleDurSec = visibleDurBeats * secPerBeat;

    // Horizontal pitch grid
    if (editParam === "pitch") {
        const absMin = PITCH_MIN_MIDI;
        const absMax = PITCH_MAX_MIDI;
        const view = pitchView;
        const span = clamp(view.span, 1e-6, absMax - absMin);
        const min = clamp(view.center - span / 2, absMin, absMax - span);
        const max = min + span;
        const startMidi = clamp(Math.floor(min), absMin, absMax);
        const endMidi = clamp(Math.ceil(max), absMin, absMax);
        for (let midi = startMidi; midi <= endMidi; midi += 1) {
            const y = valueToY("pitch", midi, h);
            const pc = ((midi % 12) + 12) % 12;
            ctx.strokeStyle =
                pc === 0 ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.05)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, y + 0.5);
            ctx.lineTo(w, y + 0.5);
            ctx.stroke();
        }
    }

    // Background waveform
    if (wavePeaks && wavePeaks.min.length >= 2 && wavePeaks.max.length >= 2) {
        const mid = h * 0.6;
        const amp = h * 0.35;
        ctx.strokeStyle = "rgba(255,255,255,0.10)";
        ctx.lineWidth = 1;
        const n = Math.max(
            0,
            Math.min(wavePeaks.min.length, wavePeaks.max.length),
        );
        const denom = Math.max(1, n);
        const v0 = visibleStartSec;
        const v1 = visibleStartSec + Math.max(1e-9, visibleDurSec);
        for (let i = 0; i < n; i += 1) {
            const t =
                wavePeaks.startSec + ((i + 0.5) * wavePeaks.durSec) / denom;
            if (t < v0 || t > v1) continue;
            const x =
                ((t - visibleStartSec) / Math.max(1e-9, visibleDurSec)) * w;
            const mi = wavePeaks.min[i] ?? 0;
            const ma = wavePeaks.max[i] ?? 0;
            const y0 = mid - ma * amp;
            let y1 = mid - mi * amp;
            // If the segment is (near-)silent, y0≈y1 and the stroke can become
            // visually imperceptible. Draw a tiny line to keep the background
            // reference visible.
            if (Math.abs(y1 - y0) < 0.75) {
                y1 = y0 + (y1 >= y0 ? 0.75 : -0.75);
            }
            ctx.beginPath();
            ctx.moveTo(x + 0.5, y0);
            ctx.lineTo(x + 0.5, y1);
            ctx.stroke();
        }
    }

    // Selection (time band)
    if (selection) {
        const a = Math.min(selection.aBeat, selection.bBeat);
        const b = Math.max(selection.aBeat, selection.bBeat);
        const x0 = a * pxPerBeat - scrollLeft;
        const x1 = b * pxPerBeat - scrollLeft;
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fillRect(x0, 0, x1 - x0, h);
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.strokeRect(x0 + 0.5, 0.5, Math.max(0, x1 - x0 - 1), h - 1);
    }

    // Curves
    if (paramView && paramView.orig.length >= 2 && paramView.edit.length >= 2) {
        const editValues =
            liveEditOverride && liveEditOverride.key === paramView.key
                ? liveEditOverride.edit
                : paramView.edit;

        // original (dashed)
        ctx.save();
        ctx.strokeStyle = "rgba(200,200,200,0.55)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 6]);
        drawCurveTimed({
            ctx,
            values: paramView.orig,
            param: editParam,
            w,
            h,
            startFrame: paramView.startFrame,
            stride: paramView.stride,
            framePeriodMs: paramView.framePeriodMs,
            visibleStartSec,
            visibleDurSec,
            valueToY,
        });
        ctx.restore();

        // edited (solid)
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.90)";
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        drawCurveTimed({
            ctx,
            values: editValues,
            param: editParam,
            w,
            h,
            startFrame: paramView.startFrame,
            stride: paramView.stride,
            framePeriodMs: paramView.framePeriodMs,
            visibleStartSec,
            visibleDurSec,
            valueToY,
        });
        ctx.restore();
    }

    if (overlayText) {
        ctx.save();
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(overlayText, w / 2, h * 0.88);
        ctx.restore();
    }

    // Playhead
    const phx = playheadBeat * pxPerBeat - scrollLeft;
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(phx + 0.5, 0);
    ctx.lineTo(phx + 0.5, h);
    ctx.stroke();

    // Keep tensionView referenced to avoid unused warning (future).
    void tensionView;
}
