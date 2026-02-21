import { useEffect, useRef, useState } from "react";

import { webApi } from "../../../services/webviewApi";
import { clamp } from "../timeline";

import type { ParamName, ParamViewSegment, WavePeaksSegment } from "./types";
import {
    lruGet,
    lruSet,
    ROOT_MIX_CACHE_LIMIT,
    rootMixPeaksCache,
    rootMixPeaksInflight,
} from "./peaksCache";

const paramFramePeriodCache = new Map<string, number>();

export function usePianoRollData(args: {
    editParam: ParamName;
    pitchEnabled: boolean;
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
}) {
    const {
        editParam,
        pitchEnabled,
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
    } = args;

    const [wavePeaks, setWavePeaks] = useState<WavePeaksSegment | null>(null);
    const [paramView, setParamView] = useState<ParamViewSegment | null>(null);

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

    // Listen for backend pitch update notifications (Tauri only).
    useEffect(() => {
        let disposed = false;
        let unlisten: null | (() => void) = null;

        async function setup() {
            if (editParam !== "pitch") return;
            if (!pitchEnabled) return;
            if (!rootTrackId) return;
            try {
                const mod = await import("@tauri-apps/api/event");
                unlisten = await mod.listen(
                    "pitch_orig_updated",
                    (event: any) => {
                        if (disposed) return;
                        const payload = (event?.payload ?? {}) as {
                            rootTrackId?: string;
                        };
                        if (
                            payload?.rootTrackId &&
                            payload.rootTrackId !== rootTrackId
                        )
                            return;
                        setRefreshToken((x) => x + 1);
                    },
                );
            } catch {
                // Safe no-op: browser/pywebview builds won't have the Tauri API.
            }
        }

        void setup();

        return () => {
            disposed = true;
            if (unlisten) unlisten();
        };
    }, [editParam, pitchEnabled, rootTrackId]);

    useEffect(() => {
        if (editParam !== "pitch") return;
        if (pitchEnabled) return;
        setParamView(null);
    }, [editParam, pitchEnabled]);

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

        const marginSec = visibleDurSec;
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
            if (!pv.key.startsWith(`${trackId}|${editParam}|`)) return false;
            const fp = Math.max(1e-6, pv.framePeriodMs);
            const step = Math.max(1, Math.floor(pv.stride));
            const startSecPv = (pv.startFrame * fp) / 1000;
            const endFramePv = pv.startFrame + (pv.orig.length - 1) * step;
            const endSecPv = (endFramePv * fp) / 1000;
            return startSecPv <= visibleStartSec && endSecPv >= visibleEndSec;
        })();

        const paramMarginSec = visibleDurSec;
        const covParamStartSec = Math.max(0, visibleStartSec - paramMarginSec);
        const covParamDurSec = visibleDurSec + 2 * paramMarginSec;
        const paramStartSecQ = Math.max(0, q(covParamStartSec));
        const paramDurSecQ = Math.max(quantStepSec, q(covParamDurSec));

        const startFrame = Math.max(
            0,
            Math.floor((paramStartSecQ * 1000) / Math.max(1e-6, fpMs)),
        );
        // Request full-resolution curve by default.
        // With fp=5ms, even tens of seconds are only a few thousand samples.
        const viewFrames = clamp(
            Math.max(
                1,
                Math.ceil((paramDurSecQ * 1000) / Math.max(1e-6, fpMs)) + 1,
            ),
            1,
            200_000,
        );
        const stride = 1;
        const frameCount = viewFrames;
        const paramKey = `${trackId}|${editParam}|${startFrame}|${frameCount}|${stride}`;

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
                  const res = await webApi.getTrackMixWaveformPeaksSegment(
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
                    const min = (res.min ?? []).map((v: any) => Number(v) || 0);
                    const max = (res.max ?? []).map((v: any) => Number(v) || 0);
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

        if (!paramCoversVisible) {
            void (async () => {
                beginLoading();
                try {
                    const res = await webApi.getParamFrames(
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
                    const fpRes =
                        Number((res as any).frame_period_ms ?? fpMs) || fpMs;
                    paramFramePeriodCache.set(fpKey, fpRes);

                    setParamView({
                        key: paramKey,
                        framePeriodMs: fpRes,
                        startFrame:
                            Number((res as any).start_frame ?? startFrame) ||
                            startFrame,
                        stride,
                        orig: ((res as any).orig ?? []).map(
                            (v: any) => Number(v) || 0,
                        ),
                        edit: ((res as any).edit ?? []).map(
                            (v: any) => Number(v) || 0,
                        ),
                    });
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
        try {
            beginLoading();
            const [waveRes, paramRes] = await Promise.all([
                webApi.getTrackMixWaveformPeaksSegment(
                    waveTrackId,
                    startSecQ,
                    durSecQ,
                    covCols,
                ),
                shouldFetchParam
                    ? webApi.getParamFrames(
                          trackId,
                          editParam,
                          startFrame,
                          frameCount,
                          stride,
                      )
                    : Promise.resolve(null as any),
            ]);

            if (fetchReqIdRef.current !== reqId) return;

            if (waveRes?.ok) {
                const min = (waveRes.min ?? []).map((v: any) => Number(v) || 0);
                const max = (waveRes.max ?? []).map((v: any) => Number(v) || 0);
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
                const fpRes =
                    Number((paramRes as any).frame_period_ms ?? fpMs) || fpMs;
                paramFramePeriodCache.set(fpKey, fpRes);
                setParamView({
                    key: paramKey,
                    framePeriodMs: fpRes,
                    startFrame:
                        Number((paramRes as any).start_frame ?? startFrame) ||
                        startFrame,
                    stride,
                    orig: ((paramRes as any).orig ?? []).map(
                        (v: any) => Number(v) || 0,
                    ),
                    edit: ((paramRes as any).edit ?? []).map(
                        (v: any) => Number(v) || 0,
                    ),
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
    ]);

    return {
        wavePeaks,
        setWavePeaks,
        paramView,
        setParamView,
        bumpRefreshToken: () => setRefreshToken((x) => x + 1),
        refreshNow,
        isRefreshing,
        isLoading,
    };
}
