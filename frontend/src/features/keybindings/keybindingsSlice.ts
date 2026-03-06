import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { ActionId, Keybinding, KeybindingMap, KeybindingOverrides } from "./types";
import { DEFAULT_KEYBINDINGS } from "./defaultKeybindings";
import { loadKeybindingOverrides, saveKeybindingOverrides } from "./keybindingStorage";

// ─── State ───────────────────────────────────────────────────────

interface KeybindingsState {
    /** 用户自定义覆盖项（与默认不同的部分） */
    overrides: KeybindingOverrides;
}

const initialState: KeybindingsState = {
    overrides: loadKeybindingOverrides(),
};

// ─── Helpers ─────────────────────────────────────────────────────

/** 合并默认映射与用户覆盖，返回完整映射表 */
export function mergeKeybindings(overrides: KeybindingOverrides): KeybindingMap {
    return { ...DEFAULT_KEYBINDINGS, ...overrides } as KeybindingMap;
}

/** 判断两个 Keybinding 是否相等 */
function keybindingEqual(a: Keybinding, b: Keybinding): boolean {
    return (
        a.key === b.key &&
        Boolean(a.ctrl) === Boolean(b.ctrl) &&
        Boolean(a.shift) === Boolean(b.shift) &&
        Boolean(a.alt) === Boolean(b.alt) &&
        Boolean(a.modifierOnly) === Boolean(b.modifierOnly)
    );
}

/**
 * 将 Keybinding 格式化为可读字符串，如 "Ctrl+Shift+S"
 */
export function formatKeybinding(kb: Keybinding): string {
    const parts: string[] = [];
    if (kb.ctrl) parts.push("Ctrl");
    if (kb.alt) parts.push("Alt");
    if (kb.shift) parts.push("Shift");

    // modifierOnly 类型无主键，直接返回修饰键名称
    if (kb.modifierOnly) {
        return parts.length > 0 ? parts.join("+") : prettifyKey(kb.key);
    }

    // 美化特殊键名
    const keyName = kb.key.length === 1 ? kb.key.toUpperCase() : prettifyKey(kb.key);
    parts.push(keyName);
    return parts.join("+");
}

function prettifyKey(key: string): string {
    const map: Record<string, string> = {
        space: "Space",
        delete: "Delete",
        backspace: "Backspace",
        tab: "Tab",
        enter: "Enter",
        escape: "Escape",
        arrowup: "↑",
        arrowdown: "↓",
        arrowleft: "←",
        arrowright: "→",
    };
    return map[key.toLowerCase()] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

// ─── Slice ───────────────────────────────────────────────────────

const keybindingsSlice = createSlice({
    name: "keybindings",
    initialState,
    reducers: {
        /** 设置某个操作的快捷键绑定 */
        setKeybinding(
            state,
            action: PayloadAction<{ actionId: ActionId; binding: Keybinding }>,
        ) {
            const { actionId, binding } = action.payload;
            const defaultBinding = DEFAULT_KEYBINDINGS[actionId];
            if (defaultBinding && keybindingEqual(defaultBinding, binding)) {
                // 与默认值相同，移除覆盖
                delete state.overrides[actionId];
            } else {
                state.overrides[actionId] = binding;
            }
            saveKeybindingOverrides(state.overrides);
        },

        /** 重置某个操作的快捷键为默认值 */
        resetKeybinding(state, action: PayloadAction<ActionId>) {
            delete state.overrides[action.payload];
            saveKeybindingOverrides(state.overrides);
        },

        /** 重置所有快捷键为默认值 */
        resetAllKeybindings(state) {
            state.overrides = {};
            saveKeybindingOverrides(state.overrides);
        },
    },
});

export const { setKeybinding, resetKeybinding, resetAllKeybindings } =
    keybindingsSlice.actions;

export default keybindingsSlice.reducer;

// ─── Selectors ───────────────────────────────────────────────────

/** 获取合并后的完整快捷键映射 */
export function selectMergedKeybindings(state: {
    keybindings: KeybindingsState;
}): KeybindingMap {
    return mergeKeybindings(state.keybindings.overrides);
}

/** 获取某个操作的当前快捷键 */
export function selectKeybinding(
    state: { keybindings: KeybindingsState },
    actionId: ActionId,
): Keybinding {
    return state.keybindings.overrides[actionId] ?? DEFAULT_KEYBINDINGS[actionId];
}

/** 检测冲突：给定新绑定，返回与之冲突的 actionId 列表（排除自身） */
export function findConflicts(
    overrides: KeybindingOverrides,
    actionId: ActionId,
    newBinding: Keybinding,
): ActionId[] {
    const merged = mergeKeybindings(overrides);
    const conflicts: ActionId[] = [];
    for (const [id, binding] of Object.entries(merged)) {
        if (id === actionId) continue;
        if (keybindingEqual(binding, newBinding)) {
            conflicts.push(id as ActionId);
        }
    }
    return conflicts;
}

/**
 * 检测事件中某个 modifierOnly 绑定的修饰键是否按下。
 * 适用于 PointerEvent / MouseEvent / KeyboardEvent 等任何带修饰键状态的事件。
 */
export function isModifierActive(
    kb: Keybinding,
    event: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey?: boolean },
): boolean {
    const isMac =
        typeof navigator !== "undefined" &&
        navigator.platform?.toLowerCase().includes("mac");
    if (kb.ctrl) return isMac ? Boolean(event.metaKey) : event.ctrlKey;
    if (kb.alt) return event.altKey;
    if (kb.shift) return event.shiftKey;
    return false;
}
