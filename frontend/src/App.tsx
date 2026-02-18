import { useEffect, useRef, useState, type DragEvent } from "react";
import { useAppDispatch, useAppSelector } from "./app/hooks";
import {
    fetchTimeline,
    importAudioFromPath,
    loadDefaultModel,
    playOriginal,
    redo,
    refreshRuntime,
    removeSelectedClipRemote,
    setToolMode,
    stopAudioPlayback,
    syncPlaybackState,
    undo,
} from "./features/session/sessionSlice";
import { MenuBar } from "./components/layout/MenuBar";
import { ActionBar } from "./components/layout/ActionBar";
import { TimelinePanel } from "./components/editor/TimelinePanel";
import { PianoRollPanel } from "./components/editor/PianoRollPanel";
import { StatusPanels } from "./components/layout/StatusPanels";
import { useI18n } from "./i18n/I18nProvider";

function App() {
    const dispatch = useAppDispatch();
    const session = useAppSelector((state) => state.session);
    const { t } = useI18n();
    const [dragActive, setDragActive] = useState(false);
    const defaultModelAttemptedRef = useRef(false);
    const editorRef = useRef<HTMLDivElement | null>(null);
    const [timelineRatio, setTimelineRatio] = useState(0.56);

    const parseDroppedPath = (
        event: DragEvent<HTMLDivElement>,
    ): string | null => {
        const droppedFile = event.dataTransfer.files?.[0] as File & {
            path?: string;
        };
        if (droppedFile?.path) {
            return droppedFile.path;
        }

        const uriList = event.dataTransfer.getData("text/uri-list");
        if (uriList && uriList.startsWith("file://")) {
            try {
                const url = new URL(uriList.trim());
                return decodeURIComponent(url.pathname).replace(/^\//, "");
            } catch {
                return null;
            }
        }

        const plainText = event.dataTransfer.getData("text/plain");
        if (plainText && /\.(wav|flac|mp3|ogg|m4a)$/i.test(plainText.trim())) {
            return plainText.trim();
        }

        return null;
    };

    useEffect(() => {
        dispatch(refreshRuntime());
        void dispatch(fetchTimeline());
    }, [dispatch]);

    useEffect(() => {
        if (session.runtime.modelLoaded || defaultModelAttemptedRef.current) {
            return;
        }
        defaultModelAttemptedRef.current = true;
        void dispatch(loadDefaultModel());
    }, [dispatch, session.runtime.modelLoaded]);

    useEffect(() => {
        if (!session.runtime.isPlaying) {
            return;
        }
        const timer = window.setInterval(() => {
            void dispatch(syncPlaybackState());
        }, 60);
        return () => {
            window.clearInterval(timer);
        };
    }, [dispatch, session.runtime.isPlaying]);

    useEffect(() => {
        const isEditable = (target: EventTarget | null): boolean => {
            const element = target as HTMLElement | null;
            if (!element) return false;
            const tagName = element.tagName.toLowerCase();
            return (
                tagName === "input" ||
                tagName === "textarea" ||
                tagName === "select" ||
                element.isContentEditable
            );
        };

        const onKeyDown = (event: KeyboardEvent) => {
            if (isEditable(event.target)) {
                return;
            }

            if (event.code === "Space") {
                event.preventDefault();
                if (session.runtime.isPlaying) {
                    void dispatch(stopAudioPlayback());
                } else {
                    void dispatch(playOriginal());
                }
                return;
            }

            if (event.key === "Tab") {
                event.preventDefault();
                dispatch(
                    setToolMode(
                        session.toolMode === "draw" ? "select" : "draw",
                    ),
                );
                return;
            }

            if (event.ctrlKey && event.key.toLowerCase() === "z") {
                event.preventDefault();
                dispatch(undo());
                return;
            }

            if (event.ctrlKey && event.key.toLowerCase() === "y") {
                event.preventDefault();
                dispatch(redo());
                return;
            }

            if (event.key === "Delete" && session.selectedClipId) {
                event.preventDefault();
                void dispatch(removeSelectedClipRemote());
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [
        dispatch,
        session.runtime.isPlaying,
        session.selectedClipId,
        session.toolMode,
    ]);

    return (
        <div
            className="relative flex h-screen min-h-screen flex-col bg-zinc-800 text-zinc-100"
            onDragEnter={(event) => {
                event.preventDefault();
                setDragActive(true);
            }}
            onDragOver={(event) => {
                event.preventDefault();
                setDragActive(true);
            }}
            onDragLeave={(event) => {
                event.preventDefault();
                const nextTarget = event.relatedTarget as Node | null;
                if (!event.currentTarget.contains(nextTarget)) {
                    setDragActive(false);
                }
            }}
            onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                const droppedPath = parseDroppedPath(event);
                if (droppedPath) {
                    void dispatch(importAudioFromPath(droppedPath));
                }
            }}
        >
            {dragActive && (
                <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-zinc-900/70">
                    <div className="rounded border border-zinc-500 bg-zinc-800 px-6 py-4 text-sm text-zinc-100 shadow-lg">
                        {t("hint_drop_audio")}
                    </div>
                </div>
            )}

            <MenuBar />
            <ActionBar />

            <div className="min-h-0 flex-1 px-2 pb-2 pt-1.5">
                <div ref={editorRef} className="flex h-full min-h-0 flex-col gap-0">
                    <div
                        className="min-h-0"
                        style={{ flexBasis: `${Math.max(30, Math.min(80, timelineRatio * 100))}%` }}
                    >
                        <TimelinePanel />
                    </div>
                    <div
                        className="group relative h-1.5 cursor-row-resize"
                        onMouseDown={(event) => {
                            event.preventDefault();
                            const startY = event.clientY;
                            const startRatio = timelineRatio;
                            const container = editorRef.current;
                            if (!container) return;
                            const totalHeight = container.getBoundingClientRect().height;

                            const onMove = (moveEvent: MouseEvent) => {
                                const dy = moveEvent.clientY - startY;
                                const next = startRatio + dy / Math.max(1, totalHeight);
                                setTimelineRatio(Math.max(0.3, Math.min(0.8, next)));
                            };
                            const onUp = () => {
                                window.removeEventListener("mousemove", onMove);
                                window.removeEventListener("mouseup", onUp);
                            };
                            window.addEventListener("mousemove", onMove);
                            window.addEventListener("mouseup", onUp);
                        }}
                    >
                        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-zinc-600 group-hover:bg-zinc-400" />
                    </div>
                    <div className="min-h-0 flex-1">
                        <PianoRollPanel />
                    </div>
                </div>
            </div>

            <StatusPanels />
        </div>
    );
}

export default App;
