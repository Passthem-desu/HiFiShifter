import { useRef, useState } from "react";
import { batch } from "react-redux";
import type { AppDispatch } from "../../../../app/store";
import type { SessionState } from "../../../../features/session/sessionSlice";
import {
    addTrackRemote,
    checkpointHistory,
    createClipsRemote,
    moveClipRemote,
    moveClipStart,
    moveClipTrack,
    selectClipRemote,
    setClipStateRemote,
} from "../../../../features/session/sessionSlice";
import type { ClipTemplate } from "../../../../features/session/sessionTypes";
import { isModifierActive } from "../../../../features/keybindings/keybindingsSlice";
import type { Keybinding } from "../../../../features/keybindings/types";
import {
    applyAutoCrossfade,
    computeAutoCrossfadeFromPayload,
} from "./autoCrossfade";
import { webApi } from "../../../../services/webviewApi";

const NEW_TRACK_SENTINEL = "__hs_new_track__";

/** copyMode 拖动时的 ghost 预览信息 */
export type GhostDragInfo = {
    /** 参与复制拖动的 clip id 列表 */
    clipIds: string[];
    /** 每个 clip 的初始位置（秒）和 trackId */
    initialById: Record<string, { startSec: number; trackId: string }>;
    /** 相对于初始位置的偏移量（秒） */
    deltaSec: number;
    /** 目标 trackId（null 表示新轨道） */
    targetTrackId: string | null;
    /** 是否允许跨轨道移动 */
    allowTrackMove: boolean;
};

export type ClipDragState = {
    pointerId: number;
    anchorClipId: string;
    clipIds: string[];
    offsetBeat: number;
    initialById: Record<string, { startSec: number; trackId: string }>;
    minstartSec: number;
    allowTrackMove: boolean;
    initialAnchorstartSec: number;
    initialAnchorTrackId: string;
    lastTrackId: string | null;
    lastDeltaBeat: number;
    copyMode: boolean;
    startClientX: number;
    startClientY: number;
    hasMoved: boolean;
};

export function useClipDrag(deps: {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    sessionRef: React.RefObject<SessionState>;
    rowHeight: number;
    multiSelectedClipIds: string[];
    multiSelectedSet: Set<string>;
    dispatch: AppDispatch;
    snapBeat: (beat: number) => number;
    beatFromClientX: (clientX: number, bounds: DOMRect, xScroll: number) => number;
    trackIdFromClientY: (clientY: number) => string | null;
    setClipDropNewTrack: (v: boolean) => void;
    setMultiSelectedClipIds: (ids: string[]) => void;
    /** modifier.clipSlipEdit 绑定 */
    slipEditKb: Keybinding;
    /** modifier.clipNoSnap 绑定 */
    noSnapKb: Keybinding;
    /** 网格吸附全局开关 */
    gridSnapEnabled: boolean;
    /** modifier.clipCopyDrag 绑定 */
    copyDragKb: Keybinding;
    /** 自动交叉淡入淡出 */
    autoCrossfadeEnabled: boolean;
    /** Ctrl+点击（未拖动）时的多选切换回调 */
    onCtrlClick?: (clipId: string) => void;
}) {
    const {
        scrollRef,
        sessionRef,
        multiSelectedClipIds,
        multiSelectedSet,
        dispatch,
        snapBeat,
        beatFromClientX,
        trackIdFromClientY,
        setClipDropNewTrack,
        setMultiSelectedClipIds,
        slipEditKb,
        noSnapKb,
        gridSnapEnabled,
        copyDragKb,
        autoCrossfadeEnabled,
        onCtrlClick,
    } = deps;

    const clipDragRef = useRef<ClipDragState | null>(null);
    const [ghostDrag, setGhostDrag] = useState<GhostDragInfo | null>(null);

    function startSlipDrag(
        e: React.PointerEvent<HTMLDivElement>,
        clipId: string,
        startSlipDragFn: (e: React.PointerEvent<HTMLDivElement>, clipId: string) => void,
    ) {
        startSlipDragFn(e, clipId);
    }

    function startClipDrag(
        e: React.PointerEvent<HTMLDivElement>,
        clipId: string,
        clipstartSec: number,
        altPressedHint: boolean | undefined,
        startSlipDragFn: (e: React.PointerEvent<HTMLDivElement>, clipId: string) => void,
    ) {
        if (e.button !== 0) return;

        const anchor = sessionRef.current.clips.find((c) => c.id === clipId);
        if (!anchor) return;

        const alt = Boolean(
            altPressedHint ||
            isModifierActive(slipEditKb, e.nativeEvent),
        );
        if (alt) {
            startSlipDrag(e, clipId, startSlipDragFn);
            return;
        }

        const scroller = scrollRef.current;
        if (!scroller) return;
        const bounds = scroller.getBoundingClientRect();
        const beatAtPointer = beatFromClientX(e.clientX, bounds, scroller.scrollLeft);

        const clipIds =
            multiSelectedClipIds.length > 0 && multiSelectedSet.has(clipId)
                ? [...multiSelectedClipIds]
                : [clipId];

        const initialById: Record<string, { startSec: number; trackId: string }> = {};
        let minstartSec = Number.POSITIVE_INFINITY;
        let allowTrackMove = true;
        let baseTrackId: string | null = null;
        for (const id of clipIds) {
            const c = sessionRef.current.clips.find((x) => x.id === id);
            if (!c) continue;
            const startSec = Math.max(0, Number(c.startSec ?? 0));
            initialById[id] = { startSec, trackId: String(c.trackId) };
            minstartSec = Math.min(minstartSec, startSec);
            if (baseTrackId == null) baseTrackId = String(c.trackId);
            if (baseTrackId !== String(c.trackId)) allowTrackMove = false;
        }
        if (!Number.isFinite(minstartSec)) minstartSec = 0;

        const initialTrackId = anchor.trackId;
        const targetTrackId = trackIdFromClientY(e.clientY) ?? initialTrackId;
        clipDragRef.current = {
            pointerId: e.pointerId,
            anchorClipId: clipId,
            clipIds,
            offsetBeat: beatAtPointer - clipstartSec,
            initialById,
            minstartSec,
            allowTrackMove,
            initialAnchorstartSec: clipstartSec,
            initialAnchorTrackId: initialTrackId,
            lastTrackId: targetTrackId,
            lastDeltaBeat: 0,
            copyMode: isModifierActive(copyDragKb, e.nativeEvent),
            startClientX: e.clientX,
            startClientY: e.clientY,
            hasMoved: false,
        };
        scroller.setPointerCapture(e.pointerId);

        function onMove(ev: PointerEvent) {
            const drag = clipDragRef.current;
            const el = scrollRef.current;
            if (!drag || drag.pointerId !== e.pointerId || !el) return;

            if (!drag.hasMoved) {
                const dx = ev.clientX - drag.startClientX;
                const dy = ev.clientY - drag.startClientY;
                if (dx * dx + dy * dy < 9) return;
                drag.hasMoved = true;
                if (!drag.copyMode) {
                    dispatch(checkpointHistory());
                    // Begin backend undo group so that move_clip + auto-crossfade
                    // share a single backend undo entry.
                    void webApi.beginUndoGroup();
                }
            }
            const b = el.getBoundingClientRect();
            const beatNow = beatFromClientX(ev.clientX, b, el.scrollLeft);
            let nextStart = Math.max(0, beatNow - drag.offsetBeat);
            // gridSnapEnabled XOR modifier → snap when exactly one is true
            const modActive = isModifierActive(noSnapKb, ev);
            if (gridSnapEnabled !== modActive) nextStart = snapBeat(nextStart);

            let deltaBeat = nextStart - drag.initialAnchorstartSec;
            deltaBeat = Math.max(deltaBeat, -drag.minstartSec);
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

            // copyMode 时不移动原 clip，只更新 ghost 预览位置
            if (drag.copyMode) {
                setGhostDrag({
                    clipIds: drag.clipIds,
                    initialById: drag.initialById,
                    deltaSec: deltaBeat,
                    targetTrackId: nextTrackId,
                    allowTrackMove: drag.allowTrackMove,
                });
            } else {
                batch(() => {
                    for (const id of drag.clipIds) {
                        const initial = drag.initialById[id];
                        if (!initial) continue;
                        dispatch(
                            moveClipStart({
                                clipId: id,
                                startSec: Math.max(0, initial.startSec + deltaBeat),
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
        }

        function end() {
            const drag = clipDragRef.current;
            if (!drag || drag.pointerId !== e.pointerId) return;
            clipDragRef.current = null;
            setClipDropNewTrack(false);

            // 清除 ghost 预览
            setGhostDrag(null);

            if (!drag.hasMoved) {
                // Ctrl+点击（未移动）：执行多选切换
                if (drag.copyMode && onCtrlClick) {
                    onCtrlClick(drag.anchorClipId);
                }
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", end);
                window.removeEventListener("pointercancel", end);
                return;
            }

            const session = sessionRef.current;
            const dropToNewTrack = drag.allowTrackMove && drag.lastTrackId == null;

            async function createNewTrackForDrop(): Promise<string | null> {
                const before = new Set(sessionRef.current.tracks.map((t) => t.id));
                const res = (await dispatch(
                    addTrackRemote({ name: undefined, parentTrackId: null }),
                ).unwrap()) as {
                    tracks?: Array<{ id?: string }>;
                    selected_track_id?: string | null;
                };
                const nextTracks = Array.isArray(res?.tracks) ? res.tracks : [];
                const created = nextTracks.find((t) => !before.has(String(t?.id)));
                return (
                    (created && String(created.id)) ||
                    (res?.selected_track_id ? String(res.selected_track_id) : null)
                );
            }

            if (drag.copyMode) {
                // copyMode 下原 clip 未被移动，直接根据 ghost 偏移量计算副本位置
                const templates: ClipTemplate[] = [];
                for (const id of drag.clipIds) {
                    const initial = drag.initialById[id];
                    const now = session.clips.find((c) => c.id === id);
                    if (!initial || !now) continue;
                    const targetTrackId = drag.allowTrackMove
                        ? (drag.lastTrackId ?? null)
                        : initial.trackId;
                    templates.push({
                        trackId: targetTrackId ?? initial.trackId,
                        name: String(now.name),
                        startSec: Math.max(0, initial.startSec + drag.lastDeltaBeat),
                        lengthSec: Number(now.lengthSec),
                        sourcePath: now.sourcePath,
                        durationSec: now.durationSec,
                        gain: Number(now.gain ?? 1) || 1,
                        muted: Boolean(now.muted),
                        sourceStartSec: Number(now.sourceStartSec ?? 0) || 0,
                        sourceEndSec: Number(now.sourceEndSec ?? 0) || 0,
                        playbackRate: Number(now.playbackRate ?? 1) || 1,
                        fadeInSec: Number(now.fadeInSec ?? 0) || 0,
                        fadeOutSec: Number(now.fadeOutSec ?? 0) || 0,
                    });
                }
                if (templates.length > 0) {
                    dispatch(checkpointHistory());
                    void (async () => {
                        // Begin backend undo group for copy-drag + auto-crossfade
                        await webApi.beginUndoGroup();
                        try {
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
                            if (!Array.isArray(created) || created.length === 0) return;
                            setMultiSelectedClipIds(created);
                            void dispatch(selectClipRemote(created[0]));
                            // 复制拖动后，尝试对新创建的 clip 应用自动交叉淡化
                            if (autoCrossfadeEnabled) {
                                const allClips = (payload?.clips ?? []) as Array<{
                                    id?: string;
                                    track_id?: string;
                                    start_sec?: number;
                                    length_sec?: number;
                                    fade_in_sec?: number;
                                    fade_out_sec?: number;
                                }>;
                                const fadeUpdates = computeAutoCrossfadeFromPayload(
                                    allClips,
                                    created,
                                );
                                if (fadeUpdates.length > 0) {
                                    const fadePromises = fadeUpdates.map((u) =>
                                        dispatch(
                                            setClipStateRemote({
                                                clipId: u.clipId,
                                                fadeInSec: u.fadeInSec,
                                                fadeOutSec: u.fadeOutSec,
                                            }),
                                        ).unwrap(),
                                    );
                                    await Promise.allSettled(fadePromises);
                                }
                            }
                        } finally {
                            void webApi.endUndoGroup();
                        }
                    })().catch(() => undefined);
                }
            } else {
                if (dropToNewTrack) {
                    void (async () => {
                        try {
                            const newTrackId = await createNewTrackForDrop();
                            if (!newTrackId) throw new Error("create_track_failed");
                            const movePs: Promise<unknown>[] = [];
                            for (const id of drag.clipIds) {
                                const initial = drag.initialById[id];
                                const now = sessionRef.current.clips.find((c) => c.id === id);
                                if (!initial || !now) continue;
                                movePs.push(
                                    dispatch(
                                        moveClipRemote({
                                            clipId: id,
                                            startSec: Number(now.startSec),
                                            trackId: newTrackId,
                                        }),
                                    ).unwrap(),
                                );
                            }
                            await Promise.allSettled(movePs);
                            if (autoCrossfadeEnabled) {
                                await new Promise((r) => setTimeout(r, 0));
                                const latestSession = sessionRef.current;
                                applyAutoCrossfade(latestSession, drag.clipIds, dispatch);
                            }
                        } catch {
                            for (const id of drag.clipIds) {
                                const initial = drag.initialById[id];
                                if (!initial) continue;
                                dispatch(moveClipTrack({ clipId: id, trackId: initial.trackId }));
                            }
                        } finally {
                            void webApi.endUndoGroup();
                        }
                    })();
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", end);
                    window.removeEventListener("pointercancel", end);
                    return;
                }

                // 收集移动 promise，等待后端确认后再应用交叉淡入淡出
                const movePromises: Promise<unknown>[] = [];
                for (const id of drag.clipIds) {
                    const initial = drag.initialById[id];
                    const now = session.clips.find((c) => c.id === id);
                    if (!initial || !now) continue;
                    const changedBeat =
                        Math.abs(Number(now.startSec) - initial.startSec) > 1e-6;
                    const changedTrack = String(now.trackId) !== initial.trackId;
                    if (changedBeat || changedTrack) {
                        movePromises.push(
                            dispatch(
                                moveClipRemote({
                                    clipId: id,
                                    startSec: Number(now.startSec),
                                    trackId: String(now.trackId),
                                }),
                            ).unwrap(),
                        );
                    }
                }

                // Auto crossfade: 等所有 move 完成后再计算并持久化交叉淡化
                if (movePromises.length > 0) {
                    const movedIds = drag.clipIds;
                    void Promise.allSettled(movePromises).then(() => {
                        if (autoCrossfadeEnabled) {
                            const latestSession = sessionRef.current;
                            applyAutoCrossfade(latestSession, movedIds, dispatch);
                        }
                        void webApi.endUndoGroup();
                    });
                } else {
                    if (autoCrossfadeEnabled) {
                        applyAutoCrossfade(session, drag.clipIds, dispatch);
                    }
                    void webApi.endUndoGroup();
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

    return { clipDragRef, startClipDrag, ghostDrag };
}
