import { useEffect, useRef } from "react";
import { useAppSelector } from "../../app/hooks";
import { selectMergedKeybindings } from "./keybindingsSlice";
import type { ActionId, Keybinding, KeybindingMap } from "./types";

/**
 * 判断当前焦点是否在可编辑元素上（输入框等），此时不拦截快捷键
 */
function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = (el.tagName ?? "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
        return true;
    }
    if (el.isContentEditable) return true;
    if (el.closest?.('input,textarea,select,[contenteditable="true"]'))
        return true;
    return false;
}

/**
 * 将 KeyboardEvent 的按键信息规范化为小写 key 字符串
 */
export function normalizeEventKey(e: KeyboardEvent): string {
    // 对 Space 按键特殊处理
    if (e.key === " " || e.code === "Space") return "space";
    return e.key.toLowerCase();
}

/**
 * 判断按下的按键是否匹配某个 Keybinding 定义
 */
export function matchesKeybinding(e: KeyboardEvent, kb: Keybinding): boolean {
    const key = normalizeEventKey(e);
    if (key !== kb.key) return false;

    const isMac =
        typeof navigator !== "undefined" &&
        navigator.platform?.toLowerCase().includes("mac");

    const modKey = isMac ? e.metaKey : e.ctrlKey;
    const wantCtrl = Boolean(kb.ctrl);
    const wantShift = Boolean(kb.shift);
    const wantAlt = Boolean(kb.alt);

    if (modKey !== wantCtrl) return false;
    if (e.shiftKey !== wantShift) return false;
    if (e.altKey !== wantAlt) return false;
    return true;
}

/**
 * 在给定映射表中查找匹配的 actionId
 */
function findMatchingAction(
    e: KeyboardEvent,
    keybindings: KeybindingMap,
): ActionId | null {
    // 优先匹配含修饰键的绑定（避免裸键误触）
    const entries = Object.entries(keybindings) as [ActionId, Keybinding][];

    // 先检查有修饰键的绑定
    for (const [actionId, kb] of entries) {
        if (kb.ctrl || kb.shift || kb.alt) {
            if (matchesKeybinding(e, kb)) return actionId;
        }
    }
    // 再检查无修饰键的绑定
    for (const [actionId, kb] of entries) {
        if (!kb.ctrl && !kb.shift && !kb.alt) {
            if (matchesKeybinding(e, kb)) return actionId;
        }
    }
    return null;
}

export type KeybindingActionHandler = (actionId: ActionId) => void;

/**
 * 全局快捷键监听 Hook
 *
 * 从 Redux store 读取合并后的快捷键映射，统一监听 keydown 事件，
 * 匹配到操作后回调 handler。
 *
 * @param handler — 收到匹配的 actionId 后执行具体逻辑的回调
 */
export function useKeybindings(handler: KeybindingActionHandler): void {
    const keybindings = useAppSelector(selectMergedKeybindings);
    const keybindingsRef = useRef(keybindings);
    const handlerRef = useRef(handler);

    useEffect(() => {
        keybindingsRef.current = keybindings;
    }, [keybindings]);

    useEffect(() => {
        handlerRef.current = handler;
    }, [handler]);

    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (e.repeat) return;
            if (isEditableTarget(document.activeElement) || isEditableTarget(e.target))
                return;

            // PianoRoll scroller 内的快捷键由其自身 onKeyDown 处理，不拦截
            const active = document.activeElement as HTMLElement | null;
            const inPianoRoll =
                active?.hasAttribute("data-piano-roll-scroller") ||
                active?.closest?.("[data-piano-roll-scroller]");
            if (inPianoRoll) {
                // 查找匹配的 actionId，如果属于 pianoRoll.* 则放行给 PianoRoll 自己处理
                // （shiftParamUp/Down 已移至全局 handler，不需要放行）
                const matchedAction = findMatchingAction(e, keybindingsRef.current);
                if (
                    matchedAction?.startsWith("pianoRoll.") &&
                    matchedAction !== "pianoRoll.shiftParamUp" &&
                    matchedAction !== "pianoRoll.shiftParamDown"
                ) {
                    return;
                }
            }

            const actionId = findMatchingAction(e, keybindingsRef.current);
            if (!actionId) return;

            e.preventDefault();
            e.stopPropagation();
            handlerRef.current(actionId);
        }

        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, []);
}

export { isEditableTarget };
