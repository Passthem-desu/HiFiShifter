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
import type {
    ActionId,
    Keybinding,
    KeybindingMap,
} from "../../../../features/keybindings/types";
import { applyAutoCrossfade } from "./autoCrossfade";
import { webApi } from "../../../../services/webviewApi";

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
        "clip.cut",
        "clip.paste",
        "clip.split",
        "clip.normalize",
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
    autoCrossfadeEnabled: boolean;
    onNormalize: (ids: string[]) => void;
}) {
    const {
        sessionRef,
        dispatch,
        multiSelectedClipIds,
        setMultiSelectedClipIds,
        clipClipboardRef,
        isEditableTarget,
        autoCrossfadeEnabled,
        onNormalize,
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

            // 快捷键设置对话框打开时，阻塞所有快捷键
            if (document.body.hasAttribute("data-keybindings-dialog-open"))
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

            // clip.delete: 当焦点在 PianoRoll 且工具为 select 时，Delete 应触发
            // edit.initialize 而非删除音频块，此处跳过以让 PianoRoll 处理
            if (actionId === "clip.delete") {
                const active = document.activeElement as HTMLElement | null;
                const inPianoRoll =
                    active?.hasAttribute("data-piano-roll-scroller") ||
                    active?.closest?.("[data-piano-roll-scroller]");
                if (inPianoRoll && s.toolMode === "select") {
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
                    const clips = s.clips.filter((c) =>
                        selectedIds.includes(c.id),
                    );
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
                        sourceStartSec: c.sourceStartSec,
                        sourceEndSec: c.sourceEndSec,
                        playbackRate: c.playbackRate,
                        fadeInSec: c.fadeInSec,
                        fadeOutSec: c.fadeOutSec,
                    }));
                    (
                        clipClipboardRef as React.MutableRefObject<
                            ClipTemplate[] | null
                        >
                    ).current = templates;
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

                case "clip.cut": {
                    if (selectedIds.length === 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    // 先复制到剪贴板
                    const cutClips = s.clips.filter((c) =>
                        selectedIds.includes(c.id),
                    );
                    if (cutClips.length === 0) return;
                    const cutTemplates = cutClips.map((c) => ({
                        trackId: c.trackId,
                        name: c.name,
                        startSec: c.startSec,
                        lengthSec: c.lengthSec,
                        sourcePath: c.sourcePath,
                        durationSec: c.durationSec,
                        gain: c.gain,
                        muted: c.muted,
                        sourceStartSec: c.sourceStartSec,
                        sourceEndSec: c.sourceEndSec,
                        playbackRate: c.playbackRate,
                        fadeInSec: c.fadeInSec,
                        fadeOutSec: c.fadeOutSec,
                    }));
                    (
                        clipClipboardRef as React.MutableRefObject<
                            ClipTemplate[] | null
                        >
                    ).current = cutTemplates;
                    try {
                        void navigator.clipboard?.writeText(
                            JSON.stringify({
                                type: "hifishifter.clipTemplates.v1",
                                templates: cutTemplates,
                            }),
                        );
                    } catch {
                        // ignore
                    }
                    // 再删除原音频块
                    setMultiSelectedClipIds([]);
                    for (const id of selectedIds) {
                        void dispatch(removeClipRemote(id));
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
                        .reduce(
                            (a, b) => Math.min(a, b),
                            Number.POSITIVE_INFINITY,
                        );
                    const delta =
                        Number.isFinite(minStart) &&
                        minStart !== Number.POSITIVE_INFINITY
                            ? playhead - minStart
                            : 0;
                    const templates = tpl.map((c) => ({
                        ...c,
                        startSec: Math.max(0, c.startSec + delta),
                    }));
                    dispatch(checkpointHistory());
                    void (async () => {
                        await webApi.beginUndoGroup();
                        try {
                            const payload = await dispatch(createClipsRemote({ templates })).unwrap();
                            const created: string[] =
                                payload?.createdClipIds ?? [];
                            if (!Array.isArray(created) || created.length === 0)
                                return;
                            setMultiSelectedClipIds(created);
                            void dispatch(selectClipRemote(created[0]));
                            if (autoCrossfadeEnabled) {
                                const latestSession = sessionRef.current;
                                if (latestSession) {
                                    await new Promise((r) => setTimeout(r, 0));
                                    applyAutoCrossfade(
                                        latestSession,
                                        created,
                                        dispatch,
                                    );
                                }
                            }
                        } finally {
                            void webApi.endUndoGroup();
                        }
                    })().catch(() => undefined);
                    return;
                }

                case "clip.split": {
                    const clipId = s.selectedClipId;
                    if (!clipId) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const splitSec = Math.max(
                        0,
                        Number(s.playheadSec ?? 0) || 0,
                    );
                    void dispatch(splitClipRemote({ clipId, splitSec }));
                    return;
                }

                case "clip.normalize": {
                    if (selectedIds.length === 0) return;
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    onNormalize(selectedIds);
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
        onNormalize,
    ]);
}
