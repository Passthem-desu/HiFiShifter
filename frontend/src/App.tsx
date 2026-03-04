import { useEffect, useMemo, useRef, useState } from "react";
import { Flex, Box, Text } from "@radix-ui/themes";
import { MenuBar } from "./components/layout/MenuBar";
import { ActionBar } from "./components/layout/ActionBar";
import { TimelinePanel } from "./components/layout/TimelinePanel";
import { PianoRollPanel } from "./components/layout/PianoRollPanel";
import { useAppDispatch, useAppSelector } from "./app/hooks";
import {
    fetchTimeline,
    refreshRuntime,
    syncPlaybackState,
    stopAudioPlayback,
    playSynthesized,
    playOriginal,
    undoRemote,
    redoRemote,
    newProjectRemote,
    openProjectFromDialog,
    saveProjectRemote,
    saveProjectAsRemote,
} from "./features/session/sessionSlice";
import { useI18n } from "./i18n/I18nProvider";
import { useClipPitchDataListener } from "./hooks/useClipPitchDataListener";
import {
    PitchAnalysisProvider,
    usePitchAnalysis,
} from "./contexts/PitchAnalysisContext";
import {
    PianoRollStatusProvider,
    usePianoRollStatus,
} from "./contexts/PianoRollStatusContext";

const statusKey: Record<string, string> = {
    Ready: "status_ready",
    Failed: "status_failed",
    "Runtime updated": "status_runtime_updated",
    "Runtime update failed": "status_runtime_update_failed",
    "Clear waveform cache failed": "status_clear_waveform_cache_failed",
    "Import canceled": "status_import_canceled",
    "Pick output canceled": "status_pick_output_canceled",
    "Output path selected": "status_output_path_selected",
    "New project": "status_new_project",
    "Open canceled": "status_open_canceled",
    "Project opened": "status_project_opened",
    "Save canceled": "status_save_canceled",
    "Save failed": "status_save_failed",
    "Save As canceled": "status_save_as_canceled",
    "Save As failed": "status_save_as_failed",
    "Project saved": "status_project_saved",
    "Clips created": "status_clips_created",
    "Glue done": "status_glue_done",
};

function AppInner() {
    const dispatch = useAppDispatch();
    const { t } = useI18n();
    const pitchAnalysis = usePitchAnalysis();
    const pianoRollStatus = usePianoRollStatus();

    const status = useAppSelector((state) => state.session.status);
    const error = useAppSelector((state) => state.session.error);

    const runtimeIsPlaying = useAppSelector(
        (state) => state.session.runtime.isPlaying,
    );
    const runtimeHasSynthesized = useAppSelector(
        (state) => state.session.runtime.hasSynthesized,
    );
    const runtimeDevice = useAppSelector((state) => state.session.runtime.device);
    const runtimeModelLoaded = useAppSelector(
        (state) => state.session.runtime.modelLoaded,
    );
    const runtimeAudioLoaded = useAppSelector(
        (state) => state.session.runtime.audioLoaded,
    );

    const containerRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ pointerId: number } | null>(null);
    const [splitRatio, setSplitRatio] = useState(() => {
        const stored = Number(localStorage.getItem("hifishifter.splitRatio"));
        return Number.isFinite(stored)
            ? Math.min(0.85, Math.max(0.15, stored))
            : 0.6;
    });
    const splitRatioRef = useRef(splitRatio);
    const [isDragging, setIsDragging] = useState(false);

    const splitter = useMemo(() => {
        const minTopPx = 200;
        const minBottomPx = 150;
        const handlePx = 8;

        function clamp(v: number, minV: number, maxV: number) {
            return Math.min(maxV, Math.max(minV, v));
        }

        function setFromClientY(clientY: number) {
            const el = containerRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const total = rect.height;
            if (
                !Number.isFinite(total) ||
                total <= minTopPx + minBottomPx + handlePx
            ) {
                return;
            }
            const y = clientY - rect.top;
            const maxTop = total - handlePx - minBottomPx;
            const nextTop = clamp(y, minTopPx, maxTop);
            const nextRatio = clamp(nextTop / total, 0.15, 0.85);
            setSplitRatio(nextRatio);
        }

        function onPointerMove(e: PointerEvent) {
            if (!dragRef.current) return;
            setFromClientY(e.clientY);
        }

        function endDrag() {
            if (!dragRef.current) return;
            dragRef.current = null;
            setIsDragging(false);
            localStorage.setItem(
                "hifishifter.splitRatio",
                String(splitRatioRef.current),
            );
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", endDrag);
            window.removeEventListener("pointercancel", endDrag);
        }

        function startDrag(e: React.PointerEvent<HTMLDivElement>) {
            if (e.button !== 0) return;
            dragRef.current = { pointerId: e.pointerId };
            setIsDragging(true);
            (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
            setFromClientY(e.clientY);
            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", endDrag);
            window.addEventListener("pointercancel", endDrag);
        }

        return { startDrag };
    }, [splitRatio]);

    const statusText = statusKey[status] ? t(statusKey[status] as any) : status;

    // 监听后端 clip_pitch_data 事件，将 per-clip MIDI 曲线存入 store。
    useClipPitchDataListener();

    const errorText = error ? `${t("status_error_prefix")}：${error}` : statusText;

    // 构建 pitch 分析进度文本（分析中时显示在状态栏左侧）
    const pitchAnalysisText = pitchAnalysis.pending
        ? (() => {
              const parts: string[] = [t("status_analyzing_pitch")];
              if (pitchAnalysis.currentClip) {
                  parts.push(`"${pitchAnalysis.currentClip}"`);
              }
              if (
                  pitchAnalysis.totalClips != null &&
                  pitchAnalysis.totalClips > 0
              ) {
                  parts.push(
                      `(${pitchAnalysis.completedClips ?? 0}/${pitchAnalysis.totalClips})`,
                  );
              }
              if (
                  pitchAnalysis.progress != null &&
                  Number.isFinite(pitchAnalysis.progress)
              ) {
                  parts.push(
                      `${Math.round(pitchAnalysis.progress * 100)}%`,
                  );
              }
              return parts.join(" ");
          })()
        : null;

    const [rendering, setRendering] = useState<{
        active: boolean;
        progress: number | null;
        target: string | null;
    }>({ active: false, progress: null, target: null });

    const [stretching, setStretching] = useState<{
        active: boolean;
        clipName: string | null;
    }>({ active: false, clipName: null });

    // Listen for backend stretch progress notifications (Tauri only).
    useEffect(() => {
        let disposed = false;
        let unlisten: null | (() => void) = null;

        async function setup() {
            try {
                const mod = await import("@tauri-apps/api/event");
                unlisten = await mod.listen(
                    "stretch_progress",
                    (event: any) => {
                        if (disposed) return;
                        const payload = (event?.payload ?? {}) as {
                            active?: boolean;
                            clipName?: string | null;
                        };
                        const active = Boolean(payload?.active);
                        const clipName =
                            typeof payload?.clipName === "string"
                                ? payload.clipName
                                : null;
                        setStretching({ active, clipName });
                    },
                );
            } catch {
                // Safe no-op for non-Tauri builds.
            }
        }

        void setup();
        return () => {
            disposed = true;
            if (unlisten) unlisten();
        };
    }, []);

    // Listen for backend playback priming notifications (Tauri only).
    useEffect(() => {
        let disposed = false;
        let unlisten: null | (() => void) = null;

        async function setup() {
            try {
                const mod = await import("@tauri-apps/api/event");
                unlisten = await mod.listen(
                    "playback_rendering_state",
                    (event: any) => {
                        if (disposed) return;
                        const payload = (event?.payload ?? {}) as {
                            active?: boolean;
                            progress?: number | null;
                            target?: string | null;
                        };
                        const active = Boolean(payload?.active);
                        const pRaw = payload?.progress;
                        const p =
                            typeof pRaw === "number" && Number.isFinite(pRaw)
                                ? Math.max(0, Math.min(1, pRaw))
                                : null;
                        const target =
                            typeof payload?.target === "string"
                                ? payload.target
                                : null;

                        setRendering({ active, progress: p, target });

                        // 渲染从 active→inactive（完成）时，延迟同步一次播放状态，
                        // 使前端能感知后端已真正开始播放。
                        if (!active && renderingWasActiveRef.current) {
                            setTimeout(() => {
                                dispatch(syncPlaybackState());
                            }, 200);
                        }
                        renderingWasActiveRef.current = active;
                    },
                );
            } catch {
                // Safe no-op for non-Tauri builds.
            }
        }

        void setup();
        return () => {
            disposed = true;
            if (unlisten) unlisten();
        };
    }, []);

    const runtimeRef = useRef({
        isPlaying: false,
        hasSynthesized: false,
    });

    const playbackSyncInFlightRef = useRef(false);
    const renderingWasActiveRef = useRef(false);

    useEffect(() => {
        void dispatch(fetchTimeline());
        void dispatch(refreshRuntime());
    }, [dispatch]);

    useEffect(() => {
        runtimeRef.current = {
            isPlaying: Boolean(runtimeIsPlaying),
            hasSynthesized: Boolean(runtimeHasSynthesized),
        };
    }, [runtimeIsPlaying, runtimeHasSynthesized]);

    useEffect(() => {
        function isEditableTarget(target: EventTarget | null): boolean {
            const el = target as HTMLElement | null;
            if (!el) return false;
            const tag = (el.tagName ?? "").toLowerCase();
            if (tag === "input" || tag === "textarea" || tag === "select") {
                return true;
            }
            if (el.isContentEditable) return true;
            // Radix/other components may put focus on nested elements.
            if (el.closest?.('input,textarea,select,[contenteditable="true"]'))
                return true;
            return false;
        }

        function onUndoRedo(e: KeyboardEvent) {
            if (e.repeat) return;
            if (!(e.ctrlKey || e.metaKey)) return;
            if (e.altKey) return;

            const active = document.activeElement as HTMLElement | null;
            if (isEditableTarget(active) || isEditableTarget(e.target)) return;

            const key = e.key.toLowerCase();
            const isUndo = key === "z" && !e.shiftKey;
            const isRedo = key === "y" || (key === "z" && e.shiftKey);
            if (!isUndo && !isRedo) return;

            e.preventDefault();
            e.stopPropagation();
            void dispatch(isUndo ? undoRemote() : redoRemote());
        }

        function onProjectShortcuts(e: KeyboardEvent) {
            if (e.repeat) return;
            if (!(e.ctrlKey || e.metaKey)) return;
            if (e.altKey) return;

            const active = document.activeElement as HTMLElement | null;
            if (isEditableTarget(active) || isEditableTarget(e.target)) return;

            const key = e.key.toLowerCase();
            const shift = Boolean(e.shiftKey);

            // Ctrl+N
            if (key === "n" && !shift) {
                e.preventDefault();
                e.stopPropagation();
                void dispatch(newProjectRemote());
                return;
            }

            // Ctrl+Shift+O
            if (key === "o" && shift) {
                e.preventDefault();
                e.stopPropagation();
                void dispatch(openProjectFromDialog());
                return;
            }

            // Ctrl+S / Ctrl+Shift+S
            if (key === "s") {
                e.preventDefault();
                e.stopPropagation();
                void dispatch(
                    shift ? saveProjectAsRemote() : saveProjectRemote(),
                );
                return;
            }
        }

        function onKeyDown(e: KeyboardEvent) {
            if (e.key !== " " && e.code !== "Space") return;
            if (e.repeat) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;

            const active = document.activeElement as HTMLElement | null;
            if (isEditableTarget(active) || isEditableTarget(e.target)) return;
            e.preventDefault();
            e.stopPropagation();

            if (runtimeRef.current.isPlaying) {
                void dispatch(stopAudioPlayback());
            } else {
                void dispatch(
                    runtimeRef.current.hasSynthesized
                        ? playSynthesized()
                        : playOriginal(),
                );
            }
        }

        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("keydown", onUndoRedo, true);
        window.addEventListener("keydown", onProjectShortcuts, true);
        return () => {
            window.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("keydown", onUndoRedo, true);
            window.removeEventListener("keydown", onProjectShortcuts, true);
        };
    }, [dispatch]);

    useEffect(() => {
        if (!runtimeIsPlaying) return;
        // Keep playhead following backend audio clock.
        // 用 in-flight guard 防止轮询请求堆积；并适度降频以降低 Redux/React 压力。
        const intervalMs = 80;
        const id = window.setInterval(() => {
            if (playbackSyncInFlightRef.current) return;
            playbackSyncInFlightRef.current = true;
            const p = dispatch(syncPlaybackState()) as unknown as Promise<unknown>;
            p.finally(() => {
                playbackSyncInFlightRef.current = false;
            });
        }, intervalMs);
        return () => window.clearInterval(id);
    }, [dispatch, runtimeIsPlaying]);

    useEffect(() => {
        splitRatioRef.current = splitRatio;
    }, [splitRatio]);

    useEffect(() => {
        if (!isDragging) return;
        const prevCursor = document.body.style.cursor;
        const prevSelect = document.body.style.userSelect;
        document.body.style.cursor = "ns-resize";
        document.body.style.userSelect = "none";
        return () => {
            document.body.style.cursor = prevCursor;
            document.body.style.userSelect = prevSelect;
        };
    }, [isDragging]);

    return (
        <Flex
            direction="column"
            className="h-screen w-screen bg-qt-window text-qt-text overflow-hidden font-sans text-sm selection:bg-qt-highlight selection:text-white"
        >
            <MenuBar />
            <ActionBar />

            {/* Main Splitter Area */}
            <div ref={containerRef} className="flex-1 min-h-0 flex flex-col">
                {/* Top: Timeline / Tracks */}
                <Box
                    className="min-h-[200px] border-b border-qt-border relative bg-qt-base"
                    style={{ flexGrow: splitRatio, flexBasis: 0 }}
                >
                    <TimelinePanel />
                </Box>

                {/* Splitter */}
                <div
                    className="h-2 bg-qt-window border-y border-qt-border cursor-ns-resize shrink-0"
                    onPointerDown={splitter.startDrag}
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label={t("aria_resize_panels")}
                />

                {/* Bottom: Parameter / Piano Roll */}
                <Box
                    className="min-h-[150px] relative bg-qt-base"
                    style={{ flexGrow: 1 - splitRatio, flexBasis: 0 }}
                >
                    <PianoRollPanel />
                </Box>
            </div>

            {/* Status Bar */}
            <Flex
                align="center"
                justify="between"
                className="h-6 bg-qt-window border-t border-qt-border px-1 select-none gap-2"
            >
                <Text size="1" color={error ? "red" : "gray"} className="truncate min-w-0">
                    {stretching.active ? (
                        <>
                            <span style={{ color: "var(--accent-9)" }}>
                                {t("status_stretching" as any)}
                                {stretching.clipName ? ` "${stretching.clipName}"` : ""}
                            </span>
                            {" | "}
                        </>
                    ) : null}
                    {pitchAnalysisText ? (
                        <>
                            <span style={{ color: "var(--accent-9)" }}>
                                {pitchAnalysisText}
                            </span>
                            {" | "}
                        </>
                    ) : null}
                    {errorText}
                    {pianoRollStatus.dataLoading ? (
                        <>
                            {" | "}
                            <span style={{ color: "var(--accent-9)" }}>
                                {t("loading")}
                            </span>
                        </>
                    ) : null}
                    {pianoRollStatus.asyncRefreshActive ? (
                        <>
                            {" | "}
                            <span style={{ color: "var(--accent-9)" }}>
                                {(t as any)("refreshing_pitch_data") || "Refreshing pitch data"}
                                {pianoRollStatus.asyncRefreshProgress > 0
                                    ? ` ${Math.round(pianoRollStatus.asyncRefreshProgress)}%`
                                    : ""}
                            </span>
                        </>
                    ) : null}
                    {rendering.active ? (
                        <>
                            {" | "}
                            {t("rendering")}
                            {rendering.progress != null
                                ? ` ${Math.round(rendering.progress * 100)}%`
                                : ""}
                        </>
                    ) : null}
                </Text>
                <Text size="1" color="gray" className="shrink-0 whitespace-nowrap">
                    {t("status_device")}: {runtimeDevice} · {t("status_model")}:
                    {runtimeModelLoaded ? t("status_ok") : t("status_na")} ·{" "}
                    {t("status_audio")}: {runtimeAudioLoaded ? t("status_ok") : t("status_na")} ·{" "}
                    {t("status_synth")}: {runtimeHasSynthesized ? t("status_ok") : t("status_na")}
                </Text>
            </Flex>
        </Flex>
    );
}

function App() {
    return (
        <PitchAnalysisProvider>
            <PianoRollStatusProvider>
                <AppInner />
            </PianoRollStatusProvider>
        </PitchAnalysisProvider>
    );
}

export default App;
