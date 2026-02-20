import React from "react";
import type { ClipInfo } from "../../../features/session/sessionSlice";
import { CLIP_BODY_PADDING_Y, CLIP_HEADER_HEIGHT } from "./constants";
import { clamp, gainToDb } from "./math";
import { fadeInAreaPath, fadeOutAreaPath, waveformAreaPath } from "./paths";
import { sliceWaveformSamples } from "./clipWaveform";

type WaveformPreview = number[] | { l: number[]; r: number[] };

export const ClipItem: React.FC<{
    clip: ClipInfo;
    rowHeight: number;
    pxPerBeat: number;
    bpm: number;
    waveform: WaveformPreview | undefined;
    selected: boolean;
    isInMultiSelectedSet: boolean;
    multiSelectedCount: number;

    ensureSelected: (clipId: string) => void;
    selectClipRemote: (clipId: string) => void;
    openContextMenu: (clipId: string, clientX: number, clientY: number) => void;

    seekFromClientX: (clientX: number, commit: boolean) => void;
    startClipDrag: (
        e: React.PointerEvent<HTMLDivElement>,
        clipId: string,
        clipStartBeat: number,
    ) => void;
    startEditDrag: (
        e: React.PointerEvent,
        clipId: string,
        type: "trim_left" | "trim_right" | "fade_in" | "fade_out" | "gain",
    ) => void;
    toggleClipMuted: (clipId: string, nextMuted: boolean) => void;

    clearContextMenu: () => void;
}> = ({
    clip,
    rowHeight,
    pxPerBeat,
    bpm,
    waveform,
    selected,
    isInMultiSelectedSet,
    multiSelectedCount,
    ensureSelected,
    selectClipRemote,
    openContextMenu,
    seekFromClientX,
    startClipDrag,
    startEditDrag,
    toggleClipMuted,
    clearContextMenu,
}) => {
    const left = Math.max(0, clip.startBeat * pxPerBeat);
    const width = Math.max(1, clip.lengthBeats * pxPerBeat);

    const waveformAmpScale = clip.muted
        ? 0
        : clamp(Number(clip.gain ?? 1), 0, 4);

    const stereo =
        waveform &&
        typeof waveform === "object" &&
        !Array.isArray(waveform) &&
        "l" in waveform &&
        "r" in waveform;

    return (
        <div
            className={`absolute rounded-sm cursor-pointer shadow-sm overflow-visible border ${clip.muted ? "opacity-60 grayscale" : "opacity-95"} ${selected ? "border-white" : "border-qt-highlight"}`}
            style={{
                left,
                width,
                top: CLIP_HEADER_HEIGHT,
                height: rowHeight - CLIP_HEADER_HEIGHT - CLIP_BODY_PADDING_Y,
                backgroundColor:
                    "color-mix(in oklab, var(--qt-highlight) 35%, transparent)",
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!isInMultiSelectedSet) {
                    ensureSelected(clip.id);
                }
                selectClipRemote(clip.id);
                openContextMenu(clip.id, e.clientX, e.clientY);
            }}
            onPointerDown={(e) => {
                if (e.button !== 0) return;

                seekFromClientX(e.clientX, true);

                e.preventDefault();
                e.stopPropagation();
                clearContextMenu();

                if (multiSelectedCount === 0 || !isInMultiSelectedSet) {
                    ensureSelected(clip.id);
                }
                selectClipRemote(clip.id);
                startClipDrag(e, clip.id, clip.startBeat);
            }}
            title={clip.sourcePath ?? clip.name}
        >
            <div
                className="absolute left-0 top-0 bottom-0 w-[6px] z-40"
                style={{ cursor: "ew-resize" }}
                onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (multiSelectedCount === 0 || !isInMultiSelectedSet) {
                        ensureSelected(clip.id);
                    }
                    selectClipRemote(clip.id);
                    startEditDrag(e, clip.id, "trim_left");
                }}
            />
            <div
                className="absolute right-0 top-0 bottom-0 w-[6px] z-40"
                style={{ cursor: "ew-resize" }}
                onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (multiSelectedCount === 0 || !isInMultiSelectedSet) {
                        ensureSelected(clip.id);
                    }
                    selectClipRemote(clip.id);
                    startEditDrag(e, clip.id, "trim_right");
                }}
            />

            <div
                className="absolute left-0 top-0 w-[14px] h-[14px] z-50"
                style={{ cursor: "nwse-resize" }}
                onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (multiSelectedCount === 0 || !isInMultiSelectedSet) {
                        ensureSelected(clip.id);
                    }
                    selectClipRemote(clip.id);
                    startEditDrag(e, clip.id, "fade_in");
                }}
            />
            <div
                className="absolute right-0 top-0 w-[14px] h-[14px] z-50"
                style={{ cursor: "nesw-resize" }}
                onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (multiSelectedCount === 0 || !isInMultiSelectedSet) {
                        ensureSelected(clip.id);
                    }
                    selectClipRemote(clip.id);
                    startEditDrag(e, clip.id, "fade_out");
                }}
            />

            <div
                className="absolute left-1 right-1 flex items-center gap-1 z-50"
                style={{
                    top: -CLIP_HEADER_HEIGHT + 1,
                    height: CLIP_HEADER_HEIGHT,
                    pointerEvents: "none",
                }}
            >
                <button
                    className={`w-5 h-4 rounded text-[10px] border transition-all ${clip.muted ? "bg-red-900 text-red-200 border-red-500" : "bg-qt-button text-gray-300 border-transparent hover:border-red-500 hover:bg-red-900 hover:text-red-200"}`}
                    style={{ pointerEvents: "auto" }}
                    onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                    }}
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const next = !Boolean(clip.muted);
                        toggleClipMuted(clip.id, next);
                    }}
                    title={clip.muted ? "Unmute" : "Mute"}
                >
                    M
                </button>

                <div
                    title={`${gainToDb(clip.gain).toFixed(1)} dB`}
                    style={{
                        cursor: "ns-resize",
                        pointerEvents: "auto",
                    }}
                    onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (multiSelectedCount === 0 || !isInMultiSelectedSet) {
                            ensureSelected(clip.id);
                        }
                        selectClipRemote(clip.id);
                        startEditDrag(e, clip.id, "gain");
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
                    {gainToDb(clip.gain) >= 0 ? "+" : ""}
                    {gainToDb(clip.gain).toFixed(1)}dB
                </div>
            </div>

            <div className="absolute inset-0 pointer-events-none z-30">
                {clip.fadeInBeats > 0 ? (
                    <svg
                        className="absolute left-0 top-0 h-full"
                        width={Math.min(width, clip.fadeInBeats * pxPerBeat)}
                        height={
                            rowHeight - CLIP_HEADER_HEIGHT - CLIP_BODY_PADDING_Y
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
                                        clip.fadeInBeats * pxPerBeat,
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
                        width={Math.min(width, clip.fadeOutBeats * pxPerBeat)}
                        height={
                            rowHeight - CLIP_HEADER_HEIGHT - CLIP_BODY_PADDING_Y
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
                                        clip.fadeOutBeats * pxPerBeat,
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
                          const w = Math.max(1, Math.floor(width));
                          const h = 22;
                          const wf = waveform as { l: number[]; r: number[] };
                          const leftSamples = sliceWaveformSamples(
                              wf.l ?? [],
                              clip,
                              bpm,
                          );
                          const rightSamples = sliceWaveformSamples(
                              wf.r ?? [],
                              clip,
                              bpm,
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
                                          h / 2,
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
                                          h / 2,
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
                                      y1={h / 2}
                                      y2={h / 2}
                                      stroke="rgba(255,255,255,0.15)"
                                      strokeWidth="1"
                                      vectorEffect="non-scaling-stroke"
                                  />
                              </svg>
                          );
                      })()
                    : Array.isArray(waveform) && waveform.length > 0
                      ? (() => {
                            const mono = sliceWaveformSamples(
                                waveform,
                                clip,
                                bpm,
                            );
                            if (mono.length < 2) return null;
                            return (
                                <svg
                                    viewBox={`0 0 ${Math.max(1, Math.floor(width))} 20`}
                                    preserveAspectRatio="none"
                                    className="w-full h-full"
                                >
                                    <path
                                        d={waveformAreaPath(
                                            mono,
                                            Math.max(1, Math.floor(width)),
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
};
