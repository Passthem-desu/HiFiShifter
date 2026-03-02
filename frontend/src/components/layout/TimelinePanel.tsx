import React, { useEffect, useMemo, useRef, useState } from "react";
import { Flex } from "@radix-ui/themes";
import { useAppDispatch, useAppSelector } from "../../app/hooks";
import type { RootState } from "../../app/store";
import { useI18n } from "../../i18n/I18nProvider";
import {
    addTrackRemote,
    removeTrackRemote,
    selectTrackRemote,
    setTrackStateRemote,
    seekPlayhead,
    selectClipRemote,
    setPlayheadBeat,
    moveTrackRemote,
    setClipMuted,
    importAudioAtPosition,
    importAudioFileAtPosition,
    setClipStateRemote,
    setClipFades,
    glueClipsRemote,
    optimisticUpdateClipColor,
    rollbackClipColor,
    removeClipRemote,
    splitClipRemote,
} from "../../features/session/sessionSlice";

import type { ClipTemplate } from "../../features/session/sessionTypes";
import { useClipDrag } from "./timeline/hooks/useClipDrag";
import { useEditDrag } from "./timeline/hooks/useEditDrag";
import { useSlipDrag } from "./timeline/hooks/useSlipDrag";
import { useKeyboardShortcuts } from "./timeline/hooks/useKeyboardShortcuts";

import {
    BackgroundGrid,
    ClipContextMenu,
    DEFAULT_PX_PER_BEAT,
    DEFAULT_ROW_HEIGHT,
    MAX_PX_PER_BEAT,
    MAX_ROW_HEIGHT,
    MIN_PX_PER_BEAT,
    MIN_ROW_HEIGHT,
    TimelineScrollArea,
    TimeRuler,
    TrackLane,
    TrackList,
    useTimelineSelectionRect,
    extractLocalFilePath,
    gridStepBeats,
    hasFileDrag,
} from "./timeline";

export const TimelinePanel: React.FC = () => {
    const dispatch = useAppDispatch();
    const { t } = useI18n();
    const s = useAppSelector((state: RootState) => state.session);
    const sessionRef = useRef(s);
    useEffect(() => {
        sessionRef.current = s;
    }, [s]);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const rulerContentRef = useRef<HTMLDivElement | null>(null);
    const scrollLeftRef = useRef(0);
    const scrollStateRafRef = useRef<number | null>(null);
    const playheadDragRef = useRef<{
        pointerId: number;
        lastBeat: number;
    } | null>(null);

    const [scrollLeft, setScrollLeft] = useState(0);
    useEffect(() => {
        scrollLeftRef.current = scrollLeft;
    }, [scrollLeft]);

    function syncScrollLeft(next: number) {
        scrollLeftRef.current = next;
        if (rulerContentRef.current) {
            rulerContentRef.current.style.transform = `translateX(${-next}px)`;
        }
        if (scrollStateRafRef.current == null) {
            scrollStateRafRef.current = requestAnimationFrame(() => {
                scrollStateRafRef.current = null;
                setScrollLeft(scrollLeftRef.current);
            });
        }
    }

    const setScrollLeftAction: React.Dispatch<React.SetStateAction<number>> = (
        action,
    ) => {
        const next =
            typeof action === "function"
                ? (action as (prev: number) => number)(scrollLeftRef.current)
                : action;
        syncScrollLeft(next);
    };
    const [pxPerBeat, setPxPerBeat] = useState(() => {
        const stored = Number(localStorage.getItem("hifishifter.pxPerBeat"));
        return Number.isFinite(stored)
            ? Math.min(MAX_PX_PER_BEAT, Math.max(MIN_PX_PER_BEAT, stored))
            : DEFAULT_PX_PER_BEAT;
    });

    const [rowHeight, setRowHeight] = useState(() => {
        const stored = Number(localStorage.getItem("hifishifter.rowHeight"));
        return Number.isFinite(stored)
            ? Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, stored))
            : DEFAULT_ROW_HEIGHT;
    });

    const panRef = useRef<{
        pointerId: number | null;
        startX: number;
        startY: number;
        scrollLeft: number;
        scrollTop: number;
    } | null>(null);

    // clip 拖拽、编辑拖拽、slip 拖拽的 ref 和启动函数由各自 hook 提供，
    // 在下方 snapBeat / beatFromClientX / trackIdFromClientY 定义后初始化。

    const [trackVolumeUi, setTrackVolumeUi] = useState<Record<string, number>>(
        {},
    );
    const [dropPreview, setDropPreview] = useState<{
        path: string;
        fileName: string;
        trackId: string | null;
        startBeat: number;
    } | null>(null);

    const [clipDropNewTrack, setClipDropNewTrack] = useState(false);

    const [altPressed, setAltPressed] = useState(false);

    const clipClipboardRef = useRef<ClipTemplate[] | null>(null);

    const tauriDraggedPathRef = useRef<string | null>(null);
    const tauriLastDropPathRef = useRef<string | null>(null);
    const tauriDropHandledAtRef = useRef<number>(0);

    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (e.key === "Alt") setAltPressed(true);
        }
        function onKeyUp(e: KeyboardEvent) {
            if (e.key === "Alt") setAltPressed(false);
        }
        function onBlur() {
            setAltPressed(false);
        }
        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("keyup", onKeyUp, true);
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("keyup", onKeyUp, true);
            window.removeEventListener("blur", onBlur);
        };
    }, []);

    useEffect(() => {
        let disposed = false;
        let unlisten: null | (() => void) = null;

        const debugDnd = localStorage.getItem("hifishifter.debugDnd") === "1";

        async function setup() {
            try {
                const mod = await import("@tauri-apps/api/window");
                const win = mod.getCurrentWindow();

                if (debugDnd) {
                    console.log("[dnd] attaching tauri drag-drop listener");
                }

                type TauriDragDropPayload = {
                    type?: string;
                    event?: string;
                    paths?: string[];
                    position?: { x?: number; y?: number };
                    pos?: { x?: number; y?: number };
                    cursorPosition?: { x?: number; y?: number };
                };

                type TauriDragDropEvent =
                    | { payload?: TauriDragDropPayload }
                    | TauriDragDropPayload;

                unlisten = await win.onDragDropEvent(
                    (event: TauriDragDropEvent) => {
                        if (disposed) return;
                        const payload = (
                            "payload" in event ? event.payload : event
                        ) as TauriDragDropPayload | undefined;
                        const type = String(
                            payload?.type ?? payload?.event ?? "",
                        );
                        const paths: string[] = Array.isArray(payload?.paths)
                            ? payload.paths
                            : [];

                    if (debugDnd) {
                        console.log("[dnd] tauri event", {
                            type,
                            pathsCount: paths.length,
                            hasPosition: Boolean(
                                payload?.position ??
                                payload?.pos ??
                                payload?.cursorPosition,
                            ),
                        });
                    }

                    // Some platforms don't dispatch DOM dragover/drop for external file drags.
                    // Use Tauri's drag-drop event as the source of truth, including ghost + import.
                    const scroller = scrollRef.current;
                    const bounds = scroller?.getBoundingClientRect() ?? null;
                    const pos = (payload?.position ??
                        payload?.pos ??
                        payload?.cursorPosition) as
                        | { x?: number; y?: number }
                        | undefined;
                    // Tauri's position is in window/client coordinates.
                    const clientX =
                        typeof pos?.x === "number" ? pos.x : undefined;
                    const clientY =
                        typeof pos?.y === "number" ? pos.y : undefined;
                    const fallbackBeat = sessionRef.current.playheadBeat ?? 0;
                    const beat =
                        clientX !== undefined && bounds && scroller
                            ? beatFromClientX(
                                  clientX,
                                  bounds,
                                  scroller.scrollLeft,
                              )
                            : fallbackBeat;
                    const trackId =
                        clientY !== undefined
                            ? trackIdFromClientY(clientY)
                            : null;

                    const primaryPath = paths.length > 0 ? paths[0] : null;
                    function fileNameFromPath(p: string) {
                        return String(p.split(/[\\/]/).pop() ?? p);
                    }

                    if (type === "enter" || type === "over") {
                        if (primaryPath) {
                            tauriDraggedPathRef.current = primaryPath;
                        }
                        // On some platforms, `paths` may only be populated on `drop`.
                        // Still update the ghost position on every `over`.
                        setDropPreview((prev) => {
                            const path =
                                primaryPath ??
                                tauriDraggedPathRef.current ??
                                prev?.path ??
                                null;
                            if (!path) return prev;
                            const nextFileName = fileNameFromPath(path);
                            return {
                                path,
                                fileName: prev?.fileName ?? nextFileName,
                                trackId,
                                startBeat: beat,
                            };
                        });
                        return;
                    }

                    if (type === "leave") {
                        tauriDraggedPathRef.current = null;
                        setDropPreview(null);
                        return;
                    }

                    if (type === "drop") {
                        if (primaryPath) {
                            tauriDraggedPathRef.current = primaryPath;
                            tauriLastDropPathRef.current = primaryPath;
                        }
                        setDropPreview(null);

                        const resolvedPath =
                            primaryPath ||
                            tauriDraggedPathRef.current ||
                            tauriLastDropPathRef.current;
                        if (resolvedPath) {
                            tauriDropHandledAtRef.current = Date.now();
                            tauriDraggedPathRef.current = null;
                            tauriLastDropPathRef.current = null;
                            void dispatch(
                                importAudioAtPosition({
                                    audioPath: resolvedPath,
                                    trackId,
                                    startBeat: beat,
                                }),
                            );
                        }
                    }
                });
            } catch (err) {
                // Safe no-op: browser/pywebview builds won't have the Tauri API.
                if (debugDnd) {
                    console.warn(
                        "Failed to attach Tauri drag-drop listener",
                        err,
                    );
                }
            }
        }

        void setup();

        return () => {
            disposed = true;
            if (unlisten) unlisten();
        };
    }, [dispatch, pxPerBeat, rowHeight]);

    const [multiSelectedClipIds, setMultiSelectedClipIds] = useState<string[]>(
        [],
    );
    const multiSelectedSet = useMemo(
        () => new Set(multiSelectedClipIds),
        [multiSelectedClipIds],
    );

    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        clipId: string;
    } | null>(null);

    /** 右键菜单中触发重命名的 clipId */
    const [renamingClipId, setRenamingClipId] = useState<string | null>(null);

    const { selectionRect, onPointerDown: onSelectionRectPointerDown } =
        useTimelineSelectionRect({
            scrollRef,
            sessionRef,
            pxPerBeat,
            rowHeight,
            clearContextMenu: () => {
                setContextMenu(null);
            },
            setMultiSelectedClipIds,
            onSingleSelect: (clipId) => {
                void dispatch(selectClipRemote(clipId));
            },
        });

    const contentWidth = useMemo(() => {
        const beats = Math.max(8, Math.ceil(s.projectBeats));
        return beats * pxPerBeat;
    }, [s.projectBeats, pxPerBeat]);

    const dropExtraRows =
        (dropPreview && !dropPreview.trackId ? 1 : 0) +
        (clipDropNewTrack ? 1 : 0);
    const contentHeight = (s.tracks.length + dropExtraRows) * rowHeight;

    const bars = useMemo(() => {
        const beatsPerBar = Math.max(1, Math.round(s.beats || 4));
        const totalBeats = Math.max(1, Math.ceil(s.projectBeats));
        const result: Array<{ beat: number; label: string }> = [];
        let barIndex = 1;
        for (let beat = 0; beat <= totalBeats; beat += beatsPerBar) {
            result.push({ beat, label: `${barIndex}.1` });
            barIndex += 1;
        }
        return result;
    }, [s.beats, s.projectBeats]);

    const clipsByTrackId = useMemo(() => {
        const map = new Map<string, typeof s.clips>();
        for (const clip of s.clips) {
            const arr = map.get(clip.trackId);
            if (arr) {
                arr.push(clip);
            } else {
                map.set(clip.trackId, [clip]);
            }
        }

        for (const arr of map.values()) {
            arr.sort((a, b) => {
                const d = (a.startBeat ?? 0) - (b.startBeat ?? 0);
                if (Math.abs(d) > 1e-9) return d;
                return String(a.id).localeCompare(String(b.id));
            });
        }

        return map;
    }, [s.clips]);

    function beatFromClientX(
        clientX: number,
        bounds: DOMRect,
        xScroll: number,
    ) {
        const x = clientX - bounds.left + xScroll;
        return Math.max(0, x / pxPerBeat);
    }

    function trackIdFromClientY(clientY: number) {
        const scroller = scrollRef.current;
        if (!scroller) return null;
        const bounds = scroller.getBoundingClientRect();
        const y = clientY - bounds.top + scroller.scrollTop;
        const idx = Math.floor(y / rowHeight);
        const tracks = sessionRef.current.tracks;
        if (idx < 0 || idx >= tracks.length) return null;
        return tracks[idx]?.id ?? null;
    }

    function rowTopForTrackId(trackId: string | null) {
        if (!trackId) {
            return s.tracks.length * rowHeight;
        }
        const idx = s.tracks.findIndex((t) => t.id === trackId);
        if (idx < 0) {
            return s.tracks.length * rowHeight;
        }
        return idx * rowHeight;
    }

    function setPlayheadFromClientX(
        clientX: number,
        bounds: DOMRect,
        xScroll: number,
        commit: boolean,
    ) {
        const beat = beatFromClientX(clientX, bounds, xScroll);
        dispatch(setPlayheadBeat(beat));
        if (commit) {
            void dispatch(seekPlayhead(beat));
        }
        return beat;
    }

    function startPanPointer(e: React.PointerEvent) {
        const scroller = scrollRef.current;
        if (!scroller) return;
        if (e.pointerType !== "mouse") return;
        panRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            scrollLeft: scroller.scrollLeft,
            scrollTop: scroller.scrollTop,
        };

        const prevCursor = document.body.style.cursor;
        const prevSelect = document.body.style.userSelect;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";

        try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
            // ignore
        }

        function onMove(ev: PointerEvent) {
            const pan = panRef.current;
            const el = scrollRef.current;
            if (!pan || !el) return;
            if (pan.pointerId != null && ev.pointerId !== pan.pointerId) return;
            el.scrollLeft = pan.scrollLeft - (ev.clientX - pan.startX);
            el.scrollTop = pan.scrollTop - (ev.clientY - pan.startY);
            syncScrollLeft(el.scrollLeft);
        }

        function end(ev: PointerEvent) {
            const pan = panRef.current;
            if (!pan) return;
            if (pan.pointerId != null && ev.pointerId !== pan.pointerId) return;
            panRef.current = null;
            document.body.style.cursor = prevCursor;
            document.body.style.userSelect = prevSelect;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
        }

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
    }

    function snapBeat(beat: number) {
        const step = gridStepBeats(s.grid);
        return Math.round(beat / step) * step;
    }

    function isEditableTarget(target: EventTarget | null): boolean {
        const el = target as HTMLElement | null;
        if (!el) return false;
        const tag = (el.tagName ?? "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") {
            return true;
        }
        if (el.isContentEditable) return true;
        if (el.closest?.('input,textarea,select,[contenteditable="true"]')) {
            return true;
        }
        return false;
    }

    // ── 拖拽 hooks ──────────────────────────────────────────────────────────
    const { editDragRef: _editDragRef, startEditDrag } = useEditDrag({
        scrollRef,
        sessionRef,
        dispatch,
        snapBeat,
        beatFromClientX,
    });

    const { slipDragRef: _slipDragRef, startSlipDrag } = useSlipDrag({
        scrollRef,
        sessionRef,
        dispatch,
        multiSelectedClipIds,
        multiSelectedSet,
        beatFromClientX,
    });

    const { clipDragRef: _clipDragRef, startClipDrag: _startClipDragInner } = useClipDrag({
        scrollRef,
        sessionRef,
        pxPerBeat,
        rowHeight,
        multiSelectedClipIds,
        multiSelectedSet,
        dispatch,
        snapBeat,
        beatFromClientX,
        trackIdFromClientY,
        setClipDropNewTrack,
        setMultiSelectedClipIds,
    });

    function startClipDrag(
        e: React.PointerEvent<HTMLDivElement>,
        clipId: string,
        clipStartBeat: number,
        altPressedHint?: boolean,
    ) {
        _startClipDragInner(e, clipId, clipStartBeat, altPressedHint, startSlipDrag);
    }

    // ── 键盘快捷键 hook ──────────────────────────────────────────────────────
    useKeyboardShortcuts({
        sessionRef,
        dispatch,
        multiSelectedClipIds,
        setMultiSelectedClipIds,
        clipClipboardRef,
        isEditableTarget,
    });
    useEffect(() => {
        if (!contextMenu) return;
        function onAnyPointerDown(e: PointerEvent) {
            const target = e.target as HTMLElement | null;
            if (target?.closest?.("[data-hs-context-menu='1']")) return;
            setContextMenu(null);
        }
        window.addEventListener("pointerdown", onAnyPointerDown, true);
        return () =>
            window.removeEventListener("pointerdown", onAnyPointerDown, true);
    }, [contextMenu]);

    return (
        <Flex className="h-full w-full bg-qt-graph-bg overflow-hidden">
            <TrackList
                t={t}
                tracks={s.tracks}
                selectedTrackId={s.selectedTrackId}
                rowHeight={rowHeight}
                trackVolumeUi={trackVolumeUi}
                onSelectTrack={(trackId) => {
                    dispatch(selectTrackRemote(trackId));
                }}
                onRemoveTrack={(trackId) => {
                    dispatch(removeTrackRemote(trackId));
                }}
                onMoveTrack={(payload) => {
                    dispatch(
                        moveTrackRemote({
                            trackId: payload.trackId,
                            targetIndex: payload.targetIndex,
                            parentTrackId: payload.parentTrackId,
                        }),
                    );
                }}
                onToggleMute={(trackId, nextMuted) => {
                    dispatch(
                        setTrackStateRemote({
                            trackId,
                            muted: nextMuted,
                        }),
                    );
                }}
                onToggleSolo={(trackId, nextSolo) => {
                    dispatch(
                        setTrackStateRemote({
                            trackId,
                            solo: nextSolo,
                        }),
                    );
                }}
                onToggleCompose={(trackId, nextComposeEnabled) => {
                    dispatch(
                        setTrackStateRemote({
                            trackId,
                            composeEnabled: nextComposeEnabled,
                        }),
                    );
                }}
                onVolumeUiChange={(trackId, nextVolume) => {
                    setTrackVolumeUi((prev) => ({
                        ...prev,
                        [trackId]: nextVolume,
                    }));
                }}
                onVolumeCommit={(trackId, nextVolume) => {
                    setTrackVolumeUi((prev) => {
                        const copy = { ...prev };
                        delete copy[trackId];
                        return copy;
                    });
                    dispatch(
                        setTrackStateRemote({
                            trackId,
                            volume: nextVolume,
                        }),
                    );
                }}
                onAddTrack={() => {
                    dispatch(addTrackRemote({}));
                }}
            />

            {/* Timeline View (Right) */}
            <Flex
                direction="column"
                className="flex-1 relative overflow-hidden bg-qt-graph-bg"
            >
                <TimeRuler
                    contentWidth={contentWidth}
                    scrollLeft={scrollLeft}
                    bars={bars}
                    pxPerBeat={pxPerBeat}
                    playheadBeat={s.playheadBeat}
                    contentRef={rulerContentRef}
                    onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        const scroller = scrollRef.current;
                        if (!scroller) return;
                        const bounds = (
                            e.currentTarget as HTMLDivElement
                        ).getBoundingClientRect();
                        setPlayheadFromClientX(
                            e.clientX,
                            bounds,
                            scroller.scrollLeft,
                            true,
                        );
                    }}
                />

                {/* Tracks Area */}
                <TimelineScrollArea
                    scrollRef={scrollRef}
                    projectBeats={s.projectBeats}
                    pxPerBeat={pxPerBeat}
                    setPxPerBeat={setPxPerBeat}
                    rowHeight={rowHeight}
                    setRowHeight={setRowHeight}
                    setScrollLeft={setScrollLeftAction}
                    className="flex-1 bg-qt-graph-bg overflow-auto relative custom-scrollbar"
                    onMouseDownCapture={(e) => {
                        if (e.button === 1) {
                            e.preventDefault();
                        }
                    }}
                    onAuxClick={(e) => {
                        if (e.button === 1) {
                            e.preventDefault();
                        }
                    }}
                    onContextMenu={(e) => {
                        e.preventDefault();
                    }}
                    onPointerDown={onSelectionRectPointerDown}
                    onDragOver={(e) => {
                        const dt = e.dataTransfer;
                        const tauriPath = tauriDraggedPathRef.current;
                        const hasDomFile = Boolean(
                            dt?.files && dt.files.length > 0,
                        );
                        const isTauri = Boolean(
                            (window as unknown as { __TAURI__?: unknown })
                                .__TAURI__,
                        );
                        if (
                            !isTauri &&
                            !hasFileDrag(dt) &&
                            !hasDomFile &&
                            !tauriPath
                        )
                            return;
                        e.preventDefault();
                        const info = extractLocalFilePath(dt);
                        const el = e.currentTarget as HTMLDivElement;
                        const bounds = el.getBoundingClientRect();
                        const beat = beatFromClientX(
                            e.clientX,
                            bounds,
                            el.scrollLeft,
                        );
                        const trackId = trackIdFromClientY(e.clientY);
                        const path = info?.path || tauriPath || "";
                        const fileName =
                            info?.name ||
                            (tauriPath
                                ? String(
                                      tauriPath.split(/[\\/]/).pop() ??
                                          tauriPath,
                                  )
                                : hasDomFile
                                  ? String(dt?.files?.[0]?.name ?? "Audio")
                                  : "Audio");
                        setDropPreview({
                            path,
                            fileName,
                            trackId,
                            startBeat: beat,
                        });
                    }}
                    onDragLeave={(e) => {
                        const related = e.relatedTarget as Node | null;
                        if (
                            related &&
                            (e.currentTarget as HTMLDivElement).contains(
                                related,
                            )
                        )
                            return;
                        setDropPreview(null);
                    }}
                    onDrop={(e) => {
                        const dt = e.dataTransfer;
                        const tauriPath = tauriDraggedPathRef.current;
                        const lastTauriDropPath = tauriLastDropPathRef.current;
                        const hasDomFile = Boolean(
                            dt?.files && dt.files.length > 0,
                        );
                        const isTauri = Boolean(
                            (window as unknown as { __TAURI__?: unknown })
                                .__TAURI__,
                        );
                        if (
                            !isTauri &&
                            !hasFileDrag(dt) &&
                            !hasDomFile &&
                            !tauriPath
                        )
                            return;
                        e.preventDefault();

                        if (
                            isTauri &&
                            Date.now() - (tauriDropHandledAtRef.current || 0) <
                                500
                        ) {
                            setDropPreview(null);
                            return;
                        }

                        const info = extractLocalFilePath(dt);
                        const el = e.currentTarget as HTMLDivElement;
                        const bounds = el.getBoundingClientRect();
                        const beat = beatFromClientX(
                            e.clientX,
                            bounds,
                            el.scrollLeft,
                        );
                        const trackId = trackIdFromClientY(e.clientY);
                        setDropPreview(null);
                        const resolvedPath =
                            info?.path || lastTauriDropPath || tauriPath;
                        if (resolvedPath) {
                            tauriDraggedPathRef.current = null;
                            tauriLastDropPathRef.current = null;
                            void dispatch(
                                importAudioAtPosition({
                                    audioPath: resolvedPath,
                                    trackId,
                                    startBeat: beat,
                                }),
                            );
                            return;
                        }

                        if (isTauri) {
                            window.setTimeout(() => {
                                const p =
                                    tauriLastDropPathRef.current ||
                                    tauriDraggedPathRef.current;
                                if (!p) return;
                                tauriDraggedPathRef.current = null;
                                tauriLastDropPathRef.current = null;
                                void dispatch(
                                    importAudioAtPosition({
                                        audioPath: p,
                                        trackId,
                                        startBeat: beat,
                                    }),
                                );
                            }, 0);
                        }

                        const fallbackFile = dt.files?.[0] ?? null;
                        if (fallbackFile) {
                            void dispatch(
                                importAudioFileAtPosition({
                                    file: fallbackFile,
                                    trackId,
                                    startBeat: beat,
                                }),
                            );
                        }
                    }}
                    onPointerDownCapture={(e) => {
                        if (e.button !== 1) return;
                        if (isEditableTarget(e.target)) return;
                        e.preventDefault();
                        startPanPointer(e);
                    }}
                    onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        setContextMenu(null);
                        setMultiSelectedClipIds([]);
                        const scroller = scrollRef.current;
                        if (!scroller) return;
                        const bounds = scroller.getBoundingClientRect();
                        setPlayheadFromClientX(
                            e.clientX,
                            bounds,
                            scroller.scrollLeft,
                            true,
                        );
                    }}
                >
                    {/* Track Lanes */}
                    <div
                        className="relative"
                        style={{ width: contentWidth, height: contentHeight }}
                    >
                        {selectionRect ? (
                            <div
                                className="absolute z-40 pointer-events-none"
                                style={{
                                    left: selectionRect.x1,
                                    top: selectionRect.y1,
                                    width: Math.max(
                                        1,
                                        selectionRect.x2 - selectionRect.x1,
                                    ),
                                    height: Math.max(
                                        1,
                                        selectionRect.y2 - selectionRect.y1,
                                    ),
                                    border: "1px dashed var(--qt-highlight)",
                                    backgroundColor:
                                        "color-mix(in oklab, var(--qt-highlight) 12%, transparent)",
                                }}
                            />
                        ) : null}

                        <BackgroundGrid
                            contentWidth={contentWidth}
                            contentHeight={contentHeight}
                            pxPerBeat={pxPerBeat}
                            grid={s.grid}
                            beatsPerBar={Math.max(1, Math.round(s.beats || 4))}
                        />

                        {clipDropNewTrack ? (
                            <div
                                className="absolute left-0 right-0 pointer-events-none z-20"
                                style={{
                                    top: s.tracks.length * rowHeight,
                                    height: rowHeight,
                                }}
                            >
                                <div
                                    className="absolute inset-0"
                                    style={{
                                        border: "1px dashed var(--qt-highlight)",
                                        backgroundColor:
                                            "color-mix(in oklab, var(--qt-highlight) 10%, transparent)",
                                    }}
                                />
                            </div>
                        ) : null}

                        {s.tracks.map((track) => {
                            const trackClips =
                                clipsByTrackId.get(track.id) ??
                                ([] as typeof s.clips);

                            return (
                                <TrackLane
                                    key={track.id}
                                    track={track}
                                    trackClips={trackClips}
                                    rowHeight={rowHeight}
                                    pxPerBeat={pxPerBeat}
                                    bpm={s.bpm}
                                    clipWaveforms={s.clipWaveforms}
                                    altPressed={altPressed}
                                    selectedClipId={s.selectedClipId}
                                    multiSelectedClipIds={multiSelectedClipIds}
                                    multiSelectedSet={multiSelectedSet}
                                    trackColor={track.color || undefined}
                                    ensureSelected={(clipId) => {
                                        if (
                                            multiSelectedClipIds.length === 0 ||
                                            !multiSelectedSet.has(clipId)
                                        ) {
                                            setMultiSelectedClipIds([clipId]);
                                        }
                                    }}
                                    selectClipRemote={(clipId) => {
                                        void dispatch(selectClipRemote(clipId));
                                    }}
                                    openContextMenu={(clipId, clientX, clientY) => {
                                        setContextMenu({
                                            x: clientX,
                                            y: clientY,
                                            clipId,
                                        });
                                    }}
                                    seekFromClientX={(clientX, commit) => {
                                        const scroller = scrollRef.current;
                                        if (!scroller) return;
                                        const bounds =
                                            scroller.getBoundingClientRect();
                                        setPlayheadFromClientX(
                                            clientX,
                                            bounds,
                                            scroller.scrollLeft,
                                            commit,
                                        );
                                    }}
                                    startClipDrag={startClipDrag}
                                    startEditDrag={startEditDrag}
                                    toggleClipMuted={(clipId, nextMuted) => {
                                        dispatch(
                                            setClipMuted({
                                                clipId,
                                                muted: nextMuted,
                                            }),
                                        );
                                        void dispatch(
                                            setClipStateRemote({
                                                clipId,
                                                muted: nextMuted,
                                            }),
                                        );
                                    }}
                                    clearContextMenu={() => {
                                        setContextMenu(null);
                                    }}
                                    renamingClipId={renamingClipId}
                                    onRenameCommit={(clipId, newName) => {
                                        void dispatch(
                                            setClipStateRemote({
                                                clipId,
                                                name: newName,
                                            }),
                                        );
                                    }}
                                    onRenameDone={() => {
                                        setRenamingClipId(null);
                                    }}
                                    onGainCommit={(clipId, db) => {
                                        const gain = Math.pow(10, db / 20);
                                        void dispatch(
                                            setClipStateRemote({
                                                clipId,
                                                gain,
                                            }),
                                        );
                                    }}
                                />
                            );
                        })}

                        {/* Drop preview (ghost item) */}
                        {dropPreview ? (
                            <div
                                className="absolute z-30 pointer-events-none"
                                style={{
                                    left: Math.max(
                                        0,
                                        dropPreview.startBeat * pxPerBeat,
                                    ),
                                    top:
                                        rowTopForTrackId(dropPreview.trackId) +
                                        8,
                                    width: Math.max(80, pxPerBeat * 2),
                                    height: rowHeight - 16,
                                }}
                            >
                                <div className="h-full w-full rounded-sm border border-dashed border-qt-highlight bg-[color-mix(in_oklab,var(--qt-highlight)_20%,transparent)]">
                                    <div className="px-2 pt-1 text-[10px] text-qt-text truncate">
                                        {dropPreview.fileName}
                                    </div>
                                </div>
                            </div>
                        ) : null}

                        {/* Playhead Cursor */}
                        <div
                            className="absolute top-0 bottom-0 w-px bg-qt-playhead z-20 cursor-ew-resize"
                            style={{ left: s.playheadBeat * pxPerBeat }}
                            onPointerDown={(e) => {
                                if (e.button !== 0) return;
                                e.stopPropagation();
                                const scroller = scrollRef.current;
                                if (!scroller) return;
                                const bounds = scroller.getBoundingClientRect();
                                const beat = setPlayheadFromClientX(
                                    e.clientX,
                                    bounds,
                                    scroller.scrollLeft,
                                    false,
                                );
                                playheadDragRef.current = {
                                    pointerId: e.pointerId,
                                    lastBeat: beat,
                                };
                                (
                                    e.currentTarget as HTMLDivElement
                                ).setPointerCapture(e.pointerId);

                                function onPointerMove(ev: PointerEvent) {
                                    const drag = playheadDragRef.current;
                                    const currentScroller = scrollRef.current;
                                    if (
                                        !drag ||
                                        drag.pointerId !== e.pointerId ||
                                        !currentScroller
                                    ) {
                                        return;
                                    }
                                    const currentBounds =
                                        currentScroller.getBoundingClientRect();
                                    drag.lastBeat = setPlayheadFromClientX(
                                        ev.clientX,
                                        currentBounds,
                                        currentScroller.scrollLeft,
                                        false,
                                    );
                                }

                                function endDrag() {
                                    const drag = playheadDragRef.current;
                                    if (!drag || drag.pointerId !== e.pointerId)
                                        return;
                                    playheadDragRef.current = null;
                                    void dispatch(seekPlayhead(drag.lastBeat));
                                    window.removeEventListener(
                                        "pointermove",
                                        onPointerMove,
                                    );
                                    window.removeEventListener(
                                        "pointerup",
                                        endDrag,
                                    );
                                    window.removeEventListener(
                                        "pointercancel",
                                        endDrag,
                                    );
                                }

                                window.addEventListener(
                                    "pointermove",
                                    onPointerMove,
                                );
                                window.addEventListener("pointerup", endDrag);
                                window.addEventListener(
                                    "pointercancel",
                                    endDrag,
                                );
                            }}
                        />
                    </div>
                </TimelineScrollArea>

                {contextMenu ? (() => {
                    const ctxClip = sessionRef.current.clips.find(
                        (c) => c.id === contextMenu.clipId,
                    );
                    if (!ctxClip) return null;

                    const selectedIds =
                        multiSelectedClipIds.length >= 2
                            ? multiSelectedClipIds
                            : [contextMenu.clipId];
                    const selectedClips = sessionRef.current.clips.filter((c) =>
                        selectedIds.includes(c.id),
                    );

                    const playheadBeat = sessionRef.current.playheadBeat;
                    const playheadInClip =
                        playheadBeat >= ctxClip.startBeat &&
                        playheadBeat <= ctxClip.startBeat + ctxClip.lengthBeats;

                    return (
                        <ClipContextMenu
                            x={contextMenu.x}
                            y={contextMenu.y}
                            clip={ctxClip}
                            selectedClips={selectedClips}
                            playheadInClip={playheadInClip}
                            onClose={() => setContextMenu(null)}
                            onDelete={(ids) => {
                                setContextMenu(null);
                                setMultiSelectedClipIds([]);
                                for (const id of ids) {
                                    void dispatch(removeClipRemote(id));
                                }
                            }}
                            onMute={(ids, muted) => {
                                for (const id of ids) {
                                    dispatch(setClipMuted({ clipId: id, muted }));
                                    void dispatch(
                                        setClipStateRemote({ clipId: id, muted }),
                                    );
                                }
                            }}
                            onRename={(clipId) => {
                                setContextMenu(null);
                                setRenamingClipId(clipId);
                            }}
                            onCopy={(ids) => {
                                const templates = sessionRef.current.clips
                                    .filter((c) => ids.includes(c.id))
                                    .map((c) => ({ ...c }));
                                if (templates.length > 0) {
                                    clipClipboardRef.current = templates;
                                }
                            }}
                            onSplit={(clipId) => {
                                setContextMenu(null);
                                void dispatch(
                                    splitClipRemote({
                                        clipId,
                                        splitBeat: sessionRef.current.playheadBeat,
                                    }),
                                );
                            }}
                            onGlue={(ids) => {
                                setContextMenu(null);
                                if (ids.length >= 2) {
                                    void dispatch(glueClipsRemote(ids));
                                    setMultiSelectedClipIds([]);
                                }
                            }}
                            onFadeCurveChange={(clipId, target, curve) => {
                                dispatch(setClipFades({
                                    clipId,
                                    ...(target === "in"
                                        ? { fadeInCurve: curve }
                                        : { fadeOutCurve: curve }),
                                }));
                            }}
                            onColorChange={(clipId, color) => {
                                // 乐观更新：立即反映到 UI
                                const prevClip = sessionRef.current.clips.find(
                                    (c) => c.id === clipId,
                                );
                                const prevColor = prevClip?.color ?? "emerald";
                                dispatch(
                                    optimisticUpdateClipColor({ clipId, color }),
                                );
                                void dispatch(
                                    setClipStateRemote({ clipId, color }),
                                ).then((result) => {
                                    // 后端失败时回滚颜色
                                    if (
                                        result.type.endsWith("/rejected") ||
                                        !(result.payload as { ok?: boolean })?.ok
                                    ) {
                                        dispatch(
                                            rollbackClipColor({
                                                clipId,
                                                color: prevColor as typeof color,
                                            }),
                                        );
                                    }
                                });
                            }}
                        />
                    );
                })() : null}
            </Flex>
        </Flex>
    );
};

