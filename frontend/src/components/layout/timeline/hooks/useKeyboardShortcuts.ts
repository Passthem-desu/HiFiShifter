import { useEffect } from "react";
import type { AppDispatch } from "../../../../app/store";
import type { SessionState } from "../../../../features/session/sessionSlice";
import {
    checkpointHistory,
    createClipsRemote,
    removeClipRemote,
    selectClipRemote,
    setClipStateRemote,
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

            // Delete / Backspace：删除选中的 clip
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

            // Ctrl+C / Ctrl+V：复制/粘贴
            if ((e.ctrlKey || e.metaKey) && !e.altKey) {
                if (key === "c") {
                    if (selectedIds.length === 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const clips = s.clips.filter((c) => selectedIds.includes(c.id));
                    if (clips.length === 0) return;
                    const templates = clips.map((c) => ({
                        trackId: c.trackId,
                        name: c.name,
                        startBeat: c.startBeat,
                        lengthBeats: c.lengthBeats,
                        sourcePath: c.sourcePath,
                        durationSec: c.durationSec,
                        gain: c.gain,
                        muted: c.muted,
                        trimStartBeat: c.trimStartBeat,
                        trimEndBeat: c.trimEndBeat,
                        playbackRate: c.playbackRate,
                        fadeInBeats: c.fadeInBeats,
                        fadeOutBeats: c.fadeOutBeats,
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
                    const playhead = s.playheadBeat ?? 0;
                    const minStart = tpl
                        .map((c) => c.startBeat)
                        .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
                    const delta =
                        Number.isFinite(minStart) && minStart !== Number.POSITIVE_INFINITY
                            ? playhead - minStart
                            : 0;
                    const templates = tpl.map((c) => ({
                        ...c,
                        startBeat: Math.max(0, c.startBeat + delta),
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
                const splitBeat = Math.max(0, Number(s.playheadBeat ?? 0) || 0);
                void dispatch(splitClipRemote({ clipId, splitBeat }));
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
