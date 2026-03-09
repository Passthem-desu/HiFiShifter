import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Flex, Box, Text, Dialog, Button } from "@radix-ui/themes";
import { MenuBar } from "./components/layout/MenuBar";
import { ActionBar } from "./components/layout/ActionBar";
import { TimelinePanel } from "./components/layout/TimelinePanel";
import { PianoRollPanel } from "./components/layout/PianoRollPanel";
import { useAppDispatch, useAppSelector } from "./app/hooks";
import {
    closeVocalShifterSkippedFilesDialog,
    closeReaperSkippedFilesDialog,
    fetchTimeline,
    refreshRuntime,
    syncPlaybackState,
    stopAudioPlayback,
    playOriginal,
    undoRemote,
    redoRemote,
    newProjectRemote,
    openProjectFromDialog,
    openProjectFromPath,
    saveProjectRemote,
    saveProjectAsRemote,
    exportAudio,
    pickOutputPath,
    setToolMode,
    checkpointHistory,
    addTrackRemote,
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
import { FileBrowserPanel } from "./components/layout/FileBrowserPanel";
import { QuickSearchPopup } from "./components/layout/QuickSearchPopup";
import { useKeybindings } from "./features/keybindings/useKeybindings";
import type { ActionId } from "./features/keybindings/types";
import { store } from "./app/store";
import { resolveRootTrackId } from "./features/session/trackUtils";
import { getParamShiftStep } from "./components/layout/pianoRoll/paramShiftStep";
import { runConfirmedExitClose } from "./confirmedExitClose";
import { paramsApi } from "./services/api";
import { coreApi } from "./services/api/core";
import type { ParamFramesPayload, ProcessorParamDescriptor } from "./types/api";

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
    "Opening project...": "status_opening_project",
    "Open failed": "status_open_failed",
    "Project opened": "status_project_opened",
    "Save canceled": "status_save_canceled",
    "Save failed": "status_save_failed",
    "Save As canceled": "status_save_as_canceled",
    "Save As failed": "status_save_as_failed",
    "Project saved": "status_project_saved",
    "Clips created": "status_clips_created",
    "Glue done": "status_glue_done",
    "Export done": "status_export_done",
    "Export failed": "status_export_failed",
    "Export separated done": "status_export_separated_done",
    "Export separated failed": "status_export_separated_failed",
    "VocalShifter imported with skipped files": "vs_import_skipped_header",
};

// 后端返回的错误码 → i18n key 映射
const errorCodeKey: Record<string, string> = {
    clipboard_not_found: "vs_paste_clipboard_not_found",
    clipboard_invalid_format: "vs_paste_clipboard_invalid_format",
    clipboard_io_error: "vs_paste_clipboard_io_error",
    no_pitch_line_selected: "vs_paste_no_pitch_line",
    import_read_failed: "vs_import_read_failed",
    import_parse_failed: "vs_import_parse_failed",
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
    const fileBrowserVisible = useAppSelector(
        (state) => state.fileBrowser.visible,
    );
    const toolMode = useAppSelector((state) => state.session.toolMode);
    const outputPath = useAppSelector((state) => state.session.outputPath);
    const projectDirty = useAppSelector((state) => state.session.project.dirty);
    const projectPath = useAppSelector((state) => state.session.project.path);
    const vocalShifterSkippedFilesDialog = useAppSelector(
        (state) => state.session.vocalShifterSkippedFilesDialog,
    );
    const reaperSkippedFilesDialog = useAppSelector(
        (state) => state.session.reaperSkippedFilesDialog,
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
    const [quickSearchOpen, setQuickSearchOpen] = useState(false);
    const [unsavedDialog, setUnsavedDialog] = useState<{
        open: boolean;
        mode: "switch" | "exit";
    }>({ open: false, mode: "switch" });
    const pendingUnsavedActionRef = useRef<null | (() => Promise<void>)>(null);
    const allowWindowCloseRef = useRef(false);
    const processorParamCacheRef = useRef(
        new Map<string, ProcessorParamDescriptor[]>(),
    );

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

    const statusText = useMemo(() => {
        // 精确匹配
        if (statusKey[status]) return t(statusKey[status] as any);
        // 前缀匹配：支持 "Export done — path" 等带后缀的状态
        for (const key of Object.keys(statusKey)) {
            if (status.startsWith(key) && status.length > key.length) {
                const suffix = status.slice(key.length);
                return t(statusKey[key] as any) + suffix;
            }
        }
        return status;
    }, [status, t]);

    // 监听后端 clip_pitch_data 事件，将 per-clip MIDI 曲线存入 store。
    useClipPitchDataListener();

    const errorText = error
        ? `${t("status_error_prefix")}：${errorCodeKey[error] ? t(errorCodeKey[error] as any) : error}`
        : statusText;

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
                  parts.push(`${Math.round(pitchAnalysis.progress * 100)}%`);
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
        toolMode: "draw" as "draw" | "select",
    });
    const outputPathRef = useRef(outputPath);

    const playbackSyncInFlightRef = useRef(false);
    const renderingWasActiveRef = useRef(false);

    const closeWindowNow = useCallback(async () => {
        try {
            await runConfirmedExitClose({
                markAllowClose: () => {
                    allowWindowCloseRef.current = true;
                },
                destroyWindow: async () => {
                    const mod = await import("@tauri-apps/api/window");
                    const currentWindow = mod.getCurrentWindow();
                    await currentWindow.destroy();
                },
                closeWindow: async () => {
                    await coreApi.closeWindow();
                },
            });
        } catch (error) {
            allowWindowCloseRef.current = false;
            throw error;
        }
    }, []);

    const promptUnsavedAction = useCallback(
        (mode: "switch" | "exit", action: () => Promise<void>) => {
            pendingUnsavedActionRef.current = action;
            setUnsavedDialog({ open: true, mode });
        },
        [],
    );

    const runOrPromptUnsavedAction = useCallback(
        (mode: "switch" | "exit", action: () => Promise<void>) => {
            if (!projectDirty) {
                void action();
                return;
            }
            promptUnsavedAction(mode, action);
        },
        [projectDirty, promptUnsavedAction],
    );

    const executePendingUnsavedAction = useCallback(async () => {
        const action = pendingUnsavedActionRef.current;
        const mode = unsavedDialog.mode;
        pendingUnsavedActionRef.current = null;
        setUnsavedDialog((current) => ({ ...current, open: false }));
        if (action) {
            try {
                await action();
            } catch (error) {
                pendingUnsavedActionRef.current = action;
                setUnsavedDialog({ open: true, mode });
                throw error;
            }
        }
    }, [unsavedDialog.mode]);

    const cancelUnsavedAction = useCallback(() => {
        pendingUnsavedActionRef.current = null;
        setUnsavedDialog((current) => ({ ...current, open: false }));
    }, []);

    const discardUnsavedAndContinue = useCallback(() => {
        void executePendingUnsavedAction().catch(() => {});
    }, [executePendingUnsavedAction]);

    const saveUnsavedAndContinue = useCallback(() => {
        void (async () => {
            try {
                const result = await dispatch(
                    projectPath ? saveProjectRemote() : saveProjectAsRemote(),
                ).unwrap();
                if ((result as { canceled?: boolean } | undefined)?.canceled) {
                    return;
                }
                await executePendingUnsavedAction();
            } catch {
                // Keep the dialog open so the user can retry or cancel.
            }
        })();
    }, [dispatch, executePendingUnsavedAction, projectPath]);

    const handleNewProject = useCallback(() => {
        runOrPromptUnsavedAction("switch", async () => {
            await dispatch(newProjectRemote()).unwrap();
        });
    }, [dispatch, runOrPromptUnsavedAction]);

    const handleOpenProject = useCallback(() => {
        runOrPromptUnsavedAction("switch", async () => {
            await dispatch(openProjectFromDialog()).unwrap();
        });
    }, [dispatch, runOrPromptUnsavedAction]);

    const handleOpenRecentProject = useCallback(
        (path: string) => {
            runOrPromptUnsavedAction("switch", async () => {
                await dispatch(openProjectFromPath(path)).unwrap();
            });
        },
        [dispatch, runOrPromptUnsavedAction],
    );

    const handleExitApp = useCallback(() => {
        runOrPromptUnsavedAction("exit", closeWindowNow);
    }, [closeWindowNow, runOrPromptUnsavedAction]);

    useEffect(() => {
        void dispatch(fetchTimeline());
        void dispatch(refreshRuntime());
    }, [dispatch]);

    useEffect(() => {
        runtimeRef.current = {
            isPlaying: Boolean(runtimeIsPlaying),
            hasSynthesized: Boolean(runtimeHasSynthesized),
            toolMode,
        };
    }, [runtimeIsPlaying, runtimeHasSynthesized, toolMode]);

    useEffect(() => {
        outputPathRef.current = outputPath;
    }, [outputPath]);

    useEffect(() => {
        let disposed = false;
        let unlisten: null | (() => void) = null;

        async function setup() {
            try {
                const mod = await import("@tauri-apps/api/window");
                const currentWindow = mod.getCurrentWindow();
                unlisten = await currentWindow.onCloseRequested(
                    (event: any) => {
                        if (allowWindowCloseRef.current) {
                            allowWindowCloseRef.current = false;
                            return;
                        }
                        if (!projectDirty) {
                            return;
                        }
                        event.preventDefault();
                        if (!disposed) {
                            promptUnsavedAction("exit", closeWindowNow);
                        }
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
    }, [closeWindowNow, projectDirty, promptUnsavedAction]);

    // 统一快捷键处理（通过 keybindings 模块管理，用户可自定义）
    const handleKeybindingAction = useCallback(
        (actionId: ActionId) => {
            switch (actionId) {
                case "playback.toggle":
                    if (runtimeRef.current.isPlaying) {
                        void dispatch(stopAudioPlayback());
                    } else {
                        void dispatch(playOriginal());
                    }
                    break;
                case "edit.undo":
                    void dispatch(undoRemote());
                    break;
                case "edit.redo":
                    void dispatch(redoRemote());
                    break;
                case "project.new":
                    handleNewProject();
                    break;
                case "project.open":
                    handleOpenProject();
                    break;
                case "project.save":
                    void dispatch(saveProjectRemote());
                    break;
                case "project.saveAs":
                    void dispatch(saveProjectAsRemote());
                    break;
                case "project.export":
                    void (async () => {
                        const curPath = outputPathRef.current?.trim();
                        if (!curPath) {
                            const picked =
                                await dispatch(pickOutputPath()).unwrap();
                            if (picked.ok && !picked.canceled && picked.path) {
                                await dispatch(exportAudio(picked.path));
                            }
                            return;
                        }
                        await dispatch(exportAudio(curPath));
                    })();
                    break;
                case "mode.toggle":
                    dispatch(
                        setToolMode(
                            runtimeRef.current.toolMode === "draw"
                                ? "select"
                                : "draw",
                        ),
                    );
                    break;
                case "quickSearch.open":
                    setQuickSearchOpen(true);
                    break;
                case "track.add": {
                    const ss = store.getState().session;
                    const parentId = ss.selectedTrackId ?? null;
                    void dispatch(addTrackRemote({ parentTrackId: parentId }));
                    break;
                }
                case "pianoRoll.shiftParamUp":
                case "pianoRoll.shiftParamDown": {
                    const isUp = actionId === "pianoRoll.shiftParamUp";
                    const ss = store.getState().session;
                    const rootTrkId = resolveRootTrackId(
                        ss.tracks,
                        ss.selectedTrackId,
                    );
                    if (!rootTrkId) break;
                    const editP = ss.editParam;
                    const rootTrk = ss.tracks.find((tr) => tr.id === rootTrkId);
                    // pitch 参数需要 pitch 分析可用才能操作
                    if (editP === "pitch") {
                        if (
                            !rootTrk?.composeEnabled ||
                            rootTrk.pitchAnalysisAlgo === "none"
                        )
                            break;
                    }
                    const selClipId = ss.selectedClipId;
                    // 优先使用多选 clip 列表，否则 fallback 到单选
                    const multiIds = ss.multiSelectedClipIds;
                    const clipIds =
                        multiIds.length >= 1
                            ? multiIds
                            : selClipId
                              ? [selClipId]
                              : [];
                    if (clipIds.length === 0) break;
                    const selClips = ss.clips.filter((c) =>
                        clipIds.includes(c.id),
                    );
                    if (selClips.length === 0) break;
                    const minSec = Math.min(...selClips.map((c) => c.startSec));
                    const maxSec = Math.max(
                        ...selClips.map((c) => c.startSec + c.lengthSec),
                    );
                    // 默认 framePeriodMs = 5
                    const fp = 5;
                    const startFrame = Math.max(
                        0,
                        Math.floor((minSec * 1000) / fp),
                    );
                    const frameCount = Math.max(
                        1,
                        Math.min(
                            200_000,
                            Math.ceil(((maxSec - minSec) * 1000) / fp),
                        ),
                    );
                    void (async () => {
                        let descriptor: ProcessorParamDescriptor | undefined;
                        if (editP !== "pitch" && rootTrk?.pitchAnalysisAlgo) {
                            const algo = rootTrk.pitchAnalysisAlgo;
                            let descriptors =
                                processorParamCacheRef.current.get(algo);
                            if (!descriptors) {
                                try {
                                    descriptors =
                                        await paramsApi.getProcessorParams(
                                            algo,
                                        );
                                    processorParamCacheRef.current.set(
                                        algo,
                                        descriptors,
                                    );
                                } catch {
                                    descriptors = undefined;
                                }
                            }
                            descriptor = descriptors?.find(
                                (param) => param.id === editP,
                            );
                        }
                        const step = getParamShiftStep(editP, descriptor);
                        const delta = isUp ? step : -step;
                        const res = await paramsApi.getParamFrames(
                            rootTrkId,
                            editP,
                            startFrame,
                            frameCount,
                            1,
                        );
                        if (!res?.ok) return;
                        const payload = res as ParamFramesPayload;
                        const editValues = (payload.edit ?? []).map(
                            (v) => Number(v) || 0,
                        );
                        const shifted = editValues.map((v) => v + delta);
                        await paramsApi.setParamFrames(
                            rootTrkId,
                            editP,
                            startFrame,
                            shifted,
                            true,
                        );
                        // 通知 PianoRoll 刷新曲线
                        dispatch(checkpointHistory());
                    })();
                    break;
                }
                // clip.* 操作由 TimelinePanel 的 useKeyboardShortcuts 处理
                default:
                    break;
            }
        },
        [dispatch, handleNewProject, handleOpenProject],
    );

    useKeybindings(handleKeybindingAction);

    useEffect(() => {
        if (!runtimeIsPlaying) return;
        // Keep playhead following backend audio clock.
        // 用 in-flight guard 防止轮询请求堆积；并适度降频以降低 Redux/React 压力。
        const intervalMs = 80;
        const id = window.setInterval(() => {
            if (playbackSyncInFlightRef.current) return;
            playbackSyncInFlightRef.current = true;
            const p = dispatch(
                syncPlaybackState(),
            ) as unknown as Promise<unknown>;
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
            <Dialog.Root
                open={Boolean(vocalShifterSkippedFilesDialog?.length)}
                onOpenChange={(open) => {
                    if (!open) {
                        dispatch(closeVocalShifterSkippedFilesDialog());
                    }
                }}
            >
                <Dialog.Content maxWidth="620px">
                    <Dialog.Title>{t("status_error_prefix")}</Dialog.Title>
                    <Dialog.Description>
                        {t("vs_import_skipped_header")}
                    </Dialog.Description>
                    <div className="mt-2 max-h-[240px] overflow-auto rounded border border-qt-border bg-qt-base p-2 text-xs">
                        {(vocalShifterSkippedFilesDialog ?? []).map((file) => (
                            <div key={file} className="truncate" title={file}>
                                • {file}
                            </div>
                        ))}
                    </div>
                    <Flex justify="end" mt="3">
                        <Button
                            onClick={() =>
                                dispatch(closeVocalShifterSkippedFilesDialog())
                            }
                        >
                            {"OK"}
                        </Button>
                    </Flex>
                </Dialog.Content>
            </Dialog.Root>

            <Dialog.Root
                open={Boolean(reaperSkippedFilesDialog?.length)}
                onOpenChange={(open) => {
                    if (!open) {
                        dispatch(closeReaperSkippedFilesDialog());
                    }
                }}
            >
                <Dialog.Content maxWidth="620px">
                    <Dialog.Title>{t("status_error_prefix")}</Dialog.Title>
                    <Dialog.Description>
                        {t("reaper_import_skipped_header")}
                    </Dialog.Description>
                    <div className="mt-2 max-h-[240px] overflow-auto rounded border border-qt-border bg-qt-base p-2 text-xs">
                        {(reaperSkippedFilesDialog ?? []).map((file) => (
                            <div key={file} className="truncate" title={file}>
                                • {file}
                            </div>
                        ))}
                    </div>
                    <Flex justify="end" mt="3">
                        <Button
                            onClick={() =>
                                dispatch(closeReaperSkippedFilesDialog())
                            }
                        >
                            {"OK"}
                        </Button>
                    </Flex>
                </Dialog.Content>
            </Dialog.Root>

            <Dialog.Root
                open={unsavedDialog.open}
                onOpenChange={(open) => {
                    if (!open) {
                        cancelUnsavedAction();
                    }
                }}
            >
                <Dialog.Content maxWidth="460px">
                    <Dialog.Title>{t("unsaved_changes_title")}</Dialog.Title>
                    <Dialog.Description>
                        {t(
                            unsavedDialog.mode === "exit"
                                ? "unsaved_changes_exit_desc"
                                : "unsaved_changes_switch_desc",
                        )}
                    </Dialog.Description>
                    <Flex justify="end" gap="2" mt="4">
                        <Button
                            variant="soft"
                            color="gray"
                            onClick={cancelUnsavedAction}
                        >
                            {t("progress_cancel")}
                        </Button>
                        <Button
                            variant="soft"
                            color="gray"
                            onClick={discardUnsavedAndContinue}
                        >
                            {t("unsaved_changes_discard")}
                        </Button>
                        <Button onClick={saveUnsavedAndContinue}>
                            {t("menu_save_project")}
                        </Button>
                    </Flex>
                </Dialog.Content>
            </Dialog.Root>

            <MenuBar
                onNewProject={handleNewProject}
                onOpenProject={handleOpenProject}
                onOpenRecentProject={handleOpenRecentProject}
                onExit={handleExitApp}
            />
            <ActionBar />

            {/* Main Content Area: Splitter + optional File Browser */}
            <Flex className="flex-1 min-h-0">
                {/* Left: Timeline / PianoRoll vertical splitter */}
                <div
                    ref={containerRef}
                    className="flex-1 min-w-0 min-h-0 flex flex-col"
                >
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

                {/* Right: File Browser Panel (可收起) */}
                {fileBrowserVisible && (
                    <div className="w-[280px] shrink-0 border-l border-qt-border bg-qt-window flex flex-col">
                        <FileBrowserPanel />
                    </div>
                )}
            </Flex>

            {/* Quick Search Popup */}
            <QuickSearchPopup
                open={quickSearchOpen}
                onClose={() => setQuickSearchOpen(false)}
            />

            {/* Status Bar */}
            <Flex
                align="center"
                justify="between"
                className="h-6 bg-qt-window border-t border-qt-border px-1 select-none gap-2"
            >
                <Flex align="center" gap="1" className="truncate min-w-0">
                    {stretching.active ? (
                        <span
                            className="shrink-0 rounded px-1 py-0 text-xs font-medium"
                            style={{
                                background: "var(--accent-3)",
                                color: "var(--accent-11)",
                                fontSize: "11px",
                                lineHeight: "16px",
                            }}
                        >
                            {t("status_stretching" as any)}
                            {stretching.clipName
                                ? ` "${stretching.clipName}"`
                                : ""}
                        </span>
                    ) : null}
                    {pitchAnalysisText ? (
                        <span
                            className="shrink-0 rounded px-1 py-0 text-xs font-medium"
                            style={{
                                background: "var(--accent-3)",
                                color: "var(--accent-11)",
                                fontSize: "11px",
                                lineHeight: "16px",
                            }}
                        >
                            {pitchAnalysisText}
                        </span>
                    ) : null}
                    {pianoRollStatus.dataLoading ? (
                        <span
                            className="shrink-0 rounded px-1 py-0 text-xs font-medium"
                            style={{
                                background: "var(--accent-3)",
                                color: "var(--accent-11)",
                                fontSize: "11px",
                                lineHeight: "16px",
                            }}
                        >
                            {t("loading")}
                        </span>
                    ) : null}
                    {pianoRollStatus.asyncRefreshActive ? (
                        <span
                            className="shrink-0 rounded px-1 py-0 text-xs font-medium"
                            style={{
                                background: "var(--accent-3)",
                                color: "var(--accent-11)",
                                fontSize: "11px",
                                lineHeight: "16px",
                            }}
                        >
                            {(t as any)("refreshing_pitch_data") ||
                                "Refreshing pitch data"}
                            {pianoRollStatus.asyncRefreshProgress > 0
                                ? ` ${Math.round(pianoRollStatus.asyncRefreshProgress)}%`
                                : ""}
                        </span>
                    ) : null}
                    {rendering.active ? (
                        <span
                            className="shrink-0 rounded px-1 py-0 text-xs font-medium"
                            style={{
                                background: "var(--accent-3)",
                                color: "var(--accent-11)",
                                fontSize: "11px",
                                lineHeight: "16px",
                            }}
                        >
                            {t("rendering")}
                            {rendering.progress != null
                                ? ` ${Math.round(rendering.progress * 100)}%`
                                : ""}
                        </span>
                    ) : null}
                    <Text
                        size="1"
                        color={error ? "red" : "gray"}
                        className="truncate"
                    >
                        {errorText}
                    </Text>
                </Flex>
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
