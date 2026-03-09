import React from "react";

import type { ClipInfo, TrackInfo } from "../../../features/session/sessionTypes";
import type { GhostDragInfo } from "./hooks/useClipDrag";
import { ClipItem } from "./ClipItem";
import { CLIP_HEADER_HEIGHT, CLIP_BODY_PADDING_Y } from "./constants";

type WaveformPreview = number[] | { l: number[]; r: number[] };

export const TrackLane = React.memo(function TrackLane(props: {
    track: TrackInfo;
    trackClips: ClipInfo[];

    rowHeight: number;
    pxPerSec: number;
    bpm: number;

    clipWaveforms: Record<string, WaveformPreview | undefined>;

    altPressed: boolean;

    selectedClipId: string | null;
    multiSelectedClipIds: string[];
    multiSelectedSet: Set<string>;

    /** 轨道主题色，用于 Clip 背景色和选中边框�?*/
    trackColor?: string;

    ensureSelected: (clipId: string) => void;
    selectClipRemote: (clipId: string) => void;
    openContextMenu: (clipId: string, clientX: number, clientY: number) => void;

    seekFromClientX: (clientX: number, commit: boolean) => void;
    startClipDrag: (
        e: React.PointerEvent<HTMLDivElement>,
        clipId: string,
        clipstartSec: number,
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
    /** Ctrl+左键多选切换 */
    toggleMultiSelect: (clipId: string) => void;

    clearContextMenu: () => void;

    /** 当前正在重命名的 clipId（来自右键菜单触发） */
    renamingClipId?: string | null;
    onRenameCommit?: (clipId: string, newName: string) => void;
    onRenameDone?: () => void;
    onGainCommit?: (clipId: string, db: number) => void;

    /** Ctrl+拖动复制时的 ghost 预览信息 */
    ghostDrag?: GhostDragInfo | null;
    /** 所有 clip 数据（用于跨轨道 ghost 查找） */
    allClips?: ClipInfo[];
}) {
    const {
        track,
        trackClips,
        rowHeight,
        pxPerSec,
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
        toggleMultiSelect,
        clearContextMenu,
        renamingClipId,
        onRenameCommit,
        onRenameDone,
        onGainCommit,
        ghostDrag,
        allClips,
    } = props;

    // 计算当前轨道上需要渲染的 ghost clip 列表
    const ghostClips = React.useMemo(() => {
        if (!ghostDrag) return [];
        const result: { clip: ClipInfo; ghostStartSec: number }[] = [];
        for (const clipId of ghostDrag.clipIds) {
            const initial = ghostDrag.initialById[clipId];
            if (!initial) continue;
            // 判断 ghost 是否应出现在当前轨道上
            const ghostTrackId = ghostDrag.allowTrackMove
                ? (ghostDrag.targetTrackId ?? initial.trackId)
                : initial.trackId;
            if (ghostTrackId !== track.id) continue;
            // 优先从当前轨道 clips 查找，跨轨道时从全部 clips 中查找
            const clip = trackClips.find((c) => c.id === clipId)
                ?? allClips?.find((c) => c.id === clipId)
                ?? undefined;
            if (!clip) continue;
            result.push({
                clip,
                ghostStartSec: Math.max(0, initial.startSec + ghostDrag.deltaSec),
            });
        }
        return result;
    }, [ghostDrag, track.id, trackClips, allClips]);

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
                        pxPerSec={pxPerSec}
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
                        toggleMultiSelect={toggleMultiSelect}
                        clearContextMenu={clearContextMenu}
                        triggerRename={renamingClipId === clip.id}
                        onRenameCommit={onRenameCommit}
                        onRenameDone={onRenameDone}
                        onGainCommit={onGainCommit}
                    />
            );
            })}
            {/* Ghost clip 预览：Ctrl+拖动复制时显示半透明副本 */}
            {ghostClips.map(({ clip, ghostStartSec }) => {
                const ghostLeft = Math.max(0, ghostStartSec * pxPerSec);
                const ghostWidth = Math.max(1, clip.lengthSec * pxPerSec);
                return (
                    <div
                        key={`ghost-${clip.id}`}
                        className="absolute pointer-events-none opacity-50"
                        style={{
                            left: ghostLeft,
                            width: ghostWidth,
                            top: 0,
                            height: rowHeight - CLIP_BODY_PADDING_Y,
                        }}
                    >
                        {/* Ghost header 条 */}
                        <div
                            className="absolute left-0 right-0 top-0 rounded-t-sm"
                            style={{
                                height: CLIP_HEADER_HEIGHT,
                                backgroundColor: trackColor
                                    ? `color-mix(in oklab, ${trackColor} 50%, transparent)`
                                    : "color-mix(in oklab, var(--qt-highlight) 50%, transparent)",
                            }}
                        />
                        {/* Ghost body 区域 */}
                        <div
                            className="absolute left-0 right-0 bottom-0 rounded-sm border border-dashed border-white/60"
                            style={{
                                top: CLIP_HEADER_HEIGHT,
                                backgroundColor: trackColor
                                    ? `color-mix(in oklab, ${trackColor} 20%, transparent)`
                                    : "color-mix(in oklab, var(--qt-highlight) 20%, transparent)",
                            }}
                        />
                    </div>
                );
            })}
        </div>
    );
});
