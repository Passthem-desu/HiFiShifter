import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { Flex, Text, Button, Select, Box, IconButton } from "@radix-ui/themes";
import { EyeOpenIcon, EyeClosedIcon, UpdateIcon } from "@radix-ui/react-icons";

import { useAppDispatch, useAppSelector } from "../../app/hooks";
import type { RootState } from "../../app/store";
import { useI18n } from "../../i18n/I18nProvider";
import {
    setEditParam,
    setTrackStateRemote,
} from "../../features/session/sessionSlice";
import { resolveRootTrackId } from "../../features/session/trackUtils";

import {
    BackgroundGrid,
    DEFAULT_PX_PER_BEAT,
    MAX_PX_PER_BEAT,
    MIN_PX_PER_BEAT,
    TimeRuler,
    clamp,
    gridStepBeats,
} from "./timeline";

import { AXIS_W, PITCH_MAX_MIDI, PITCH_MIN_MIDI } from "./pianoRoll/constants";
import { drawPianoRoll } from "./pianoRoll/render";
import { usePianoRollData } from "./pianoRoll/usePianoRollData";
import { usePianoRollInteractions } from "./pianoRoll/usePianoRollInteractions";
import { useLiveParamEditing } from "./pianoRoll/useLiveParamEditing";
import type {
    ParamName,
    StrokeMode,
    StrokePoint,
    ValueViewport,
} from "./pianoRoll/types";

import { PitchStatusBadge } from "./PitchStatusBadge";

export const PianoRollPanel: React.FC = () => {
    const dispatch = useAppDispatch();
    const { t } = useI18n();
    const s = useAppSelector((state: RootState) => state.session);
    const editParam = s.editParam as ParamName;

    const effectiveSelectedTrackId = useMemo(() => {
        if (s.selectedTrackId) return s.selectedTrackId;
        const clipId = s.selectedClipId;
        if (!clipId) return null;
        const clip = s.clips.find((c) => c.id === clipId);
        return clip?.trackId ?? null;
    }, [s.selectedTrackId, s.selectedClipId, s.clips]);

    const [scrollLeft, setScrollLeft] = useState(0);
    const [pxPerBeat, setPxPerBeat] = useState(() => {
        const stored = Number(
            localStorage.getItem("hifishifter.paramPxPerBeat"),
        );
        return Number.isFinite(stored)
            ? Math.min(MAX_PX_PER_BEAT, Math.max(MIN_PX_PER_BEAT, stored))
            : DEFAULT_PX_PER_BEAT;
    });
    const scrollLeftRef = useRef(scrollLeft);
    const pxPerBeatRef = useRef(pxPerBeat);

    useEffect(() => {
        scrollLeftRef.current = scrollLeft;
    }, [scrollLeft]);

    useEffect(() => {
        pxPerBeatRef.current = pxPerBeat;
        localStorage.setItem("hifishifter.paramPxPerBeat", String(pxPerBeat));
    }, [pxPerBeat]);

    const setPxPerBeatImmediate = useCallback(
        (next: number) => {
            pxPerBeatRef.current = next;
            setPxPerBeat(next);
        },
        [setPxPerBeat],
    );

    // 副参数独立显示开关，默认全部关闭
    const [secondaryParamVisible, setSecondaryParamVisible] = useState<
        Partial<Record<ParamName, boolean>>
    >({});

    const toggleSecondaryParam = useCallback((param: ParamName) => {
        setSecondaryParamVisible((prev) => ({
            ...prev,
            [param]: !(prev[param] ?? false),
        }));
    }, []);

    const [pitchView, setPitchView] = useState<ValueViewport>(() => ({
        center: (PITCH_MIN_MIDI + PITCH_MAX_MIDI) / 2,
        span: PITCH_MAX_MIDI - PITCH_MIN_MIDI,
    }));
    const [tensionView, setTensionView] = useState<ValueViewport>(() => ({
        center: 0.5,
        span: 1,
    }));
    const pitchViewRef = useRef(pitchView);
    const tensionViewRef = useRef(tensionView);

    useEffect(() => {
        pitchViewRef.current = pitchView;
    }, [pitchView]);
    useEffect(() => {
        tensionViewRef.current = tensionView;
    }, [tensionView]);

    const rootTrackId = useMemo(() => {
        return resolveRootTrackId(s.tracks, effectiveSelectedTrackId);
    }, [effectiveSelectedTrackId, s.tracks]);

    const rootTrack = useMemo(() => {
        if (!rootTrackId) return null;
        return s.tracks.find((tr) => tr.id === rootTrackId) ?? null;
    }, [s.tracks, rootTrackId]);

    const pitchHardDisableReason = useMemo(() => {
        if (editParam !== "pitch") return null;
        if (!rootTrack) return null;
        if (!rootTrack.composeEnabled) return t("pitch_requires_compose");
        if (rootTrack.pitchAnalysisAlgo === "none") return t("pitch_requires_algo");
        return null;
    }, [editParam, rootTrack, t]);

    const pitchEnabled = editParam !== "pitch" || pitchHardDisableReason == null;

    const secPerBeat = 60 / Math.max(1e-6, s.bpm);
    const contentWidth = Math.max(
        8,
        Math.ceil(Math.max(1, s.projectBeats) * pxPerBeat),
    );

    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const axisCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const rafRef = useRef<number | null>(null);
    const drawRef = useRef<() => void>(() => {});
    const lastScrollLeftRef = useRef<number | null>(null);
    const scrollStateRafRef = useRef<number | null>(null);

    const rulerContentRef = useRef<HTMLDivElement | null>(null);
    const gridLayerRef = useRef<HTMLDivElement | null>(null);
    const gridBoundaryRef = useRef<HTMLDivElement | null>(null);

    function positiveMod(value: number, mod: number): number {
        if (!Number.isFinite(value) || !Number.isFinite(mod) || mod <= 0)
            return 0;
        const r = value % mod;
        return (r + mod) % mod;
    }

    const viewSizeRef = useRef({ w: 1, h: 1 });
    const [viewSize, setViewSize] = useState({ w: 1, h: 1 });

    useLayoutEffect(() => {
        const el = scrollerRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => {
            const w = Math.max(1, Math.floor(el.clientWidth));
            const h = Math.max(1, Math.floor(el.clientHeight));
            viewSizeRef.current = { w, h };
            setViewSize({ w, h });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const invalidate = useCallback(() => {
        if (rafRef.current != null) return;
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            drawRef.current();
        });
    }, []);

    // The ruler is React-rendered, but the main graph is canvas-rendered.
    // Ensure playhead changes (seek / playback) trigger a redraw.
    useEffect(() => {
        invalidate();
    }, [s.playheadBeat, invalidate]);

    function syncScrollLeft(scroller: HTMLDivElement) {
        const next = scroller.scrollLeft;
        if (
            lastScrollLeftRef.current != null &&
            lastScrollLeftRef.current === next
        ) {
            return;
        }
        lastScrollLeftRef.current = next;
        scrollLeftRef.current = next;

        if (rulerContentRef.current) {
            rulerContentRef.current.style.transform = `translateX(${-next}px)`;
        }

        if (gridLayerRef.current) {
            const weakStepPx = Math.max(
                1e-6,
                pxPerBeatRef.current * gridStepBeats(s.grid),
            );
            const barStepPx = Math.max(
                1e-6,
                pxPerBeatRef.current * Math.max(1, Math.round(s.beats || 4)),
            );
            const weakOffsetPx = -positiveMod(next, weakStepPx);
            const barOffsetPx = -positiveMod(next, barStepPx);
            gridLayerRef.current.style.backgroundPosition = `${weakOffsetPx}px 0px, ${barOffsetPx}px 0px`;
        }

        if (gridBoundaryRef.current) {
            const left = contentWidth - 1 - next;
            gridBoundaryRef.current.style.left = `${left}px`;
            gridBoundaryRef.current.style.opacity =
                left >= -2 && left <= viewSizeRef.current.w + 2 ? "0.9" : "0";
        }

        if (scrollStateRafRef.current == null) {
            scrollStateRafRef.current = requestAnimationFrame(() => {
                scrollStateRafRef.current = null;
                setScrollLeft(scrollLeftRef.current);
            });
        }

        invalidate();
    }

    useLayoutEffect(() => {
        const el = scrollerRef.current;
        if (!el) return;
        syncScrollLeft(el);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contentWidth, s.grid, s.beats]);

    const valueToY = useCallback(
        (param: ParamName, v: number, h: number): number => {
            const H = Math.max(1, h);
            if (param === "pitch") {
                const absMin = PITCH_MIN_MIDI;
                const absMax = PITCH_MAX_MIDI;
                const view = pitchViewRef.current;
                const span = clamp(view.span, 1e-6, absMax - absMin);
                const min = clamp(
                    view.center - span / 2,
                    absMin,
                    absMax - span,
                );
                const t =
                    (clamp(v, absMin, absMax) - min) / Math.max(1e-9, span);
                return (1 - t) * H;
            }

            const view = tensionViewRef.current;
            const span = clamp(view.span, 1e-6, 1);
            const min = clamp(view.center - span / 2, 0, 1 - span);
            const t = (clamp(v, 0, 1) - min) / Math.max(1e-9, span);
            return (1 - t) * H;
        },
        [],
    );

    const yToViewportT = useCallback((y: number, h: number): number => {
        const H = Math.max(1, h);
        return clamp(y / H, 0, 1);
    }, []);

    const yToValue = useCallback(
        (param: ParamName, y: number, h: number): number => {
            const H = Math.max(1, h);
            const t = 1 - clamp(y / H, 0, 1);
            if (param === "pitch") {
                const absMin = PITCH_MIN_MIDI;
                const absMax = PITCH_MAX_MIDI;
                const view = pitchViewRef.current;
                const span = clamp(view.span, 1e-6, absMax - absMin);
                const min = clamp(
                    view.center - span / 2,
                    absMin,
                    absMax - span,
                );
                return clamp(min + t * span, absMin, absMax);
            }
            const view = tensionViewRef.current;
            const span = clamp(view.span, 1e-6, 1);
            const min = clamp(view.center - span / 2, 0, 1 - span);
            return clamp(min + t * span, 0, 1);
        },
        [],
    );

    function clampViewport(param: ParamName, v: ValueViewport): ValueViewport {
        const isLinear = param !== "pitch";
        const absMin = isLinear ? 0 : PITCH_MIN_MIDI;
        const absMax = isLinear ? 1 : PITCH_MAX_MIDI;
        const maxSpan = absMax - absMin;
        const minSpan = isLinear ? 0.05 : 6;
        const span = clamp(v.span, minSpan, maxSpan);
        const center = clamp(v.center, absMin + span / 2, absMax - span / 2);
        return { center, span };
    }

    const selectionRef = useRef<{ aBeat: number; bBeat: number } | null>(null);
    const [selectionUi, setSelectionUi] = useState<{
        aBeat: number;
        bBeat: number;
    } | null>(null);

    const strokeRef = useRef<{
        mode: StrokeMode;
        pointerId: number;
        param: ParamName;
        points: StrokePoint[];
    } | null>(null);

    const panRef = useRef<{
        pointerId: number;
        startClientX: number;
        startClientY: number;
        startScrollLeft: number;
        startView: ValueViewport;
        startRectH: number;
    } | null>(null);

    const clipboardRef = useRef<{
        param: ParamName;
        framePeriodMs: number;
        values: number[];
    } | null>(null);

    // 用于通知 usePianoRollData 当前是否处于 live 编辑状态（pointer down 期间为 true）。
    // pitch_orig_updated 事件到达时若为 true，则延迟曲线刷新到 pointer-up 后执行。
    const liveEditActiveRef = useRef(false);

    const {
        wavePeaks,
        paramView,
        setParamView,
        secondaryParamView,
        bumpRefreshToken,
        refreshNow,
        notifyLiveEditEnded,
        isLoading,
        pitchAnalysisPending,
        pitchAnalysisProgress,
        pitchEditUserModified,
        pitchEditBackendAvailable,
    } = usePianoRollData({
        editParam,
        pitchEnabled,
        paramsEpoch: (s as unknown as { paramsEpoch?: number }).paramsEpoch ?? 0,
        rootTrackId,
        selectedTrackId: effectiveSelectedTrackId,
        tracks: s.tracks,
        secPerBeat,
        scrollLeft,
        pxPerBeat,
        viewWidth: viewSize.w,
        viewSizeRef,
        scrollLeftRef,
        pxPerBeatRef,
        invalidate,
        liveEditActiveRef,
    });

    // Data and viewport changes should always trigger a canvas redraw.
    // usePianoRollData() may call invalidate() before these refs update,
    // so we schedule a follow-up redraw after React commits state.
    useEffect(() => {
        invalidate();
    }, [wavePeaks, paramView, pxPerBeat, viewSize.w, viewSize.h, invalidate]);

    useEffect(() => {
        invalidate();
    }, [pitchView, tensionView, editParam, invalidate]);

    const paramViewRef = useRef<import("./pianoRoll/types").ParamViewSegment | null>(
        null,
    );
    useEffect(() => {
        paramViewRef.current = paramView;
    }, [paramView]);

    const {
        liveEditOverrideRef,
        ensureLiveEditBase,
        applyDenseToLiveEdit,
        commitStroke: commitStrokeBase,
    } = useLiveParamEditing({
        rootTrackId,
        editParam,
        pitchEnabled,
        paramView,
        setParamView,
        bumpRefreshToken,
        invalidate,
    });

    // 包装 commitStroke：在 pointer-up 提交笔画后，清除 liveEditActive 状态，
    // 并触发可能被延迟的 pitch_orig_updated 曲线刷新。
    const commitStroke: typeof commitStrokeBase = useCallback(
        async (points, mode) => {
            await commitStrokeBase(points, mode);
            liveEditActiveRef.current = false;
            notifyLiveEditEnded();
        },
        [commitStrokeBase, notifyLiveEditEnded],
    );

    // Keep draw function always up-to-date (invalidate() is stable and calls drawRef.current()).
    drawRef.current = () => {
        // 确定副参数名称（非当前 editParam 的另一个参数）
        const secondaryParam: ParamName = editParam === "pitch" ? "tension" : "pitch";
        drawPianoRoll({
            axisCanvas: axisCanvasRef.current,
            canvas: canvasRef.current,
            viewSize: viewSizeRef.current,
            editParam,
            pitchView: pitchViewRef.current,
            tensionView: tensionViewRef.current,
            valueToY,
            wavePeaks,
            paramView,
            secondaryParamView,
            showSecondaryParam: secondaryParamVisible[secondaryParam] ?? false,
            overlayText:
                editParam === "pitch" && !pitchEnabled
                    ? pitchHardDisableReason
                    : null,
            liveEditOverride: liveEditOverrideRef.current,
            selection: selectionRef.current,
            pxPerBeat: pxPerBeatRef.current,
            scrollLeft: scrollLeftRef.current,
            secPerBeat,
            playheadBeat: s.playheadBeat,
        });
    };

    const interactions = usePianoRollInteractions({
        dispatch,
        rootTrackId,
        editParam,
        pitchEnabled,
        toolMode: s.toolMode,
        secPerBeat,
        scrollLeftRef,
        pxPerBeatRef,
        setPxPerBeat: setPxPerBeatImmediate,
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
    });

    const onScrollerWheelNative = interactions.onScrollerWheelNative;

    useEffect(() => {
        const el = scrollerRef.current;
        if (!el) return;

        const handler: EventListener = (evt) => {
            onScrollerWheelNative(evt as globalThis.WheelEvent);
        };

        el.addEventListener("wheel", handler, {
            passive: false,
        } as globalThis.AddEventListenerOptions);
        return () => {
            el.removeEventListener("wheel", handler);
        };
    }, [onScrollerWheelNative]);

    // Silence unused state warnings; selectionUi is future UI.
    void selectionUi;

    const showPitchAnalyzingOverlay =
        editParam === "pitch" &&
        pitchEnabled &&
        Boolean(rootTrackId) &&
        pitchAnalysisPending;

    const showOverlay = isLoading || showPitchAnalyzingOverlay;

    const pitchPercent =
        pitchAnalysisProgress != null &&
        Number.isFinite(pitchAnalysisProgress) &&
        pitchAnalysisProgress >= 0
            ? Math.max(
                  0,
                  Math.min(100, Math.round(pitchAnalysisProgress * 100)),
              )
            : null;

    return (
        <Flex
            direction="column"
            className="h-full w-full bg-qt-graph-bg border-t border-qt-border"
        >
            {/* Header / Parameter Switch */}
            <Flex
                align="center"
                justify="between"
                className="h-8 bg-qt-base border-b border-qt-border px-2 shrink-0"
            >
                <Text size="1" weight="bold" color="gray">
                    {t("param_editor")}
                </Text>

                <Flex gap="2" align="center">
                    <Flex gap="1" align="center">
                        <Button
                            size="1"
                            variant={editParam === "pitch" ? "solid" : "soft"}
                            color={editParam === "pitch" ? "grass" : "gray"}
                            onClick={() => dispatch(setEditParam("pitch"))}
                            style={{ cursor: "pointer" }}
                        >
                            {t("pitch")}
                        </Button>
                        {/* 当 editParam 不是 pitch 时，显示 pitch 副参数开关 */}
                        {editParam !== "pitch" && pitchEnabled ? (
                            <IconButton
                                size="1"
                                variant={secondaryParamVisible["pitch"] ? "soft" : "ghost"}
                                color={secondaryParamVisible["pitch"] ? "blue" : "gray"}
                                onClick={() => toggleSecondaryParam("pitch")}
                                style={{ cursor: "pointer" }}
                                title={secondaryParamVisible["pitch"] ? t("hide_secondary_param") : t("show_secondary_param")}
                            >
                                {secondaryParamVisible["pitch"] ? <EyeOpenIcon /> : <EyeClosedIcon />}
                            </IconButton>
                        ) : null}
                        <Button
                            size="1"
                            variant={editParam === "tension" ? "solid" : "soft"}
                            color={editParam === "tension" ? "amber" : "gray"}
                            onClick={() => dispatch(setEditParam("tension"))}
                            style={{ cursor: "pointer" }}
                        >
                            {t("tension")}
                        </Button>
                        {/* 当 editParam 不是 tension 时，显示 tension 副参数开关 */}
                        {editParam !== "tension" ? (
                            <IconButton
                                size="1"
                                variant={secondaryParamVisible["tension"] ? "soft" : "ghost"}
                                color={secondaryParamVisible["tension"] ? "orange" : "gray"}
                                onClick={() => toggleSecondaryParam("tension")}
                                style={{ cursor: "pointer" }}
                                title={secondaryParamVisible["tension"] ? t("hide_secondary_param") : t("show_secondary_param")}
                            >
                                {secondaryParamVisible["tension"] ? <EyeOpenIcon /> : <EyeClosedIcon />}
                            </IconButton>
                        ) : null}
                    </Flex>

                    {editParam === "pitch" ? (
                        <PitchStatusBadge
                            tracks={s.tracks}
                            selectedTrackId={effectiveSelectedTrackId}
                            status={
                                pitchEnabled
                                    ? {
                                          analysisPending: pitchAnalysisPending,
                                          analysisProgress: pitchAnalysisProgress,
                                          pitchEditUserModified,
                                          pitchEditBackendAvailable,
                                      }
                                    : undefined
                            }
                        />
                    ) : null}

                    <IconButton
                        size="1"
                        variant="soft"
                        color="gray"
                        disabled={isLoading || showPitchAnalyzingOverlay}
                        onClick={() => void refreshNow()}
                        style={{ cursor: isLoading ? "default" : "pointer" }}
                        title={t("action_refresh")}
                    >
                        <UpdateIcon />
                    </IconButton>

                    {editParam === "pitch" && rootTrack ? (
                        <Flex align="center" gap="2">
                            <Text size="1" color="gray">
                                Algo
                            </Text>
                            <Select.Root
                                value={
                                    [
                                        "world_dll",
                                        "nsf_hifigan_onnx",
                                        "none",
                                    ].includes(rootTrack.pitchAnalysisAlgo)
                                        ? rootTrack.pitchAnalysisAlgo
                                        : "world_dll"
                                }
                                onValueChange={(v) => {
                                    if (!rootTrackId) return;
                                    dispatch(
                                        setTrackStateRemote({
                                            trackId: rootTrackId,
                                            pitchAnalysisAlgo: v,
                                        }),
                                    );
                                }}
                            >
                                <Select.Trigger className="min-w-[140px]" />
                                <Select.Content>
                                    <Select.Item value="world_dll">
                                        WORLD (DLL)
                                    </Select.Item>
                                    <Select.Item value="nsf_hifigan_onnx">
                                        NSF-HiFiGAN (ONNX)
                                    </Select.Item>
                                    <Select.Item value="none">
                                        {t("none")}
                                    </Select.Item>
                                </Select.Content>
                            </Select.Root>
                        </Flex>
                    ) : null}
                </Flex>
            </Flex>

            {/* Note/Curve Editor Area */}
            <Flex className="flex-1 overflow-hidden relative">
                {/* Left axis + corner */}
                <Flex direction="column" className="shrink-0">
                    <Box
                        className="h-6 bg-qt-window border-b border-qt-border"
                        style={{ width: AXIS_W }}
                    />
                    <div
                        className="bg-qt-window border-r border-qt-border relative"
                        style={{ width: AXIS_W, flex: 1 }}
                    >
                        <canvas
                            ref={axisCanvasRef}
                            className="absolute inset-0"
                        />
                    </div>
                </Flex>

                {/* Right: ruler + scrollable canvas */}
                <Flex direction="column" className="flex-1 min-w-0">
                    <TimeRuler
                        contentWidth={contentWidth}
                        scrollLeft={scrollLeft}
                        bars={(() => {
                            const beatsPerBar = Math.max(
                                1,
                                Math.round(s.beats || 4),
                            );
                            const totalBeats = Math.max(
                                1,
                                Math.ceil(s.projectBeats),
                            );
                            const result: Array<{
                                beat: number;
                                label: string;
                            }> = [];
                            let barIndex = 1;
                            for (
                                let beat = 0;
                                beat <= totalBeats;
                                beat += beatsPerBar
                            ) {
                                result.push({ beat, label: `${barIndex}.1` });
                                barIndex += 1;
                            }
                            return result;
                        })()}
                        pxPerBeat={pxPerBeat}
                        playheadBeat={s.playheadBeat}
                        contentRef={rulerContentRef}
                        onMouseDown={interactions.onRulerMouseDown}
                    />

                    <div
                        ref={scrollerRef}
                        className="flex-1 bg-qt-graph-bg overflow-x-auto overflow-y-hidden relative custom-scrollbar"
                        tabIndex={0}
                        onMouseDownCapture={
                            interactions.onScrollerMouseDownCapture
                        }
                        onAuxClick={interactions.onScrollerAuxClick}
                        onScroll={interactions.onScrollerScroll}
                        onContextMenu={interactions.onScrollerContextMenu}
                        onKeyDown={interactions.onScrollerKeyDown}
                    >
                        {/* Spacer to provide scrollable width (must not consume full height) */}
                        <div
                            className="relative"
                            style={{ width: contentWidth, height: 1 }}
                            aria-hidden
                        />

                        {/* Sticky viewport overlay: grid + canvas do not physically scroll */}
                        <div
                            className="sticky left-0 top-0 h-full"
                            style={{ width: viewSize.w, overflow: "hidden" }}
                        >
                            <div
                                className="relative h-full"
                                style={{ width: viewSize.w }}
                            >
                                <BackgroundGrid
                                    contentWidth={contentWidth}
                                    contentHeight={viewSize.h}
                                    viewportWidth={viewSize.w}
                                    scrollLeft={scrollLeft}
                                    pxPerBeat={pxPerBeat}
                                    grid={s.grid}
                                    beatsPerBar={Math.max(
                                        1,
                                        Math.round(s.beats || 4),
                                    )}
                                    layerRef={gridLayerRef}
                                    boundaryRef={gridBoundaryRef}
                                />

                                <canvas
                                    ref={canvasRef}
                                    className="absolute inset-0"
                                    onPointerDown={
                                        interactions.onCanvasPointerDown
                                    }
                                />
                            </div>
                        </div>
                    </div>
                </Flex>

                {showOverlay ? (
                    <div className="absolute inset-0 z-50 flex items-center justify-center qt-overlay">
                        <div className="flex flex-col items-center gap-2">
                            <Text size="2" color="gray">
                                {showPitchAnalyzingOverlay
                                    ? pitchPercent != null
                                        ? `${t("pitch_analyzing")} ${pitchPercent}%`
                                        : t("pitch_analyzing")
                                    : t("loading")}
                            </Text>
                            {showPitchAnalyzingOverlay ? (
                                <div className="w-64 h-2 bg-qt-surface border border-qt-border rounded overflow-hidden">
                                    <div
                                        className={
                                            "h-full bg-qt-highlight transition-[width] duration-150" +
                                            (pitchPercent == null
                                                ? " animate-pulse"
                                                : "")
                                        }
                                        style={{
                                            width:
                                                pitchPercent != null
                                                    ? `${pitchPercent}%`
                                                    : "15%",
                                            opacity:
                                                pitchPercent != null ? 1 : 0.6,
                                        }}
                                    />
                                </div>
                            ) : null}
                        </div>
                    </div>
                ) : null}
            </Flex>
        </Flex>
    );
};
