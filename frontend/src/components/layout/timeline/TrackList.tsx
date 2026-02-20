import React, { useEffect, useMemo, useRef, useState } from "react";
import { Flex, Box, Text, IconButton, Slider } from "@radix-ui/themes";
import { Cross2Icon, PlusIcon } from "@radix-ui/react-icons";
import type { TrackInfo } from "../../../features/session/sessionSlice";

export const TrackList: React.FC<{
    t: (key: any) => string;
    tracks: TrackInfo[];
    selectedTrackId: string | null;
    rowHeight: number;
    trackVolumeUi: Record<string, number>;
    onSelectTrack: (trackId: string) => void;
    onRemoveTrack: (trackId: string) => void;
    onMoveTrack: (payload: {
        trackId: string;
        targetIndex: number;
        parentTrackId: string | null;
    }) => void;
    onToggleMute: (trackId: string, nextMuted: boolean) => void;
    onToggleSolo: (trackId: string, nextSolo: boolean) => void;
    onVolumeUiChange: (trackId: string, nextVolume: number) => void;
    onVolumeCommit: (trackId: string, nextVolume: number) => void;
    onAddTrack: () => void;
}> = ({
    t,
    tracks,
    selectedTrackId,
    rowHeight,
    trackVolumeUi,
    onSelectTrack,
    onRemoveTrack,
    onMoveTrack,
    onToggleMute,
    onToggleSolo,
    onVolumeUiChange,
    onVolumeCommit,
    onAddTrack,
}) => {
    const listRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{
        pointerId: number;
        trackId: string;
        startClientX: number;
        startClientY: number;
        hasMoved: boolean;
        originalParentId: string | null;
        originalIndexSelf: number;
    } | null>(null);

    const [dragUi, setDragUi] = useState<{
        draggingTrackId: string;
        overTrackId: string | null;
        mode: "reorder" | "nest";
        indicatorY: number | null;
    } | null>(null);

    const parentById = useMemo(() => {
        const m = new Map<string, string | null>();
        for (const tr of tracks) {
            m.set(tr.id, tr.parentId ?? null);
        }
        return m;
    }, [tracks]);

    useEffect(() => {
        return () => {
            // Safety cleanup.
            dragRef.current = null;
            setDragUi(null);
        };
    }, []);

    function wouldCreateCycle(trackId: string, parentTrackId: string | null) {
        let cur = parentTrackId;
        let guard = 0;
        while (cur && guard++ < 1000) {
            if (cur === trackId) return true;
            cur = parentById.get(cur) ?? null;
        }
        return false;
    }

    function siblingsOf(parentTrackId: string | null): string[] {
        const out: string[] = [];
        for (const tr of tracks) {
            if ((tr.parentId ?? null) === parentTrackId) out.push(tr.id);
        }
        return out;
    }

    function trackAtClientY(clientY: number): {
        track: TrackInfo | null;
        yInRow: number;
        index: number;
    } {
        const el = listRef.current;
        if (!el) return { track: null, yInRow: 0, index: -1 };
        const bounds = el.getBoundingClientRect();
        const y = clientY - bounds.top + el.scrollTop;
        const idx = Math.floor(y / rowHeight);
        const yInRow = y - idx * rowHeight;
        if (idx < 0 || idx >= tracks.length)
            return { track: null, yInRow, index: idx };
        return { track: tracks[idx] ?? null, yInRow, index: idx };
    }

    function computeDropSpec(
        draggingTrackId: string,
        clientX: number,
        clientY: number,
    ): { parentTrackId: string | null; targetIndex: number; mode: "reorder" | "nest" } {
        const el = listRef.current;
        const bounds = el?.getBoundingClientRect();
        const { track: over, yInRow } = trackAtClientY(clientY);

        // Dropping outside -> append as root.
        if (!over) {
            const roots = siblingsOf(null).filter((id) => id !== draggingTrackId);
            return { parentTrackId: null, targetIndex: roots.length, mode: "reorder" };
        }

        const overIndent = Math.max(0, (over.depth ?? 0) * 16);
        const localX = bounds ? clientX - bounds.left : clientX;
        const nest =
            over.id !== draggingTrackId &&
            localX > 24 + overIndent + 40;

        if (nest) {
            const parentTrackId = over.id;
            if (wouldCreateCycle(draggingTrackId, parentTrackId)) {
                const roots = siblingsOf(null).filter((id) => id !== draggingTrackId);
                return { parentTrackId: null, targetIndex: roots.length, mode: "reorder" };
            }
            const children = siblingsOf(parentTrackId).filter(
                (id) => id !== draggingTrackId,
            );
            return {
                parentTrackId,
                targetIndex: children.length,
                mode: "nest",
            };
        }

        let parentTrackId = over.parentId ?? null;
        if (wouldCreateCycle(draggingTrackId, parentTrackId)) {
            parentTrackId = null;
        }

        if (over.id === draggingTrackId) {
            const siblingsIncl = siblingsOf(parentTrackId);
            const indexSelf = Math.max(0, siblingsIncl.indexOf(draggingTrackId));
            return { parentTrackId, targetIndex: indexSelf, mode: "reorder" };
        }

        const siblings = siblingsOf(parentTrackId).filter(
            (id) => id !== draggingTrackId,
        );
        const baseIndex = Math.max(0, siblings.indexOf(over.id));
        const insertAfter = yInRow > rowHeight / 2;
        const targetIndex = Math.min(siblings.length, baseIndex + (insertAfter ? 1 : 0));
        return { parentTrackId, targetIndex, mode: "reorder" };
    }

    return (
        <Flex
            direction="column"
            className="w-64 border-r border-qt-border bg-qt-window shrink-0"
        >
            <Box className="h-6 border-b border-qt-border px-2 flex items-center bg-qt-window shadow-sm z-10">
                <Text size="1" weight="bold" color="gray">
                    {t("tracks")}
                </Text>
            </Box>
            <div
                ref={listRef}
                className="flex-1 overflow-y-auto custom-scrollbar relative"
            >
                {dragUi?.mode === "reorder" &&
                typeof dragUi.indicatorY === "number" ? (
                    <div
                        className="absolute left-1 right-1 pointer-events-none z-50"
                        style={{ top: dragUi.indicatorY }}
                    >
                        <div className="h-px bg-qt-highlight" />
                    </div>
                ) : null}
                {tracks.map((track) => {
                    const selected = selectedTrackId === track.id;
                    const depth = Math.max(0, Number(track.depth ?? 0) || 0);
                    const indent = depth * 16;
                    const dragging = dragUi?.draggingTrackId === track.id;
                    const isOver = dragUi?.overTrackId === track.id;
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

                    const guideLines = depth > 0 ? Array.from({ length: depth }) : [];

                    return (
                        <div
                            key={track.id}
                            style={{ height: rowHeight }}
                            className="border-b border-qt-border relative group overflow-hidden"
                            onPointerDown={(e) => {
                                if (e.button !== 0) return;

                                // If the pointer down starts on an interactive control, do not start a drag.
                                const target = e.target as HTMLElement | null;
                                if (
                                    target?.closest?.(
                                        "button,[role='slider'],input,textarea,select,a",
                                    )
                                ) {
                                    return;
                                }

                                const overSiblings = siblingsOf(track.parentId ?? null);
                                const originalIndexSelf = Math.max(
                                    0,
                                    overSiblings.indexOf(track.id),
                                );

                                dragRef.current = {
                                    pointerId: e.pointerId,
                                    trackId: track.id,
                                    startClientX: e.clientX,
                                    startClientY: e.clientY,
                                    hasMoved: false,
                                    originalParentId: track.parentId ?? null,
                                    originalIndexSelf,
                                };

                                const el = e.currentTarget as HTMLDivElement;
                                el.setPointerCapture(e.pointerId);

                                const prevCursor = document.body.style.cursor;
                                const prevSelect = document.body.style.userSelect;

                                function onMove(ev: PointerEvent) {
                                    const drag = dragRef.current;
                                    if (!drag || drag.pointerId !== e.pointerId) return;

                                    if (!drag.hasMoved) {
                                        const dx = ev.clientX - drag.startClientX;
                                        const dy = ev.clientY - drag.startClientY;
                                        if (dx * dx + dy * dy < 9) {
                                            return;
                                        }
                                        drag.hasMoved = true;
                                        document.body.style.cursor = "grabbing";
                                        document.body.style.userSelect = "none";
                                    }

                                    const spec = computeDropSpec(
                                        drag.trackId,
                                        ev.clientX,
                                        ev.clientY,
                                    );
                                    const overInfo = trackAtClientY(ev.clientY);
                                    const over = overInfo.track;

                                    let indicatorY: number | null = null;
                                    if (spec.mode === "reorder") {
                                        const idx = overInfo.index;
                                        if (!Number.isFinite(idx)) {
                                            indicatorY = null;
                                        } else if (!over) {
                                            indicatorY = tracks.length * rowHeight;
                                        } else {
                                            const insertAfter =
                                                overInfo.yInRow > rowHeight / 2;
                                            indicatorY =
                                                idx * rowHeight +
                                                (insertAfter ? rowHeight : 0);
                                        }
                                    }

                                    setDragUi({
                                        draggingTrackId: drag.trackId,
                                        overTrackId: over?.id ?? null,
                                        mode: spec.mode,
                                        indicatorY,
                                    });
                                }

                                function end(ev: PointerEvent) {
                                    const drag = dragRef.current;
                                    if (!drag || drag.pointerId !== e.pointerId) return;
                                    dragRef.current = null;

                                    window.removeEventListener("pointermove", onMove);
                                    window.removeEventListener("pointerup", end);
                                    window.removeEventListener("pointercancel", end);

                                    document.body.style.cursor = prevCursor;
                                    document.body.style.userSelect = prevSelect;

                                    const moved = drag.hasMoved;
                                    setDragUi(null);

                                    if (!moved) {
                                        onSelectTrack(drag.trackId);
                                        return;
                                    }

                                    const spec = computeDropSpec(
                                        drag.trackId,
                                        ev.clientX,
                                        ev.clientY,
                                    );

                                    if (
                                        spec.parentTrackId === drag.originalParentId &&
                                        spec.targetIndex === drag.originalIndexSelf
                                    ) {
                                        return;
                                    }

                                    onMoveTrack({
                                        trackId: drag.trackId,
                                        targetIndex: spec.targetIndex,
                                        parentTrackId: spec.parentTrackId,
                                    });
                                }

                                window.addEventListener("pointermove", onMove);
                                window.addEventListener("pointerup", end);
                                window.addEventListener("pointercancel", end);
                            }}
                        >
                            {/* Always-visible left accent bar (pinned to list edge) */}
                            <div
                                className={`absolute left-0 top-0 bottom-0 w-1 bg-qt-highlight transition-opacity ${selected ? "opacity-100" : "opacity-80 group-hover:opacity-90"}`}
                            />

                            {/* Left gutter: makes nesting depth visible at a glance */}
                            <div
                                className="absolute left-0 top-0 bottom-0 bg-qt-window pointer-events-none"
                                style={{ width: indent }}
                            >
                                {guideLines.map((_, i) => (
                                    <div
                                        key={i}
                                        className="absolute top-0 bottom-0 border-l border-qt-border opacity-60"
                                        style={{ left: i * 16 + 8 }}
                                    />
                                ))}
                                {depth > 0 ? (
                                    <div
                                        className="absolute border-t border-qt-border opacity-60"
                                        style={{
                                            left: (depth - 1) * 16 + 8,
                                            right: 0,
                                            top: "50%",
                                        }}
                                    />
                                ) : null}
                            </div>

                            {/* Content block: shifted right by depth */}
                            <Box
                                className={`absolute top-0 bottom-0 right-0 bg-qt-base transition-colors overflow-hidden ${selected ? "bg-qt-button-hover" : "hover:bg-qt-button-hover"} ${dragging ? "opacity-60" : ""} ${isOver ? "bg-qt-button-hover" : ""}`}
                                style={{ left: indent }}
                            >
                                {/* Keep a subtle in-row bar too, but don't rely on it */}
                                <div
                                    className={`absolute left-0 top-0 bottom-0 w-1 bg-qt-highlight transition-opacity ${selected ? "opacity-100" : "opacity-10 group-hover:opacity-30"}`}
                                />

                                {isOver && dragUi?.mode === "nest" ? (
                                    <div
                                        className="absolute inset-0 pointer-events-none"
                                        style={{
                                            backgroundColor:
                                                "color-mix(in oklab, var(--qt-highlight) 14%, transparent)",
                                            border: "1px dashed var(--qt-highlight)",
                                        }}
                                    />
                                ) : null}

                                <Flex
                                    direction="column"
                                    p="2"
                                    gap="2"
                                    height="100%"
                                    justify="center"
                                >
                                    <Flex justify="between" align="center">
                                        <Text
                                            size="2"
                                            weight="medium"
                                            className={`text-gray-200 truncate pr-2 ${depth > 0 ? "opacity-90" : ""}`}
                                        >
                                            {track.name}
                                        </Text>
                                        <IconButton
                                            size="1"
                                            variant="ghost"
                                            color="gray"
                                            className="opacity-0 group-hover:opacity-100"
                                            disabled={tracks.length <= 1}
                                            onPointerDown={(e) => e.stopPropagation()}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onRemoveTrack(track.id);
                                            }}
                                        >
                                            <Cross2Icon />
                                        </IconButton>
                                    </Flex>

                                <Flex gap="2" align="center">
                                    <button
                                        className={`w-6 h-5 rounded text-[10px] border transition-all ${muted ? "bg-red-900 text-red-200 border-red-500" : "bg-qt-button text-gray-300 border-transparent hover:border-red-500 hover:bg-red-900 hover:text-red-200"}`}
                                        onPointerDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onToggleMute(track.id, !muted);
                                        }}
                                    >
                                        M
                                    </button>
                                    <button
                                        className={`w-6 h-5 rounded text-[10px] border transition-all ${solo ? "bg-yellow-900 text-yellow-200 border-yellow-500" : "bg-qt-button text-gray-300 border-transparent hover:border-yellow-500 hover:bg-yellow-900 hover:text-yellow-200"}`}
                                        onPointerDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onToggleSolo(track.id, !solo);
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
                                        onVolumeUiChange(track.id, next);
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
                                        onVolumeCommit(track.id, next);
                                    }}
                                    onPointerDown={(e) => e.stopPropagation()}
                                />
                                </Flex>
                            </Box>
                        </div>
                    );
                })}

                <Flex
                    align="center"
                    justify="center"
                    className="h-8 border-b border-qt-border border-dashed text-gray-500 hover:text-gray-300 hover:bg-qt-button-hover cursor-pointer transition-colors"
                    onClick={onAddTrack}
                >
                    <PlusIcon className="mr-1" />{" "}
                    <Text size="1">{t("track_add")}</Text>
                </Flex>
            </div>
        </Flex>
    );
};
