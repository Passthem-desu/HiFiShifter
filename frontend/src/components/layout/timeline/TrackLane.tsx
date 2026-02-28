import React from "react";

import type { ClipInfo, TrackInfo } from "../../../features/session/sessionTypes";
import { ClipItem } from "./ClipItem";

type WaveformPreview = number[] | { l: number[]; r: number[] };

export const TrackLane = React.memo(function TrackLane(props: {
    track: TrackInfo;
    trackClips: ClipInfo[];

    rowHeight: number;
    pxPerBeat: number;
    bpm: number;

    clipWaveforms: Record<string, WaveformPreview | undefined>;

    altPressed: boolean;

    selectedClipId: string | null;
    multiSelectedClipIds: string[];
    multiSelectedSet: Set<string>;

    /** 轨道主题色，用于 Clip 背景色和选中边框色 */
    trackColor?: string;

    ensureSelected: (clipId: string) => void;
    selectClipRemote: (clipId: string) => void;
    openContextMenu: (clipId: string, clientX: number, clientY: number) => void;

    seekFromClientX: (clientX: number, commit: boolean) => void;
    startClipDrag: (
        e: React.PointerEvent<HTMLDivElement>,
        clipId: string,
        clipStartBeat: number,
        altPressedHint?: boolean,
    ) => void;
    startEditDrag: (
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
    ) => void;
    toggleClipMuted: (clipId: string, nextMuted: boolean) => void;

    clearContextMenu: () => void;

    /** 当前正在重命名的 clipId（来自右键菜单触发） */
    renamingClipId?: string | null;
    onRenameCommit?: (clipId: string, newName: string) => void;
    onRenameDone?: () => void;
    onGainCommit?: (clipId: string, db: number) => void;
}) {
    const {
        track,
        trackClips,
        rowHeight,
        pxPerBeat,
        bpm,
        clipWaveforms,
        altPressed,
        selectedClipId,
        multiSelectedClipIds,
        multiSelectedSet,
        trackColor,
        ensureSelected,
        selectClipRemote,
        openContextMenu,
        seekFromClientX,
        startClipDrag,
        startEditDrag,
        toggleClipMuted,
        clearContextMenu,
        renamingClipId,
        onRenameCommit,
        onRenameDone,
        onGainCommit,
    } = props;

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
                        : selectedClipId === clip.id;
                const waveform = clipWaveforms[clip.id];

                return (
                    <ClipItem
                        key={clip.id}
                        clip={clip}
                        rowHeight={rowHeight}
                        pxPerBeat={pxPerBeat}
                        bpm={bpm}
                        waveform={waveform}
                        altPressed={altPressed}
                        selected={selected}
                        isInMultiSelectedSet={multiSelectedSet.has(clip.id)}
                        multiSelectedCount={multiSelectedClipIds.length}
                        trackColor={trackColor}
                        ensureSelected={ensureSelected}
                        selectClipRemote={selectClipRemote}
                        openContextMenu={openContextMenu}
                        seekFromClientX={seekFromClientX}
                        startClipDrag={startClipDrag}
                        startEditDrag={startEditDrag}
                        toggleClipMuted={toggleClipMuted}
                        clearContextMenu={clearContextMenu}
                        triggerRename={renamingClipId === clip.id}
                        onRenameCommit={onRenameCommit}
                        onRenameDone={onRenameDone}
                        onGainCommit={onGainCommit}
                    />
                );
            })}
        </div>
    );
});
