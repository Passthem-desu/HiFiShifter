import React, { useEffect, useMemo, useRef, useState } from "react";
import { batch } from "react-redux";
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
    moveClipRemote,
    removeClipRemote,
    moveTrackRemote,
    checkpointHistory,
    moveClipStart,
    moveClipTrack,
    setClipLength,
    setClipPlaybackRate,
    setClipTrim,
    setClipFades,
    setClipGain,
    setClipMuted,
    importAudioAtPosition,
    importAudioFileAtPosition,
    setClipStateRemote,
    splitClipRemote,
    glueClipsRemote,
    createClipsRemote,
} from "../../features/session/sessionSlice";

import type { ClipTemplate } from "../../features/session/sessionTypes";

import {
    BackgroundGrid,
    DEFAULT_PX_PER_BEAT,
    DEFAULT_ROW_HEIGHT,
    GlueContextMenu,
    MAX_PX_PER_BEAT,
    MAX_ROW_HEIGHT,
    MIN_PX_PER_BEAT,
    MIN_ROW_HEIGHT,
    TimelineScrollArea,
    TimeRuler,
    TrackLane,
    TrackList,
    useTimelineSelectionRect,
    clamp,
    clipSourceBeats,
    dbToGain,
    extractLocalFilePath,
    gainToDb,
    gridStepBeats,
    hasFileDrag,
} from "./timeline";

export const TimelinePanel: React.FC = () => {
    const NEW_TRACK_SENTINEL = "__hs_new_track__";
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

    const clipDragRef = useRef<{
        pointerId: number;
        anchorClipId: string;
        clipIds: string[];
        offsetBeat: number;
        initialById: Record<string, { startBeat: number; trackId: string }>;
        minStartBeat: number;
        allowTrackMove: boolean;
        initialAnchorStartBeat: number;
        initialAnchorTrackId: string;
        lastTrackId: string | null;
        lastDeltaBeat: number;
        copyMode: boolean;
        startClientX: number;
        startClientY: number;
        hasMoved: boolean;
    } | null>(null);

    const slipDragRef = useRef<{
        pointerId: number;
        anchorClipId: string;
        clipIds: string[];
        initialPointerBeat: number;
        initialById: Record<
            string,
            {
                trimStartBeat: number;
                trimEndBeat: number;
                playbackRate: number;
                sourceBeats: number | null;
                maxSlipBeats: number;
            }
        >;
    } | null>(null);

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

    const editDragRef = useRef<{
        type:
            | "trim_left"
            | "trim_right"
            | "stretch_left"
            | "stretch_right"
            | "fade_in"
            | "fade_out"
            | "gain";
        pointerId: number;
        clipId: string;
        baseStartBeat: number;
        baseLengthBeats: number;
        basePlaybackRate: number;
        baseTrimStartBeat: number;
        baseTrimEndBeat: number;
        baseFadeInBeats: number;
        baseFadeOutBeats: number;
        baseGain: number;
        sourceBeats: number | null;
        rightEdgeBeat: number;
    } | null>(null);

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

    function startEditDrag(
        e: React.PointerEvent,
        clipId: string,
        type:
            | "trim_left"
            | "trim_right"
            | "stretch_left"
            | "stretch_right"
            | "fade_in"
            | "fade_out"
            | "gain",
    ) {
        if (e.button !== 0) return;
        const clip = sessionRef.current.clips.find((c) => c.id === clipId);
        if (!clip) return;
        const scroller = scrollRef.current;
        if (!scroller) return;
        const rightEdgeBeat = clip.startBeat + clip.lengthBeats;

        dispatch(checkpointHistory());

        editDragRef.current = {
            type,
            pointerId: e.pointerId,
            clipId,
            baseStartBeat: clip.startBeat,
            baseLengthBeats: clip.lengthBeats,
            basePlaybackRate: Number(clip.playbackRate ?? 1) || 1,
            baseTrimStartBeat: clip.trimStartBeat,
            baseTrimEndBeat: clip.trimEndBeat,
            baseFadeInBeats: clip.fadeInBeats,
            baseFadeOutBeats: clip.fadeOutBeats,
            baseGain: clip.gain,
            sourceBeats: clipSourceBeats(clip, sessionRef.current.bpm),
            rightEdgeBeat,
        };

        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

        function onMove(ev: PointerEvent) {
            const drag = editDragRef.current;
            const el = scrollRef.current;
            if (!drag || drag.pointerId !== e.pointerId || !el) return;
            const b = el.getBoundingClientRect();
            let beat = beatFromClientX(ev.clientX, b, el.scrollLeft);
            // Fade handles should be continuous (no snap). Trims/moves snap by default.
            const shouldSnap =
                drag.type === "trim_left" ||
                drag.type === "trim_right" ||
                drag.type === "stretch_left" ||
                drag.type === "stretch_right";
            if (shouldSnap && !ev.shiftKey) beat = snapBeat(beat);

            const clipNow = sessionRef.current.clips.find(
                (c) => c.id === drag.clipId,
            );
            if (!clipNow) return;

            const minLen = 0.0;
            if (drag.type === "fade_in") {
                const raw = beat - drag.baseStartBeat;
                const next = clamp(raw, 0, Math.max(0, drag.baseLengthBeats));
                dispatch(
                    setClipFades({ clipId: drag.clipId, fadeInBeats: next }),
                );
                return;
            }
            if (drag.type === "fade_out") {
                const raw = drag.rightEdgeBeat - beat;
                const next = clamp(raw, 0, Math.max(0, drag.baseLengthBeats));
                dispatch(
                    setClipFades({ clipId: drag.clipId, fadeOutBeats: next }),
                );
                return;
            }
            if (drag.type === "gain") {
                // Vertical drag: up increases gain.
                const movementY = (ev.movementY ?? 0) as number;
                const deltaDb = -movementY * 0.25;
                const nextDb = clamp(gainToDb(clipNow.gain) + deltaDb, -24, 12);
                const nextGain = clamp(dbToGain(nextDb), 0, 2);
                dispatch(setClipGain({ clipId: drag.clipId, gain: nextGain }));
                return;
            }

            if (drag.type === "trim_left") {
                const desiredStart = clamp(
                    beat,
                    0,
                    drag.rightEdgeBeat - minLen,
                );
                const desiredDelta = desiredStart - drag.baseStartBeat;

                const rate =
                    Number(clipNow.playbackRate ?? 1) > 0
                        ? Number(clipNow.playbackRate ?? 1)
                        : 1;
                let nextTrimStart =
                    drag.baseTrimStartBeat + desiredDelta * rate;
                nextTrimStart = Math.max(0, nextTrimStart);
                const actualDeltaTrim = nextTrimStart - drag.baseTrimStartBeat;
                const actualDeltaTimeline = actualDeltaTrim / rate;
                const nextStart = drag.baseStartBeat + actualDeltaTimeline;
                const nextLen = clamp(
                    drag.baseLengthBeats - actualDeltaTimeline,
                    minLen,
                    10_000,
                );

                dispatch(
                    moveClipStart({
                        clipId: drag.clipId,
                        startBeat: nextStart,
                    }),
                );
                dispatch(
                    setClipLength({
                        clipId: drag.clipId,
                        lengthBeats: nextLen,
                    }),
                );
                dispatch(
                    setClipTrim({
                        clipId: drag.clipId,
                        trimStartBeat: nextTrimStart,
                    }),
                );
                return;
            }

            if (drag.type === "stretch_left") {
                const desiredStart = clamp(
                    beat,
                    0,
                    drag.rightEdgeBeat - minLen,
                );
                const nextStart = desiredStart;
                const nextLen = clamp(
                    drag.rightEdgeBeat - nextStart,
                    minLen,
                    10_000,
                );
                const baseLen = Math.max(
                    1e-6,
                    Number(drag.baseLengthBeats) || 0,
                );
                const baseRate =
                    drag.basePlaybackRate > 0 &&
                    Number.isFinite(drag.basePlaybackRate)
                        ? drag.basePlaybackRate
                        : 1;
                const nextRate = clamp(
                    (baseRate * baseLen) / Math.max(1e-6, nextLen),
                    0.1,
                    10,
                );

                dispatch(
                    moveClipStart({
                        clipId: drag.clipId,
                        startBeat: nextStart,
                    }),
                );
                dispatch(
                    setClipLength({
                        clipId: drag.clipId,
                        lengthBeats: nextLen,
                    }),
                );
                dispatch(
                    setClipPlaybackRate({
                        clipId: drag.clipId,
                        playbackRate: nextRate,
                    }),
                );
                return;
            }

            if (drag.type === "trim_right") {
                const desiredRight = clamp(
                    beat,
                    drag.baseStartBeat + minLen,
                    10_000,
                );

                const rate =
                    Number(clipNow.playbackRate ?? 1) > 0
                        ? Number(clipNow.playbackRate ?? 1)
                        : 1;
                const desiredLen = desiredRight - drag.baseStartBeat;
                const nextLen = clamp(desiredLen, minLen, 10_000);
                const usedDeltaTimeline = nextLen - drag.baseLengthBeats;
                let nextTrimEnd =
                    drag.baseTrimEndBeat - usedDeltaTimeline * rate;
                // Can't trim past the end; once trimEnd reaches 0, further extension is silence.
                nextTrimEnd = Math.max(0, nextTrimEnd);

                dispatch(
                    setClipLength({
                        clipId: drag.clipId,
                        lengthBeats: nextLen,
                    }),
                );
                dispatch(
                    setClipTrim({
                        clipId: drag.clipId,
                        trimEndBeat: nextTrimEnd,
                    }),
                );
                return;
            }

            if (drag.type === "stretch_right") {
                const desiredRight = clamp(
                    beat,
                    drag.baseStartBeat + minLen,
                    10_000,
                );
                const nextLen = clamp(
                    desiredRight - drag.baseStartBeat,
                    minLen,
                    10_000,
                );
                const baseLen = Math.max(
                    1e-6,
                    Number(drag.baseLengthBeats) || 0,
                );
                const baseRate =
                    drag.basePlaybackRate > 0 &&
                    Number.isFinite(drag.basePlaybackRate)
                        ? drag.basePlaybackRate
                        : 1;
                const nextRate = clamp(
                    (baseRate * baseLen) / Math.max(1e-6, nextLen),
                    0.1,
                    10,
                );

                dispatch(
                    setClipLength({
                        clipId: drag.clipId,
                        lengthBeats: nextLen,
                    }),
                );
                dispatch(
                    setClipPlaybackRate({
                        clipId: drag.clipId,
                        playbackRate: nextRate,
                    }),
                );
            }
        }

        function end() {
            const drag = editDragRef.current;
            if (!drag || drag.pointerId !== e.pointerId) return;
            editDragRef.current = null;

            const clipNow = sessionRef.current.clips.find(
                (c) => c.id === drag.clipId,
            );
            if (!clipNow) return;

            if (drag.type === "trim_left") {
                void dispatch(
                    moveClipRemote({
                        clipId: drag.clipId,
                        startBeat: clipNow.startBeat,
                        trackId: clipNow.trackId,
                    }),
                );
                void dispatch(
                    setClipStateRemote({
                        clipId: drag.clipId,
                        lengthBeats: clipNow.lengthBeats,
                        trimStartBeat: clipNow.trimStartBeat,
                    }),
                );
            } else if (drag.type === "trim_right") {
                void dispatch(
                    setClipStateRemote({
                        clipId: drag.clipId,
                        lengthBeats: clipNow.lengthBeats,
                        trimEndBeat: clipNow.trimEndBeat,
                    }),
                );
            } else if (drag.type === "stretch_left") {
                void dispatch(
                    moveClipRemote({
                        clipId: drag.clipId,
                        startBeat: clipNow.startBeat,
                        trackId: clipNow.trackId,
                    }),
                );
                void dispatch(
                    setClipStateRemote({
                        clipId: drag.clipId,
                        lengthBeats: clipNow.lengthBeats,
                        playbackRate: clipNow.playbackRate,
                    }),
                );
            } else if (drag.type === "stretch_right") {
                void dispatch(
                    setClipStateRemote({
                        clipId: drag.clipId,
                        lengthBeats: clipNow.lengthBeats,
                        playbackRate: clipNow.playbackRate,
                    }),
                );
            } else if (drag.type === "fade_in") {
                void dispatch(
                    setClipStateRemote({
                        clipId: drag.clipId,
                        fadeInBeats: clipNow.fadeInBeats,
                    }),
                );
            } else if (drag.type === "fade_out") {
                void dispatch(
                    setClipStateRemote({
                        clipId: drag.clipId,
                        fadeOutBeats: clipNow.fadeOutBeats,
                    }),
                );
            } else if (drag.type === "gain") {
                void dispatch(
                    setClipStateRemote({
                        clipId: drag.clipId,
                        gain: clipNow.gain,
                    }),
                );
            }

            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
        }

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
    }

    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (e.repeat) return;
            if (
                isEditableTarget(document.activeElement) ||
                isEditableTarget(e.target)
            )
                return;

            const key = e.key.toLowerCase();

            const selectedIds =
                multiSelectedClipIds.length > 0
                    ? [...multiSelectedClipIds]
                    : s.selectedClipId
                      ? [s.selectedClipId]
                      : [];

            // Delete / Backspace: remove selected items.
            if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                if (key === "delete" || key === "backspace") {
                    if (selectedIds.length === 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setMultiSelectedClipIds([]);
                    for (const id of selectedIds) {
                        void dispatch(removeClipRemote(id));
                    }
                    return;
                }
            }

            // Ctrl+C / Ctrl+V: copy/paste selected items.
            if ((e.ctrlKey || e.metaKey) && !e.altKey) {
                if (key === "c") {
                    if (selectedIds.length === 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const clips = sessionRef.current.clips.filter((c) =>
                        selectedIds.includes(c.id),
                    );
                    if (clips.length === 0) return;
                    const templates = clips.map((c) => ({
                        trackId: c.trackId,
                        name: c.name,
                        startBeat: c.startBeat,
                        lengthBeats: c.lengthBeats,
                        sourcePath: c.sourcePath,
                        durationSec: c.durationSec,
                        gain: c.gain,
                        muted: c.muted,
                        trimStartBeat: c.trimStartBeat,
                        trimEndBeat: c.trimEndBeat,
                        playbackRate: c.playbackRate,
                        fadeInBeats: c.fadeInBeats,
                        fadeOutBeats: c.fadeOutBeats,
                    }));
                    clipClipboardRef.current = templates;

                    // Best-effort: also write to system clipboard.
                    try {
                        void navigator.clipboard?.writeText(
                            JSON.stringify({
                                type: "hifishifter.clipTemplates.v1",
                                templates,
                            }),
                        );
                    } catch {
                        // ignore
                    }
                    return;
                }

                if (key === "v") {
                    const tpl = clipClipboardRef.current;
                    if (!tpl || tpl.length === 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const playhead = sessionRef.current.playheadBeat ?? 0;
                    const minStart = tpl
                        .map((c) => c.startBeat)
                        .reduce(
                            (a, b) => Math.min(a, b),
                            Number.POSITIVE_INFINITY,
                        );
                    const delta =
                        Number.isFinite(minStart) &&
                        minStart !== Number.POSITIVE_INFINITY
                            ? playhead - minStart
                            : 0;
                    const templates = tpl.map((c) => ({
                        ...c,
                        startBeat: Math.max(0, c.startBeat + delta),
                    }));
                    dispatch(checkpointHistory());
                    void dispatch(createClipsRemote({ templates }))
                        .unwrap()
.then((payload) => {
                            const created: string[] =
                                payload?.createdClipIds ?? [];
                            if (!Array.isArray(created) || created.length === 0)
                                return;
                            setMultiSelectedClipIds(created);
                            void dispatch(selectClipRemote(created[0]));
                        })
                        .catch(() => undefined);
                    return;
                }
            }

            if (!e.ctrlKey && !e.metaKey && !e.altKey && key === "s") {
                const clipId = s.selectedClipId;
                if (!clipId) return;
                e.preventDefault();
                e.stopPropagation();
                const splitBeat = Math.max(
                    0,
                    Number(sessionRef.current.playheadBeat ?? 0) || 0,
                );
                void dispatch(
                    splitClipRemote({
                        clipId,
                        splitBeat,
                    }),
                );
            }
        }
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [dispatch, multiSelectedClipIds, s.selectedClipId]);

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

    function startClipDrag(
        e: React.PointerEvent<HTMLDivElement>,
        clipId: string,
        clipStartBeat: number,
        altPressedHint?: boolean,
    ) {
        if (e.button !== 0) return;

        const anchor = sessionRef.current.clips.find((c) => c.id === clipId);
        if (!anchor) return;

        // Alt + drag: slip-edit (adjust internal offset), do not move the item.
        // This mode is continuous (no snap).
        const alt = Boolean(
            altPressedHint ||
            e.altKey ||
            e.nativeEvent.getModifierState?.("Alt"),
        );
        if (alt) {
            startSlipDrag(e, clipId);
            return;
        }
        const scroller = scrollRef.current;
        if (!scroller) return;
        const bounds = scroller.getBoundingClientRect();
        const beatAtPointer = beatFromClientX(
            e.clientX,
            bounds,
            scroller.scrollLeft,
        );

        const clipIds =
            multiSelectedClipIds.length > 0 && multiSelectedSet.has(clipId)
                ? [...multiSelectedClipIds]
                : [clipId];

        const initialById: Record<
            string,
            { startBeat: number; trackId: string }
        > = {};
        let minStartBeat = Number.POSITIVE_INFINITY;
        let allowTrackMove = true;
        let baseTrackId: string | null = null;
        for (const id of clipIds) {
            const c = sessionRef.current.clips.find((x) => x.id === id);
            if (!c) continue;
            const startBeat = Math.max(0, Number(c.startBeat ?? 0));
            initialById[id] = { startBeat, trackId: String(c.trackId) };
            minStartBeat = Math.min(minStartBeat, startBeat);
            if (baseTrackId == null) baseTrackId = String(c.trackId);
            if (baseTrackId !== String(c.trackId)) allowTrackMove = false;
        }
        if (!Number.isFinite(minStartBeat)) minStartBeat = 0;

        const initialTrackId = anchor.trackId;
        const targetTrackId = trackIdFromClientY(e.clientY) ?? initialTrackId;
        clipDragRef.current = {
            pointerId: e.pointerId,
            anchorClipId: clipId,
            clipIds,
            offsetBeat: beatAtPointer - clipStartBeat,
            initialById,
            minStartBeat,
            allowTrackMove,
            initialAnchorStartBeat: clipStartBeat,
            initialAnchorTrackId: initialTrackId,
            lastTrackId: targetTrackId,
            lastDeltaBeat: 0,
            copyMode: Boolean(e.ctrlKey || e.metaKey),
            startClientX: e.clientX,
            startClientY: e.clientY,
            hasMoved: false,
        };
        // Capture on the scroll container so cross-track moves (which re-parent the clip)
        // don't accidentally drop pointer capture.
        scroller.setPointerCapture(e.pointerId);

        function onMove(ev: PointerEvent) {
            const drag = clipDragRef.current;
            const el = scrollRef.current;
            if (!drag || drag.pointerId !== e.pointerId || !el) return;

            // Deadzone: treat small jitter as a click, not a drag.
            if (!drag.hasMoved) {
                const dx = ev.clientX - drag.startClientX;
                const dy = ev.clientY - drag.startClientY;
                if (dx * dx + dy * dy < 9) {
                    return;
                }
                drag.hasMoved = true;
                // Only checkpoint for real moves. Ctrl-drag creates new clips at end.
                if (!drag.copyMode) {
                    dispatch(checkpointHistory());
                }
            }
            const b = el.getBoundingClientRect();
            const beatNow = beatFromClientX(ev.clientX, b, el.scrollLeft);
            let nextStart = Math.max(0, beatNow - drag.offsetBeat);
            if (!ev.shiftKey) nextStart = snapBeat(nextStart);

            let deltaBeat = nextStart - drag.initialAnchorStartBeat;
            // Keep group relative offsets; clamp so no clip crosses < 0.
            deltaBeat = Math.max(deltaBeat, -drag.minStartBeat);
            drag.lastDeltaBeat = deltaBeat;

            const hoveredTrackId = trackIdFromClientY(ev.clientY);
            const nextTrackId = drag.allowTrackMove
                ? hoveredTrackId
                : drag.initialAnchorTrackId;

            if (drag.allowTrackMove) {
                drag.lastTrackId = nextTrackId;
                setClipDropNewTrack(nextTrackId == null);
            } else {
                drag.lastTrackId = drag.initialAnchorTrackId;
                setClipDropNewTrack(false);
            }

            batch(() => {
                for (const id of drag.clipIds) {
                    const initial = drag.initialById[id];
                    if (!initial) continue;
                    dispatch(
                        moveClipStart({
                            clipId: id,
                            startBeat: Math.max(
                                0,
                                initial.startBeat + deltaBeat,
                            ),
                        }),
                    );
                    if (drag.allowTrackMove) {
                        dispatch(
                            moveClipTrack({
                                clipId: id,
                                trackId: nextTrackId ?? NEW_TRACK_SENTINEL,
                            }),
                        );
                    }
                }
            });
        }

        function end() {
            const drag = clipDragRef.current;
            if (!drag || drag.pointerId !== e.pointerId) return;
            clipDragRef.current = null;
            setClipDropNewTrack(false);

            // If it never really moved, treat as click: do nothing.
            if (!drag.hasMoved) {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", end);
                window.removeEventListener("pointercancel", end);
                return;
            }

            const session = sessionRef.current;
            const dropToNewTrack =
                drag.allowTrackMove && drag.lastTrackId == null;

            async function createNewTrackForDrop(): Promise<string | null> {
                const before = new Set(
                    sessionRef.current.tracks.map((t) => t.id),
                );
                const res = (await dispatch(
                    addTrackRemote({ name: undefined, parentTrackId: null }),
                ).unwrap()) as {
                    tracks?: Array<{ id?: string }>;
                    selected_track_id?: string | null;
                };

                const nextTracks = Array.isArray(res?.tracks) ? res.tracks : [];
                const created = nextTracks.find(
                    (t) => !before.has(String(t?.id)),
                );
                return (
                    (created && String(created.id)) ||
                    (res?.selected_track_id
                        ? String(res.selected_track_id)
                        : null)
                );
            }

            if (drag.copyMode) {
                // Ctrl-drag duplicates: create copies at the dragged positions, keep originals.
                const templates: ClipTemplate[] = [];
                for (const id of drag.clipIds) {
                    const initial = drag.initialById[id];
                    const now = session.clips.find((c) => c.id === id);
                    if (!initial || !now) continue;
                    const effectiveTrackId =
                        String(now.trackId) === NEW_TRACK_SENTINEL
                            ? null
                            : String(now.trackId);
                    templates.push({
                        trackId: effectiveTrackId ?? initial.trackId,
                        name: String(now.name),
                        startBeat: Number(now.startBeat),
                        lengthBeats: Number(now.lengthBeats),
                        sourcePath: now.sourcePath,
                        durationSec: now.durationSec,
                        gain: Number(now.gain ?? 1) || 1,
                        muted: Boolean(now.muted),
                        trimStartBeat: Number(now.trimStartBeat ?? 0) || 0,
                        trimEndBeat: Number(now.trimEndBeat ?? 0) || 0,
                        playbackRate: Number(now.playbackRate ?? 1) || 1,
                        fadeInBeats: Number(now.fadeInBeats ?? 0) || 0,
                        fadeOutBeats: Number(now.fadeOutBeats ?? 0) || 0,
                    });

                    // Revert original.
                    dispatch(
                        moveClipStart({
                            clipId: id,
                            startBeat: initial.startBeat,
                        }),
                    );
                    dispatch(
                        moveClipTrack({ clipId: id, trackId: initial.trackId }),
                    );
                }
                if (templates.length > 0) {
                    dispatch(checkpointHistory());
                    void (async () => {
                        if (dropToNewTrack) {
                            const newTrackId = await createNewTrackForDrop();
                            if (newTrackId) {
                                for (const tpl of templates) {
                                    tpl.trackId = newTrackId;
                                }
                            }
                        }

                        const payload = await dispatch(
                            createClipsRemote({ templates }),
                        ).unwrap();
                        const created: string[] = payload?.createdClipIds ?? [];
                        if (!Array.isArray(created) || created.length === 0)
                            return;
                        setMultiSelectedClipIds(created);
                        void dispatch(selectClipRemote(created[0]));
                    })().catch(() => undefined);
                }
            } else {
                if (dropToNewTrack) {
                    void (async () => {
                        try {
                            const newTrackId = await createNewTrackForDrop();
                            if (!newTrackId) {
                                throw new Error("create_track_failed");
                            }
                            for (const id of drag.clipIds) {
                                const initial = drag.initialById[id];
                                const now = sessionRef.current.clips.find(
                                    (c) => c.id === id,
                                );
                                if (!initial || !now) continue;
                                void dispatch(
                                    moveClipRemote({
                                        clipId: id,
                                        startBeat: Number(now.startBeat),
                                        trackId: newTrackId,
                                    }),
                                );
                            }
                        } catch {
                            // Best-effort revert: avoid leaving clips on a non-existent temporary track.
                            for (const id of drag.clipIds) {
                                const initial = drag.initialById[id];
                                if (!initial) continue;
                                dispatch(
                                    moveClipTrack({
                                        clipId: id,
                                        trackId: initial.trackId,
                                    }),
                                );
                            }
                        }
                    })();

                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", end);
                    window.removeEventListener("pointercancel", end);
                    return;
                }

                for (const id of drag.clipIds) {
                    const initial = drag.initialById[id];
                    const now = session.clips.find((c) => c.id === id);
                    if (!initial || !now) continue;
                    const changedBeat =
                        Math.abs(Number(now.startBeat) - initial.startBeat) >
                        1e-6;
                    const changedTrack =
                        String(now.trackId) !== initial.trackId;
                    if (changedBeat || changedTrack) {
                        void dispatch(
                            moveClipRemote({
                                clipId: id,
                                startBeat: Number(now.startBeat),
                                trackId: String(now.trackId),
                            }),
                        );
                    }
                }
            }
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
        }

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
    }

    function startSlipDrag(
        e: React.PointerEvent<HTMLDivElement>,
        clipId: string,
    ) {
        if (e.button !== 0) return;
        const anchor = sessionRef.current.clips.find((c) => c.id === clipId);
        if (!anchor) return;
        const scroller = scrollRef.current;
        if (!scroller) return;

        dispatch(checkpointHistory());

        const bounds = scroller.getBoundingClientRect();
        const beatAtPointer = beatFromClientX(
            e.clientX,
            bounds,
            scroller.scrollLeft,
        );

        const clipIds =
            multiSelectedClipIds.length > 0 && multiSelectedSet.has(clipId)
                ? [...multiSelectedClipIds]
                : [clipId];

        const initialById: Record<
            string,
            {
                trimStartBeat: number;
                trimEndBeat: number;
                playbackRate: number;
                sourceBeats: number | null;
                maxSlipBeats: number;
            }
        > = {};
        const bpm = Number(sessionRef.current.bpm ?? 120) || 120;
        for (const id of clipIds) {
            const c = sessionRef.current.clips.find((x) => x.id === id);
            if (!c) continue;
            const sourceBeats = clipSourceBeats(c, bpm);
            const trimStartBeat = Number(c.trimStartBeat ?? 0) || 0;
            const trimEndBeat = Math.max(0, Number(c.trimEndBeat ?? 0) || 0);
            // Clamp slip distance to at most 1x the original source duration (in beats).
            // If source duration is unknown, fall back to the clip's current timeline length.
            const maxSlipBeats =
                sourceBeats != null && Number.isFinite(sourceBeats)
                    ? Math.max(0, Number(sourceBeats))
                    : Math.max(0, Number(c.lengthBeats ?? 0) || 0);
            initialById[id] = {
                trimStartBeat,
                trimEndBeat,
                playbackRate: Number(c.playbackRate ?? 1) || 1,
                sourceBeats,
                maxSlipBeats,
            };
        }

        slipDragRef.current = {
            pointerId: e.pointerId,
            anchorClipId: clipId,
            clipIds,
            initialPointerBeat: beatAtPointer,
            initialById,
        };

        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);

        function onMove(ev: PointerEvent) {
            const drag = slipDragRef.current;
            const el = scrollRef.current;
            if (!drag || drag.pointerId !== e.pointerId || !el) return;
            const b = el.getBoundingClientRect();
            const beatNow = beatFromClientX(ev.clientX, b, el.scrollLeft);
            // Slip direction: dragging right should move content right inside the clip
            // (i.e. reveal earlier content), which means trimStart decreases.
            let deltaBeat = drag.initialPointerBeat - beatNow;
            // Slip-edit should be continuous (no snap)

            for (const id of drag.clipIds) {
                const initial = drag.initialById[id];
                if (!initial) continue;
                const rate =
                    initial.playbackRate > 0 &&
                    Number.isFinite(initial.playbackRate)
                        ? initial.playbackRate
                        : 1;

                const deltaSrcBeat = deltaBeat * rate;

                // Non-repeating slip-edit: allow moving past source bounds.
                // Out-of-range time renders as silence.
                let nextTrimStart = initial.trimStartBeat + deltaSrcBeat;
                if (
                    Number.isFinite(initial.maxSlipBeats) &&
                    initial.maxSlipBeats > 1e-6
                ) {
                    nextTrimStart = clamp(
                        nextTrimStart,
                        -initial.maxSlipBeats,
                        initial.maxSlipBeats,
                    );
                }
                dispatch(
                    setClipTrim({ clipId: id, trimStartBeat: nextTrimStart }),
                );
            }
        }

        function end() {
            const drag = slipDragRef.current;
            if (!drag || drag.pointerId !== e.pointerId) return;
            slipDragRef.current = null;

            const session = sessionRef.current;
            for (const id of drag.clipIds) {
                const now = session.clips.find((c) => c.id === id);
                if (!now) continue;
                void dispatch(
                    setClipStateRemote({
                        clipId: id,
                        trimStartBeat: Number(now.trimStartBeat ?? 0) || 0,
                        trimEndBeat: Number(now.trimEndBeat ?? 0) || 0,
                    }),
                );
            }

            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
        }

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
    }

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

                        // In Tauri, DataTransfer may not expose files/types during external drag.
                        // Always preventDefault so the DOM drop event can fire.
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
                            // Prefer Tauri drag-drop event handler to avoid double import.
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
                            // Tauri may deliver the file path via onDragDropEvent slightly after DOM drop.
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

                {contextMenu ? (
                    <GlueContextMenu
                        x={contextMenu.x}
                        y={contextMenu.y}
                        disabled={(() => {
                            const ids =
                                multiSelectedClipIds.length >= 2
                                    ? multiSelectedClipIds
                                    : [contextMenu.clipId];
                            if (ids.length < 2) return true;
                            const clips = sessionRef.current.clips.filter((c) =>
                                ids.includes(c.id),
                            );
                            if (clips.length !== ids.length) return true;
                            const trackId = clips[0]?.trackId;
                            return (
                                !trackId ||
                                clips.some((c) => c.trackId !== trackId)
                            );
                        })()}
                        onGlue={() => {
                            const ids =
                                multiSelectedClipIds.length >= 2
                                    ? multiSelectedClipIds
                                    : [contextMenu.clipId];
                            setContextMenu(null);
                            if (ids.length >= 2) {
                                void dispatch(glueClipsRemote(ids));
                                setMultiSelectedClipIds([]);
                            }
                        }}
                    />
                ) : null}
            </Flex>
        </Flex>
    );
};
