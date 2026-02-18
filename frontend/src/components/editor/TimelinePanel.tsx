import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useAppDispatch, useAppSelector } from "../../app/hooks";
import {
    addTrackRemote,
    addClipOnTrack,
    fetchSelectedTrackSummary,
    moveClipRemote,
    moveTrackRemote,
    moveClipStart,
    removeTrackRemote,
    removeSelectedClipRemote,
    seekPlayhead,
    setClipLength,
    setClipStateRemote,
    selectClipRemote,
    selectTrackRemote,
    setTrackStateRemote,
    type GridSize,
} from "../../features/session/sessionSlice";
import { useI18n } from "../../i18n/I18nProvider";

interface DragState {
    clipId: string;
    startX: number;
    startY: number;
    initialBeat: number;
    initialLengthBeats: number;
    initialLaneIndex: number;
    mode: "move" | "resize-left" | "resize-right";
}

interface TrackDragState {
    trackId: string;
}

const BEAT_WIDTH = 52;
const HEADER_WIDTH = 172;
const RULER_HEIGHT = 32;
const TRACK_HEIGHT = 56;

function subdivisionForGrid(grid: GridSize): number {
    if (grid === "1/4") return 1;
    if (grid === "1/8") return 2;
    if (grid === "1/16") return 4;
    return 8;
}

function clipColorClass(
    color: "blue" | "violet" | "emerald" | "amber",
    selected: boolean,
    playing: boolean,
): string {
    const ring = selected ? " ring-1 ring-cyan-400" : "";
    const glow = playing ? "" : "";
    if (color === "violet")
        return `bg-zinc-500/75 border-zinc-300/45${ring}${glow}`;
    if (color === "emerald")
        return `bg-zinc-500/75 border-zinc-300/45${ring}${glow}`;
    if (color === "amber")
        return `bg-zinc-500/75 border-zinc-300/45${ring}${glow}`;
    return `bg-zinc-500/75 border-zinc-300/45${ring}${glow}`;
}

export function TimelinePanel() {
    const dispatch = useAppDispatch();
    const {
        bpm,
        beats,
        projectBeats,
        grid,
        playheadBeat,
        tracks,
        clips,
        selectedTrackId,
        selectedClipId,
        clipWaveforms,
        playbackClipId,
        runtime,
    } = useAppSelector((state) => state.session);
    const { t } = useI18n();

    const [dragState, setDragState] = useState<DragState | null>(null);
    const [trackDragState, setTrackDragState] = useState<TrackDragState | null>(null);

    const totalBeats = Math.max(beats * 2, Math.ceil(projectBeats));
    const bodyWidth = totalBeats * BEAT_WIDTH;
    const subdivisions = subdivisionForGrid(grid);
    const step = 1 / subdivisions;

    const seekFromPointer = (
        event: ReactMouseEvent<HTMLElement>,
        snap = true,
    ) => {
        const target = event.target as HTMLElement;
        if (target.closest("[data-no-seek='1']")) {
            return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const x = Math.min(bodyWidth, Math.max(0, event.clientX - rect.left));
        const rawBeat = x / BEAT_WIDTH;
        const nextBeat = snap
            ? Math.max(0, Math.round(rawBeat / step) * step)
            : Math.max(0, rawBeat);
        void dispatch(seekPlayhead(nextBeat));
    };

    const lanes = useMemo(() => {
        return tracks.map((track, laneIndex) => ({
            track,
            laneIndex,
            clips: clips.filter((clip) => clip.trackId === track.id),
        }));
    }, [tracks, clips]);

    const selectedClip = useMemo(
        () => clips.find((clip) => clip.id === selectedClipId) ?? null,
        [clips, selectedClipId],
    );

    const siblingIndex = (trackId: string, parentId?: string | null) => {
        const siblings = tracks.filter((track) => (track.parentId ?? null) === (parentId ?? null));
        return Math.max(0, siblings.findIndex((track) => track.id === trackId));
    };

    useEffect(() => {
        void dispatch(fetchSelectedTrackSummary());
    }, [dispatch, selectedTrackId]);

    useEffect(() => {
        if (!dragState) return;

        let latestBeat = dragState.initialBeat;
        let latestLength = dragState.initialLengthBeats;
        let latestTrackId: string | undefined;

        const onPointerMove = (event: PointerEvent) => {
            const deltaBeat = (event.clientX - dragState.startX) / BEAT_WIDTH;
            const rawBeat = Math.max(0, dragState.initialBeat + deltaBeat);
            const snappedBeat = Math.max(0, Math.round(rawBeat / step) * step);
            const nextBeat = event.altKey ? rawBeat : snappedBeat;

            if (dragState.mode === "move") {
                latestBeat = nextBeat;
                const deltaLane = Math.round(
                    (event.clientY - dragState.startY) / TRACK_HEIGHT,
                );
                const laneIndex = Math.max(
                    0,
                    Math.min(
                        lanes.length - 1,
                        dragState.initialLaneIndex + deltaLane,
                    ),
                );
                latestTrackId = lanes[laneIndex]?.track.id;

                dispatch(
                    moveClipStart({
                        clipId: dragState.clipId,
                        startBeat: nextBeat,
                    }),
                );
                return;
            }

            if (dragState.mode === "resize-right") {
                const rawLength = Math.max(
                    0.25,
                    dragState.initialLengthBeats +
                        (event.altKey
                            ? deltaBeat
                            : Math.round(deltaBeat / step) * step),
                );
                latestLength = rawLength;
                dispatch(
                    setClipLength({
                        clipId: dragState.clipId,
                        lengthBeats: rawLength,
                    }),
                );
                return;
            }

            const clipEnd = dragState.initialBeat + dragState.initialLengthBeats;
            const candidateStart = Math.max(
                0,
                event.altKey ? rawBeat : Math.round(rawBeat / step) * step,
            );
            const boundedStart = Math.min(clipEnd - 0.25, candidateStart);
            const nextLength = Math.max(0.25, clipEnd - boundedStart);
            latestBeat = boundedStart;
            latestLength = nextLength;
            dispatch(
                moveClipStart({
                    clipId: dragState.clipId,
                    startBeat: boundedStart,
                }),
            );
            dispatch(
                setClipLength({
                    clipId: dragState.clipId,
                    lengthBeats: nextLength,
                }),
            );
        };

        const onPointerUp = () => {
            if (dragState.mode === "move") {
                void dispatch(
                    moveClipRemote({
                        clipId: dragState.clipId,
                        startBeat: latestBeat,
                        trackId: latestTrackId,
                    }),
                );
            } else if (dragState.mode === "resize-right") {
                void dispatch(
                    setClipStateRemote({
                        clipId: dragState.clipId,
                        lengthBeats: latestLength,
                    }),
                );
            } else {
                void dispatch(
                    moveClipRemote({
                        clipId: dragState.clipId,
                        startBeat: latestBeat,
                    }),
                );
                void dispatch(
                    setClipStateRemote({
                        clipId: dragState.clipId,
                        lengthBeats: latestLength,
                    }),
                );
            }
            setDragState(null);
        };

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        return () => {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
        };
    }, [dispatch, dragState, lanes, step]);

    return (
        <section className="h-full rounded border border-zinc-700 bg-zinc-800 p-2">
            <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-semibold text-zinc-200">
                    {t("timeline_title")}
                </div>
                <div className="text-[11px] text-zinc-400">
                    {bpm} BPM · {beats}/4 · Grid {grid}
                </div>
            </div>

            {selectedClip && (
                <div className="mb-2 rounded border border-zinc-700 bg-zinc-800/60 p-2 text-[11px] text-zinc-300">
                    <div className="mb-1 flex items-center justify-between">
                        <span className="font-semibold text-zinc-200">
                            Item · {selectedClip.name}
                        </span>
                        <span className="text-zinc-500">{selectedClip.id}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                        <label className="flex items-center gap-1">
                            <span className="w-12 text-zinc-500">Len</span>
                            <input
                                className="w-full rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5"
                                type="number"
                                step={0.25}
                                min={0.1}
                                value={selectedClip.lengthBeats}
                                onChange={(event) =>
                                    void dispatch(
                                        setClipStateRemote({
                                            clipId: selectedClip.id,
                                            lengthBeats:
                                                Number(event.target.value) ||
                                                selectedClip.lengthBeats,
                                        }),
                                    )
                                }
                            />
                        </label>

                        <label className="flex items-center gap-1">
                            <span className="w-12 text-zinc-500">Gain</span>
                            <input
                                className="w-full"
                                type="range"
                                min={0}
                                max={2}
                                step={0.01}
                                value={selectedClip.gain}
                                onChange={(event) =>
                                    void dispatch(
                                        setClipStateRemote({
                                            clipId: selectedClip.id,
                                            gain: Number(event.target.value),
                                        }),
                                    )
                                }
                            />
                        </label>

                        <label className="flex items-center gap-1">
                            <span className="w-12 text-zinc-500">Rate</span>
                            <input
                                className="w-full rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5"
                                type="number"
                                min={0.25}
                                max={4}
                                step={0.05}
                                value={selectedClip.playbackRate}
                                onChange={(event) =>
                                    void dispatch(
                                        setClipStateRemote({
                                            clipId: selectedClip.id,
                                            playbackRate:
                                                Number(event.target.value) ||
                                                selectedClip.playbackRate,
                                        }),
                                    )
                                }
                            />
                        </label>

                        <label className="flex items-center gap-1">
                            <span className="w-12 text-zinc-500">Trim In</span>
                            <input
                                className="w-full rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5"
                                type="number"
                                min={0}
                                step={0.1}
                                value={selectedClip.trimStartBeat}
                                onChange={(event) =>
                                    void dispatch(
                                        setClipStateRemote({
                                            clipId: selectedClip.id,
                                            trimStartBeat:
                                                Number(event.target.value) || 0,
                                        }),
                                    )
                                }
                            />
                        </label>

                        <label className="flex items-center gap-1">
                            <span className="w-12 text-zinc-500">Trim Out</span>
                            <input
                                className="w-full rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5"
                                type="number"
                                min={0}
                                step={0.1}
                                value={selectedClip.trimEndBeat}
                                onChange={(event) =>
                                    void dispatch(
                                        setClipStateRemote({
                                            clipId: selectedClip.id,
                                            trimEndBeat:
                                                Number(event.target.value) || 0,
                                        }),
                                    )
                                }
                            />
                        </label>
                    </div>

                    <div className="mt-1 flex items-center gap-2">
                        <button
                            type="button"
                            className={`rounded border px-2 py-0.5 ${selectedClip.muted ? "border-amber-300/70 bg-amber-400/25 text-amber-100" : "border-zinc-700 text-zinc-300 hover:bg-zinc-700"}`}
                            onClick={() =>
                                void dispatch(
                                    setClipStateRemote({
                                        clipId: selectedClip.id,
                                        muted: !selectedClip.muted,
                                    }),
                                )
                            }
                        >
                            Mute Item
                        </button>
                        <span className="text-zinc-500">
                            Start {selectedClip.startBeat.toFixed(2)} · Len {selectedClip.lengthBeats.toFixed(2)}
                        </span>
                    </div>
                </div>
            )}

            <div className="overflow-auto rounded border border-zinc-700 bg-zinc-900/80">
                <div style={{ width: HEADER_WIDTH + bodyWidth }}>
                    <div
                        className="sticky top-0 z-20 flex border-b border-zinc-700 bg-zinc-800"
                        style={{ height: RULER_HEIGHT }}
                    >
                        <div
                            className="border-r border-zinc-700 px-2 py-1 text-[11px] text-zinc-400"
                            style={{ width: HEADER_WIDTH }}
                        >
                            {t("tracks")}
                        </div>

                        <div className="flex items-center gap-1 px-2 text-[10px] text-zinc-400">
                            <button
                                type="button"
                                className="rounded border border-zinc-600 px-1.5 py-0.5 hover:bg-zinc-700"
                                onClick={() => void dispatch(addTrackRemote({}))}
                            >
                                +Track
                            </button>
                            {selectedTrackId && (
                                <button
                                    type="button"
                                    className="rounded border border-zinc-600 px-1.5 py-0.5 text-zinc-200 hover:bg-zinc-700"
                                    onClick={() =>
                                        void dispatch(removeTrackRemote(selectedTrackId))
                                    }
                                >
                                    -Track
                                </button>
                            )}
                        </div>

                        <div
                            className="relative"
                            style={{ width: bodyWidth }}
                            onMouseDown={(event) => {
                                if (event.button !== 0) return;
                                seekFromPointer(event);
                            }}
                        >
                            {Array.from({ length: totalBeats + 1 }).map(
                                (_, beatIndex) => {
                                    const isBar = beatIndex % beats === 0;
                                    return (
                                        <div
                                            key={`ruler_${beatIndex}`}
                                            className="absolute bottom-0 top-0 border-l"
                                            style={{
                                                left: beatIndex * BEAT_WIDTH,
                                                borderColor: isBar
                                                    ? "rgb(113 113 122 / 0.8)"
                                                    : "rgb(82 82 91 / 0.45)",
                                            }}
                                        >
                                            {isBar && (
                                                <span className="ml-1 text-[10px] leading-8 text-zinc-400">
                                                    {Math.floor(
                                                        beatIndex / beats,
                                                    ) + 1}
                                                </span>
                                            )}
                                        </div>
                                    );
                                },
                            )}
                        </div>
                    </div>

                    <div className="relative">
                        {lanes.map((lane) => {
                            return (
                                    <div
                                    key={lane.track.id}
                                    className="flex border-b border-zinc-700"
                                    style={{ height: TRACK_HEIGHT }}
                                >
                                    <div
                                        className="border-r border-zinc-700 bg-zinc-800 px-2 py-1"
                                        style={{ width: HEADER_WIDTH }}
                                        draggable
                                        onDragStart={() =>
                                            setTrackDragState({ trackId: lane.track.id })
                                        }
                                        onDragOver={(event) => event.preventDefault()}
                                        onDrop={(event) => {
                                            event.preventDefault();
                                            const draggingTrackId = trackDragState?.trackId;
                                            if (!draggingTrackId || draggingTrackId === lane.track.id) {
                                                return;
                                            }
                                            const parentTrackId = lane.track.parentId ?? null;
                                            const targetIndex = siblingIndex(
                                                lane.track.id,
                                                parentTrackId,
                                            );
                                            void dispatch(
                                                moveTrackRemote({
                                                    trackId: draggingTrackId,
                                                    parentTrackId,
                                                    targetIndex,
                                                }),
                                            );
                                            setTrackDragState(null);
                                        }}
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <button
                                                type="button"
                                                className={`truncate text-left text-xs ${selectedTrackId === lane.track.id ? "text-cyan-300" : "text-zinc-200"}`}
                                                style={{ paddingLeft: `${(lane.track.depth ?? 0) * 10}px` }}
                                                onClick={() =>
                                                    void dispatch(selectTrackRemote(lane.track.id))
                                                }
                                            >
                                                {lane.track.name}
                                            </button>
                                            <div className="flex items-center gap-1">
                                                <button
                                                    type="button"
                                                    className="rounded border border-zinc-600 px-1 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700"
                                                    onClick={() =>
                                                        void dispatch(
                                                            addClipOnTrack({
                                                                trackId:
                                                                    lane.track.id,
                                                            }),
                                                        )
                                                    }
                                                >
                                                    +
                                                </button>
                                                <button
                                                    type="button"
                                                    className="rounded border border-zinc-600 px-1 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700"
                                                    onClick={() =>
                                                        void dispatch(
                                                            addTrackRemote({
                                                                parentTrackId:
                                                                    lane.track.id,
                                                            }),
                                                        )
                                                    }
                                                >
                                                    +Sub
                                                </button>
                                                <button
                                                    type="button"
                                                    className="rounded border border-zinc-600 px-1 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700"
                                                    onClick={() =>
                                                        void dispatch(
                                                            removeTrackRemote(
                                                                lane.track.id,
                                                            ),
                                                        )
                                                    }
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        </div>

                                        <div className="mt-1 flex items-center gap-1">
                                            <button
                                                type="button"
                                                className={`rounded border px-1.5 py-0.5 text-[10px] ${
                                                    lane.track.muted
                                                        ? "border-cyan-500/60 bg-cyan-900/30 text-cyan-100"
                                                        : "border-zinc-600 text-zinc-300 hover:bg-zinc-700"
                                                }`}
                                                onClick={() =>
                                                    void dispatch(
                                                        setTrackStateRemote({
                                                            trackId:
                                                                lane.track.id,
                                                            muted: !lane.track
                                                                .muted,
                                                        }),
                                                    )
                                                }
                                            >
                                                M
                                            </button>
                                            <button
                                                type="button"
                                                className={`rounded border px-1.5 py-0.5 text-[10px] ${
                                                    lane.track.solo
                                                        ? "border-cyan-500/60 bg-cyan-900/30 text-cyan-100"
                                                        : "border-zinc-600 text-zinc-300 hover:bg-zinc-700"
                                                }`}
                                                onClick={() =>
                                                    void dispatch(
                                                        setTrackStateRemote({
                                                            trackId:
                                                                lane.track.id,
                                                            solo: !lane.track
                                                                .solo,
                                                        }),
                                                    )
                                                }
                                            >
                                                S
                                            </button>
                                            <input
                                                className="h-1.5 w-14 accent-cyan-500"
                                                type="range"
                                                min={0}
                                                max={1}
                                                step={0.01}
                                                value={lane.track.volume}
                                                onChange={(event) =>
                                                    void dispatch(
                                                        setTrackStateRemote({
                                                            trackId:
                                                                lane.track.id,
                                                            volume: Number(
                                                                event.target
                                                                    .value,
                                                            ),
                                                        }),
                                                    )
                                                }
                                            />
                                            <div
                                                className="rounded border border-zinc-600 px-1 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700"
                                                onDragOver={(event) => event.preventDefault()}
                                                onDrop={(event) => {
                                                    event.preventDefault();
                                                    const draggingTrackId = trackDragState?.trackId;
                                                    if (!draggingTrackId || draggingTrackId === lane.track.id) {
                                                        return;
                                                    }
                                                    void dispatch(
                                                        moveTrackRemote({
                                                            trackId: draggingTrackId,
                                                            parentTrackId:
                                                                lane.track.id,
                                                            targetIndex:
                                                                lane.track
                                                                    .childTrackIds
                                                                    ?.length ?? 0,
                                                        }),
                                                    );
                                                    setTrackDragState(null);
                                                }}
                                            >
                                                ↳
                                            </div>
                                        </div>
                                    </div>

                                    <div
                                        className="relative"
                                        style={{ width: bodyWidth }}
                                        onMouseDown={(event) => {
                                            if (event.button !== 0) return;
                                            seekFromPointer(event);
                                        }}
                                    >
                                        {Array.from({
                                            length:
                                                totalBeats * subdivisions + 1,
                                        }).map((_, lineIndex) => {
                                            const isMajorBeat =
                                                lineIndex % subdivisions === 0;
                                            const left =
                                                (lineIndex / subdivisions) *
                                                BEAT_WIDTH;
                                            return (
                                                <div
                                                    key={`${lane.track.id}_line_${lineIndex}`}
                                                    className="absolute bottom-0 top-0 border-l"
                                                    style={{
                                                        left,
                                                        borderColor: isMajorBeat
                                                            ? "rgb(94 94 94 / 0.5)"
                                                            : "rgb(72 72 72 / 0.45)",
                                                    }}
                                                />
                                            );
                                        })}

                                        {lane.clips.map((clip) => {
                                            const left =
                                                clip.startBeat * BEAT_WIDTH;
                                            const width =
                                                clip.lengthBeats * BEAT_WIDTH;
                                            const selected =
                                                clip.id === selectedClipId;
                                            const playing =
                                                runtime.isPlaying &&
                                                playbackClipId === clip.id;
                                            return (
                                                <button
                                                    key={clip.id}
                                                    type="button"
                                                    data-no-seek="1"
                                                    className={`absolute top-2 h-10 rounded border px-2 text-left text-xs text-zinc-100 ${clipColorClass(
                                                        clip.color,
                                                        selected,
                                                        playing,
                                                    )}`}
                                                    style={{
                                                        left,
                                                        width: Math.max(
                                                            width,
                                                            28,
                                                        ),
                                                    }}
                                                    onClick={() =>
                                                        void dispatch(
                                                            selectClipRemote(
                                                                clip.id,
                                                            ),
                                                        )
                                                    }
                                                    onPointerDown={(event) => {
                                                        event.preventDefault();
                                                        void dispatch(
                                                            selectClipRemote(
                                                                clip.id,
                                                            ),
                                                        );
                                                        const laneIndex = lanes.findIndex(
                                                            (item) =>
                                                                item.track.id ===
                                                                clip.trackId,
                                                        );
                                                        setDragState({
                                                            clipId: clip.id,
                                                            startX: event.clientX,
                                                            startY: event.clientY,
                                                            initialBeat:
                                                                clip.startBeat,
                                                            initialLengthBeats:
                                                                clip.lengthBeats,
                                                            initialLaneIndex:
                                                                laneIndex >= 0
                                                                    ? laneIndex
                                                                    : 0,
                                                            mode: "move",
                                                        });
                                                    }}
                                                >
                                                    <span
                                                        className="absolute bottom-0 left-0 top-0 w-1.5 cursor-ew-resize rounded-l border-r border-white/20 bg-white/10"
                                                        onPointerDown={(event) => {
                                                            event.preventDefault();
                                                            event.stopPropagation();
                                                            const laneIndex = lanes.findIndex(
                                                                (item) =>
                                                                    item.track
                                                                        .id ===
                                                                    clip.trackId,
                                                            );
                                                            setDragState({
                                                                clipId: clip.id,
                                                                startX: event.clientX,
                                                                startY: event.clientY,
                                                                initialBeat:
                                                                    clip.startBeat,
                                                                initialLengthBeats:
                                                                    clip.lengthBeats,
                                                                initialLaneIndex:
                                                                    laneIndex >=
                                                                    0
                                                                        ? laneIndex
                                                                        : 0,
                                                                mode: "resize-left",
                                                            });
                                                        }}
                                                    />
                                                    <span
                                                        className="absolute bottom-0 right-0 top-0 w-1.5 cursor-ew-resize rounded-r border-l border-white/20 bg-white/10"
                                                        onPointerDown={(event) => {
                                                            event.preventDefault();
                                                            event.stopPropagation();
                                                            const laneIndex = lanes.findIndex(
                                                                (item) =>
                                                                    item.track
                                                                        .id ===
                                                                    clip.trackId,
                                                            );
                                                            setDragState({
                                                                clipId: clip.id,
                                                                startX: event.clientX,
                                                                startY: event.clientY,
                                                                initialBeat:
                                                                    clip.startBeat,
                                                                initialLengthBeats:
                                                                    clip.lengthBeats,
                                                                initialLaneIndex:
                                                                    laneIndex >=
                                                                    0
                                                                        ? laneIndex
                                                                        : 0,
                                                                mode: "resize-right",
                                                            });
                                                        }}
                                                    />
                                                    <div className="absolute inset-x-1 bottom-1 h-3 overflow-hidden rounded-sm bg-zinc-800/60">
                                                        <div className="flex h-full items-end gap-[1px]">
                                                            {(
                                                                clipWaveforms[
                                                                    clip.id
                                                                ] ?? []
                                                            )
                                                                .slice(0, 120)
                                                                .map(
                                                                    (
                                                                        value,
                                                                        idx,
                                                                    ) => {
                                                                        const height =
                                                                            Math.max(
                                                                                1,
                                                                                Math.round(
                                                                                    Math.min(
                                                                                        1,
                                                                                        Math.max(
                                                                                            0,
                                                                                            value,
                                                                                        ),
                                                                                    ) *
                                                                                        100,
                                                                                ),
                                                                            );
                                                                        return (
                                                                            <span
                                                                                key={`${clip.id}_wf_${idx}`}
                                                                                className="w-[1px] bg-zinc-100/70"
                                                                                style={{
                                                                                    height: `${height}%`,
                                                                                }}
                                                                            />
                                                                        );
                                                                    },
                                                                )}
                                                        </div>
                                                    </div>
                                                    <div className="truncate font-medium">
                                                        {clip.name}
                                                    </div>
                                                    <div className="truncate text-[10px] text-zinc-100/80">
                                                        {clip.startBeat.toFixed(
                                                            2,
                                                        )}{" "}
                                                        {t("beat")}
                                                    </div>
                                                    {playing && (
                                                        <div className="absolute right-1 top-1 rounded bg-cyan-200/80 px-1 text-[9px] font-semibold text-cyan-950">
                                                            {runtime.playbackTarget === "synthesized"
                                                                ? t("status_target_synthesized")
                                                                : t("status_target_original")}
                                                        </div>
                                                    )}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}

                        <div
                            className="pointer-events-none absolute bottom-0 top-0 z-10"
                            style={{
                                left: HEADER_WIDTH + playheadBeat * BEAT_WIDTH,
                            }}
                        >
                            <div className="absolute -top-0.5 left-1/2 h-0 w-0 -translate-x-1/2 border-l-[6px] border-r-[6px] border-t-[8px] border-l-transparent border-r-transparent border-t-indigo-300" />
                            <div className="h-full w-[2px] bg-indigo-300/95 shadow-[0_0_8px_rgba(129,140,248,0.9)]" />
                        </div>

                        <button
                            type="button"
                            data-no-seek="1"
                            className="absolute top-0 z-20 h-full w-6 -translate-x-1/2 cursor-ew-resize border-x border-indigo-300/25 bg-indigo-300/8"
                            style={{
                                left: HEADER_WIDTH + playheadBeat * BEAT_WIDTH,
                            }}
                            onMouseDown={(event) => {
                                event.preventDefault();
                                const startX = event.clientX;
                                const startBeat = playheadBeat;
                                const onMove = (moveEvent: MouseEvent) => {
                                    const delta =
                                        (moveEvent.clientX - startX) /
                                        BEAT_WIDTH;
                                    const snapped = Math.max(
                                        0,
                                        Math.round((startBeat + delta) / step) *
                                            step,
                                    );
                                    void dispatch(seekPlayhead(snapped));
                                };
                                const onUp = () => {
                                    window.removeEventListener(
                                        "mousemove",
                                        onMove,
                                    );
                                    window.removeEventListener("mouseup", onUp);
                                };
                                window.addEventListener("mousemove", onMove);
                                window.addEventListener("mouseup", onUp);
                            }}
                        >
                            <span className="absolute left-1/2 top-1 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-indigo-200" />
                        </button>

                        {selectedClipId && (
                            <button
                                type="button"
                                className="absolute right-2 top-2 z-30 rounded border border-rose-300/35 bg-rose-500/20 px-2 py-1 text-[10px] text-rose-100 hover:bg-rose-500/35"
                                onClick={() => void dispatch(removeSelectedClipRemote())}
                            >
                                {t("delete_clip")}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </section>
    );
}
