import { useEffect } from "react";
import type { AppDispatch } from "../../../../app/store";
import { useAppSelector } from "../../../../app/hooks";
import type { SessionState } from "../../../../features/session/sessionSlice";
import {
    checkpointHistory,
    createClipsRemote,
    removeClipRemote,
    selectClipRemote,
    splitClipRemote,
} from "../../../../features/session/sessionSlice";
import type { ClipTemplate } from "../../../../features/session/sessionTypes";
import { selectMergedKeybindings } from "../../../../features/keybindings/keybindingsSlice";
import type { ActionId, Keybinding, KeybindingMap } from "../../../../features/keybindings/types";

/**
 * 判断 KeyboardEvent 是否匹配某个 Keybinding
 */
function matchesKeybinding(e: KeyboardEvent, kb: Keybinding): boolean {
    let key = e.key.toLowerCase();
    if (key === " " || e.code === "Space") key = "space";

    if (key !== kb.key) return false;

    const isMac =
        typeof navigator !== "undefined" &&
        navigator.platform?.toLowerCase().includes("mac");

    const modKey = isMac ? e.metaKey : e.ctrlKey;
    if (modKey !== Boolean(kb.ctrl)) return false;
    if (e.shiftKey !== Boolean(kb.shift)) return false;
    if (e.altKey !== Boolean(kb.alt)) return false;
    return true;
}

/**
 * 在 keybinding map 中查找匹配的 actionId
 * 只检查 clip.* 操作
 */
function matchClipAction(
    e: KeyboardEvent,
    keybindings: KeybindingMap,
): ActionId | null {
    const clipActions: ActionId[] = [
        "clip.delete",
        "clip.copy",
        "clip.paste",
        "clip.split",
    ];
    // 优先匹配含修饰键的
    for (const actionId of clipActions) {
        const kb = keybindings[actionId];
        if ((kb.ctrl || kb.shift || kb.alt) && matchesKeybinding(e, kb)) {
            return actionId;
        }
    }
    for (const actionId of clipActions) {
        const kb = keybindings[actionId];
        if (!kb.ctrl && !kb.shift && !kb.alt && matchesKeybinding(e, kb)) {
            return actionId;
        }
    }
    return null;
}

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

    const keybindings = useAppSelector(selectMergedKeybindings);

    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (e.repeat) return;
            if (
                isEditableTarget(document.activeElement) ||
                isEditableTarget(e.target)
            )
                return;

            const s = sessionRef.current;
            const selectedIds =
                multiSelectedClipIds.length > 0
                    ? [...multiSelectedClipIds]
                    : s.selectedClipId
                      ? [s.selectedClipId]
                      : [];

            const actionId = matchClipAction(e, keybindings);
            if (!actionId) return;

            // clip.copy / clip.paste: PianoRoll 有自己的复制粘贴逻辑，焦点在其中时跳过
            if (actionId === "clip.copy" || actionId === "clip.paste") {
                const active = document.activeElement as HTMLElement | null;
                if (
                    active?.hasAttribute("data-piano-roll-scroller") ||
                    active?.closest?.("[data-piano-roll-scroller]")
                ) {
                    return;
                }
            }

            switch (actionId) {
                case "clip.delete": {
                    if (selectedIds.length === 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setMultiSelectedClipIds([]);
                    for (const id of selectedIds) {
                        void dispatch(removeClipRemote(id));
                    }
                    return;
                }

                case "clip.copy": {
                    if (selectedIds.length === 0) return;
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

                case "clip.paste": {
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

                case "clip.split": {
                    const clipId = s.selectedClipId;
                    if (!clipId) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const splitSec = Math.max(0, Number(s.playheadSec ?? 0) || 0);
                    void dispatch(splitClipRemote({ clipId, splitSec }));
                    return;
                }
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
        keybindings,
    ]);
}
