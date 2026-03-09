import type {
    KeyboardEvent,
    MouseEvent,
    MutableRefObject,
    PointerEvent as ReactPointerEvent,
    UIEvent,
    WheelEvent,
} from "react";
import { useCallback } from "react";

import type { ParamFramesPayload } from "../../../types/api";
import type { AppDispatch } from "../../../app/store";
import { paramsApi } from "../../../services/api";
import {
    seekPlayhead,
    setplayheadSec,
} from "../../../features/session/sessionSlice";
import { clamp, MAX_PX_PER_SEC, MIN_PX_PER_SEC } from "../timeline";
import type {
    ParamName,
    ParamViewSegment,
    StrokeMode,
    StrokePoint,
    ValueViewport,
} from "./types";
import type { MutableRefObject as MutRef } from "react";
import { isModifierActive } from "../../../features/keybindings/keybindingsSlice";
import type { Keybinding } from "../../../features/keybindings/types";

type CanvasCursor = "default" | "crosshair" | "grab" | "grabbing";

export function usePianoRollInteractions(args: {
    dispatch: AppDispatch;
    rootTrackId: string | null;
    editParam: ParamName;
    pitchEnabled: boolean;
    toolMode: string;
    secPerBeat: number;
    scrollLeftRef: MutableRefObject<number>;
    pxPerBeatRef: MutableRefObject<number>;
    setPxPerBeat: (next: number) => void;
    /** 当前 BPM，用于动态计�?pxPerBeat 的合法范�?*/
    bpm: number;
    setPitchView: (next: ValueViewport) => void;
    setParamViewport: (param: string, next: ValueViewport) => void;
    pitchViewRef: MutableRefObject<ValueViewport>;
    paramViewsRef: MutableRefObject<Record<string, ValueViewport>>;

    scrollerRef: MutableRefObject<HTMLDivElement | null>;
    canvasRef: MutableRefObject<HTMLCanvasElement | null>;
    viewSizeRef: MutableRefObject<{ w: number; h: number }>;

    selectionRef: MutableRefObject<{ aBeat: number; bBeat: number } | null>;
    setSelectionUi: (next: { aBeat: number; bBeat: number } | null) => void;
    setCanvasCursor: (next: CanvasCursor) => void;

    strokeRef: MutableRefObject<{
        mode: StrokeMode;
        pointerId: number;
        param: ParamName;
        points: StrokePoint[];
    } | null>;
    panRef: MutableRefObject<{
        pointerId: number;
        startClientX: number;
        startClientY: number;
        startScrollLeft: number;
        startView: ValueViewport;
        startRectH: number;
    } | null>;

    clipboardRef: MutableRefObject<{
        param: ParamName;
        framePeriodMs: number;
        values: number[];
    } | null>;

    paramView: ParamViewSegment | null;
    paramViewRef: MutableRefObject<ParamViewSegment | null>;

    bumpRefreshToken: () => void;
    syncScrollLeft: (scroller: HTMLDivElement) => void;
    invalidate: () => void;

    yToViewportT: (y: number, h: number) => number;
    yToValue: (param: ParamName, y: number, h: number) => number;
    valueToY: (param: ParamName, v: number, h: number) => number;
    clampViewport: (param: ParamName, v: ValueViewport) => ValueViewport;

    ensureLiveEditBase: (pv: ParamViewSegment) => void;
    applyDenseToLiveEdit: (
        pv: ParamViewSegment,
        denseStartFrame: number,
        dense: number[] | null,
        minF: number,
        maxF: number,
        mode: StrokeMode,
    ) => void;

    commitStroke: (points: StrokePoint[], mode: StrokeMode) => Promise<void>;

    /** 用于选区拖拽 onUp 时同步更新本地 paramView state（与 commitStroke 行为一致） */
    setParamView: (next: ParamViewSegment | null) => void;
    /** 用于选区拖拽 onUp 时清除 live edit overlay */
    liveEditOverrideRef: MutRef<{ key: string; edit: number[] } | null>;

    /** pointer down 期间设为 true，pointer up 后由 commitStroke 包装层重置为 false。
     *  用于保护 pitch_orig_updated 事件触发的曲线刷新不覆盖正在绘制的内容。 */
    liveEditActiveRef?: MutableRefObject<boolean>;    /** pianoRoll.copy 绑定 */
    pianoRollCopyKb: Keybinding;
    /** pianoRoll.paste 绑定 */
    pianoRollPasteKb: Keybinding;
    /** modifier.pianoRollVerticalZoom 绑定 */
    prVerticalZoomKb: Keybinding;
}) {
    const {
        dispatch,
        rootTrackId,
        editParam,
        pitchEnabled,
        toolMode,
        secPerBeat,
        scrollLeftRef,
        pxPerBeatRef,
        setPxPerBeat,
        bpm,
        setPitchView,
        setParamViewport,
        pitchViewRef,
        paramViewsRef,
        scrollerRef,
        canvasRef,
        viewSizeRef,
        selectionRef,
        setSelectionUi,
        setCanvasCursor,
        strokeRef,
        panRef,
        clipboardRef,
        paramView,
        paramViewRef,
        bumpRefreshToken,
        syncScrollLeft,
        invalidate,
        yToViewportT,
        yToValue,
        valueToY,
        clampViewport,
        ensureLiveEditBase,
        applyDenseToLiveEdit,
        commitStroke,
        setParamView,
        liveEditOverrideRef,
        liveEditActiveRef,
        pianoRollCopyKb,
        pianoRollPasteKb,
        prVerticalZoomKb,
    } = args;

    const pointerBeat = useCallback(
        (clientX: number): number => {
            const canvas = canvasRef.current;
            if (!canvas) return 0;
            const rect = canvas.getBoundingClientRect();
            const x = clientX - rect.left;
            const sl = scrollLeftRef.current;
            const ppb = pxPerBeatRef.current;
            return (sl + x) / Math.max(1e-9, ppb);
        },
        [canvasRef, scrollLeftRef, pxPerBeatRef],
    );

    const pointerValue = useCallback(
        (clientY: number): number => {
            const canvas = canvasRef.current;
            if (!canvas) return 0;
            const rect = canvas.getBoundingClientRect();
            const y = clientY - rect.top;
            const raw = yToValue(editParam, y, rect.height);
            // render.ts 绘制 pitch 曲线时对值加了 +0.5（使曲线居于琴键中心），
            // 此处减去相同偏移，确保编辑点与显示位置对齐。
            return editParam === "pitch" ? raw - 0.5 : raw;
        },
        [canvasRef, editParam, yToValue],
    );

    const onRulerMouseDown = useCallback(
        (e: MouseEvent<HTMLDivElement>) => {
            if (e.button !== 0) return;
            const bounds = (
                e.currentTarget as HTMLDivElement
            ).getBoundingClientRect();
            const sl = scrollLeftRef.current;
            const ppb = pxPerBeatRef.current;
            const beat = clamp(
                (e.clientX - bounds.left + sl) / Math.max(1e-9, ppb),
                0,
                1e12,
            );
            // beat → sec：playheadSec 存储的是秒，必须转换后再 dispatch
            const sec = beat * secPerBeat;
            dispatch(setplayheadSec(sec));
            void dispatch(seekPlayhead(sec));
        },
        [dispatch, scrollLeftRef, pxPerBeatRef, secPerBeat],
    );

    const onScrollerMouseDownCapture = useCallback((e: MouseEvent) => {
        if (e.button === 1) e.preventDefault();
    }, []);

    const onScrollerAuxClick = useCallback((e: MouseEvent) => {
        if (e.button === 1) e.preventDefault();
    }, []);

    const onScrollerScroll = useCallback(
        (e: UIEvent<HTMLDivElement>) => {
            syncScrollLeft(e.currentTarget as HTMLDivElement);
        },
        [syncScrollLeft],
    );

    const onScrollerContextMenu = useCallback((e: MouseEvent) => {
        e.preventDefault();
    }, []);

    const onScrollerKeyDown = useCallback(
        (e: KeyboardEvent<HTMLDivElement>) => {
            if (!rootTrackId) return;
            if (editParam === "pitch" && !pitchEnabled) return;

            // pianoRoll.shiftParamUp / shiftParamDown 已移至全局 handleKeybindingAction 处理

            if (!selectionRef.current) return;

            const sel = selectionRef.current;
            const aBeat = Math.min(sel.aBeat, sel.bBeat);
            const bBeat = Math.max(sel.aBeat, sel.bBeat);
            const startSec = aBeat * secPerBeat;
            const durSec = Math.max(0, (bBeat - aBeat) * secPerBeat);
            const fp = paramView?.framePeriodMs ?? 5;
            const startFrame = Math.max(0, Math.floor((startSec * 1000) / fp));
            const frameCount = clamp(
                Math.ceil((durSec * 1000) / fp),
                1,
                200_000,
            );

            // 检测 pianoRoll.copy 绑定
            {
                const kb = pianoRollCopyKb;
                let keyMatch = false;
                if (kb.modifierOnly) {
                    keyMatch = isModifierActive(kb, e.nativeEvent);
                } else {
                    let pressedKey =
                        e.key === " " ? "space" : e.key.toLowerCase();
                    if (pressedKey !== kb.key) keyMatch = false;
                    else {
                        const isMac = navigator.platform
                            .toLowerCase()
                            .includes("mac");
                        const modKey = isMac ? e.metaKey : e.ctrlKey;
                        keyMatch =
                            modKey === Boolean(kb.ctrl) &&
                            e.shiftKey === Boolean(kb.shift) &&
                            e.altKey === Boolean(kb.alt);
                    }
                }
                if (keyMatch) {
                    e.preventDefault();
                    void (async () => {
                        const res = await paramsApi.getParamFrames(
                            rootTrackId,
                            editParam,
                            startFrame,
                            frameCount,
                            1,
                        );
                        if (!res?.ok) return;
                        const payload = res as ParamFramesPayload;
                        clipboardRef.current = {
                            param: editParam,
                            framePeriodMs:
                                Number(payload.frame_period_ms ?? fp) || fp,
                            values: (payload.edit ?? []).map(
                                (v) => Number(v) || 0,
                            ),
                        };
                    })();
                    return;
                }
            }

            // 检测 pianoRoll.paste 绑定
            {
                const kb = pianoRollPasteKb;
                let keyMatch = false;
                if (kb.modifierOnly) {
                    keyMatch = isModifierActive(kb, e.nativeEvent);
                } else {
                    let pressedKey =
                        e.key === " " ? "space" : e.key.toLowerCase();
                    if (pressedKey !== kb.key) keyMatch = false;
                    else {
                        const isMac = navigator.platform
                            .toLowerCase()
                            .includes("mac");
                        const modKey = isMac ? e.metaKey : e.ctrlKey;
                        keyMatch =
                            modKey === Boolean(kb.ctrl) &&
                            e.shiftKey === Boolean(kb.shift) &&
                            e.altKey === Boolean(kb.alt);
                    }
                }
                if (keyMatch) {
                    e.preventDefault();
                    const clip = clipboardRef.current;
                    if (!clip) return;
                    if (clip.param !== editParam) return;
                    void (async () => {
                        await paramsApi.setParamFrames(
                            rootTrackId,
                            editParam,
                            startFrame,
                            clip.values,
                            true,
                        );
                        bumpRefreshToken();
                    })();
                }
            }
        },
        [
            rootTrackId,
            selectionRef,
            secPerBeat,
            paramView?.framePeriodMs,
            editParam,
            pitchEnabled,
            clipboardRef,
            bumpRefreshToken,
            pianoRollCopyKb,
            pianoRollPasteKb,
        ],
    );

    const onScrollerWheelNative = useCallback(
        (e: globalThis.WheelEvent) => {
            const el = scrollerRef.current;
            if (!el) return;

            // Anchor zoom to the actual drawable viewport (canvas), not the scroller.
            // The scroller may include rulers/padding, which makes zoom feel off-center.
            const canvas = canvasRef.current;
            const bounds = (canvas ?? el).getBoundingClientRect();

            const pointerXRaw = e.clientX - bounds.left;
            const pointerYRaw = e.clientY - bounds.top;
            if (
                pointerXRaw < 0 ||
                pointerYRaw < 0 ||
                pointerXRaw > bounds.width ||
                pointerYRaw > bounds.height
            ) {
                return;
            }

            // We rely on preventDefault to stop native scrolling while zooming.
            e.preventDefault();

            // Ctrl + wheel: vertical zoom (value axis)
            if (isModifierActive(prVerticalZoomKb, e)) {
                const h = Math.max(1, bounds.height);
                const y = clamp(pointerYRaw, 0, h);
                const t = yToViewportT(y, h);
                const valueAtPointer = yToValue(editParam, y, h);

                const factor = e.deltaY < 0 ? 0.9 : 1.1;
                if (editParam === "pitch") {
                    const cur = pitchViewRef.current;
                    const nextSpan = cur.span * factor;
                    const next = clampViewport("pitch", {
                        span: nextSpan,
                        center: valueAtPointer - (0.5 - t) * nextSpan,
                    });
                    setPitchView(next);
                } else {
                    const cur = paramViewsRef.current[editParam] ?? {
                        center: 0.5,
                        span: 1,
                    };
                    const nextSpan = cur.span * factor;
                    const next = clampViewport(editParam, {
                        span: nextSpan,
                        center: valueAtPointer - (0.5 - t) * nextSpan,
                    });
                    setParamViewport(editParam, next);
                }
                invalidate();
                return;
            }

            // Wheel: horizontal zoom (time axis)
            const dir = e.deltaY < 0 ? 1 : -1;
            const factor = dir > 0 ? 1.1 : 0.9;
            const pointerX = clamp(pointerXRaw, 0, Math.max(1, bounds.width));
            const curPxPerBeat = pxPerBeatRef.current;
            const beatAtPointer =
                (pointerX + el.scrollLeft) / Math.max(1e-9, curPxPerBeat);

            // 动态计�?pxPerBeat 的合法范围（基于 pxPerSec 的范围和当前 BPM�?
            const secPerBeatLocal = 60 / Math.max(1, bpm);
            const minPxPerBeat = MIN_PX_PER_SEC * secPerBeatLocal;
            const maxPxPerBeat = MAX_PX_PER_SEC * secPerBeatLocal;

            const next = clamp(
                curPxPerBeat * factor,
                minPxPerBeat,
                maxPxPerBeat,
            );
            if (Math.abs(next - curPxPerBeat) < 1e-9) return;

            setPxPerBeat(next);
            const nextScrollLeft = beatAtPointer * next - pointerX;
            el.scrollLeft = Math.max(0, nextScrollLeft);
            syncScrollLeft(el);
        },
        [
            scrollerRef,
            canvasRef,
            editParam,
            yToViewportT,
            yToValue,
            pitchViewRef,
            paramViewsRef,
            clampViewport,
            setPitchView,
            setParamViewport,
            invalidate,
            pxPerBeatRef,
            setPxPerBeat,
            syncScrollLeft,
        ],
    );

    // React's onWheel handler may run in a passive listener in modern React.
    // Keep this for compatibility, but do not call preventDefault here.
    const onScrollerWheel = useCallback((_e: WheelEvent<HTMLDivElement>) => {
        // no-op; wheel is handled via native listener with passive:false
    }, []);

    const getDefaultCanvasCursor = useCallback((): CanvasCursor => {
        return toolMode === "select" ? "default" : "crosshair";
    }, [toolMode]);

    const isPointerNearDraggableSelection = useCallback(
        (clientX: number, clientY: number): boolean => {
            if (toolMode !== "select") return false;
            const sel = selectionRef.current;
            const pv = paramViewRef.current;
            const canvas = canvasRef.current;
            if (!sel || !pv || pv.edit.length === 0 || !canvas) return false;

            const beat = pointerBeat(clientX);
            const aBeat = Math.min(sel.aBeat, sel.bBeat);
            const bBeat = Math.max(sel.aBeat, sel.bBeat);
            if (beat < aBeat || beat > bBeat) return false;

            const fp = pv.framePeriodMs;
            const sec = beat * secPerBeat;
            const frame = Math.max(0, Math.floor((sec * 1000) / fp));
            const idx = Math.round(
                (frame - pv.startFrame) / Math.max(1, pv.stride),
            );
            const curveVal = idx >= 0 && idx < pv.edit.length ? pv.edit[idx] : null;
            if (curveVal == null) return false;

            const rect = canvas.getBoundingClientRect();
            const rectH = rect.height || viewSizeRef.current.h || 1;
            const mouseY = clientY - rect.top;
            const mappedCurveVal =
                editParam === "pitch" ? curveVal + 0.5 : curveVal;
            const curveY = valueToY(editParam, mappedCurveVal, rectH);
            return Math.abs(mouseY - curveY) < 10;
        },
        [
            toolMode,
            selectionRef,
            paramViewRef,
            canvasRef,
            pointerBeat,
            secPerBeat,
            viewSizeRef,
            editParam,
            valueToY,
        ],
    );

    const onCanvasPointerMove = useCallback(
        (e: ReactPointerEvent<HTMLCanvasElement>) => {
            if (panRef.current || strokeRef.current) return;
            if (isPointerNearDraggableSelection(e.clientX, e.clientY)) {
                setCanvasCursor("grab");
                return;
            }
            setCanvasCursor(getDefaultCanvasCursor());
        },
        [
            panRef,
            strokeRef,
            isPointerNearDraggableSelection,
            setCanvasCursor,
            getDefaultCanvasCursor,
        ],
    );

    const onCanvasPointerLeave = useCallback(() => {
        if (panRef.current || strokeRef.current) return;
        setCanvasCursor(getDefaultCanvasCursor());
    }, [panRef, strokeRef, setCanvasCursor, getDefaultCanvasCursor]);

    const onCanvasPointerDown = useCallback(
        (e: ReactPointerEvent<HTMLCanvasElement>) => {
            if (!rootTrackId) return;

            // Middle mouse: pan (time axis)
            if (e.button === 1) {
                e.preventDefault();
                setCanvasCursor("grabbing");
                const scroller = scrollerRef.current;
                if (!scroller) return;
                const pid = e.pointerId;
                panRef.current = {
                    pointerId: pid,
                    startClientX: e.clientX,
                    startClientY: e.clientY,
                    startScrollLeft: scroller.scrollLeft,
                    startView:
                        editParam === "pitch"
                            ? pitchViewRef.current
                            : (paramViewsRef.current[editParam] ?? {
                                  center: 0.5,
                                  span: 1,
                              }),
                    startRectH:
                        (canvasRef.current?.getBoundingClientRect().height ??
                            viewSizeRef.current.h) ||
                        1,
                };
                (e.currentTarget as HTMLCanvasElement).setPointerCapture(pid);
                const onMove = (ev: globalThis.PointerEvent) => {
                    const pan = panRef.current;
                    if (!pan || pan.pointerId !== pid) return;
                    const dx = ev.clientX - pan.startClientX;
                    const dy = ev.clientY - pan.startClientY;
                    scroller.scrollLeft = Math.max(0, pan.startScrollLeft - dx);
                    syncScrollLeft(scroller);

                    const hPx = Math.max(1, pan.startRectH);
                    const deltaCenter = (dy / hPx) * pan.startView.span;
                    if (editParam === "pitch") {
                        setPitchView(
                            clampViewport("pitch", {
                                span: pan.startView.span,
                                center: pan.startView.center + deltaCenter,
                            }),
                        );
                    } else {
                        setParamViewport(
                            editParam,
                            clampViewport(editParam, {
                                span: pan.startView.span,
                                center: pan.startView.center + deltaCenter,
                            }),
                        );
                    }
                    invalidate();
                };
                const onUp = () => {
                    panRef.current = null;
                    setCanvasCursor(getDefaultCanvasCursor());
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                    window.removeEventListener("pointercancel", onUp);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
                window.addEventListener("pointercancel", onUp);
                return;
            }

            if (toolMode === "select") {
                // 右键：取消选区
                if (e.button === 2) {
                    e.preventDefault();
                    selectionRef.current = null;
                    setSelectionUi(null);
                    invalidate();
                    return;
                }
                if (e.button !== 0) return;

                const b = pointerBeat(e.clientX);
                const sel = selectionRef.current;

                // 如果已有选区，且鼠标在选区范围内且靠近曲线，则进入拖拽曲线模式
                if (sel) {
                    const aBeat = Math.min(sel.aBeat, sel.bBeat);
                    const bBeat = Math.max(sel.aBeat, sel.bBeat);
                    if (b >= aBeat && b <= bBeat) {
                        // 判断鼠标是否在曲线附近（像素距离 < 10px）
                        const pv = paramViewRef.current;
                        if (pv && pv.edit.length > 0) {
                            const fp = pv.framePeriodMs;
                            const sec = b * secPerBeat;
                            const frame = Math.max(
                                0,
                                Math.floor((sec * 1000) / fp),
                            );
                            const idx = Math.round(
                                (frame - pv.startFrame) /
                                    Math.max(1, pv.stride),
                            );
                            const curveVal =
                                idx >= 0 && idx < pv.edit.length
                                    ? pv.edit[idx]
                                    : null;
                            const mouseVal = pointerValue(e.clientY);

                            // 使用像素距离判断是否靠近曲线，避免不同参数值域差异的影响
                            const canvas = canvasRef.current;
                            const rectH = canvas
                                ? canvas.getBoundingClientRect().height
                                : viewSizeRef.current.h || 1;
                            const mouseY = canvas
                                ? e.clientY - canvas.getBoundingClientRect().top
                                : 0;
                            // pitch 绘制时有 +0.5 偏移（画在琴键中心），命中检测需保持一致
                            const mappedCurveVal =
                                curveVal !== null
                                    ? editParam === "pitch"
                                        ? curveVal + 0.5
                                        : curveVal
                                    : null;
                            const curveY =
                                mappedCurveVal !== null
                                    ? valueToY(editParam, mappedCurveVal, rectH)
                                    : null;
                            const HIT_THRESHOLD_PX = 10;

                            if (
                                curveY !== null &&
                                Math.abs(mouseY - curveY) < HIT_THRESHOLD_PX
                            ) {
                                // 进入拖拽选中曲线模式（支持 X+Y 双向拖拽）
                                setCanvasCursor("grabbing");
                                const startMouseVal = mouseVal;
                                const startBeat = pointerBeat(e.clientX);
                                const pid = e.pointerId;
                                (
                                    e.currentTarget as HTMLCanvasElement
                                ).setPointerCapture(pid);

                                // 保存选区内曲线原始值
                                const selStartSec = aBeat * secPerBeat;
                                const selEndSec = bBeat * secPerBeat;
                                const selStartFrame = Math.max(
                                    0,
                                    Math.floor((selStartSec * 1000) / fp),
                                );
                                const selEndFrame = Math.max(
                                    0,
                                    Math.ceil((selEndSec * 1000) / fp),
                                );
                                const stride = Math.max(1, pv.stride);
                                const selStartIdx = Math.max(
                                    0,
                                    Math.round(
                                        (selStartFrame - pv.startFrame) / stride,
                                    ),
                                );
                                const selEndIdx = Math.min(
                                    pv.edit.length - 1,
                                    Math.round(
                                        (selEndFrame - pv.startFrame) / stride,
                                    ),
                                );
                                const origValues = pv.edit.slice(
                                    selStartIdx,
                                    selEndIdx + 1,
                                );
                                ensureLiveEditBase(pv);
                                if (liveEditActiveRef)
                                    liveEditActiveRef.current = true;

                                // 用闭包变量记录最新 X/Y 偏移量
                                let lastValueDelta = 0;
                                let lastFrameDelta = 0; // 帧偏移（整数）

                                const onMove = (
                                    ev: globalThis.PointerEvent,
                                ) => {
                                    const currentVal = pointerValue(ev.clientY);
                                    lastValueDelta = currentVal - startMouseVal;

                                    // 计算 X 方向帧偏移
                                    const currentBeat = pointerBeat(ev.clientX);
                                    const beatDelta = currentBeat - startBeat;
                                    const secDelta = beatDelta * secPerBeat;
                                    lastFrameDelta = Math.round((secDelta * 1000) / fp);

                                    const pvNow = paramViewRef.current;
                                    if (!pvNow) return;

                                    ensureLiveEditBase(pvNow);

                                    // 构造覆盖原选区 + 新位置的完整 dense 数组
                                    const selLen = selEndIdx - selStartIdx + 1;
                                    const origDenseStart = pv.startFrame + selStartIdx * stride;

                                    // 计算需要覆盖的帧范围：原选区 ∪ 新位置选区
                                    const newDenseStart = origDenseStart + lastFrameDelta;
                                    const overallMinFrame = Math.max(0, Math.min(origDenseStart, newDenseStart));
                                    const origDenseEnd = origDenseStart + (selLen - 1) * stride;
                                    const newDenseEnd = newDenseStart + (selLen - 1) * stride;
                                    const overallMaxFrame = Math.max(origDenseEnd, newDenseEnd);

                                    const overallLen = Math.floor((overallMaxFrame - overallMinFrame) / stride) + 1;
                                    const dense = new Array<number>(overallLen);

                                    // 先用 orig 曲线填充整个范围（边界还原）
                                    for (let i = 0; i < overallLen; i++) {
                                        const globalIdx = Math.round((overallMinFrame + i * stride - pv.startFrame) / stride);
                                        dense[i] = (globalIdx >= 0 && globalIdx < pvNow.orig.length)
                                            ? pvNow.orig[globalIdx]
                                            : 0;
                                    }

                                    // 再将选区值写入新位置（覆盖 orig）
                                    for (let i = 0; i < selLen; i++) {
                                        const targetFrame = newDenseStart + i * stride;
                                        const denseIdx = Math.round((targetFrame - overallMinFrame) / stride);
                                        if (denseIdx >= 0 && denseIdx < overallLen) {
                                            dense[denseIdx] = (origValues[i] ?? 0) + lastValueDelta;
                                        }
                                    }

                                    applyDenseToLiveEdit(
                                        pvNow,
                                        overallMinFrame,
                                        dense,
                                        overallMinFrame,
                                        overallMaxFrame,
                                        "draw",
                                    );

                                    // 实时更新选区位置显示
                                    const beatDeltaForSel = (lastFrameDelta * fp) / 1000 / secPerBeat;
                                    selectionRef.current = {
                                        aBeat: aBeat + beatDeltaForSel,
                                        bBeat: bBeat + beatDeltaForSel,
                                    };
                                    setSelectionUi(selectionRef.current);

                                    invalidate();
                                };

                                const onUp = () => {
                                    window.removeEventListener(
                                        "pointermove",
                                        onMove,
                                    );
                                    window.removeEventListener(
                                        "pointerup",
                                        onUp,
                                    );
                                    window.removeEventListener(
                                        "pointercancel",
                                        onUp,
                                    );

                                    // 提交拖拽结果到后端
                                    const pvNow = paramViewRef.current;
                                    if (pvNow && rootTrackId) {
                                        const selLen = selEndIdx - selStartIdx + 1;
                                        const origDenseStart = pv.startFrame + selStartIdx * stride;
                                        const newDenseStart = origDenseStart + lastFrameDelta;

                                        const overallMinFrame = Math.max(0, Math.min(origDenseStart, newDenseStart));
                                        const origDenseEnd = origDenseStart + (selLen - 1) * stride;
                                        const newDenseEnd = newDenseStart + (selLen - 1) * stride;
                                        const overallMaxFrame = Math.max(origDenseEnd, newDenseEnd);
                                        const overallLen = Math.floor((overallMaxFrame - overallMinFrame) / stride) + 1;

                                        // 构造最终提交的 dense 数组
                                        const finalDense = new Array<number>(overallLen);

                                        // 先用 orig 填充整个范围
                                        for (let i = 0; i < overallLen; i++) {
                                            const globalIdx = Math.round((overallMinFrame + i * stride - pvNow.startFrame) / stride);
                                            finalDense[i] = (globalIdx >= 0 && globalIdx < pvNow.orig.length)
                                                ? pvNow.orig[globalIdx]
                                                : 0;
                                        }

                                        // 再将偏移后的选区值写入新位置
                                        for (let i = 0; i < selLen; i++) {
                                            const targetFrame = newDenseStart + i * stride;
                                            const denseIdx = Math.round((targetFrame - overallMinFrame) / stride);
                                            if (denseIdx >= 0 && denseIdx < overallLen) {
                                                finalDense[denseIdx] = (origValues[i] ?? 0) + lastValueDelta;
                                            }
                                        }

                                        // 立即同步更新本地 paramView state
                                        const nextEdit = pvNow.edit.slice();
                                        for (let i = 0; i < overallLen; i++) {
                                            const globalIdx = Math.round((overallMinFrame + i * stride - pvNow.startFrame) / stride);
                                            if (globalIdx >= 0 && globalIdx < nextEdit.length) {
                                                nextEdit[globalIdx] = finalDense[i];
                                            }
                                        }
                                        setParamView({ ...pvNow, edit: nextEdit });
                                        liveEditOverrideRef.current = null;

                                        // 确保选区位置最终正确
                                        const beatDeltaForSel = (lastFrameDelta * fp) / 1000 / secPerBeat;
                                        selectionRef.current = {
                                            aBeat: aBeat + beatDeltaForSel,
                                            bBeat: bBeat + beatDeltaForSel,
                                        };
                                        setSelectionUi(selectionRef.current);

                                        void (async () => {
                                            await paramsApi.setParamFrames(
                                                rootTrackId,
                                                editParam,
                                                overallMinFrame,
                                                finalDense,
                                                true,
                                            );
                                            if (liveEditActiveRef)
                                                liveEditActiveRef.current = false;
                                            bumpRefreshToken();
                                        })();
                                    } else {
                                        if (liveEditActiveRef)
                                            liveEditActiveRef.current = false;
                                    }
                                    setCanvasCursor("grab");
                                    invalidate();
                                };

                                window.addEventListener("pointermove", onMove);
                                window.addEventListener("pointerup", onUp);
                                window.addEventListener("pointercancel", onUp);
                                return;
                            }
                        }
                    }
                }

                // 默认行为：创建新选区
                selectionRef.current = { aBeat: b, bBeat: b };
                setSelectionUi(selectionRef.current);
                const pid = e.pointerId;
                (e.currentTarget as HTMLCanvasElement).setPointerCapture(pid);
                const onMove = (ev: globalThis.PointerEvent) => {
                    if (selectionRef.current == null) return;
                    const bb = pointerBeat(ev.clientX);
                    selectionRef.current = {
                        aBeat: selectionRef.current.aBeat,
                        bBeat: bb,
                    };
                    setSelectionUi(selectionRef.current);
                    invalidate(); // 实时重绘选区
                };
                const onUp = () => {
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                    window.removeEventListener("pointercancel", onUp);
                    invalidate();
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
                window.addEventListener("pointercancel", onUp);
                return;
            }

            const mode: StrokeMode = e.button === 2 ? "restore" : "draw";
            if (e.button !== 0 && e.button !== 2) return;
            setCanvasCursor(getDefaultCanvasCursor());
            const pv = paramViewRef.current;
            if (pv) ensureLiveEditBase(pv);
            const fp = paramView?.framePeriodMs ?? 5;
            const beat = pointerBeat(e.clientX);
            const sec = beat * secPerBeat;
            const frame = Math.max(0, Math.floor((sec * 1000) / fp));
            const value = pointerValue(e.clientY);

            strokeRef.current = {
                mode,
                pointerId: e.pointerId,
                param: editParam,
                points: [{ frame, value }],
            };
            // 标记 live 编辑开始，阻止 pitch_orig_updated 事件立即刷新曲线�?
            if (liveEditActiveRef) liveEditActiveRef.current = true;

            const pv0 = paramViewRef.current;
            if (pv0) {
                applyDenseToLiveEdit(
                    pv0,
                    frame,
                    mode === "restore" ? null : [value],
                    frame,
                    frame,
                    mode,
                );
            }
            (e.currentTarget as HTMLCanvasElement).setPointerCapture(
                e.pointerId,
            );
            invalidate();

            const onMove = (ev: globalThis.PointerEvent) => {
                const st = strokeRef.current;
                if (!st || st.pointerId !== e.pointerId) return;
                const b2 = pointerBeat(ev.clientX);
                const sec2 = b2 * secPerBeat;
                const f2 = Math.max(0, Math.floor((sec2 * 1000) / fp));
                const v2 = pointerValue(ev.clientY);

                const pv2 = paramViewRef.current;
                const last = st.points[st.points.length - 1];
                if (last && last.frame === f2) {
                    last.value = v2;
                    if (pv2) {
                        applyDenseToLiveEdit(
                            pv2,
                            f2,
                            mode === "restore" ? null : [v2],
                            f2,
                            f2,
                            mode,
                        );
                    }
                } else if (last) {
                    const a = { frame: last.frame, value: last.value };
                    const b = { frame: f2, value: v2 };
                    st.points.push(b);

                    const minF = Math.min(a.frame, b.frame);
                    const maxF = Math.max(a.frame, b.frame);

                    let dense: number[] | null = null;
                    if (mode !== "restore") {
                        const len = maxF - minF + 1;
                        dense = new Array<number>(len);
                        const denom = b.frame - a.frame;
                        for (let f = minF; f <= maxF; f += 1) {
                            const t = denom === 0 ? 1 : (f - a.frame) / denom;
                            dense[f - minF] = a.value + (b.value - a.value) * t;
                        }
                    }

                    if (pv2) {
                        applyDenseToLiveEdit(
                            pv2,
                            minF,
                            dense,
                            minF,
                            maxF,
                            mode,
                        );
                    }
                }
                invalidate();
            };

            const onUp = () => {
                const st = strokeRef.current;
                if (!st || st.pointerId !== e.pointerId) return;
                strokeRef.current = null;
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
                window.removeEventListener("pointercancel", onUp);
                invalidate();
                // commitStroke 包装层会在完成后重置 liveEditActiveRef 并触发延迟刷新�?
                void commitStroke(st.points, st.mode);
            };

            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
            window.addEventListener("pointercancel", onUp);
        },
        [
            rootTrackId,
            editParam,
            toolMode,
            scrollerRef,
            canvasRef,
            viewSizeRef,
            panRef,
            pitchViewRef,
            paramViewsRef,
            syncScrollLeft,
            clampViewport,
            setPitchView,
            setParamViewport,
            invalidate,
            pointerBeat,
            selectionRef,
            setSelectionUi,
            paramViewRef,
            ensureLiveEditBase,
            paramView?.framePeriodMs,
            secPerBeat,
            pointerValue,
            strokeRef,
            applyDenseToLiveEdit,
            commitStroke,
        ],
    );

    return {
        onRulerMouseDown,
        onScrollerMouseDownCapture,
        onScrollerAuxClick,
        onScrollerScroll,
        onScrollerContextMenu,
        onScrollerKeyDown,
        onScrollerWheel,
        onScrollerWheelNative,
        onCanvasPointerMove,
        onCanvasPointerLeave,
        onCanvasPointerDown,
    };
}
