import type { ActionId, ActionMeta, KeybindingMap } from "./types";

/**
 * 默认快捷键映射表
 * 收录了项目中所有硬编码快捷键的默认值
 */
export const DEFAULT_KEYBINDINGS: KeybindingMap = {
    // 模式切换
    "mode.toggle": { key: "tab" },

    // 播放控制
    "playback.toggle": { key: "space" },

    // 编辑
    "edit.undo": { key: "z", ctrl: true },
    "edit.redo": { key: "y", ctrl: true },

    // 工程
    "project.new": { key: "n", ctrl: true },
    "project.open": { key: "o", ctrl: true, shift: true },
    "project.save": { key: "s", ctrl: true },
    "project.saveAs": { key: "s", ctrl: true, shift: true },
    "project.export": { key: "e", ctrl: true },

    // Clip 操作
    "clip.delete": { key: "delete" },
    "clip.copy": { key: "c", ctrl: true },
    "clip.paste": { key: "v", ctrl: true },
    "clip.split": { key: "s" },

    // PianoRoll 操作
    "pianoRoll.copy": { key: "c", ctrl: true },
    "pianoRoll.paste": { key: "v", ctrl: true },

    // 修饰键行为
    "modifier.clipSlipEdit": { key: "alt", modifierOnly: true, alt: true },
    "modifier.clipStretch": { key: "alt", modifierOnly: true, alt: true },
    "modifier.clipNoSnap": { key: "shift", modifierOnly: true, shift: true },
    "modifier.clipCopyDrag": { key: "control", modifierOnly: true, ctrl: true },
    "modifier.pianoRollVerticalZoom": { key: "control", modifierOnly: true, ctrl: true },
};

/**
 * 操作元信息（用于 UI 分组 & 显示）
 */
export const ACTION_META: Record<ActionId, ActionMeta> = {
    "mode.toggle": { labelKey: "kb_mode_toggle", group: "mode" },

    "playback.toggle": { labelKey: "kb_playback_toggle", group: "playback" },

    "edit.undo": { labelKey: "kb_edit_undo", group: "edit" },
    "edit.redo": { labelKey: "kb_edit_redo", group: "edit" },

    "project.new": { labelKey: "kb_project_new", group: "project" },
    "project.open": { labelKey: "kb_project_open", group: "project" },
    "project.save": { labelKey: "kb_project_save", group: "project" },
    "project.saveAs": { labelKey: "kb_project_save_as", group: "project" },
    "project.export": { labelKey: "kb_project_export", group: "project" },

    "clip.delete": { labelKey: "kb_clip_delete", group: "clip" },
    "clip.copy": { labelKey: "kb_clip_copy", group: "clip" },
    "clip.paste": { labelKey: "kb_clip_paste", group: "clip" },
    "clip.split": { labelKey: "kb_clip_split", group: "clip" },

    "pianoRoll.copy": { labelKey: "kb_pianoroll_copy", group: "pianoRoll" },
    "pianoRoll.paste": { labelKey: "kb_pianoroll_paste", group: "pianoRoll" },

    "modifier.clipSlipEdit": { labelKey: "kb_modifier_slip_edit", group: "modifier" },
    "modifier.clipStretch": { labelKey: "kb_modifier_stretch", group: "modifier" },
    "modifier.clipNoSnap": { labelKey: "kb_modifier_no_snap", group: "modifier" },
    "modifier.clipCopyDrag": { labelKey: "kb_modifier_copy_drag", group: "modifier" },
    "modifier.pianoRollVerticalZoom": { labelKey: "kb_modifier_pr_vzoom", group: "modifier" },
};

/**
 * 所有 ActionId 列表（保持顺序一致，方便遍历）
 */
export const ALL_ACTION_IDS: ActionId[] = Object.keys(
    DEFAULT_KEYBINDINGS,
) as ActionId[];

/**
 * 分组标题 i18n key
 */
export const GROUP_LABEL_KEYS: Record<ActionMeta["group"], string> = {
    mode: "kb_group_mode",
    playback: "kb_group_playback",
    edit: "kb_group_edit",
    project: "kb_group_project",
    clip: "kb_group_clip",
    pianoRoll: "kb_group_pianoroll",
    modifier: "kb_group_modifier",
};
