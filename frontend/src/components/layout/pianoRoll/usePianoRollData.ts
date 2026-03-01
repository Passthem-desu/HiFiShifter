import { useEffect, useRef, useState } from "react";

import type { ParamFramesPayload } from "../../../types/api";
import { paramsApi, waveformApi } from "../../../services/api";
import { clamp } from "../timeline";

import type { ParamName, ParamViewSegment, WavePeaksSegment } from "./types";
import {
    lruGet,
    lruSet,
    ROOT_MIX_CACHE_LIMIT,
    rootMixPeaksCache,
    rootMixPeaksInflight,
} from "./peaksCache";
import { framesToTime, timeToFrame } from "./utils";
const paramFramePeriodCache = new Map<string, number>();

export function usePianoRollData(args: {
    editParam: ParamName;
    pitchEnabled: boolean;
    paramsEpoch: number;
    rootTrackId: string | null;
    selectedTrackId: string | null;
    tracks: Array<{ id: string; parentId?: string | null }>;
    secPerBeat: number;
    scrollLeft: number;
    pxPerBeat: number;
    viewWidth: number;
    viewSizeRef: React.MutableRefObject<{ w: number; h: number }>;
    scrollLeftRef: React.MutableRefObject<number>;
    pxPerBeatRef: React.MutableRefObject<number>;
    invalidate: () => void;
    /** 外部通知当前是否正在进行 live 编辑（pointer down 期间为 true）。
     *  为 true 时，pitch_orig_updated 触发的曲线刷新会被推迟到 pointer-up 后执行。 */
    liveEditActiveRef?: React.MutableRefObject<boolean>;
}) {
    const {
        editParam,
        pitchEnabled,
        paramsEpoch,
        rootTrackId,
        selectedTrackId,
        tracks,
        secPerBeat,
        scrollLeft,
        pxPerBeat,
        viewWidth,
        viewSizeRef,
        scrollLeftRef,
        pxPerBeatRef,
        invalidate,
        liveEditActiveRef: externalLiveEditActiveRef,
    } = args;

    // 内部 fallback：若外部未传入 liveEditActiveRef，则使用内部 ref（始终为 false）。
    const internalLiveEditActiveRef = useRef(false);
    const liveEditActiveRef =
        externalLiveEditActiveRef ?? internalLiveEditActiveRef;

    // 当 pitch_orig_updated 到达时若正在编辑，将刷新推迟到 pointer-up 后执行。
    const pendingPitchUpdatedRefreshRef = useRef(false);
    const [wavePeaks, setWavePeaks] = useState<WavePeaksSegment | null>(null);
    const [paramView, setParamView] = useState<ParamViewSegment | null>(null);
    // 副参数曲线（仅 edit，用于叠加显示）
    const [secondaryParamView, setSecondaryParamView] =
        useState<ParamViewSegment | null>(null);
    const secondaryFetchReqIdRef = useRef(0);

    const [pitchAnalysisPending, setPitchAnalysisPending] = useState(false);
    const [pitchAnalysisProgress, setPitchAnalysisProgress] = useState<
        number | null
    >(null);

    const [pitchEditUserModified, setPitchEditUserModified] = useState<
        boolean | null
    >(null);
    const [pitchEditBackendAvailable, setPitchEditBackendAvailable] = useState<
        boolean | null
    >(null);

    const [isRefreshing, setIsRefreshing] = useState(false);
    const [loadingCount, setLoadingCount] = useState(0);
    const isLoading = loadingCount > 0;

    function beginLoading() {
        setLoadingCount((c) => c + 1);
    }
    function endLoading() {
        setLoadingCount((c) => Math.max(0, c - 1));
    }

    const fpRetryRef = useRef<Set<string>>(new Set());

    const paramViewRef = useRef<ParamViewSegment | null>(null);
    useEffect(() => {
        paramViewRef.current = paramView;
    }, [paramView]);

    const fetchDebounceRef = useRef<number | null>(null);
    const fetchReqIdRef = useRef(0);
    const [refreshToken, setRefreshToken] = useState(0);

    const [forceParamFetchToken, setForceParamFetchToken] = useState(0);
    const lastAppliedForceParamFetchTokenRef = useRef(0);

    function hasTauriInvoke(): boolean {
        const w = window as unknown as {
            __TAURI__?: { core?: { invoke?: unknown }; invoke?: unknown };
        };
        return (
            typeof w.__TAURI__?.core?.invoke === "function" ||
            typeof w.__TAURI__?.invoke === "function"
        );
    }

    // Force parameter refresh when the session state changes meaningfully (undo/redo/timeline edits).
    // 同时清除旧曲线数据，避免旧数据在新数据到达前短暂显示（也修复初次导入后曲线不显示的问题）。
    useEffect(() => {
        if (!rootTrackId) return;
        setParamView(null);
        setSecondaryParamView(null);
        setForceParamFetchToken((x) => x + 1);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [paramsEpoch, rootTrackId]);

    const pitchPollDelayMsRef = useRef(250);

    // In pywebview (no Tauri events), poll pitch analysis completion while pending.
    useEffect(() => {
        if (editParam !== "pitch") return;
        if (!pitchEnabled) return;
        if (!rootTrackId) return;
        if (hasTauriInvoke()) return;

        if (!pitchAnalysisPending) {
            pitchPollDelayMsRef.current = 250;
            return;
        }

        const delay = clamp(pitchPollDelayMsRef.current, 100, 1500);
        const id = window.setTimeout(() => {
            setForceParamFetchToken((x) => x + 1);
            pitchPollDelayMsRef.current = Math.min(
                1000,
                Math.round(pitchPollDelayMsRef.current * 1.6),
            );
        }, delay);

        return () => {
            window.clearTimeout(id);
        };
    }, [editParam, pitchEnabled, rootTrackId, pitchAnalysisPending]);

    // Listen for backend pitch analysis lifecycle notifications (Tauri only).
    useEffect(() => {
        let disposed = false;
        let unlistenUpdated: null | (() => void) = null;
        let unlistenStarted: null | (() => void) = null;
        let unlistenProgress: null | (() => void) = null;

        async function setup() {
            if (editParam !== "pitch") return;
            if (!pitchEnabled) return;
            if (!rootTrackId) return;
            try {
                const mod = await import("@tauri-apps/api/event");

                type PitchOrigUpdatedPayload = { rootTrackId?: string };
                type PitchOrigAnalysisStartedPayload = { rootTrackId?: string };
                type PitchOrigAnalysisProgressPayload = {
                    rootTrackId?: string;
                    progress?: number;
                };

                unlistenUpdated = await mod.listen<PitchOrigUpdatedPayload>(
                    "pitch_orig_updated",
                    (event) => {
                        if (disposed) return;
                        const payload = event.payload ?? {};
                        if (
                            payload?.rootTrackId &&
                            payload.rootTrackId !== rootTrackId
                        )
                            return;

                        setPitchAnalysisPending(false);
                        setPitchAnalysisProgress(null);

                        // 若用户正在绘制曲线（pointer down），推迟曲线刷新到 pointer-up 后，
                        // 避免后端分析结果覆盖用户正在绘制的 liveEditOverride 内容。
                        if (liveEditActiveRef.current) {
                            pendingPitchUpdatedRefreshRef.current = true;
                        } else {
                            // 清空波形缓存，强制重新拉取以同步音高分析后的数据
                            setWavePeaks(null);
                            setForceParamFetchToken((x) => x + 1);
                            setRefreshToken((x) => x + 1);
                        }
                    },
                );

                unlistenStarted =
                    await mod.listen<PitchOrigAnalysisStartedPayload>(
                        "pitch_orig_analysis_started",
                        (event) => {
                            if (disposed) return;
                            const payload = event.payload ?? {};
                            if (
                                payload?.rootTrackId &&
                                payload.rootTrackId !== rootTrackId
                            )
                                return;
                            setPitchAnalysisPending(true);
                            setPitchAnalysisProgress(0);
                        },
                    );

                unlistenProgress =
                    await mod.listen<PitchOrigAnalysisProgressPayload>(
                        "pitch_orig_analysis_progress",
                        (event) => {
                            if (disposed) return;
                            const payload = event.payload ?? {};
                            if (
                                payload?.rootTrackId &&
                                payload.rootTrackId !== rootTrackId
                            )
                                return;
                            const p = Number(payload?.progress);
                            if (!Number.isFinite(p)) return;
                            const pp = Math.max(0, Math.min(1, p));
                            setPitchAnalysisPending(true);
                            setPitchAnalysisProgress(pp);
                        },
                    );
            } catch {
                // Safe no-op: browser/pywebview builds won't have the Tauri API.
            }
        }

        void setup();

        return () => {
            disposed = true;
            if (unlistenUpdated) unlistenUpdated();
            if (unlistenStarted) unlistenStarted();
            if (unlistenProgress) unlistenProgress();
        };
    }, [editParam, pitchEnabled, rootTrackId]);

    useEffect(() => {
        if (editParam !== "pitch") return;
        if (pitchEnabled) return;
        setParamView(null);
        setPitchAnalysisPending(false);
        setPitchAnalysisProgress(null);
        setPitchEditUserModified(null);
        setPitchEditBackendAvailable(null);
    }, [editParam, pitchEnabled]);

    // 当 editParam 切换时，清除副参数缓存
    useEffect(() => {
        setSecondaryParamView(null);
    }, [editParam, rootTrackId]);

    function computeVisibleRequest() {
        const debug =
            typeof window !== "undefined" &&
            window.localStorage?.getItem("hifishifter.debugPianoRoll") === "1";

        const trackId = rootTrackId;
        if (!trackId) {
            if (debug) {
                // eslint-disable-next-line no-console
                console.debug("[PianoRollData] no rootTrackId; skip fetch");
            }
            return null;
        }

        const selected = selectedTrackId
            ? (tracks.find((tr) => tr.id === selectedTrackId) ?? null)
            : null;
        const waveTrackId = selected?.parentId ?? selected?.id ?? trackId;

        const { w } = viewSizeRef.current;
        const colsRaw = clamp(Math.floor(w), 16, 8192);
        const cols = clamp(Math.round(colsRaw / 64) * 64, 64, 1024);

        const sl = scrollLeftRef.current;
        const ppb = pxPerBeatRef.current;
        const startBeat = sl / Math.max(1e-9, ppb);
        const durBeats = w / Math.max(1e-9, ppb);
        const startSec = startBeat * secPerBeat;
        const durSec = durBeats * secPerBeat;

        const visibleStartSec = startSec;
        const visibleDurSec = Math.max(1e-6, durSec);
        const visibleEndSec = visibleStartSec + visibleDurSec;

        const quantStepSec = 0.02;
        const q = (x: number) => {
            const step = Math.max(1e-6, quantStepSec);
            return Math.round(x / step) * step;
        };

        const waveCoversVisible =
            wavePeaks != null &&
            wavePeaks.key.startsWith(`${waveTrackId}|`) &&
            wavePeaks.startSec <= visibleStartSec &&
            wavePeaks.startSec + wavePeaks.durSec >= visibleEndSec;

        const marginSec = visibleDurSec * 2;
        const covStartSec = Math.max(0, visibleStartSec - marginSec);
        const covDurSec = visibleDurSec + 2 * marginSec;
        const covCols = clamp(
            Math.round(((cols * (covDurSec / visibleDurSec)) / 64) * 64),
            64,
            2048,
        );

        const startSecQ = Math.max(0, q(covStartSec));
        const durSecQ = Math.max(quantStepSec, q(covDurSec));

        const waveKey = `${waveTrackId}|${startSecQ.toFixed(3)}|${durSecQ.toFixed(3)}|${covCols}`;

        const waveHit = !waveCoversVisible
            ? lruGet(rootMixPeaksCache, waveKey)
            : null;
        if (waveHit) {
            setWavePeaks({
                key: waveKey,
                startSec: startSecQ,
                durSec: durSecQ,
                columns: covCols,
                min: waveHit.min,
                max: waveHit.max,
            });
        }

        const shouldFetchWave = !waveCoversVisible && waveHit == null;

        const fpKey = `${trackId}|${editParam}`;
        const cachedFp = paramFramePeriodCache.get(fpKey);
        const pvForFp = paramViewRef.current;
        const pvFp =
            pvForFp && pvForFp.key.startsWith(`${trackId}|${editParam}|`)
                ? pvForFp.framePeriodMs
                : null;
        const fpMs = Number(cachedFp ?? pvFp ?? 5) || 5;

        const paramCoversVisible = (() => {
            const pv = paramViewRef.current;
            if (!pv) return false;
            // Check version to invalidate old cache with wrong coordinate calculations
            if (!pv.key.startsWith(`v2|${trackId}|${editParam}|`)) return false;
            const fp = Math.max(1e-6, pv.framePeriodMs);
            const step = Math.max(1, Math.floor(pv.stride));
            const startSecPv = framesToTime(pv.startFrame, fp);
            const endFramePv = pv.startFrame + (pv.orig.length - 1) * step;
            const endSecPv = framesToTime(endFramePv, fp);
            return startSecPv <= visibleStartSec && endSecPv >= visibleEndSec;
        })();

        const paramMarginSec = visibleDurSec;
        const covParamStartSec = Math.max(0, visibleStartSec - paramMarginSec);
        const covParamDurSec = visibleDurSec + 2 * paramMarginSec;
        const paramStartSecQ = Math.max(0, q(covParamStartSec));
        const paramDurSecQ = Math.max(quantStepSec, q(covParamDurSec));

        // DEBUG: Log data request parameters
        const debugEnabled =
            typeof window !== "undefined" &&
            window.localStorage?.getItem("hifishifter.debugPianoRoll") === "1";

        if (debugEnabled) {
            console.log("[usePianoRollData] Request params:", {
                trackId,
                editParam,
                visibleStartSec,
                visibleDurSec,
                visibleEndSec,
                paramMarginSec,
                covParamStartSec,
                covParamDurSec,
                paramStartSecQ,
                paramDurSecQ,
                framePeriodMs: fpMs,
            });
        }

        // CRITICAL FIX: Use unquantized time for precise frame calculation
        // Quantization is only for cache alignment, not coordinate calculation
        const startFrame = Math.max(0, timeToFrame(covParamStartSec, fpMs));
        // Request full-resolution curve by default.
        // With fp=5ms, even tens of seconds are only a few thousand samples.
        const viewFrames = clamp(
            Math.max(
                1,
                // Use unquantized duration for frame count calculation
                timeToFrame(covParamStartSec + covParamDurSec, fpMs) -
                    startFrame +
                    1,
            ),
            1,
            200_000,
        );
        const stride = 1;
        const frameCount = viewFrames;
        // Version 2: Fixed coordinate calculation to use unquantized time
        const paramKey = `v2|${trackId}|${editParam}|${startFrame}|${frameCount}|${stride}`;

        // 副参数：另一个参数（pitch <-> tension）
        const secondaryParam: ParamName =
            editParam === "pitch" ? "tension" : "pitch";
        const secondaryFpKey = `${trackId}|${secondaryParam}`;
        const secondaryCachedFp = paramFramePeriodCache.get(secondaryFpKey);
        const secondaryFpMs = Number(secondaryCachedFp ?? 5) || 5;
        // CRITICAL FIX: Use unquantized time for secondary param as well
        const secondaryStartFrame = Math.max(
            0,
            timeToFrame(covParamStartSec, secondaryFpMs),
        );
        const secondaryFrameCount = clamp(
            Math.max(
                1,
                timeToFrame(covParamStartSec + covParamDurSec, secondaryFpMs) -
                    secondaryStartFrame +
                    1,
            ),
            1,
            200_000,
        );
        const secondaryParamKey = `v2|${trackId}|${secondaryParam}|${secondaryStartFrame}|${secondaryFrameCount}|${stride}`;

        return {
            debug,
            trackId,
            waveTrackId,
            waveHit,
            shouldFetchWave,
            waveKey,
            startSecQ,
            durSecQ,
            covCols,
            paramCoversVisible,
            paramKey,
            startFrame,
            frameCount,
            stride,
            fpMs,
            fpKey,
            forceParamFetchToken,
            secondaryParam,
            secondaryFpKey,
            secondaryFpMs,
            secondaryStartFrame,
            secondaryFrameCount,
            secondaryParamKey,
        };
    }

    async function refreshVisible() {
        const req = computeVisibleRequest();
        if (!req) return;

        const {
            debug,
            trackId,
            waveTrackId,
            waveHit,
            shouldFetchWave,
            waveKey,
            startSecQ,
            durSecQ,
            covCols,
            paramCoversVisible,
            paramKey,
            startFrame,
            frameCount,
            stride,
            fpMs,
            fpKey,
            forceParamFetchToken: localForceParamFetchToken,
        } = req;

        if (waveHit) {
            setWavePeaks({
                key: waveKey,
                startSec: startSecQ,
                durSec: durSecQ,
                columns: covCols,
                min: waveHit.min,
                max: waveHit.max,
            });
        }

        const waveP = shouldFetchWave
            ? (rootMixPeaksInflight.get(waveKey) ??
              (async () => {
                  const res = await waveformApi.getTrackMixWaveformPeaksSegment(
                      waveTrackId,
                      startSecQ,
                      durSecQ,
                      covCols,
                  );
                  return res;
              })())
            : null;
        if (waveP) rootMixPeaksInflight.set(waveKey, waveP);

        const reqId = ++fetchReqIdRef.current;

        if (waveP) {
            void (async () => {
                beginLoading();
                try {
                    const res = await waveP;
                    if (fetchReqIdRef.current !== reqId) return;
                    if (!res?.ok) {
                        if (debug) {
                            // eslint-disable-next-line no-console
                            console.debug("[PianoRollData] wavePeaks not ok", {
                                waveTrackId,
                                waveKey,
                                res,
                            });
                        }
                        return;
                    }
                    const min = (res.min ?? []).map((v) => Number(v) || 0);
                    const max = (res.max ?? []).map((v) => Number(v) || 0);

                    // DEBUG: 验证返回数据长度
                    console.log("[WavePeaks] API response:", {
                        requestedStartSec: startSecQ,
                        requestedDurSec: durSecQ,
                        requestedColumns: covCols,
                        actualMinLength: min.length,
                        actualMaxLength: max.length,
                        mismatch:
                            min.length !== covCols || max.length !== covCols,
                    });

                    lruSet(
                        rootMixPeaksCache,
                        waveKey,
                        { min, max, t: Date.now() },
                        ROOT_MIX_CACHE_LIMIT,
                    );
                    rootMixPeaksInflight.delete(waveKey);
                    setWavePeaks({
                        key: waveKey,
                        startSec: startSecQ,
                        durSec: durSecQ,
                        columns: covCols,
                        min,
                        max,
                    });
                    invalidate();
                } catch {
                    rootMixPeaksInflight.delete(waveKey);
                } finally {
                    endLoading();
                }
            })();
        }

        if (editParam === "pitch" && !pitchEnabled) {
            // Skip pitch fetch when disabled; waveform still updates.
            return;
        }

        const forceParam =
            localForceParamFetchToken !==
            lastAppliedForceParamFetchTokenRef.current;
        const shouldFetchParam = !paramCoversVisible || forceParam;

        // 副参数异步加载（独立请求，不影响主参数刷新逻辑）
        void (async () => {
            const secReqId = ++secondaryFetchReqIdRef.current;
            // pitch 副参数需要 pitchEnabled（若 editParam 为 tension，pitch 作为副参数时检查）
            const secondaryPitchEnabled =
                req.secondaryParam !== "pitch" ||
                (() => {
                    // 复用外部 pitchEnabled 逻辑：只要 rootTrack 允许 pitch 分析即可
                    return pitchEnabled || editParam === "pitch";
                })();
            if (!secondaryPitchEnabled && req.secondaryParam === "pitch")
                return;
            try {
                const res = await paramsApi.getParamFrames(
                    req.trackId,
                    req.secondaryParam,
                    req.secondaryStartFrame,
                    req.secondaryFrameCount,
                    stride,
                );
                if (secondaryFetchReqIdRef.current !== secReqId) return;
                if (!res?.ok) return;
                const payload = res as ParamFramesPayload;
                const fpRes =
                    Number(payload.frame_period_ms ?? req.secondaryFpMs) ||
                    req.secondaryFpMs;
                paramFramePeriodCache.set(req.secondaryFpKey, fpRes);
                setSecondaryParamView({
                    key: req.secondaryParamKey,
                    framePeriodMs: fpRes,
                    startFrame:
                        Number(
                            payload.start_frame ?? req.secondaryStartFrame,
                        ) || req.secondaryStartFrame,
                    stride,
                    orig: [],
                    edit: (payload.edit ?? []).map((v) => Number(v) || 0),
                });
                invalidate();
            } catch {
                // ignore
            }
        })();

        if (shouldFetchParam) {
            void (async () => {
                const debugEnabled =
                    typeof window !== "undefined" &&
                    window.localStorage?.getItem(
                        "hifishifter.debugPianoRoll",
                    ) === "1";
                beginLoading();
                try {
                    if (debugEnabled) {
                        console.log(
                            "[usePianoRollData] Fetching param frames:",
                            {
                                trackId,
                                editParam,
                                startFrame,
                                frameCount,
                                stride,
                                startTimeSec: framesToTime(startFrame, fpMs),
                                endTimeSec: framesToTime(
                                    startFrame + frameCount - 1,
                                    fpMs,
                                ),
                            },
                        );
                    }

                    const res = await paramsApi.getParamFrames(
                        trackId,
                        editParam,
                        startFrame,
                        frameCount,
                        stride,
                    );
                    if (fetchReqIdRef.current !== reqId) return;
                    if (!res?.ok) {
                        if (debug) {
                            // eslint-disable-next-line no-console
                            console.debug(
                                "[PianoRollData] paramFrames not ok",
                                {
                                    trackId,
                                    editParam,
                                    paramKey,
                                    startFrame,
                                    frameCount,
                                    stride,
                                    res,
                                },
                            );
                        }
                        return;
                    }

                    const payload = res as ParamFramesPayload;

                    if (editParam === "pitch") {
                        const pending = Boolean(
                            payload.analysis_pending ?? false,
                        );
                        setPitchAnalysisPending(pending);
                        if (!pending) setPitchAnalysisProgress(null);

                        const userModified = payload.pitch_edit_user_modified;
                        setPitchEditUserModified(
                            typeof userModified === "boolean"
                                ? userModified
                                : null,
                        );

                        const backendAvail =
                            payload.pitch_edit_backend_available;
                        setPitchEditBackendAvailable(
                            typeof backendAvail === "boolean"
                                ? backendAvail
                                : null,
                        );
                    }
                    const fpRes =
                        Number(payload.frame_period_ms ?? fpMs) || fpMs;
                    paramFramePeriodCache.set(fpKey, fpRes);

                    const receivedStartFrame =
                        Number(payload.start_frame ?? startFrame) || startFrame;
                    const receivedOrigLen = (payload.orig ?? []).length;
                    const receivedEditLen = (payload.edit ?? []).length;

                    if (debugEnabled) {
                        console.log("[usePianoRollData] Received param data:", {
                            trackId,
                            editParam,
                            requestedStartFrame: startFrame,
                            requestedFrameCount: frameCount,
                            receivedStartFrame,
                            receivedOrigLen,
                            receivedEditLen,
                            framePeriodMs: fpRes,
                            receivedStartSec: framesToTime(
                                receivedStartFrame,
                                fpRes,
                            ),
                            receivedEndSec: framesToTime(
                                receivedStartFrame + receivedEditLen - 1,
                                fpRes,
                            ),
                            receivedDurSec: framesToTime(
                                receivedEditLen - 1,
                                fpRes,
                            ),
                        });
                    }

                    setParamView({
                        key: paramKey,
                        framePeriodMs: fpRes,
                        startFrame: receivedStartFrame,
                        stride,
                        orig: (payload.orig ?? []).map((v) => Number(v) || 0),
                        edit: (payload.edit ?? []).map((v) => Number(v) || 0),
                    });
                    lastAppliedForceParamFetchTokenRef.current =
                        localForceParamFetchToken;
                    invalidate();

                    if (Math.abs(fpRes - fpMs) > 1e-3) {
                        const retryKey = `${fpKey}|${fpMs}`;
                        if (!fpRetryRef.current.has(retryKey)) {
                            fpRetryRef.current.add(retryKey);
                            void Promise.resolve().then(() => refreshVisible());
                        }
                    }
                } catch {
                    // ignore
                } finally {
                    endLoading();
                }
            })();
        }
    }

    async function refreshNow() {
        const req = computeVisibleRequest();
        if (!req) return;

        const {
            debug,
            trackId,
            waveTrackId,
            waveKey,
            startSecQ,
            durSecQ,
            covCols,
            paramKey,
            startFrame,
            frameCount,
            stride,
            fpMs,
            fpKey,
        } = req;

        setIsRefreshing(true);
        const reqId = ++fetchReqIdRef.current;
        const shouldFetchParam = !(editParam === "pitch" && !pitchEnabled);
        const secondaryPitchOk =
            req.secondaryParam !== "pitch" ||
            pitchEnabled ||
            editParam === "pitch";
        const shouldFetchSecondary = secondaryPitchOk;
        try {
            beginLoading();
            const [waveRes, paramRes, secondaryRes] = await Promise.all([
                waveformApi.getTrackMixWaveformPeaksSegment(
                    waveTrackId,
                    startSecQ,
                    durSecQ,
                    covCols,
                ),
                shouldFetchParam
                    ? paramsApi.getParamFrames(
                          trackId,
                          editParam,
                          startFrame,
                          frameCount,
                          stride,
                      )
                    : Promise.resolve(null),
                shouldFetchSecondary
                    ? paramsApi.getParamFrames(
                          trackId,
                          req.secondaryParam,
                          req.secondaryStartFrame,
                          req.secondaryFrameCount,
                          stride,
                      )
                    : Promise.resolve(null),
            ]);

            if (fetchReqIdRef.current !== reqId) return;

            if (waveRes?.ok) {
                const min = (waveRes.min ?? []).map((v) => Number(v) || 0);
                const max = (waveRes.max ?? []).map((v) => Number(v) || 0);
                lruSet(
                    rootMixPeaksCache,
                    waveKey,
                    { min, max, t: Date.now() },
                    ROOT_MIX_CACHE_LIMIT,
                );
                setWavePeaks({
                    key: waveKey,
                    startSec: startSecQ,
                    durSec: durSecQ,
                    columns: covCols,
                    min,
                    max,
                });
            } else if (debug) {
                // eslint-disable-next-line no-console
                console.debug("[PianoRollData] refreshNow wavePeaks not ok", {
                    waveTrackId,
                    waveKey,
                    waveRes,
                });
            }

            if (shouldFetchParam && paramRes?.ok) {
                const payload = paramRes as ParamFramesPayload;

                if (editParam === "pitch") {
                    const pending = Boolean(payload.analysis_pending ?? false);
                    setPitchAnalysisPending(pending);
                    if (!pending) setPitchAnalysisProgress(null);

                    const userModified = payload.pitch_edit_user_modified;
                    setPitchEditUserModified(
                        typeof userModified === "boolean" ? userModified : null,
                    );

                    const backendAvail = payload.pitch_edit_backend_available;
                    setPitchEditBackendAvailable(
                        typeof backendAvail === "boolean" ? backendAvail : null,
                    );
                }
                const fpRes = Number(payload.frame_period_ms ?? fpMs) || fpMs;
                paramFramePeriodCache.set(fpKey, fpRes);
                setParamView({
                    key: paramKey,
                    framePeriodMs: fpRes,
                    startFrame:
                        Number(payload.start_frame ?? startFrame) || startFrame,
                    stride,
                    orig: (payload.orig ?? []).map((v) => Number(v) || 0),
                    edit: (payload.edit ?? []).map((v) => Number(v) || 0),
                });

                if (Math.abs(fpRes - fpMs) > 1e-3) {
                    const retryKey = `${fpKey}|${fpMs}`;
                    if (!fpRetryRef.current.has(retryKey)) {
                        fpRetryRef.current.add(retryKey);
                        void Promise.resolve().then(() => refreshNow());
                    }
                }
            } else if (shouldFetchParam && debug) {
                // eslint-disable-next-line no-console
                console.debug("[PianoRollData] refreshNow paramFrames not ok", {
                    trackId,
                    editParam,
                    paramKey,
                    paramRes,
                });
            }

            if (shouldFetchSecondary && secondaryRes?.ok) {
                const secPayload = secondaryRes as ParamFramesPayload;
                const secFpRes =
                    Number(secPayload.frame_period_ms ?? req.secondaryFpMs) ||
                    req.secondaryFpMs;
                paramFramePeriodCache.set(req.secondaryFpKey, secFpRes);
                setSecondaryParamView({
                    key: req.secondaryParamKey,
                    framePeriodMs: secFpRes,
                    startFrame:
                        Number(
                            secPayload.start_frame ?? req.secondaryStartFrame,
                        ) || req.secondaryStartFrame,
                    stride,
                    orig: [],
                    edit: (secPayload.edit ?? []).map((v) => Number(v) || 0),
                });
            }
        } finally {
            setIsRefreshing(false);
            endLoading();
            invalidate();
        }
    }

    useEffect(() => {
        if (!rootTrackId) return;

        if (fetchDebounceRef.current != null) {
            window.clearTimeout(fetchDebounceRef.current);
            fetchDebounceRef.current = null;
        }
        fetchDebounceRef.current = window.setTimeout(() => {
            fetchDebounceRef.current = null;
            void refreshVisible();
        }, 75);

        return () => {
            if (fetchDebounceRef.current != null) {
                window.clearTimeout(fetchDebounceRef.current);
                fetchDebounceRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        rootTrackId,
        selectedTrackId,
        editParam,
        scrollLeft,
        pxPerBeat,
        secPerBeat,
        viewWidth,
        refreshToken,
        forceParamFetchToken,
    ]);

    /**
     * 由外部（PianoRollPanel）在 pointer-up 时调用，通知 live 编辑已结束。
     * 若此前有被推迟的 pitch_orig_updated 刷新，此时立即触发。
     */
    function notifyLiveEditEnded() {
        if (pendingPitchUpdatedRefreshRef.current) {
            pendingPitchUpdatedRefreshRef.current = false;
            setForceParamFetchToken((x) => x + 1);
            setRefreshToken((x) => x + 1);
        }
    }

    return {
        wavePeaks,
        setWavePeaks,
        paramView,
        setParamView,
        secondaryParamView,
        bumpRefreshToken: () => setRefreshToken((x) => x + 1),
        refreshNow,
        notifyLiveEditEnded,
        isRefreshing,
        isLoading,
        pitchAnalysisPending,
        pitchAnalysisProgress,
        pitchEditUserModified,
        pitchEditBackendAvailable,
    };
}
