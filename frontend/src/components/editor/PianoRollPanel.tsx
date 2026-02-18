import { useEffect, useMemo, useState } from "react";
import { useAppDispatch, useAppSelector } from "../../app/hooks";
import {
    addAutomationPoint,
    fetchSelectedTrackSummary,
    moveAutomationPoint,
    removeAutomationPoint,
    setSelectedPoint,
    type EditParam,
    type GridSize,
} from "../../features/session/sessionSlice";
import { useI18n } from "../../i18n/I18nProvider";

interface PointDragState {
    pointId: string;
}

const VIEW_WIDTH = 1200;
const VIEW_HEIGHT = 260;
const LEFT_PADDING = 12;
const RIGHT_PADDING = 12;
const TOP_PADDING = 12;
const BOTTOM_PADDING = 24;

function subdivisionForGrid(grid: GridSize): number {
    if (grid === "1/4") return 1;
    if (grid === "1/8") return 2;
    if (grid === "1/16") return 4;
    return 8;
}

function valueRangeForParam(param: EditParam): {
    min: number;
    max: number;
    label: string;
} {
    if (param === "pitch") {
        return { min: -24, max: 24, label: "pitch_label" };
    }
    return { min: 0, max: 1, label: "tension_label" };
}

export function PianoRollPanel() {
    const dispatch = useAppDispatch();
    const {
        editParam,
        toolMode,
        beats,
        projectBeats,
        grid,
        clipAutomation,
        clipPitchRanges,
        selectedTrackId,
        selectedTrackSummary,
        selectedClipId,
        selectedPointId,
    } = useAppSelector((state) => state.session);
    const [dragging, setDragging] = useState<PointDragState | null>(null);
    const { t } = useI18n();

    const points = selectedClipId
        ? (clipAutomation[selectedClipId]?.[editParam] ?? [])
        : [];
    const totalBeats = Math.max(beats * 2, Math.ceil(projectBeats));
    const xMin = LEFT_PADDING;
    const xMax = VIEW_WIDTH - RIGHT_PADDING;
    const yMin = TOP_PADDING;
    const yMax = VIEW_HEIGHT - BOTTOM_PADDING;
    const subdivision = subdivisionForGrid(grid);

    const baseRange = valueRangeForParam(editParam);
    const selectedPitchRange = selectedClipId
        ? clipPitchRanges[selectedClipId]
        : undefined;
    const range =
        editParam === "pitch" && selectedPitchRange
            ? {
                  min: Math.floor(selectedPitchRange.min - 1),
                  max: Math.ceil(selectedPitchRange.max + 1),
                  label: baseRange.label,
              }
            : baseRange;

    useEffect(() => {
        void dispatch(fetchSelectedTrackSummary());
    }, [dispatch, selectedTrackId]);

    const toX = (beat: number) => xMin + (beat / totalBeats) * (xMax - xMin);
    const toY = (value: number) =>
        yMax - ((value - range.min) / (range.max - range.min)) * (yMax - yMin);
    const toBeat = (x: number) => ((x - xMin) / (xMax - xMin)) * totalBeats;
    const toValue = (y: number) =>
        range.max - ((y - yMin) / (yMax - yMin)) * (range.max - range.min);

    const snappedStep = 1 / subdivision;

    const pathData = useMemo(() => {
        if (points.length === 0) return "";
        return points
            .map(
                (point, index) =>
                    `${index === 0 ? "M" : "L"} ${toX(point.beat).toFixed(2)} ${toY(point.value).toFixed(2)}`,
            )
            .join(" ");
    }, [points, totalBeats, range.max, range.min]);

    useEffect(() => {
        if (!dragging) return;

        const onPointerMove = (event: PointerEvent) => {
            const svgElement = document.getElementById("automation_svg");
            if (!svgElement) return;
            const bounds = svgElement.getBoundingClientRect();
            const x = Math.min(
                xMax,
                Math.max(xMin, event.clientX - bounds.left),
            );
            const y = Math.min(
                yMax,
                Math.max(yMin, event.clientY - bounds.top),
            );

            const beat = Math.max(
                0,
                Math.round(toBeat(x) / snappedStep) * snappedStep,
            );
            const valueRaw = toValue(y);
            const value = Math.min(range.max, Math.max(range.min, valueRaw));

            dispatch(
                moveAutomationPoint({
                    param: editParam,
                    pointId: dragging.pointId,
                    beat,
                    value,
                }),
            );
        };

        const onPointerUp = () => {
            setDragging(null);
        };

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        return () => {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
        };
    }, [
        dispatch,
        dragging,
        editParam,
        range.max,
        range.min,
        snappedStep,
        xMax,
        xMin,
        yMax,
        yMin,
    ]);

    return (
        <section className="h-full min-h-0 rounded border border-zinc-700 bg-zinc-800 p-2">
            <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-semibold text-zinc-200">
                    {t("param_editor")}
                </div>
                <div className="text-[11px] text-zinc-400">
                    {t("tool_mode")} {toolMode} · {t("edit_param")} {editParam}{" "}
                    · {t(range.label as "pitch_label" | "tension_label")}
                </div>
            </div>

            <div className="mb-2 rounded border border-zinc-700 bg-zinc-900/70 p-2 text-[11px] text-zinc-300">
                <div>
                    Track: {selectedTrackSummary.trackId ?? "-"} · Clips: {selectedTrackSummary.clipCount}
                </div>
                <div>
                    Pitch: {selectedTrackSummary.pitchRange.min.toFixed(1)} ~ {selectedTrackSummary.pitchRange.max.toFixed(1)}
                </div>
                <div className="mt-1 h-6 overflow-hidden rounded bg-zinc-800/70">
                    <div className="flex h-full items-end gap-[1px]">
                        {selectedTrackSummary.waveformPreview.slice(0, 180).map((value, idx) => {
                            const height = Math.max(
                                1,
                                Math.round(
                                    Math.min(1, Math.max(0, value)) * 100,
                                ),
                            );
                            return (
                                <span
                                    key={`track_wf_${idx}`}
                                    className="w-[1px] bg-zinc-200/80"
                                    style={{ height: `${height}%` }}
                                />
                            );
                        })}
                    </div>
                </div>
            </div>

            <div className="overflow-auto rounded border border-zinc-700 bg-zinc-900/85 p-2">
                <svg
                    id="automation_svg"
                    width={VIEW_WIDTH}
                    height={VIEW_HEIGHT}
                    className="select-none"
                    onDoubleClick={(event) => {
                        const bounds =
                            event.currentTarget.getBoundingClientRect();
                        const x = Math.min(
                            xMax,
                            Math.max(xMin, event.clientX - bounds.left),
                        );
                        const y = Math.min(
                            yMax,
                            Math.max(yMin, event.clientY - bounds.top),
                        );
                        const beat = Math.max(
                            0,
                            Math.round(toBeat(x) / snappedStep) * snappedStep,
                        );
                        const value = Math.min(
                            range.max,
                            Math.max(range.min, toValue(y)),
                        );
                        dispatch(
                            addAutomationPoint({
                                param: editParam,
                                beat,
                                value,
                            }),
                        );
                    }}
                >
                    <rect
                        x={0}
                        y={0}
                        width={VIEW_WIDTH}
                        height={VIEW_HEIGHT}
                        fill="rgb(35 35 35 / 0.9)"
                    />

                    {Array.from({ length: totalBeats * subdivision + 1 }).map(
                        (_, line) => {
                            const beat = line / subdivision;
                            const x = toX(beat);
                            const isMajor = line % subdivision === 0;
                            return (
                                <line
                                    key={`v_${line}`}
                                    x1={x}
                                    y1={yMin}
                                    x2={x}
                                    y2={yMax}
                                    stroke={
                                        isMajor
                                            ? "rgb(113 113 122 / 0.32)"
                                            : "rgb(82 82 91 / 0.2)"
                                    }
                                    strokeWidth={1}
                                />
                            );
                        },
                    )}

                    {Array.from({ length: 7 }).map((_, idx) => {
                        const t = idx / 6;
                        const y = yMin + t * (yMax - yMin);
                        const value = range.max - t * (range.max - range.min);
                        return (
                            <g key={`h_${idx}`}>
                                <line
                                    x1={xMin}
                                    y1={y}
                                    x2={xMax}
                                    y2={y}
                                    stroke="rgb(82 82 91 / 0.22)"
                                    strokeWidth={1}
                                />
                                <text
                                    x={2}
                                    y={y + 4}
                                    fill="rgb(161 161 170)"
                                    fontSize="10"
                                >
                                    {value.toFixed(
                                        editParam === "pitch" ? 1 : 2,
                                    )}
                                </text>
                            </g>
                        );
                    })}

                    {pathData && (
                        <path
                            d={pathData}
                            stroke="rgb(103 232 249)"
                            strokeWidth={2}
                            fill="none"
                            strokeLinejoin="round"
                        />
                    )}

                    {points.map((point) => {
                        const selected = point.id === selectedPointId;
                        return (
                            <circle
                                key={point.id}
                                cx={toX(point.beat)}
                                cy={toY(point.value)}
                                r={selected ? 6 : 4.5}
                                fill={
                                    selected
                                        ? "rgb(103 232 249)"
                                        : "rgb(212 212 212)"
                                }
                                stroke="rgb(24 24 27)"
                                strokeWidth={1.5}
                                onPointerDown={(event) => {
                                    event.preventDefault();
                                    dispatch(setSelectedPoint(point.id));
                                    setDragging({ pointId: point.id });
                                }}
                                onContextMenu={(event) => {
                                    event.preventDefault();
                                    dispatch(
                                        removeAutomationPoint({
                                            param: editParam,
                                            pointId: point.id,
                                        }),
                                    );
                                }}
                            />
                        );
                    })}

                    <text
                        x={xMin}
                        y={VIEW_HEIGHT - 6}
                        fill="rgb(161 161 170)"
                        fontSize="10"
                    >
                        {t("points_help")}
                    </text>
                </svg>
            </div>

            <div className="mt-2 text-[11px] text-zinc-500">
                {t("points_count")}: {points.length}
                {selectedClipId ? ` · Clip ${selectedClipId}` : ""}
                {selectedPointId
                    ? ` · ${t("selected")} ${selectedPointId}`
                    : ""}
            </div>
        </section>
    );
}
