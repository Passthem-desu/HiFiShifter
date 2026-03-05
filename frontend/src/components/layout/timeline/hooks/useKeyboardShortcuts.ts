import { useEffect } from "react";
import type { AppDispatch } from "../../../../app/store";
import type { SessionState } from "../../../../features/session/sessionSlice";
import {
    checkpointHistory,
    createClipsRemote,
    removeClipRemote,
    selectClipRemote,
    splitClipRemote,
} from "../../../../features/session/sessionSlice";
import type { ClipTemplate } from "../../../../features/session/sessionTypes";

export function useKeyboardShortcuts(deps: {
    sessionRef: React.RefObject<SessionState>;
    dispatch: AppDispatch;
    multiSelectedClipIds: string[];
    setMultiSelectedClipIds: (ids: string[]) => void;
    clipClipboardRef: React.RefObject<ClipTemplate[] | null>;
    isEditableTarget: (target: EventTarget | null) => boolean;
}) {
    const {
        sessionRef,
        dispatch,
        multiSelectedClipIds,
        setMultiSelectedClipIds,
        clipClipboardRef,
        isEditableTarget,
    } = deps;

    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (e.repeat) return;
            if (
                isEditableTarget(document.activeElement) ||
                isEditableTarget(e.target)
            )
                return;

            const key = e.key.toLowerCase();
            const s = sessionRef.current;

            const selectedIds =
                multiSelectedClipIds.length > 0
                    ? [...multiSelectedClipIds]
                    : s.selectedClipId
                      ? [s.selectedClipId]
                      : [];

            // Delete / Backspace：删除选中�?clip
            if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                if (key === "delete" || key === "backspace") {
                    if (selectedIds.length === 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setMultiSelectedClipIds([]);
                    for (const id of selectedIds) {
                        void dispatch(removeClipRemote(id));
                    }
                    return;
                }
            }

            // Ctrl+C / Ctrl+V：复制粘贴（PianoRoll 有自己的复制粘贴逻辑，焦点在其中时跳过）
            if ((e.ctrlKey || e.metaKey) && !e.altKey) {
                const active = document.activeElement as HTMLElement | null;
                if (
                    active?.hasAttribute("data-piano-roll-scroller") ||
                    active?.closest?.("[data-piano-roll-scroller]")
                ) {
                    // 焦点在 PianoRoll scroller 内，让事件继续传播给 PianoRoll 的 onKeyDown
                    return;
                }

                if (key === "c") {                    if (selectedIds.length === 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const clips = s.clips.filter((c) => selectedIds.includes(c.id));
                    if (clips.length === 0) return;
                    const templates = clips.map((c) => ({
                        trackId: c.trackId,
                        name: c.name,
                        startSec: c.startSec,
                        lengthSec: c.lengthSec,
                        sourcePath: c.sourcePath,
                        durationSec: c.durationSec,
                        gain: c.gain,
                        muted: c.muted,
                        trimStartSec: c.trimStartSec,
                        trimEndSec: c.trimEndSec,
                        playbackRate: c.playbackRate,
                        fadeInSec: c.fadeInSec,
                        fadeOutSec: c.fadeOutSec,
                    }));
                    (clipClipboardRef as React.MutableRefObject<ClipTemplate[] | null>).current = templates;
                    try {
                        void navigator.clipboard?.writeText(
                            JSON.stringify({
                                type: "hifishifter.clipTemplates.v1",
                                templates,
                            }),
                        );
                    } catch {
                        // ignore
                    }
                    return;
                }

                if (key === "v") {
                    const tpl = clipClipboardRef.current;
                    if (!tpl || tpl.length === 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const playhead = s.playheadSec ?? 0;
                    const minStart = tpl
                        .map((c) => c.startSec)
                        .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
                    const delta =
                        Number.isFinite(minStart) && minStart !== Number.POSITIVE_INFINITY
                            ? playhead - minStart
                            : 0;
                    const templates = tpl.map((c) => ({
                        ...c,
                        startSec: Math.max(0, c.startSec + delta),
                    }));
                    dispatch(checkpointHistory());
                    void dispatch(createClipsRemote({ templates }))
                        .unwrap()
                        .then((payload) => {
                            const created: string[] = payload?.createdClipIds ?? [];
                            if (!Array.isArray(created) || created.length === 0) return;
                            setMultiSelectedClipIds(created);
                            void dispatch(selectClipRemote(created[0]));
                        })
                        .catch(() => undefined);
                    return;
                }
            }

            // S：在播放头处分割选中 clip
            if (!e.ctrlKey && !e.metaKey && !e.altKey && key === "s") {
                const clipId = s.selectedClipId;
                if (!clipId) return;
                e.preventDefault();
                e.stopPropagation();
                const splitSec = Math.max(0, Number(s.playheadSec ?? 0) || 0);
                void dispatch(splitClipRemote({ clipId, splitSec }));
            }
        }
        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [
        dispatch,
        multiSelectedClipIds,
        sessionRef,
        setMultiSelectedClipIds,
        clipClipboardRef,
        isEditableTarget,
    ]);
}
