import type { AppDispatch } from "../../../../app/store";
import type { SessionState } from "../../../../features/session/sessionSlice";
import {
    setClipFades,
} from "../../../../features/session/sessionSlice";
import { setClipStateRemote } from "../../../../features/session/thunks/timelineThunks";

/**
 * 自动交叉淡入淡出：为同轨道重叠的 clip 对设置 fade。
 * 对每个被拖动的 clip，找同轨道其它 clip 的重叠区域，
 * 设置左侧 clip 的 fadeOut 和右侧 clip 的 fadeIn 为重叠长度。
 * 无论新值比原值大还是小，都直接设置为重叠长度。
 * 同时将 fade 值持久化到后端。
 *
 * 对于没有重叠的方向，保留 clip 原有的 fade 值。
 */
export function applyAutoCrossfade(
    session: SessionState,
    movedIds: string[],
    dispatch: AppDispatch,
) {
    // 收集每个 clip 的 fadeIn/fadeOut 由重叠产生的值
    const fadeInOverlaps = new Map<string, number>();
    const fadeOutOverlaps = new Map<string, number>();

    for (const id of movedIds) {
        const clip = session.clips.find((c) => c.id === id);
        if (!clip) continue;
        const clipStart = Number(clip.startSec);
        const clipEnd = clipStart + Number(clip.lengthSec);

        const sameTrack = session.clips.filter(
            (c) => c.trackId === clip.trackId && c.id !== id,
        );

        for (const other of sameTrack) {
            const otherStart = Number(other.startSec);
            const otherEnd = otherStart + Number(other.lengthSec);
            const overlapStart = Math.max(clipStart, otherStart);
            const overlapEnd = Math.min(clipEnd, otherEnd);
            const overlap = overlapEnd - overlapStart;
            if (overlap <= 0.001) continue;

            if (clipStart <= otherStart) {
                fadeOutOverlaps.set(id, Math.max(fadeOutOverlaps.get(id) ?? 0, overlap));
                fadeInOverlaps.set(other.id, Math.max(fadeInOverlaps.get(other.id) ?? 0, overlap));
            } else {
                fadeInOverlaps.set(id, Math.max(fadeInOverlaps.get(id) ?? 0, overlap));
                fadeOutOverlaps.set(other.id, Math.max(fadeOutOverlaps.get(other.id) ?? 0, overlap));
            }
        }
    }

    const allClipIds = new Set([...fadeInOverlaps.keys(), ...fadeOutOverlaps.keys(), ...movedIds]);
    for (const clipId of allClipIds) {
        const clip = session.clips.find((c) => c.id === clipId);
        if (!clip) continue;

        const hasOverlapIn = fadeInOverlaps.has(clipId);
        const hasOverlapOut = fadeOutOverlaps.has(clipId);

        // 有重叠方向 → 使用重叠长度；无重叠方向 → 保留原始 fade 值
        const fadeInSec = hasOverlapIn
            ? (fadeInOverlaps.get(clipId) ?? 0)
            : Number(clip.fadeInSec ?? 0);
        const fadeOutSec = hasOverlapOut
            ? (fadeOutOverlaps.get(clipId) ?? 0)
            : Number(clip.fadeOutSec ?? 0);

        if (Math.abs(fadeInSec - Number(clip.fadeInSec ?? 0)) > 0.001 ||
            Math.abs(fadeOutSec - Number(clip.fadeOutSec ?? 0)) > 0.001) {
            dispatch(setClipFades({ clipId, fadeInSec, fadeOutSec }));
            void dispatch(setClipStateRemote({ clipId, fadeInSec, fadeOutSec }));
        }
    }
}
