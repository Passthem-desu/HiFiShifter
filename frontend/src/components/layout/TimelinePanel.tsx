import React, { useEffect, useMemo, useRef, useState } from "react";
import { Flex, Box, Text, IconButton, Slider } from "@radix-ui/themes";
import { Cross2Icon, PlusIcon } from "@radix-ui/react-icons";
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

const DEFAULT_PX_PER_BEAT = 50;
const MIN_PX_PER_BEAT = 16;
const MAX_PX_PER_BEAT = 160;
const DEFAULT_ROW_HEIGHT = 96;
const MIN_ROW_HEIGHT = 56;
const MAX_ROW_HEIGHT = 192;
const CLIP_HEADER_HEIGHT = 18;
const CLIP_BODY_PADDING_Y = 6;

function gridStepBeats(grid: string): number {
    if (grid === "1/8") return 0.5;
    if (grid === "1/16") return 0.25;
    if (grid === "1/32") return 0.125;
    return 1;
}

function waveformAreaPath(
    samples: number[],
    width: number,
    height: number,
    ampScale: number = 1,
): string {
    if (!samples.length || width <= 0 || height <= 0) return "";
    const mid = height / 2;
    const scale = height * 0.45;
    const step = width / Math.max(1, samples.length - 1);
    const s = Math.max(0, Number(ampScale) || 0);
    let top = `M 0 ${mid.toFixed(2)}`;
    for (let i = 0; i < samples.length; i++) {
        const x = i * step;
        const amp = Math.max(0, Math.min(1, Math.abs(samples[i] ?? 0) * s));
        const y = mid - amp * scale;
        top += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    let bottom = "";
    for (let i = samples.length - 1; i >= 0; i--) {
        const x = i * step;
        const amp = Math.max(0, Math.min(1, Math.abs(samples[i] ?? 0) * s));
        const y = mid + amp * scale;
        bottom += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    return `${top}${bottom} Z`;
}

function fadeInAreaPath(width: number, height: number, steps = 24): string {
    if (width <= 0 || height <= 0) return "";
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < steps; i++) {
        const t = i / Math.max(1, steps - 1);
        const x = t * width;
        const g = Math.sin((t * Math.PI) / 2); // curved
        const y = height * (1 - g);
        pts.push({ x, y });
    }
    let d = `M 0 ${height.toFixed(2)}`;
    for (const p of pts) d += ` L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
    d += ` L ${width.toFixed(2)} ${height.toFixed(2)} Z`;
    return d;
}

function fadeOutAreaPath(width: number, height: number, steps = 24): string {
    if (width <= 0 || height <= 0) return "";
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < steps; i++) {
        const t = i / Math.max(1, steps - 1);
        const x = t * width;
        const g = Math.cos((t * Math.PI) / 2); // curved
        const y = height * (1 - g);
        pts.push({ x, y });
    }
    let d = `M 0 ${height.toFixed(2)}`;
    // first point is near top; the polygon still references bottom-left first.
    for (const p of pts) d += ` L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
    d += ` L ${width.toFixed(2)} ${height.toFixed(2)} Z`;
    return d;
}

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

    function hasFileDrag(dt: DataTransfer): boolean {
        if (!dt) return false;
        if (dt.files && dt.files.length > 0) return true;
        const types = Array.from(dt.types ?? []);
        if (types.includes("Files")) return true;
        const items = Array.from(dt.items ?? []);
        return items.some((it) => it.kind === "file");
    }

    function extractLocalFilePath(
        dt: DataTransfer,
    ): { path: string; name: string } | null {
        const itemFile = Array.from(dt.items ?? [])
            .find((it) => it.kind === "file")
            ?.getAsFile() as any;
        const file = (dt.files?.[0] as any) ?? itemFile;

        const directPath = String(file?.path ?? "").trim();
        if (directPath) {
            return {
                path: directPath,
                name: String(file?.name ?? directPath),
            };
        }

        const uriList = String(dt.getData("text/uri-list") ?? "").trim();
        if (uriList) {
            const first = uriList
                .split(/\r?\n/)
                .map((line) => line.trim())
                .find((line) => line && !line.startsWith("#"));
            if (first) {
                try {
                    const url = new URL(first);
                    if (url.protocol === "file:") {
                        let p = decodeURIComponent(url.pathname);
                        if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
                        if (p) {
                            return {
                                path: p,
                                name: String(file?.name ?? p),
                            };
                        }
                    }
                } catch {
                    // ignore
                }
            }
        }

        const text = String(dt.getData("text/plain") ?? "").trim();
        if (text && (text.includes("\\") || /^[A-Za-z]:\\/.test(text))) {
            return {
                path: text,
                name: String(file?.name ?? text),
            };
        }

        return null;
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

    useEffect(() => {
        const scroller = scrollRef.current;
        if (!scroller) return;
        setScrollLeft(scroller.scrollLeft);
    }, []);

    useEffect(() => {
        localStorage.setItem("hifishifter.pxPerBeat", String(pxPerBeat));
    }, [pxPerBeat]);

    useEffect(() => {
        localStorage.setItem("hifishifter.rowHeight", String(rowHeight));
    }, [rowHeight]);

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

    function clamp(value: number, minV: number, maxV: number) {
        return Math.min(maxV, Math.max(minV, value));
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

    function gainToDb(gain: number): number {
        const g = Math.max(1e-4, Number(gain) || 1);
        return 20 * Math.log10(g);
    }

    function dbToGain(db: number): number {
        return Math.pow(10, db / 20);
    }

    function clipSourceBeats(clip: (typeof s.clips)[number]): number | null {
        const durationSec = Number((clip as any).durationSec ?? 0);
        if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
        return (durationSec * sessionRef.current.bpm) / 60;
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
            sourceBeats: clipSourceBeats(clip),
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

    function sliceWaveformSamples(
        samples: number[],
        clip: (typeof s.clips)[number],
    ): number[] {
        if (!Array.isArray(samples) || samples.length < 2) return samples;
        const durationSec = Number((clip as any).durationSec ?? 0);
        if (!Number.isFinite(durationSec) || durationSec <= 0) return samples;
        const bpm = Math.max(1e-6, Number(s.bpm) || 120);
        const sourceBeats = (durationSec * bpm) / 60;
        if (!Number.isFinite(sourceBeats) || sourceBeats <= 1e-6)
            return samples;

        const trimStart = Math.max(0, Number(clip.trimStartBeat ?? 0) || 0);
        const trimEnd = Math.max(0, Number(clip.trimEndBeat ?? 0) || 0);
        const startBeat = clamp(trimStart, 0, sourceBeats);
        const maxEndBeat = Math.max(startBeat, sourceBeats - trimEnd);
        const desiredLen = Math.max(0, Number(clip.lengthBeats ?? 0) || 0);
        const endBeat = clamp(startBeat + desiredLen, startBeat, maxEndBeat);
        if (endBeat - startBeat <= 1e-9) return [];

        const n = samples.length;
        const i0 = clamp(Math.floor((startBeat / sourceBeats) * n), 0, n - 1);
        const i1 = clamp(Math.ceil((endBeat / sourceBeats) * n), i0 + 1, n);
        return samples.slice(i0, i1);
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
            {/* Track List (Left) */}
            <Flex
                direction="column"
                className="w-64 border-r border-qt-border bg-qt-window shrink-0"
            >
                <Box className="h-6 border-b border-qt-border px-2 flex items-center bg-qt-window shadow-sm z-10">
                    <Text size="1" weight="bold" color="gray">
                        {t("tracks")}
                    </Text>
                </Box>
                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    {s.tracks.map((track) => {
                        const selected = s.selectedTrackId === track.id;
                        const indent = Math.max(0, (track.depth ?? 0) * 12);
                        const muted = Boolean(track.muted);
                        const solo = Boolean(track.solo);
                        const backendVolume = Math.max(
                            0,
                            Math.min(1, Number(track.volume ?? 0.9)),
                        );
                        const uiOverride = trackVolumeUi[track.id];
                        const volume = Number.isFinite(uiOverride)
                            ? uiOverride
                            : backendVolume;

                        return (
                            <Box
                                key={track.id}
                                className={`border-b border-qt-border bg-qt-base relative group transition-colors overflow-hidden ${selected ? "bg-qt-button-hover" : "hover:bg-qt-button-hover"}`}
                                style={{ height: rowHeight }}
                                onClick={() =>
                                    dispatch(selectTrackRemote(track.id))
                                }
                            >
                                <div
                                    className={`absolute left-0 top-0 bottom-0 w-1 bg-qt-highlight transition-opacity ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                                ></div>
                                <Flex
                                    direction="column"
                                    p="2"
                                    gap="2"
                                    height="100%"
                                    justify="center"
                                >
                                    <Flex
                                        justify="between"
                                        align="center"
                                        style={{ paddingLeft: indent }}
                                    >
                                        <Text
                                            size="2"
                                            weight="medium"
                                            className="text-gray-200 truncate pr-2"
                                        >
                                            {track.name}
                                        </Text>
                                        <IconButton
                                            size="1"
                                            variant="ghost"
                                            color="gray"
                                            className="opacity-0 group-hover:opacity-100"
                                            disabled={s.tracks.length <= 1}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                dispatch(
                                                    removeTrackRemote(track.id),
                                                );
                                            }}
                                        >
                                            <Cross2Icon />
                                        </IconButton>
                                    </Flex>

                                    <Flex gap="2" align="center">
                                        <button
                                            className={`w-6 h-5 rounded text-[10px] border transition-all ${muted ? "bg-red-900 text-red-200 border-red-500" : "bg-qt-button text-gray-300 border-transparent hover:border-red-500 hover:bg-red-900 hover:text-red-200"}`}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                dispatch(
                                                    setTrackStateRemote({
                                                        trackId: track.id,
                                                        muted: !muted,
                                                    }),
                                                );
                                            }}
                                        >
                                            M
                                        </button>
                                        <button
                                            className={`w-6 h-5 rounded text-[10px] border transition-all ${solo ? "bg-yellow-900 text-yellow-200 border-yellow-500" : "bg-qt-button text-gray-300 border-transparent hover:border-yellow-500 hover:bg-yellow-900 hover:text-yellow-200"}`}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                dispatch(
                                                    setTrackStateRemote({
                                                        trackId: track.id,
                                                        solo: !solo,
                                                    }),
                                                );
                                            }}
                                        >
                                            S
                                        </button>
                                        <Box flexGrow="1" />
                                        <Text size="1" color="gray">
                                            {Math.round(volume * 100)}%
                                        </Text>
                                    </Flex>

                                    <Slider
                                        value={[Math.round(volume * 100)]}
                                        size="1"
                                        className="w-full"
                                        onValueChange={(v) => {
                                            const next =
                                                Math.max(
                                                    0,
                                                    Math.min(
                                                        100,
                                                        Number(v[0] ?? 0),
                                                    ),
                                                ) / 100;
                                            setTrackVolumeUi((prev) => ({
                                                ...prev,
                                                [track.id]: next,
                                            }));
                                        }}
                                        onValueCommit={(v) => {
                                            const next =
                                                Math.max(
                                                    0,
                                                    Math.min(
                                                        100,
                                                        Number(v[0] ?? 0),
                                                    ),
                                                ) / 100;
                                            setTrackVolumeUi((prev) => {
                                                const copy = { ...prev };
                                                delete copy[track.id];
                                                return copy;
                                            });
                                            dispatch(
                                                setTrackStateRemote({
                                                    trackId: track.id,
                                                    volume: next,
                                                }),
                                            );
                                        }}
                                        onPointerDown={(e) =>
                                            e.stopPropagation()
                                        }
                                    />
                                </Flex>
                            </Box>
                        );
                    })}
                    <Flex
                        align="center"
                        justify="center"
                        className="h-8 border-b border-qt-border border-dashed text-gray-500 hover:text-gray-300 hover:bg-qt-button-hover cursor-pointer transition-colors"
                        onClick={() => dispatch(addTrackRemote({}))}
                    >
                        <PlusIcon className="mr-1" />{" "}
                        <Text size="1">{t("track_add")}</Text>
                    </Flex>
                </div>
            </Flex>

            {/* Timeline View (Right) */}
            <Flex
                direction="column"
                className="flex-1 relative overflow-hidden bg-qt-graph-bg"
            >
                {/* Time Ruler */}
                <Box
                    className="h-6 bg-qt-window border-b border-qt-border relative overflow-hidden shrink-0 select-none"
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
                >
                    <div
                        className="absolute inset-0 will-change-transform"
                        style={{
                            width: contentWidth,
                            transform: `translateX(${-scrollLeft}px)`,
                        }}
                    >
                        {bars.map((m) => (
                            <div
                                key={m.beat}
                                className="absolute top-0 bottom-0 text-[10px] text-gray-500 pt-1"
                                style={{ left: m.beat * pxPerBeat }}
                            >
                                <div className="pl-1 border-l border-gray-600 h-2">
                                    {m.label}
                                </div>
                            </div>
                        ))}

                        {/* Playhead (ruler) */}
                        <div
                            className="absolute top-0 bottom-0 w-px bg-red-500 z-20"
                            style={{ left: s.playheadBeat * pxPerBeat }}
                        />
                        <div
                            className="absolute top-0 z-30"
                            style={{
                                left: s.playheadBeat * pxPerBeat,
                                transform: "translateX(-6px)",
                            }}
                        >
                            <div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] border-t-red-500" />
                        </div>
                    </div>
                </Box>

                {/* Tracks Area */}
                <div
                    ref={scrollRef}
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
                    onScroll={(e) => {
                        setScrollLeft(
                            (e.currentTarget as HTMLDivElement).scrollLeft,
                        );
                    }}
                    onWheel={(e) => {
                        // Alt + wheel: vertical zoom (track height)
                        if (e.altKey) {
                            e.preventDefault();
                            const dir = e.deltaY < 0 ? 1 : -1;
                            const factor = dir > 0 ? 1.1 : 0.9;
                            setRowHeight((prev) =>
                                Math.round(
                                    clamp(
                                        prev * factor,
                                        MIN_ROW_HEIGHT,
                                        MAX_ROW_HEIGHT,
                                    ),
                                ),
                            );
                            return;
                        }

                        // Ctrl + wheel: horizontal zoom (time scale)
                        if (!e.ctrlKey) return;
                        e.preventDefault();
                        const dir = e.deltaY < 0 ? 1 : -1;
                        const factor = dir > 0 ? 1.1 : 0.9;
                        setPxPerBeat((prev) => {
                            const next = Math.min(
                                MAX_PX_PER_BEAT,
                                Math.max(MIN_PX_PER_BEAT, prev * factor),
                            );
                            return next;
                        });
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

                        {/* Background Grid (clipped to project width) */}
                        <div
                            className="absolute left-0 top-0 pointer-events-none"
                            style={{
                                width: contentWidth,
                                height: contentHeight,
                                backgroundImage: [
                                    "linear-gradient(to right, var(--qt-graph-grid-weak) 1px, transparent 1px)",
                                    "linear-gradient(to right, var(--qt-graph-grid-strong) 2px, transparent 2px)",
                                ].join(", "),
                                backgroundSize: [
                                    `${pxPerBeat * gridStepBeats(s.grid)}px 100%`,
                                    `${pxPerBeat * Math.max(1, Math.round(s.beats || 4))}px 100%`,
                                ].join(", "),
                                opacity: 0.75,
                            }}
                        />

                        {/* Project End Boundary */}
                        <div
                            className="absolute top-0 bottom-0 w-px z-20"
                            style={{
                                left: contentWidth - 1,
                                backgroundColor: "var(--qt-highlight)",
                                opacity: 0.9,
                            }}
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
                                        const left = Math.max(
                                            0,
                                            clip.startBeat * pxPerBeat,
                                        );
                                        const width = Math.max(
                                            1,
                                            clip.lengthBeats * pxPerBeat,
                                        );
                                        const waveformAmpScale = clip.muted
                                            ? 0
                                            : clamp(
                                                  Number(clip.gain ?? 1),
                                                  0,
                                                  4,
                                              );
                                        const waveform =
                                            s.clipWaveforms[clip.id];
                                        const stereo =
                                            waveform &&
                                            typeof waveform === "object" &&
                                            !Array.isArray(waveform) &&
                                            "l" in waveform &&
                                            "r" in waveform;
                                        return (
                                            <div
                                                key={clip.id}
                                                className={`absolute rounded-sm cursor-pointer shadow-sm overflow-visible border ${clip.muted ? "opacity-60 grayscale" : "opacity-95"} ${selected ? "border-white" : "border-qt-highlight"}`}
                                                style={{
                                                    left,
                                                    width,
                                                    top: CLIP_HEADER_HEIGHT,
                                                    height:
                                                        rowHeight -
                                                        CLIP_HEADER_HEIGHT -
                                                        CLIP_BODY_PADDING_Y,
                                                    backgroundColor:
                                                        "color-mix(in oklab, var(--qt-highlight) 35%, transparent)",
                                                }}
                                                onContextMenu={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    if (
                                                        !multiSelectedSet.has(
                                                            clip.id,
                                                        )
                                                    ) {
                                                        setMultiSelectedClipIds(
                                                            [clip.id],
                                                        );
                                                    }
                                                    void dispatch(
                                                        selectClipRemote(
                                                            clip.id,
                                                        ),
                                                    );
                                                    setContextMenu({
                                                        x: e.clientX,
                                                        y: e.clientY,
                                                        clipId: clip.id,
                                                    });
                                                }}
                                                onPointerDown={(e) => {
                                                    // Only handle left-button interactions here.
                                                    // Allow middle-button pan to bubble (so it won't be intercepted by clips).
                                                    if (e.button !== 0) return;

                                                    // Prevent pointer -> mouse compatibility events from bubbling to
                                                    // the lane's onMouseDown (which would move the playhead).
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    setContextMenu(null);
                                                    // When multi-selected, interacting with one selected clip should not clear selection.
                                                    if (
                                                        multiSelectedClipIds.length ===
                                                            0 ||
                                                        !multiSelectedSet.has(
                                                            clip.id,
                                                        )
                                                    ) {
                                                        setMultiSelectedClipIds(
                                                            [clip.id],
                                                        );
                                                    }
                                                    void dispatch(
                                                        selectClipRemote(
                                                            clip.id,
                                                        ),
                                                    );
                                                    startClipDrag(
                                                        e,
                                                        clip.id,
                                                        clip.startBeat,
                                                    );
                                                }}
                                                title={
                                                    clip.sourcePath ?? clip.name
                                                }
                                            >
                                                {/* Trim handles */}
                                                <div
                                                    className="absolute left-0 top-0 bottom-0 w-[6px] z-40"
                                                    style={{
                                                        cursor: "ew-resize",
                                                    }}
                                                    onPointerDown={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        if (
                                                            multiSelectedClipIds.length ===
                                                                0 ||
                                                            !multiSelectedSet.has(
                                                                clip.id,
                                                            )
                                                        ) {
                                                            setMultiSelectedClipIds(
                                                                [clip.id],
                                                            );
                                                        }
                                                        void dispatch(
                                                            selectClipRemote(
                                                                clip.id,
                                                            ),
                                                        );
                                                        startEditDrag(
                                                            e,
                                                            clip.id,
                                                            "trim_left",
                                                        );
                                                    }}
                                                />
                                                <div
                                                    className="absolute right-0 top-0 bottom-0 w-[6px] z-40"
                                                    style={{
                                                        cursor: "ew-resize",
                                                    }}
                                                    onPointerDown={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        if (
                                                            multiSelectedClipIds.length ===
                                                                0 ||
                                                            !multiSelectedSet.has(
                                                                clip.id,
                                                            )
                                                        ) {
                                                            setMultiSelectedClipIds(
                                                                [clip.id],
                                                            );
                                                        }
                                                        void dispatch(
                                                            selectClipRemote(
                                                                clip.id,
                                                            ),
                                                        );
                                                        startEditDrag(
                                                            e,
                                                            clip.id,
                                                            "trim_right",
                                                        );
                                                    }}
                                                />

                                                {/* Fade handles (top corners) */}
                                                <div
                                                    className="absolute left-0 top-0 w-[14px] h-[14px] z-50"
                                                    style={{
                                                        cursor: "nwse-resize",
                                                    }}
                                                    onPointerDown={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        if (
                                                            multiSelectedClipIds.length ===
                                                                0 ||
                                                            !multiSelectedSet.has(
                                                                clip.id,
                                                            )
                                                        ) {
                                                            setMultiSelectedClipIds(
                                                                [clip.id],
                                                            );
                                                        }
                                                        void dispatch(
                                                            selectClipRemote(
                                                                clip.id,
                                                            ),
                                                        );
                                                        startEditDrag(
                                                            e,
                                                            clip.id,
                                                            "fade_in",
                                                        );
                                                    }}
                                                />
                                                <div
                                                    className="absolute right-0 top-0 w-[14px] h-[14px] z-50"
                                                    style={{
                                                        cursor: "nesw-resize",
                                                    }}
                                                    onPointerDown={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        if (
                                                            multiSelectedClipIds.length ===
                                                                0 ||
                                                            !multiSelectedSet.has(
                                                                clip.id,
                                                            )
                                                        ) {
                                                            setMultiSelectedClipIds(
                                                                [clip.id],
                                                            );
                                                        }
                                                        void dispatch(
                                                            selectClipRemote(
                                                                clip.id,
                                                            ),
                                                        );
                                                        startEditDrag(
                                                            e,
                                                            clip.id,
                                                            "fade_out",
                                                        );
                                                    }}
                                                />

                                                {/* Clip header strip (above body): M + gain knob + name + dB */}
                                                <div
                                                    className="absolute left-1 right-1 flex items-center gap-1 z-50"
                                                    style={{
                                                        top:
                                                            -CLIP_HEADER_HEIGHT +
                                                            1,
                                                        height: CLIP_HEADER_HEIGHT,
                                                        pointerEvents: "none",
                                                    }}
                                                >
                                                    <button
                                                        className={`w-5 h-4 rounded text-[10px] border transition-all ${clip.muted ? "bg-red-900 text-red-200 border-red-500" : "bg-qt-button text-gray-300 border-transparent hover:border-red-500 hover:bg-red-900 hover:text-red-200"}`}
                                                        style={{
                                                            pointerEvents:
                                                                "auto",
                                                        }}
                                                        onPointerDown={(e) => {
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                        }}
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                            const next =
                                                                !Boolean(
                                                                    clip.muted,
                                                                );
                                                            dispatch(
                                                                setClipMuted({
                                                                    clipId: clip.id,
                                                                    muted: next,
                                                                }),
                                                            );
                                                            void dispatch(
                                                                setClipStateRemote(
                                                                    {
                                                                        clipId: clip.id,
                                                                        muted: next,
                                                                    },
                                                                ),
                                                            );
                                                        }}
                                                        title={
                                                            clip.muted
                                                                ? "Unmute"
                                                                : "Mute"
                                                        }
                                                    >
                                                        M
                                                    </button>

                                                    <div
                                                        title={`${gainToDb(clip.gain).toFixed(1)} dB`}
                                                        style={{
                                                            cursor: "ns-resize",
                                                            pointerEvents:
                                                                "auto",
                                                        }}
                                                        onPointerDown={(e) => {
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                            if (
                                                                multiSelectedClipIds.length ===
                                                                    0 ||
                                                                !multiSelectedSet.has(
                                                                    clip.id,
                                                                )
                                                            ) {
                                                                setMultiSelectedClipIds(
                                                                    [clip.id],
                                                                );
                                                            }
                                                            void dispatch(
                                                                selectClipRemote(
                                                                    clip.id,
                                                                ),
                                                            );
                                                            startEditDrag(
                                                                e,
                                                                clip.id,
                                                                "gain",
                                                            );
                                                        }}
                                                    >
                                                        <div className="w-4 h-4 rounded-full border border-white/60 bg-white/10" />
                                                    </div>

                                                    <div className="flex-1 min-w-0 pointer-events-none">
                                                        <div className="text-[10px] text-white font-medium drop-shadow-md truncate">
                                                            {clip.name}
                                                        </div>
                                                    </div>

                                                    <div className="text-[10px] text-white/80 drop-shadow-md pointer-events-none">
                                                        {gainToDb(clip.gain) >=
                                                        0
                                                            ? "+"
                                                            : ""}
                                                        {gainToDb(
                                                            clip.gain,
                                                        ).toFixed(1)}
                                                        dB
                                                    </div>
                                                </div>

                                                {/* Fade lines */}
                                                <div className="absolute inset-0 pointer-events-none z-30">
                                                    {clip.fadeInBeats > 0 ? (
                                                        <svg
                                                            className="absolute left-0 top-0 h-full"
                                                            width={Math.min(
                                                                width,
                                                                clip.fadeInBeats *
                                                                    pxPerBeat,
                                                            )}
                                                            height={
                                                                rowHeight -
                                                                CLIP_HEADER_HEIGHT -
                                                                CLIP_BODY_PADDING_Y
                                                            }
                                                            viewBox={`0 0 ${Math.max(1, Math.min(width, clip.fadeInBeats * pxPerBeat))} ${Math.max(1, rowHeight - CLIP_HEADER_HEIGHT - CLIP_BODY_PADDING_Y)}`}
                                                            preserveAspectRatio="none"
                                                        >
                                                            <path
                                                                d={fadeInAreaPath(
                                                                    Math.max(
                                                                        1,
                                                                        Math.min(
                                                                            width,
                                                                            clip.fadeInBeats *
                                                                                pxPerBeat,
                                                                        ),
                                                                    ),
                                                                    Math.max(
                                                                        1,
                                                                        rowHeight -
                                                                            CLIP_HEADER_HEIGHT -
                                                                            CLIP_BODY_PADDING_Y,
                                                                    ),
                                                                )}
                                                                fill="rgba(255,255,255,0.14)"
                                                                stroke="rgba(255,255,255,0.55)"
                                                                strokeWidth="1"
                                                                vectorEffect="non-scaling-stroke"
                                                            />
                                                        </svg>
                                                    ) : null}
                                                    {clip.fadeOutBeats > 0 ? (
                                                        <svg
                                                            className="absolute right-0 top-0 h-full"
                                                            width={Math.min(
                                                                width,
                                                                clip.fadeOutBeats *
                                                                    pxPerBeat,
                                                            )}
                                                            height={
                                                                rowHeight -
                                                                CLIP_HEADER_HEIGHT -
                                                                CLIP_BODY_PADDING_Y
                                                            }
                                                            viewBox={`0 0 ${Math.max(1, Math.min(width, clip.fadeOutBeats * pxPerBeat))} ${Math.max(1, rowHeight - CLIP_HEADER_HEIGHT - CLIP_BODY_PADDING_Y)}`}
                                                            preserveAspectRatio="none"
                                                        >
                                                            <path
                                                                d={fadeOutAreaPath(
                                                                    Math.max(
                                                                        1,
                                                                        Math.min(
                                                                            width,
                                                                            clip.fadeOutBeats *
                                                                                pxPerBeat,
                                                                        ),
                                                                    ),
                                                                    Math.max(
                                                                        1,
                                                                        rowHeight -
                                                                            CLIP_HEADER_HEIGHT -
                                                                            CLIP_BODY_PADDING_Y,
                                                                    ),
                                                                )}
                                                                fill="rgba(255,255,255,0.14)"
                                                                stroke="rgba(255,255,255,0.55)"
                                                                strokeWidth="1"
                                                                vectorEffect="non-scaling-stroke"
                                                            />
                                                        </svg>
                                                    ) : null}
                                                </div>

                                                <div className="absolute inset-x-0 inset-y-1 opacity-50">
                                                    {stereo
                                                        ? (() => {
                                                              const w =
                                                                  Math.max(
                                                                      1,
                                                                      Math.floor(
                                                                          width,
                                                                      ),
                                                                  );
                                                              const h = 22;
                                                              const wf =
                                                                  waveform as {
                                                                      l: number[];
                                                                      r: number[];
                                                                  };
                                                              const leftSamples =
                                                                  sliceWaveformSamples(
                                                                      wf.l ??
                                                                          [],
                                                                      clip,
                                                                  );
                                                              const rightSamples =
                                                                  sliceWaveformSamples(
                                                                      wf.r ??
                                                                          [],
                                                                      clip,
                                                                  );
                                                              return (
                                                                  <svg
                                                                      viewBox={`0 0 ${w} ${h}`}
                                                                      preserveAspectRatio="none"
                                                                      className="w-full h-full"
                                                                  >
                                                                      <path
                                                                          d={waveformAreaPath(
                                                                              leftSamples,
                                                                              w,
                                                                              h /
                                                                                  2,
                                                                              waveformAmpScale,
                                                                          )}
                                                                          transform={`translate(0,0)`}
                                                                          fill="rgba(255,255,255,0.55)"
                                                                          stroke="rgba(255,255,255,0.25)"
                                                                          strokeWidth="1"
                                                                          vectorEffect="non-scaling-stroke"
                                                                      />
                                                                      <path
                                                                          d={waveformAreaPath(
                                                                              rightSamples,
                                                                              w,
                                                                              h /
                                                                                  2,
                                                                              waveformAmpScale,
                                                                          )}
                                                                          transform={`translate(0,${h / 2})`}
                                                                          fill="rgba(255,255,255,0.55)"
                                                                          stroke="rgba(255,255,255,0.25)"
                                                                          strokeWidth="1"
                                                                          vectorEffect="non-scaling-stroke"
                                                                      />
                                                                      <line
                                                                          x1="0"
                                                                          x2={w}
                                                                          y1={
                                                                              h /
                                                                              2
                                                                          }
                                                                          y2={
                                                                              h /
                                                                              2
                                                                          }
                                                                          stroke="rgba(255,255,255,0.15)"
                                                                          strokeWidth="1"
                                                                          vectorEffect="non-scaling-stroke"
                                                                      />
                                                                  </svg>
                                                              );
                                                          })()
                                                        : Array.isArray(
                                                                waveform,
                                                            ) &&
                                                            waveform.length > 0
                                                          ? (() => {
                                                                const mono =
                                                                    sliceWaveformSamples(
                                                                        waveform,
                                                                        clip,
                                                                    );
                                                                if (
                                                                    mono.length <
                                                                    2
                                                                )
                                                                    return null;
                                                                return (
                                                                    <svg
                                                                        viewBox={`0 0 ${Math.max(1, Math.floor(width))} 20`}
                                                                        preserveAspectRatio="none"
                                                                        className="w-full h-full"
                                                                    >
                                                                        <path
                                                                            d={waveformAreaPath(
                                                                                mono,
                                                                                Math.max(
                                                                                    1,
                                                                                    Math.floor(
                                                                                        width,
                                                                                    ),
                                                                                ),
                                                                                20,
                                                                                waveformAmpScale,
                                                                            )}
                                                                            fill="rgba(255,255,255,0.55)"
                                                                            stroke="rgba(255,255,255,0.25)"
                                                                            strokeWidth="1"
                                                                            vectorEffect="non-scaling-stroke"
                                                                        />
                                                                    </svg>
                                                                );
                                                            })()
                                                          : null}
                                                </div>
                                            </div>
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
                </div>

                {contextMenu ? (
                    <div
                        data-hs-context-menu="1"
                        className="fixed z-50 rounded-sm border border-qt-border bg-qt-window text-qt-text shadow-sm"
                        style={{ left: contextMenu.x, top: contextMenu.y }}
                    >
                        <button
                            className="px-3 py-2 text-left w-full hover:bg-qt-button-hover disabled:opacity-40 disabled:hover:bg-transparent"
                            disabled={(() => {
                                const ids =
                                    multiSelectedClipIds.length >= 2
                                        ? multiSelectedClipIds
                                        : [contextMenu.clipId];
                                if (ids.length < 2) return true;
                                const clips = sessionRef.current.clips.filter(
                                    (c) => ids.includes(c.id),
                                );
                                if (clips.length !== ids.length) return true;
                                const trackId = clips[0]?.trackId;
                                return (
                                    !trackId ||
                                    clips.some((c) => c.trackId !== trackId)
                                );
                            })()}
                            onClick={() => {
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
                        >
                            胶合
                        </button>
                    </div>
                ) : null}
            </Flex>
        </Flex>
    );
};
