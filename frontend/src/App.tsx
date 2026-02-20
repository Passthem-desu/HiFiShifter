import { useEffect, useMemo, useRef, useState } from "react";
import { Flex, Box, Text, Separator } from "@radix-ui/themes";
import { MenuBar } from "./components/layout/MenuBar";
import { ActionBar } from "./components/layout/ActionBar";
import { TimelinePanel } from "./components/layout/TimelinePanel";
import { PianoRollPanel } from "./components/layout/PianoRollPanel";
import { useAppDispatch, useAppSelector } from "./app/hooks";
import type { RootState } from "./app/store";
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

function App() {
    const dispatch = useAppDispatch();
    const s = useAppSelector((state: RootState) => state.session);
    const { t } = useI18n();

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

    const statusKey: Record<string, string> = {
        Ready: "status_ready",
        Failed: "status_failed",
        "Runtime updated": "status_runtime_updated",
        "Runtime update failed": "status_runtime_update_failed",
        "Import canceled": "status_import_canceled",
        "Pick output canceled": "status_pick_output_canceled",
        "Output path selected": "status_output_path_selected",
    };

    const statusText = statusKey[s.status]
        ? t(statusKey[s.status] as any)
        : s.status;

    const runtimeRef = useRef({
        isPlaying: false,
        hasSynthesized: false,
    });

    useEffect(() => {
        void dispatch(fetchTimeline());
        void dispatch(refreshRuntime());
    }, [dispatch]);

    useEffect(() => {
        runtimeRef.current = {
            isPlaying: Boolean(s.runtime.isPlaying),
            hasSynthesized: Boolean(s.runtime.hasSynthesized),
        };
    }, [s.runtime.isPlaying, s.runtime.hasSynthesized]);

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
        if (!s.runtime.isPlaying) return;
        // Keep playhead following backend audio clock.
        const id = window.setInterval(() => {
            void dispatch(syncPlaybackState());
        }, 50);
        return () => window.clearInterval(id);
    }, [dispatch, s.runtime.isPlaying]);

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
            <Separator size="4" color="gray" />
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
                    aria-label="Resize panels"
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
                className="h-6 bg-qt-window border-t border-qt-border px-2 select-none"
            >
                <Text size="1" color={s.error ? "red" : "gray"}>
                    {s.error ? `Error: ${s.error}` : statusText}
                </Text>
                <Text size="1" color="gray">
                    {t("status_device")}: {s.runtime.device} |{" "}
                    {t("status_model")}: {s.runtime.modelLoaded ? "OK" : "—"} |{" "}
                    {t("status_audio")}: {s.runtime.audioLoaded ? "OK" : "—"} |{" "}
                    {t("status_synth")}: {s.runtime.hasSynthesized ? "OK" : "—"}
                </Text>
            </Flex>
        </Flex>
    );
}

export default App;
