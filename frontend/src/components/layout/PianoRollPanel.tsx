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
import { useAppTheme } from "../../theme/AppThemeProvider";
import { getWaveformColors } from "../../theme/waveformColors";

import {
    BackgroundGrid,
    DEFAULT_PX_PER_SEC,
    MAX_PX_PER_SEC,
    MIN_PX_PER_SEC,
    TimeRuler,
    clamp,
    gridStepBeats,
} from "./timeline";

import { AXIS_W, PITCH_MAX_MIDI, PITCH_MIN_MIDI } from "./pianoRoll/constants";
import { drawPianoRoll } from "./pianoRoll/render";
import type { DetectedPitchCurve } from "./pianoRoll/render";
import { usePianoRollData } from "./pianoRoll/usePianoRollData";
import { useClipsPeaksForPianoRoll } from "./pianoRoll/useClipsPeaksForPianoRoll";
import { usePianoRollInteractions } from "./pianoRoll/usePianoRollInteractions";
import { useLiveParamEditing } from "./pianoRoll/useLiveParamEditing";
import type {
    ParamName,
    StrokeMode,
    StrokePoint,
    ValueViewport,
} from "./pianoRoll/types";

import { PitchStatusBadge } from "./PitchStatusBadge";
import { useAsyncPitchRefresh } from "../../hooks/useAsyncPitchRefresh";
import { ProgressBar } from "../ProgressBar";
import { LoadingSpinner } from "../LoadingSpinner";
import { usePitchAnalysis } from "../../contexts/PitchAnalysisContext";
import { usePianoRollStatusUpdate } from "../../contexts/PianoRollStatusContext";

export const PianoRollPanel: React.FC = () => {
    const dispatch = useAppDispatch();
    const { t } = useI18n();
    const s = useAppSelector((state: RootState) => state.session);
    const editParam = s.editParam as ParamName;
    const { mode: themeMode } = useAppTheme();
    const waveformColors = useMemo(
        () => getWaveformColors(themeMode),
        [themeMode],
    );

    // Task 6.3: 集成 useAsyncPitchRefresh Hook
    const asyncRefresh = useAsyncPitchRefresh();
    const [showSuccessMessage, setShowSuccessMessage] = useState(false);



    const effectiveSelectedTrackId = useMemo(() => {
        if (s.selectedTrackId) return s.selectedTrackId;
        const clipId = s.selectedClipId;
        if (!clipId) return null;
        const clip = s.clips.find((c) => c.id === clipId);
        return clip?.trackId ?? null;
    }, [s.selectedTrackId, s.selectedClipId, s.clips]);

    const [scrollLeft, setScrollLeft] = useState(0);
    const [pxPerSec, setPxPerSec] = useState(() => {
        const stored = Number(
            localStorage.getItem("hifishifter.paramPxPerSec"),
        );
        return Number.isFinite(stored) && stored > 0
            ? Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, stored))
            : DEFAULT_PX_PER_SEC;
    });
    // 渲染时根�?BPM 换算 pxPerBeat：pxPerBeat = pxPerSec × (60 / bpm)
    const pxPerBeat = pxPerSec * (60 / Math.max(1e-6, s.bpm));
    const scrollLeftRef = useRef(scrollLeft);
    const pxPerBeatRef = useRef(pxPerBeat);

    // BPM 变化时，按比例调�?scrollLeft，保持视口中心点的秒数不�?
    // scrollLeft_new = scrollLeft_old × (bpm_old / bpm_new)
    const prevBpmRef = useRef(s.bpm);
    useEffect(() => {
        const prevBpm = prevBpmRef.current;
        prevBpmRef.current = s.bpm;
        if (Math.abs(prevBpm - s.bpm) < 1e-9) return;
        const ratio = prevBpm / Math.max(1e-6, s.bpm);
        const newScrollLeft = scrollLeftRef.current * ratio;
        scrollLeftRef.current = newScrollLeft;
        setScrollLeft(newScrollLeft);
    }, [s.bpm]);

    useEffect(() => {
        scrollLeftRef.current = scrollLeft;
    }, [scrollLeft]);

    useEffect(() => {
        pxPerBeatRef.current = pxPerBeat;
        localStorage.setItem("hifishifter.paramPxPerSec", String(pxPerSec));
    }, [pxPerBeat, pxPerSec]);

    const setPxPerBeatImmediate = useCallback(
        (next: number) => {
            // next 是新�?pxPerBeat，需要反推回 pxPerSec
            const nextPxPerSec = next / (60 / Math.max(1e-6, s.bpm));
            pxPerBeatRef.current = next;
            setPxPerSec(nextPxPerSec);
        },
        [s.bpm, setPxPerSec],
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

    // 收集轨道组内所有 trackId（root + 递归所有子轨道）
    const groupTrackIds = useMemo(() => {
        const ids = new Set<string>();
        if (!rootTrackId) return ids;
        ids.add(rootTrackId);
        const frontier = [rootTrackId];
        let idx = 0;
        while (idx < frontier.length) {
            const cur = frontier[idx++];
            const track = s.tracks.find((t) => t.id === cur);
            if (track?.childTrackIds) {
                for (const childId of track.childTrackIds) {
                    if (!ids.has(childId)) {
                        ids.add(childId);
                        frontier.push(childId);
                    }
                }
            }
        }
        return ids;
    }, [rootTrackId, s.tracks]);

    const pitchHardDisableReason = useMemo(() => {
        if (editParam !== "pitch") return null;
        if (!rootTrack) return null;
        if (!rootTrack.composeEnabled) return t("pitch_requires_compose");
        if (rootTrack.pitchAnalysisAlgo === "none")
            return t("pitch_requires_algo");
        return null;
    }, [editParam, rootTrack, t]);

    const pitchEnabled =
        editParam !== "pitch" || pitchHardDisableReason == null;



    const secPerBeat = 60 / Math.max(1e-6, s.bpm);
    const contentWidth = Math.max(8, Math.ceil(s.projectSec * pxPerSec));

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
    }, [s.playheadSec, invalidate]);

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

    // 从全局 Context 读取 pitch 分析进度状态（�?PitchAnalysisProvider 统一管理�?
    const pitchAnalysis = usePitchAnalysis();
    const pitchAnalysisPending = pitchAnalysis.pending;
    const pitchAnalysisProgress = pitchAnalysis.progress;

    // 将 PianoRoll 加载状态同步到全局 Context（供 status bar 使用）
    const updatePianoRollStatus = usePianoRollStatusUpdate();

    // 用于通知 usePianoRollData 当前是否处于 live 编辑状态（pointer down 期间�?true）�?
    // pitch_orig_updated 事件到达时若�?true，则延迟曲线刷新�?pointer-up 后执行�?
    const liveEditActiveRef = useRef(false);

    const {
        paramView,
        setParamView,
        secondaryParamView,
        bumpRefreshToken,
        refreshNow,
        notifyLiveEditEnded,
        isLoading,
        pitchEditUserModified,
        pitchEditBackendAvailable,
    } = usePianoRollData({
        editParam,
        pitchEnabled,
        paramsEpoch:
            (s as unknown as { paramsEpoch?: number }).paramsEpoch ?? 0,
        rootTrackId,
        selectedTrackId: effectiveSelectedTrackId,
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

    // 获取当前 track 下的所�?clips，用�?per-clip 波形叠加绘制
    // 获取轨道组内所有 clips（包含 root 轨道及所有子轨道的 clip）
    const trackClips = useMemo(
        () => s.clips.filter((c) => groupTrackIds.has(c.trackId)),
        [s.clips, groupTrackIds],
    );

    // 可见区域的 sec 范围（统一用 sec 坐标系）
    const visibleStartSec = scrollLeft / Math.max(1e-9, pxPerSec);
    const visibleEndSec = visibleStartSec + viewSize.w / Math.max(1e-9, pxPerSec);

    // Per-clip 波形 peaks（替代原来的 mix 波形）
    const clipPeaks = useClipsPeaksForPianoRoll({
        clips: trackClips,
        visibleStartSec,
        visibleEndSec,
        secPerBeat,
    });
    // Data and viewport changes should always trigger a canvas redraw.
    // usePianoRollData() may call invalidate() before these refs update,
    // so we schedule a follow-up redraw after React commits state.
    useEffect(() => {
        invalidate();
    }, [clipPeaks, paramView, pxPerBeat, viewSize.w, viewSize.h, invalidate]);

    useEffect(() => {
        invalidate();
    }, [pitchView, tensionView, editParam, invalidate]);

    // 检测音高曲线更新时触发重绘（必须在 detectedPitchCurves 声明之后�?
    // useEffect 已移�?detectedPitchCurves useMemo 定义之后，见下方�?

    const paramViewRef = useRef<
        import("./pianoRoll/types").ParamViewSegment | null
    >(null);
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
    // 并触发可能被延迟�?pitch_orig_updated 曲线刷新�?
    const commitStroke: typeof commitStrokeBase = useCallback(
        async (points, mode) => {
            await commitStrokeBase(points, mode);
            liveEditActiveRef.current = false;
            notifyLiveEditEnded();
        },
        [commitStrokeBase, notifyLiveEditEnded],
    );

    // C 键按下时才显示 detectedPitchCurve
    const [cKeyDown, setCKeyDown] = useState(false);
    const cKeyDownRef = useRef(false);

    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (e.key === "c" || e.key === "C") {
                if (!cKeyDownRef.current) {
                    cKeyDownRef.current = true;
                    setCKeyDown(true);
                }
            }
        }
        function onKeyUp(e: KeyboardEvent) {
            if (e.key === "c" || e.key === "C") {
                cKeyDownRef.current = false;
                setCKeyDown(false);
            }
        }
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("keyup", onKeyUp);
        };
    }, []);

    // 从 store 中的 clipPitchCurves 转换为 DetectedPitchCurve[] 供 drawPianoRoll 使用。
    // 仅在 pitch 模式下且 C 键按下时有意义，其他情况下传空数组以避免不必要的计算。
    const detectedPitchCurves = useMemo((): DetectedPitchCurve[] => {
        if (editParam !== "pitch") return [];
        if (!cKeyDown) return [];        return Object.entries(s.clipPitchCurves)
            .filter(([clipId]) => {
                // 只保留属于当前轨道组内的 clip，显示 root 及所有子轨道的 detected curve
                const clip = s.clips.find((cl) => cl.id === clipId);
                return clip && groupTrackIds.has(clip.trackId);
            })
            .map(([clipId, c]) => {
                // 通过 clipId 查找对应 clip 的当前 startSec 和 lengthSec，用于裁剪渲染区域
                const clip = s.clips.find((cl) => cl.id === clipId);
                return {
                    curveStartSec: c.curveStartSec,
                    midiCurve: c.midiCurve,
                    framePeriodMs: c.framePeriodMs,
                    clipStartSec: clip ? Number(clip.startSec ?? 0) : c.curveStartSec,
                    clipLengthSec: clip ? Number(clip.lengthSec ?? 0) : Infinity,
                };
            });
    }, [editParam, cKeyDown, s.clipPitchCurves, s.clips, groupTrackIds]);

    // 检测音高曲线更新时触发重绘
    useEffect(() => {
        invalidate();
    }, [detectedPitchCurves, invalidate]);

    // Keep draw function always up-to-date (invalidate() is stable and calls drawRef.current()).
    drawRef.current = () => {
        // 确定副参数名称（非当�?editParam 的另一个参数）
        const secondaryParam: ParamName =
            editParam === "pitch" ? "tension" : "pitch";
        drawPianoRoll({
            axisCanvas: axisCanvasRef.current,
            canvas: canvasRef.current,
            viewSize: viewSizeRef.current,
            editParam,
            pitchView: pitchViewRef.current,
            tensionView: tensionViewRef.current,
            valueToY,
            clipPeaks,
            paramView,
            secondaryParamView,
            showSecondaryParam: secondaryParamVisible[secondaryParam] ?? false,
            overlayText:
                editParam === "pitch" && !pitchEnabled
                    ? pitchHardDisableReason
                    : null,
            liveEditOverride: liveEditOverrideRef.current,
            selection: selectionRef.current,
            pxPerSec,
            scrollLeft: scrollLeftRef.current,
            secPerBeat,
            playheadSec: s.playheadSec,
            waveformColors,
            detectedPitchCurves,
        });
    };

    const interactions = usePianoRollInteractions({
        dispatch,
        rootTrackId,
        editParam,
        pitchEnabled,
        toolMode: s.toolMode,
        secPerBeat,
        bpm: s.bpm,
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

    // 同步 isLoading 和 asyncRefresh 状态到全局 Context
    useEffect(() => {
        updatePianoRollStatus({
            dataLoading: isLoading,
            asyncRefreshActive: asyncRefresh.isLoading,
            asyncRefreshProgress: asyncRefresh.progress,
            asyncRefreshStatus: asyncRefresh.status,
            asyncRefreshError: asyncRefresh.error,
        });
    }, [
        isLoading,
        asyncRefresh.isLoading,
        asyncRefresh.progress,
        asyncRefresh.status,
        asyncRefresh.error,
        updatePianoRollStatus,
    ]);

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
                        {/* �?editParam 不是 pitch 时，显示 pitch 副参数开�?*/}
                        {editParam !== "pitch" && pitchEnabled ? (
                            <IconButton
                                size="1"
                                variant={
                                    secondaryParamVisible["pitch"]
                                        ? "soft"
                                        : "ghost"
                                }
                                color={
                                    secondaryParamVisible["pitch"]
                                        ? "blue"
                                        : "gray"
                                }
                                onClick={() => toggleSecondaryParam("pitch")}
                                style={{ cursor: "pointer" }}
                                title={
                                    secondaryParamVisible["pitch"]
                                        ? t("hide_secondary_param")
                                        : t("show_secondary_param")
                                }
                            >
                                {secondaryParamVisible["pitch"] ? (
                                    <EyeOpenIcon />
                                ) : (
                                    <EyeClosedIcon />
                                )}
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
                        {/* �?editParam 不是 tension 时，显示 tension 副参数开�?*/}
                        {editParam !== "tension" ? (
                            <IconButton
                                size="1"
                                variant={
                                    secondaryParamVisible["tension"]
                                        ? "soft"
                                        : "ghost"
                                }
                                color={
                                    secondaryParamVisible["tension"]
                                        ? "orange"
                                        : "gray"
                                }
                                onClick={() => toggleSecondaryParam("tension")}
                                style={{ cursor: "pointer" }}
                                title={
                                    secondaryParamVisible["tension"]
                                        ? t("hide_secondary_param")
                                        : t("show_secondary_param")
                                }
                            >
                                {secondaryParamVisible["tension"] ? (
                                    <EyeOpenIcon />
                                ) : (
                                    <EyeClosedIcon />
                                )}
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
                                          analysisProgress:
                                              pitchAnalysisProgress,
                                          pitchEditUserModified,
                                          pitchEditBackendAvailable,
                                      }
                                    : undefined
                            }
                        />
                    ) : null}

                    {/* Task 6.4: 刷新按钮修改为调�?startRefresh() */}
                    <IconButton
                        size="1"
                        variant="soft"
                        color="gray"
                        disabled={
                            isLoading ||
                            pitchAnalysisPending ||
                            asyncRefresh.isLoading
                        }
                        onClick={async () => {
                            if (!rootTrackId) return;
                            await asyncRefresh.startRefresh(rootTrackId);
                            // Task 6.7: 任务完成后显�?1 秒成功提�?
                            if (asyncRefresh.status === "completed") {
                                setShowSuccessMessage(true);
                                setTimeout(
                                    () => setShowSuccessMessage(false),
                                    1000,
                                );
                            }
                            // 同时触发传统刷新以更�?UI（后续可优化为由后端事件驱动�?
                            void refreshNow();
                        }}
                        style={{
                            cursor:
                                isLoading || asyncRefresh.isLoading
                                    ? "default"
                                    : "pointer",
                        }}
                        title={t("action_refresh")}
                    >
                        {asyncRefresh.isLoading ? (
                            <LoadingSpinner size="sm" />
                        ) : (
                            <UpdateIcon />
                        )}
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
                                        world
                                    </Select.Item>
                                    <Select.Item value="nsf_hifigan_onnx">
                                        nsf-hifigan
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

            {/* Task 6.5: 参数面板顶部添加进度条区�?*/}
            {asyncRefresh.isLoading && (
                <Flex className="px-3 py-2 bg-qt-base border-b border-qt-border">
                    <ProgressBar
                        percentage={asyncRefresh.progress}
                        label={
                            (t as any)("refreshing_pitch_data") ||
                            "Refreshing pitch data"
                        }
                        showCancel={true}
                        onCancel={async () => {
                            // Task 6.6: 取消按钮点击时调�?cancelRefresh()
                            await asyncRefresh.cancelRefresh();
                        }}
                        estimatedRemaining={asyncRefresh.estimatedRemaining}
                    />
                </Flex>
            )}

            {/* Task 6.7: 任务完成后显示成功提�?*/}
            {showSuccessMessage && (
                <Flex
                    align="center"
                    gap="2"
                    className="px-3 py-2 bg-green-900/20 border-b border-green-700 text-green-300 text-sm"
                >
                    <span>&#x2713;</span>
                    <span></span>
                </Flex>
            )}

            {/* Task 6.8: 任务失败时显示错误消息和重试按钮 */}
            {asyncRefresh.status === "failed" && asyncRefresh.error && (
                <Flex
                    align="center"
                    justify="between"
                    className="px-3 py-2 bg-red-900/20 border-b border-red-700 text-red-300 text-sm"
                >
                    <span></span>
                    <Button
                        size="1"
                        variant="soft"
                        color="red"
                        onClick={() =>
                            rootTrackId &&
                            void asyncRefresh.startRefresh(rootTrackId)
                        }
                    >
                        {(t as any)("retry") || "Retry"}
                    </Button>
                </Flex>
            )}

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
                            const totalBeats = Math.max(1, Math.ceil(s.projectSec / secPerBeat));
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
                        pxPerSec={pxPerSec}
                        secPerBeat={secPerBeat}
                        playheadSec={s.playheadSec}
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

            </Flex>
        </Flex>
    );
};
