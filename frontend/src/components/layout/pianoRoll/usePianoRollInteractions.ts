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
    setPlayheadBeat,
} from "../../../features/session/sessionSlice";
import { clamp, MAX_PX_PER_BEAT, MIN_PX_PER_BEAT } from "../timeline";
import type {
    ParamName,
    ParamViewSegment,
    StrokeMode,
    StrokePoint,
    ValueViewport,
} from "./types";

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
    setPitchView: (next: ValueViewport) => void;
    setTensionView: (next: ValueViewport) => void;
    pitchViewRef: MutableRefObject<ValueViewport>;
    tensionViewRef: MutableRefObject<ValueViewport>;

    scrollerRef: MutableRefObject<HTMLDivElement | null>;
    canvasRef: MutableRefObject<HTMLCanvasElement | null>;
    viewSizeRef: MutableRefObject<{ w: number; h: number }>;

    selectionRef: MutableRefObject<{ aBeat: number; bBeat: number } | null>;
    setSelectionUi: (next: { aBeat: number; bBeat: number } | null) => void;

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

    /** pointer down 期间设为 true，pointer up 后由 commitStroke 包装层重置为 false。
     *  用于保护 pitch_orig_updated 事件触发的曲线刷新不覆盖正在绘制的内容。 */
    liveEditActiveRef?: MutableRefObject<boolean>;
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
        setPitchView,
        setTensionView,
        pitchViewRef,
        tensionViewRef,
        scrollerRef,
        canvasRef,
        viewSizeRef,
        selectionRef,
        setSelectionUi,
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
        clampViewport,
        ensureLiveEditBase,
        applyDenseToLiveEdit,
        commitStroke,
        liveEditActiveRef,
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
            return yToValue(editParam, y, rect.height);
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
            dispatch(setPlayheadBeat(beat));
            void dispatch(seekPlayhead(beat));
        },
        [dispatch, scrollLeftRef, pxPerBeatRef],
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
            if (!selectionRef.current) return;
            if (editParam === "pitch" && !pitchEnabled) return;
            const isMac = navigator.platform.toLowerCase().includes("mac");
            const mod = isMac ? e.metaKey : e.ctrlKey;
            if (!mod) return;

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

            if (e.key.toLowerCase() === "c") {
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
                        framePeriodMs: Number(payload.frame_period_ms ?? fp) || fp,
                        values: (payload.edit ?? []).map((v) => Number(v) || 0),
                    };
                })();
                return;
            }

            if (e.key.toLowerCase() === "v") {
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
            if (e.ctrlKey) {
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
                    const cur = tensionViewRef.current;
                    const nextSpan = cur.span * factor;
                    const next = clampViewport(editParam, {
                        span: nextSpan,
                        center: valueAtPointer - (0.5 - t) * nextSpan,
                    });
                    setTensionView(next);
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

            const next = clamp(
                curPxPerBeat * factor,
                MIN_PX_PER_BEAT,
                MAX_PX_PER_BEAT,
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
            tensionViewRef,
            clampViewport,
            setPitchView,
            setTensionView,
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

    const onCanvasPointerDown = useCallback(
        (e: ReactPointerEvent<HTMLCanvasElement>) => {
            if (!rootTrackId) return;
            if (editParam !== "pitch" && editParam !== "tension") return;

            // Middle mouse: pan (time axis)
            if (e.button === 1) {
                e.preventDefault();
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
                            : tensionViewRef.current,
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
                        setTensionView(
                            clampViewport("tension", {
                                span: pan.startView.span,
                                center: pan.startView.center + deltaCenter,
                            }),
                        );
                    }
                    invalidate();
                };
                const onUp = () => {
                    panRef.current = null;
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
                if (e.button !== 0) return;
                const b = pointerBeat(e.clientX);
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
            // 标记 live 编辑开始，阻止 pitch_orig_updated 事件立即刷新曲线。
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
                // commitStroke 包装层会在完成后重置 liveEditActiveRef 并触发延迟刷新。
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
            tensionViewRef,
            syncScrollLeft,
            clampViewport,
            setPitchView,
            setTensionView,
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
        onCanvasPointerDown,
    };
}
