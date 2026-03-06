import type { ParamName, ParamViewSegment, ValueViewport } from "./types";
import type { ClipPeaksEntry } from "./useClipsPeaksForPianoRoll";
import { clamp } from "../timeline";
import { AXIS_W, PITCH_MAX_MIDI, PITCH_MIN_MIDI } from "./constants";
import { framesToTime, timeToPixel } from "./utils";
import {
    processWaveformPeaks,
    renderWaveformCanvas,
} from "../../../utils/waveformRenderer";

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

    // Check debug flag
    const debugEnabled =
        typeof window !== "undefined" &&
        window.localStorage?.getItem("hifishifter.debugPianoRoll") === "1";

    // DEBUG: 验证曲线时间参数（使用统一转换函数�?
    const curveStartSec = framesToTime(startFrame, fp);
    const curveEndSec = framesToTime(
        startFrame + (values.length - 1) * step,
        fp,
    );
    const curveTotalDurSec = curveEndSec - curveStartSec;

    if (debugEnabled) {
        console.log("[drawCurveTimed] Params:", {
            param,
            visibleStartSec,
            visibleDurSec,
            visibleEndSec: visibleStartSec + visibleDurSec,
            startFrame,
            stride: step,
            framePeriodMs: fp,
            valuesLength: values.length,
            firstValue: values[0],
            lastValue: values[values.length - 1],
            curveStartSec,
            curveEndSec,
            curveTotalDurSec,
            canvasWidth: w,
        });
    }

    let started = false;
    let firstPoint: { frame: number; tSec: number; x: number } | null = null;
    let lastPoint: { frame: number; tSec: number; x: number } | null = null;

    ctx.beginPath();
    for (let i = 0; i < values.length; i += 1) {
        const frame = startFrame + i * step;
        const tSec = framesToTime(frame, fp);
        if (tSec < visibleStartSec || tSec > visibleStartSec + visibleDurSec) {
            started = false;
            continue;
        }
        const x = timeToPixel(tSec, visibleStartSec, visibleDurSec, w);

        // Track first and last points for debugging
        if (!firstPoint && started === false) {
            firstPoint = { frame, tSec, x };
        }
        lastPoint = { frame, tSec, x };

        // pitch 曲线：MIDI �?N 应绘制在 N 键中心（N �?N+1 区间的中点），加 0.5 偏移
        const rawValue = values[i] ?? 0;
        const mappedValue = param === "pitch" ? rawValue + 0.5 : rawValue;
        const y = valueToY(param, mappedValue, h);
        if (!started) {
            ctx.moveTo(x, y);
            started = true;
        } else {
            ctx.lineTo(x, y);
        }
    }

    // DEBUG: Log first and last rendered points
    if (debugEnabled && firstPoint && lastPoint) {
        console.log("[drawCurveTimed] Rendered points:", {
            param,
            firstPoint: {
                frame: firstPoint.frame,
                tSec: firstPoint.tSec,
                x: firstPoint.x,
                // Verify conversion
                verifyTime: framesToTime(firstPoint.frame, fp),
                verifyPixel: timeToPixel(
                    firstPoint.tSec,
                    visibleStartSec,
                    visibleDurSec,
                    w,
                ),
            },
            lastPoint: {
                frame: lastPoint.frame,
                tSec: lastPoint.tSec,
                x: lastPoint.x,
                // Verify conversion
                verifyTime: framesToTime(lastPoint.frame, fp),
                verifyPixel: timeToPixel(
                    lastPoint.tSec,
                    visibleStartSec,
                    visibleDurSec,
                    w,
                ),
            },
            pixelSpan: lastPoint.x - firstPoint.x,
            timeSpan: lastPoint.tSec - firstPoint.tSec,
            pxPerSec:
                (lastPoint.x - firstPoint.x) /
                (lastPoint.tSec - firstPoint.tSec),
        });
    }

    ctx.stroke();
}

/**
 * per-clip 检测音高曲线（来自后端 clip_pitch_data 事件），
 * 在参数面板 pitch 视图中作为参考线渲染。
 */
export interface DetectedPitchCurve {
    /** MIDI 曲线第 0 帧对应的 timeline 绝对时间（秒），直接来自后端 */
    curveStartSec: number;
    /** MIDI 音高曲线，每帧一个值，0 表示无声 */
    midiCurve: number[];
    /** WORLD 帧周期（毫秒） */
    framePeriodMs: number;
    /** clip 在 timeline 上的起始时间（秒），用于裁剪渲染区域 */
    clipStartSec: number;
    /** clip 在 timeline 上的长度（秒），用于裁剪渲染区域 */
    clipLengthSec: number;
}

export function drawPianoRoll(args: {
    axisCanvas: HTMLCanvasElement | null;
    canvas: HTMLCanvasElement | null;
    viewSize: { w: number; h: number };
    editParam: ParamName;
    pitchView: ValueViewport;
    tensionView: ValueViewport;
    valueToY: (param: ParamName, v: number, h: number) => number;
    clipPeaks: ClipPeaksEntry[];
    paramView: ParamViewSegment | null;
    secondaryParamView: ParamViewSegment | null;
    showSecondaryParam: boolean;
    overlayText?: string | null;
    liveEditOverride: { key: string; edit: number[] } | null;
    selection: { aBeat: number; bBeat: number } | null;
    pxPerSec: number;
    scrollLeft: number;
    secPerBeat: number;
    playheadSec: number; // 播放头位置（秒）
    pitchAnalysisPending?: boolean;
    waveformColors?: { fill: string; stroke: string };
    /** 检测音高曲线列表，在 pitch 模式下渲染为参考线 */
    detectedPitchCurves?: DetectedPitchCurve[];
    /** 是否为深色主题（默认 true） */
    isDark?: boolean;
}) {
    const {
        axisCanvas,
        canvas,
        viewSize,
        editParam,
        pitchView,
        tensionView,
        valueToY,
        clipPeaks,
        paramView,
        secondaryParamView,
        showSecondaryParam,
        overlayText,
        liveEditOverride,
        selection,
        pxPerSec,
        scrollLeft,
        secPerBeat,
        playheadSec,
        pitchAnalysisPending,
        waveformColors = {
            fill: "rgba(255,255,255,0.2)",
            stroke: "rgba(255,255,255,0.7)",
        },
        detectedPitchCurves,
        isDark = true,
    } = args;

    // 主题颜色查找表
    const colors = isDark
        ? {
              // 琴键区
              axisBorder: "rgba(255,255,255,0.08)",
              whiteKey: "#e8e8e8",
              blackKey: "#1a1a1a",
              blackKeyGradient: "rgba(0,0,0,0.35)",
              cLabel: "#3b82f6",
              cSeparator: "rgba(100,100,100,0.45)",
              keySeparator: "rgba(160,160,160,0.20)",
              tensionLabel: "rgba(255,255,255,0.55)",
              tensionLine: "rgba(255,255,255,0.10)",
              // 网格线
              pitchGridC: "rgba(255,255,255,0.10)",
              pitchGridOther: "rgba(255,255,255,0.05)",
              // 曲线
              origCurve: "rgba(200,200,200,0.55)",
              editCurve: "rgba(255,255,255,0.90)",
              selectionCurve: "rgba(100,200,255,0.95)",
              // 叠加文字 & 播放头
              overlayTextColor: "rgba(255,255,255,0.35)",
              playheadLine: "rgba(255,255,255,0.25)",
          }
        : {
              // 浅色主题
              axisBorder: "rgba(0,0,0,0.10)",
              whiteKey: "#ffffff",
              blackKey: "#3a3a3a",
              blackKeyGradient: "rgba(0,0,0,0.25)",
              cLabel: "#2563eb",
              cSeparator: "rgba(0,0,0,0.25)",
              keySeparator: "rgba(0,0,0,0.12)",
              tensionLabel: "rgba(0,0,0,0.55)",
              tensionLine: "rgba(0,0,0,0.10)",
              // 网格线
              pitchGridC: "rgba(0,0,0,0.12)",
              pitchGridOther: "rgba(0,0,0,0.06)",
              // 曲线
              origCurve: "rgba(80,80,80,0.55)",
              editCurve: "rgba(0,0,0,0.85)",
              selectionCurve: "rgba(30,120,200,0.95)",
              // 叠加文字 & 播放头
              overlayTextColor: "rgba(0,0,0,0.35)",
              playheadLine: "rgba(0,0,0,0.20)",
          };

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

            ctx.strokeStyle = colors.axisBorder;
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

                    const black = isBlackKey(midi);
                    const pc = ((midi % 12) + 12) % 12;

                    // 白键
                    if (!black) {
                        ctx.fillStyle = colors.whiteKey;
                        ctx.fillRect(0, top, w, keyH);
                    }

                    // 黑键：深色覆盖，宽度 72%
                    if (black) {
                        ctx.fillStyle = colors.blackKey;
                        ctx.fillRect(0, top, w * 0.72, keyH);
                        // 黑键右侧渐变边缘
                        const grad = ctx.createLinearGradient(
                            w * 0.62,
                            0,
                            w * 0.72,
                            0,
                        );
                        grad.addColorStop(0, "rgba(0,0,0,0)");
                        grad.addColorStop(1, colors.blackKeyGradient);
                        ctx.fillStyle = grad;
                        ctx.fillRect(w * 0.62, top, w * 0.1, keyH);
                    }

                    // C 音名标注
                    if (pc === 0) {
                        ctx.fillStyle = colors.cLabel;                        ctx.font = "bold 9px sans-serif";
                        ctx.textBaseline = "middle";
                        ctx.fillText(midiToLabel(midi), 5, top + keyH / 2);
                    }

                    // 分隔线：C 音用较深的线，其他用浅线
                    ctx.strokeStyle =
                        pc === 0
                            ? colors.cSeparator
                            : colors.keySeparator;
                    ctx.lineWidth = pc === 0 ? 1 : 0.5;
                    ctx.beginPath();
                    ctx.moveTo(0, top + 0.5);
                    ctx.lineTo(w, top + 0.5);
                    ctx.stroke();
                    ctx.lineWidth = 1;
                }
            } else {
                // tension axis labels
                ctx.fillStyle = colors.tensionLabel;
                ctx.font = "10px sans-serif";
                ctx.textBaseline = "middle";
                const marks = [1, 0.5, 0];
                for (const m of marks) {
                    const y = valueToY("tension", m, h);
                    ctx.fillText(String(m), 6, y);
                    ctx.strokeStyle = colors.tensionLine;
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

    // 统一用 sec 坐标系：所有 x 坐标 = timeSec * pxPerSec - scrollLeft
    const visibleStartSec = scrollLeft / Math.max(1e-9, pxPerSec);
    const visibleDurSec = w / Math.max(1e-9, pxPerSec);
    // beat 坐标系辅助（仅用于 selection 等仍以 beat 为单位的数据）
    const pxPerBeat = pxPerSec * secPerBeat;

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
            const y = valueToY("pitch", midi + 0.5, h);
            const pc = ((midi % 12) + 12) % 12;
            ctx.strokeStyle =
                pc === 0 ? colors.pitchGridC : colors.pitchGridOther;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, y + 0.5);
            ctx.lineTo(w, y + 0.5);
            ctx.stroke();
        }
    }

    // Background waveform: per-clip 叠加绘制
    // peaks 数据覆盖整个 source 文件，渲染时根据 trimStart/playbackRate 计算偏移，
    // 裁剪到 clip 可视区域，trim 拖动不影响 peaks 数据本身。
    for (const entry of clipPeaks) {
        if (!entry.peaks) continue;
        const {
            min: pMin,
            max: pMax,
            durSec: pDurSec,
        } = entry.peaks;
        if (pMin.length < 2 || pMax.length < 2) continue;

        const pr = entry.playbackRate > 0 ? entry.playbackRate : 1;
        const trimStartSec = entry.trimStartSec ?? 0;
        const sourceDurSec = entry.sourceDurationSec > 0 ? entry.sourceDurationSec : pDurSec;

        // clip 在 canvas 上的可视 x 范围
        const clipStartX = entry.startSec * pxPerSec - scrollLeft;
        const clipWidthPx = entry.lengthSec * pxPerSec;
        if (clipWidthPx <= 0) continue;

        // peaks 覆盖整个 source 文件（0 ~ sourceDurSec），列数 = peaksCols
        const peaksCols = pMin.length;

        // 整个 source 文件在 timeline 域的像素宽度 = (sourceDurSec / pr) * pxPerSec
        const sourceWidthPx = (sourceDurSec / pr) * pxPerSec;
        // trimStart 对应的 timeline 域偏移量（像素）= (trimStartSec / pr) * pxPerSec
        const trimOffsetPx = (trimStartSec / pr) * pxPerSec;

        // 处理波形：1:1 映射 peaks 列
        const processed = processWaveformPeaks({
            min: pMin,
            max: pMax,
            startSec: 0,
            durSec: pDurSec,
            visibleStartSec: 0,
            visibleDurSec: pDurSec,
            targetWidth: peaksCols,
        });

        // 裁剪到 clip 的可视 x 范围，避免溢出到相邻 clip
        ctx.save();
        ctx.beginPath();
        ctx.rect(clipStartX, 0, clipWidthPx, h);
        ctx.clip();

        // 平移：先到 clip 起始位置，再向左偏移 trimStart 部分
        // 这样 peaks 的 trimStart 位置对齐到 clipStartX
        ctx.translate(clipStartX - trimOffsetPx, 0);

        // 缩放：将 peaksCols 列映射到整个 source 在 timeline 上的宽度
        if (peaksCols > 0 && sourceWidthPx > 0) {
            ctx.scale(sourceWidthPx / peaksCols, 1);
        }

        renderWaveformCanvas(ctx, processed, {
            width: peaksCols,
            height: h,
            fillColor: waveformColors.fill,
            strokeColor: waveformColors.stroke,
            barWidth: 1.5,
            centerY: h * 0.5,
            amplitude: h * 0.5,
        });

        ctx.restore();
    }
    // Selection (time band)
    if (selection) {
        const a = Math.min(selection.aBeat, selection.bBeat);
        const b = Math.max(selection.aBeat, selection.bBeat);
        const x0 = a * pxPerBeat - scrollLeft;
        const x1 = b * pxPerBeat - scrollLeft;
        ctx.fillStyle = "rgba(100, 200, 255, 0.08)";
        ctx.fillRect(x0, 0, x1 - x0, h);
        ctx.strokeStyle = "rgba(100, 200, 255, 0.30)";
        ctx.strokeRect(x0 + 0.5, 0.5, Math.max(0, x1 - x0 - 1), h - 1);
    }

    // 若音高分析进行中，跳过曲线绘制（进度条已显示状态）
    if (pitchAnalysisPending) {
        return;
    }

    // 检测音高参考线：在 pitch 模式下，将后端推送的 per-clip 检测曲线渲染为半透明彩色参考线�?
    // 渲染在用户编辑曲线下方，不干扰主曲线的视觉层次�?
    if (
        editParam === "pitch" &&
        detectedPitchCurves &&
        detectedPitchCurves.length > 0
    ) {
        // �?clip 时循环颜色，增强区分�?
        const DETECTED_COLORS = [
            "rgba(80, 220, 180, 0.55)", // 青绿
            "rgba(255, 180, 60, 0.55)", // 橙黄
            "rgba(180, 120, 255, 0.55)", // �?
            "rgba(60, 180, 255, 0.55)", // �?
        ];

        for (let ci = 0; ci < detectedPitchCurves.length; ci++) {
            const curve = detectedPitchCurves[ci];
            if (!curve.midiCurve || curve.midiCurve.length < 2) continue;

            const fp = Math.max(1e-6, curve.framePeriodMs);
            // 曲线起始时间（秒）：直接来自后端，无需帧→秒转换
            const curveStartSec = curve.curveStartSec;

            ctx.save();

            // 裁剪到 clip 可见区域：只渲染 [clipStartSec, clipStartSec + clipLengthSec] 内的曲线
            const cStartSec = curve.clipStartSec;
            const cLenSec = curve.clipLengthSec;
            const clipLeftX = cStartSec * pxPerSec - scrollLeft;
            const clipRightX = (cStartSec + cLenSec) * pxPerSec - scrollLeft;
            const clipWidthPx = clipRightX - clipLeftX;
            if (clipWidthPx > 0 && isFinite(clipWidthPx)) {
                ctx.beginPath();
                ctx.rect(clipLeftX, 0, clipWidthPx, h);
                ctx.clip();
            }

            ctx.strokeStyle = DETECTED_COLORS[ci % DETECTED_COLORS.length];
            ctx.lineWidth = 1.5;
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;

            ctx.beginPath();
            let hasStarted = false;

            for (let i = 0; i < curve.midiCurve.length; i++) {
                const midi = curve.midiCurve[i];
                if (midi == null || !isFinite(midi)) continue;

                // 计算当前帧的时间（秒），统一用 sec 坐标系
                const frameSec = curveStartSec + (i * fp) / 1000;
                const x = frameSec * pxPerSec - scrollLeft;
                // 裁剪到可见区域
                if (x < -10 || x > w + 10) continue;

                // 无声帧（midi <= 0）：跳过，但保持连续性
                if (midi <= 0) {
                    continue;
                }

                // pitch 曲线加 0.5 偏移，使点落在键中心
                const y = valueToY("pitch", midi + 0.5, h);

                if (!hasStarted) {
                    ctx.moveTo(x, y);
                    hasStarted = true;
                } else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.stroke();
            ctx.restore();
        }    }

    // Curves
    // 副参数曲线（半透明、细线，绘制在主参数曲线下方�?
    if (
        showSecondaryParam &&
        secondaryParamView &&
        secondaryParamView.edit.length >= 2
    ) {
        // 根据副参数类型选择颜色：pitch 用蓝色，tension 用橙�?
        const secondaryParam: ParamName = secondaryParamView.key.includes(
            "|pitch|",
        )
            ? "pitch"
            : "tension";
        const secondaryColor =
            secondaryParam === "pitch"
                ? "rgba(100, 200, 255, 0.45)"
                : "rgba(255, 180, 60, 0.45)";
        ctx.save();
        ctx.strokeStyle = secondaryColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        drawCurveTimed({
            ctx,
            values: secondaryParamView.edit,
            param: secondaryParam,
            w,
            h,
            startFrame: secondaryParamView.startFrame,
            stride: secondaryParamView.stride,
            framePeriodMs: secondaryParamView.framePeriodMs,
            visibleStartSec,
            visibleDurSec,
            valueToY,
        });
        ctx.restore();
    }

    if (paramView && paramView.orig.length >= 2 && paramView.edit.length >= 2) {
        const editValues =
            liveEditOverride && liveEditOverride.key === paramView.key
                ? liveEditOverride.edit
                : paramView.edit;

        // original (dashed)
        ctx.save();
        ctx.strokeStyle = colors.origCurve;
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
        ctx.strokeStyle = colors.editCurve;
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

        // 选区内曲线高亮：在选区范围内用亮蓝色加粗重绘编辑曲线
        if (selection) {
            const selMinBeat = Math.min(selection.aBeat, selection.bBeat);
            const selMaxBeat = Math.max(selection.aBeat, selection.bBeat);
            const selX0 = selMinBeat * pxPerBeat - scrollLeft;
            const selX1 = selMaxBeat * pxPerBeat - scrollLeft;

            ctx.save();
            // 裁剪到选区范围
            ctx.beginPath();
            ctx.rect(selX0, 0, selX1 - selX0, h);
            ctx.clip();

            ctx.strokeStyle = colors.selectionCurve;
            ctx.lineWidth = 3;
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
    }

    if (overlayText) {
        ctx.save();
        ctx.fillStyle = colors.overlayTextColor;
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(overlayText, w / 2, h * 0.88);
        ctx.restore();
    }

    // Playhead（统一用 sec 坐标系）
    const phx = playheadSec * pxPerSec - scrollLeft;
    ctx.strokeStyle = colors.playheadLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(phx + 0.5, 0);
    ctx.lineTo(phx + 0.5, h);
    ctx.stroke();

    // Keep tensionView referenced to avoid unused warning (future).
    void tensionView;
}
