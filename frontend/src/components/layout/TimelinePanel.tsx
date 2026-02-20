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
    moveClipRemote,
    moveClipStart,
    moveClipTrack,
    setClipLength,
    setClipTrim,
    setClipFades,
    setClipGain,
    setClipMuted,
    importAudioAtPosition,
    importAudioFileAtPosition,
    setClipStateRemote,
    splitClipRemote,
    glueClipsRemote,
} from "../../features/session/sessionSlice";

import {
    BackgroundGrid,
    ClipItem,
    DEFAULT_PX_PER_BEAT,
    DEFAULT_ROW_HEIGHT,
    GlueContextMenu,
    MAX_PX_PER_BEAT,
    MAX_ROW_HEIGHT,
    MIN_PX_PER_BEAT,
    MIN_ROW_HEIGHT,
    TimelineScrollArea,
    TimeRuler,
    TrackList,
    clamp,
    clipSourceBeats,
    dbToGain,
    extractLocalFilePath,
    gainToDb,
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
    const playheadDragRef = useRef<{
        pointerId: number;
        lastBeat: number;
    } | null>(null);
    const [scrollLeft, setScrollLeft] = useState(0);
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
        lastTrackId: string;
        lastDeltaBeat: number;
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

    const selectionDragRef = useRef<{
        pointerId: number;
        startX: number;
        startY: number;
        curX: number;
        curY: number;
    } | null>(null);
    const [selectionRect, setSelectionRect] = useState<{
        x1: number;
        y1: number;
        x2: number;
        y2: number;
    } | null>(null);

    const editDragRef = useRef<{
        type: "trim_left" | "trim_right" | "fade_in" | "fade_out" | "gain";
        pointerId: number;
        clipId: string;
        baseStartBeat: number;
        baseLengthBeats: number;
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

    const dropExtraRows = dropPreview && !dropPreview.trackId ? 1 : 0;
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
        if (idx < 0 || idx >= s.tracks.length) return null;
        return s.tracks[idx]?.id ?? null;
    }

    function rowTopForTrackId(trackId: string | null) {
        if (!trackId) {
            return s.tracks.length * rowHeight;
        }
        const idx = s.tracks.findIndex((t) => t.id === trackId);
        return Math.max(0, idx) * rowHeight;
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

    function startPan(e: React.MouseEvent) {
        const scroller = scrollRef.current;
        if (!scroller) return;
        panRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            scrollLeft: scroller.scrollLeft,
            scrollTop: scroller.scrollTop,
        };
        const prevCursor = document.body.style.cursor;
        const prevSelect = document.body.style.userSelect;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";

        function onMove(ev: MouseEvent) {
            const pan = panRef.current;
            const el = scrollRef.current;
            if (!pan || !el) return;
            el.scrollLeft = pan.scrollLeft - (ev.clientX - pan.startX);
            el.scrollTop = pan.scrollTop - (ev.clientY - pan.startY);
            setScrollLeft(el.scrollLeft);
        }

        function end() {
            panRef.current = null;
            document.body.style.cursor = prevCursor;
            document.body.style.userSelect = prevSelect;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", end);
        }

        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", end);
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
        type: "trim_left" | "trim_right" | "fade_in" | "fade_out" | "gain",
    ) {
        if (e.button !== 0) return;
        const clip = sessionRef.current.clips.find((c) => c.id === clipId);
        if (!clip) return;
        const scroller = scrollRef.current;
        if (!scroller) return;
        const rightEdgeBeat = clip.startBeat + clip.lengthBeats;

        editDragRef.current = {
            type,
            pointerId: e.pointerId,
            clipId,
            baseStartBeat: clip.startBeat,
            baseLengthBeats: clip.lengthBeats,
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
            if (ev.altKey) beat = snapBeat(beat);

            const clipNow = sessionRef.current.clips.find(
                (c) => c.id === drag.clipId,
            );
            if (!clipNow) return;

            const minLen = 0.0;
            const sourceBeats = drag.sourceBeats;

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

                let nextTrimStart = drag.baseTrimStartBeat + desiredDelta;
                if (sourceBeats != null) {
                    nextTrimStart = clamp(
                        nextTrimStart,
                        0,
                        Math.max(
                            0,
                            sourceBeats - drag.baseTrimEndBeat - minLen,
                        ),
                    );
                } else {
                    nextTrimStart = Math.max(0, nextTrimStart);
                }
                const actualDelta = nextTrimStart - drag.baseTrimStartBeat;
                const nextStart = drag.baseStartBeat + actualDelta;
                const nextLen = clamp(
                    drag.baseLengthBeats - actualDelta,
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

            if (drag.type === "trim_right") {
                const desiredRight = clamp(
                    beat,
                    drag.baseStartBeat + minLen,
                    10_000,
                );
                const desiredDelta = desiredRight - drag.rightEdgeBeat;

                let nextTrimEnd = drag.baseTrimEndBeat - desiredDelta;
                if (sourceBeats != null) {
                    nextTrimEnd = clamp(
                        nextTrimEnd,
                        0,
                        Math.max(
                            0,
                            sourceBeats - drag.baseTrimStartBeat - minLen,
                        ),
                    );
                } else {
                    nextTrimEnd = Math.max(0, nextTrimEnd);
                }
                const actualDelta = drag.baseTrimEndBeat - nextTrimEnd;
                const nextLen = clamp(
                    drag.baseLengthBeats + actualDelta,
                    minLen,
                    10_000,
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
                        trimEndBeat: nextTrimEnd,
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
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (
                isEditableTarget(document.activeElement) ||
                isEditableTarget(e.target)
            )
                return;

            if (e.key.toLowerCase() === "s") {
                const clipId = s.selectedClipId;
                if (!clipId) return;
                e.preventDefault();
                e.stopPropagation();
                void dispatch(
                    splitClipRemote({
                        clipId,
                        splitBeat: Math.max(0, s.playheadBeat),
                    }),
                );
            }
        }
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [dispatch, s.playheadBeat, s.selectedClipId]);

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
    ) {
        if (e.button !== 0) return;
        const anchor = sessionRef.current.clips.find((c) => c.id === clipId);
        if (!anchor) return;
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
        };
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);

        function onMove(ev: PointerEvent) {
            const drag = clipDragRef.current;
            const el = scrollRef.current;
            if (!drag || drag.pointerId !== e.pointerId || !el) return;
            const b = el.getBoundingClientRect();
            const beatNow = beatFromClientX(ev.clientX, b, el.scrollLeft);
            let nextStart = Math.max(0, beatNow - drag.offsetBeat);
            if (ev.altKey) {
                nextStart = snapBeat(nextStart);
            }

            let deltaBeat = nextStart - drag.initialAnchorStartBeat;
            // Keep group relative offsets; clamp so no clip crosses < 0.
            deltaBeat = Math.max(deltaBeat, -drag.minStartBeat);
            drag.lastDeltaBeat = deltaBeat;

            const nextTrackId = drag.allowTrackMove
                ? (trackIdFromClientY(ev.clientY) ?? drag.lastTrackId)
                : drag.initialAnchorTrackId;
            if (drag.allowTrackMove && nextTrackId !== drag.lastTrackId) {
                drag.lastTrackId = nextTrackId;
            }

            for (const id of drag.clipIds) {
                const initial = drag.initialById[id];
                if (!initial) continue;
                dispatch(
                    moveClipStart({
                        clipId: id,
                        startBeat: Math.max(0, initial.startBeat + deltaBeat),
                    }),
                );
                if (drag.allowTrackMove) {
                    dispatch(
                        moveClipTrack({ clipId: id, trackId: nextTrackId }),
                    );
                }
            }
        }

        function end() {
            const drag = clipDragRef.current;
            if (!drag || drag.pointerId !== e.pointerId) return;
            clipDragRef.current = null;

            const session = sessionRef.current;
            for (const id of drag.clipIds) {
                const initial = drag.initialById[id];
                const now = session.clips.find((c) => c.id === id);
                if (!initial || !now) continue;
                const changedBeat =
                    Math.abs(Number(now.startBeat) - initial.startBeat) > 1e-6;
                const changedTrack = String(now.trackId) !== initial.trackId;
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
                    setScrollLeft={setScrollLeft}
                    className="flex-1 bg-qt-graph-bg overflow-auto relative custom-scrollbar"
                    onContextMenu={(e) => {
                        e.preventDefault();
                    }}
                    onPointerDown={(e) => {
                        if (e.button !== 2) return;
                        const el = e.currentTarget as HTMLDivElement;
                        const bounds = el.getBoundingClientRect();
                        const x = e.clientX - bounds.left + el.scrollLeft;
                        const y = e.clientY - bounds.top + el.scrollTop;
                        selectionDragRef.current = {
                            pointerId: e.pointerId,
                            startX: x,
                            startY: y,
                            curX: x,
                            curY: y,
                        };
                        setSelectionRect({ x1: x, y1: y, x2: x, y2: y });
                        setContextMenu(null);
                        e.preventDefault();
                        e.stopPropagation();
                        el.setPointerCapture(e.pointerId);

                        function onMove(ev: PointerEvent) {
                            const drag = selectionDragRef.current;
                            const current = scrollRef.current;
                            if (
                                !drag ||
                                drag.pointerId !== e.pointerId ||
                                !current
                            )
                                return;
                            const b = current.getBoundingClientRect();
                            const cx = ev.clientX - b.left + current.scrollLeft;
                            const cy = ev.clientY - b.top + current.scrollTop;
                            drag.curX = cx;
                            drag.curY = cy;
                            setSelectionRect({
                                x1: Math.min(drag.startX, cx),
                                y1: Math.min(drag.startY, cy),
                                x2: Math.max(drag.startX, cx),
                                y2: Math.max(drag.startY, cy),
                            });
                        }

                        function end() {
                            const drag = selectionDragRef.current;
                            if (!drag || drag.pointerId !== e.pointerId) return;
                            selectionDragRef.current = null;
                            const rect = {
                                x1: Math.min(drag.startX, drag.curX),
                                y1: Math.min(drag.startY, drag.curY),
                                x2: Math.max(drag.startX, drag.curX),
                                y2: Math.max(drag.startY, drag.curY),
                            };
                            setSelectionRect(null);

                            const session = sessionRef.current;
                            const selected: string[] = [];
                            for (const clip of session.clips) {
                                const trackIdx = session.tracks.findIndex(
                                    (t) => t.id === clip.trackId,
                                );
                                if (trackIdx < 0) continue;
                                const cx1 = clip.startBeat * pxPerBeat;
                                const cx2 =
                                    (clip.startBeat + clip.lengthBeats) *
                                    pxPerBeat;
                                const cy1 = trackIdx * rowHeight;
                                const cy2 = cy1 + rowHeight;
                                const hit =
                                    cx2 >= rect.x1 &&
                                    cx1 <= rect.x2 &&
                                    cy2 >= rect.y1 &&
                                    cy1 <= rect.y2;
                                if (hit) selected.push(clip.id);
                            }
                            setMultiSelectedClipIds(selected);
                            if (selected.length === 1) {
                                void dispatch(selectClipRemote(selected[0]));
                            }

                            window.removeEventListener("pointermove", onMove);
                            window.removeEventListener("pointerup", end);
                            window.removeEventListener("pointercancel", end);
                        }

                        window.addEventListener("pointermove", onMove);
                        window.addEventListener("pointerup", end);
                        window.addEventListener("pointercancel", end);
                    }}
                    onDragOver={(e) => {
                        const dt = e.dataTransfer;
                        if (!hasFileDrag(dt)) return;
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
                        setDropPreview({
                            path: info?.path ?? "",
                            fileName: info?.name ?? "File",
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
                        if (!hasFileDrag(dt)) return;
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
                        setDropPreview(null);
                        if (info?.path) {
                            void dispatch(
                                importAudioAtPosition({
                                    audioPath: info.path,
                                    trackId: trackId ?? undefined,
                                    startBeat: beat,
                                }),
                            );
                            return;
                        }

                        const fallbackFile = dt.files?.[0] ?? null;
                        if (fallbackFile) {
                            void dispatch(
                                importAudioFileAtPosition({
                                    file: fallbackFile,
                                    trackId: trackId ?? undefined,
                                    startBeat: beat,
                                }),
                            );
                        }
                    }}
                    onMouseDown={(e) => {
                        if (e.button === 1) {
                            e.preventDefault();
                            startPan(e);
                            return;
                        }
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

                        {s.tracks.map((track) => {
                            const trackClips = s.clips
                                .filter((clip) => clip.trackId === track.id)
                                .slice()
                                .sort((a, b) => {
                                    const d =
                                        (a.startBeat ?? 0) - (b.startBeat ?? 0);
                                    if (Math.abs(d) > 1e-9) return d;
                                    return String(a.id).localeCompare(
                                        String(b.id),
                                    );
                                });
                            return (
                                <div
                                    key={track.id}
                                    className="border-b border-qt-border relative"
                                    style={{ height: rowHeight }}
                                >
                                    {trackClips.map((clip) => {
                                        const selected =
                                            multiSelectedClipIds.length > 0
                                                ? multiSelectedSet.has(clip.id)
                                                : s.selectedClipId === clip.id;
                                        const waveform = s.clipWaveforms[
                                            clip.id
                                        ] as any;
                                        return (
                                            <ClipItem
                                                key={clip.id}
                                                clip={clip}
                                                rowHeight={rowHeight}
                                                pxPerBeat={pxPerBeat}
                                                bpm={s.bpm}
                                                waveform={waveform}
                                                selected={selected}
                                                isInMultiSelectedSet={multiSelectedSet.has(
                                                    clip.id,
                                                )}
                                                multiSelectedCount={
                                                    multiSelectedClipIds.length
                                                }
                                                ensureSelected={(clipId) => {
                                                    if (
                                                        multiSelectedClipIds.length ===
                                                            0 ||
                                                        !multiSelectedSet.has(
                                                            clipId,
                                                        )
                                                    ) {
                                                        setMultiSelectedClipIds(
                                                            [clipId],
                                                        );
                                                    }
                                                }}
                                                selectClipRemote={(clipId) => {
                                                    void dispatch(
                                                        selectClipRemote(
                                                            clipId,
                                                        ),
                                                    );
                                                }}
                                                openContextMenu={(
                                                    clipId,
                                                    clientX,
                                                    clientY,
                                                ) => {
                                                    setContextMenu({
                                                        x: clientX,
                                                        y: clientY,
                                                        clipId,
                                                    });
                                                }}
                                                seekFromClientX={(
                                                    clientX,
                                                    commit,
                                                ) => {
                                                    const scroller =
                                                        scrollRef.current;
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
                                                toggleClipMuted={(
                                                    clipId,
                                                    nextMuted,
                                                ) => {
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
                                </div>
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
                                    <div className="px-2 pt-1 text-[10px] text-gray-200 truncate">
                                        {dropPreview.fileName}
                                    </div>
                                </div>
                            </div>
                        ) : null}

                        {/* Playhead Cursor */}
                        <div
                            className="absolute top-0 bottom-0 w-px bg-red-500 z-20 cursor-ew-resize"
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
