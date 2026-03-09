/**
 * 快捷键管理系统 — 类型定义
 */

/** 所有可绑定操作的 ID */
export type ActionId =
    // 播放控制
    | "playback.toggle" // 播放/暂停
    // 编辑
    | "edit.undo" // 撤销
    | "edit.redo" // 重做
    // 工程
    | "project.new" // 新建工程
    | "project.open" // 打开工程
    | "project.save" // 保存
    | "project.saveAs" // 另存为
    | "project.export" // 导出音频
    // 轨道
    | "track.add" // 新建轨道
    // Clip 操作
    | "clip.delete" // 删除选中 clip
    | "clip.copy" // 复制 clip
    | "clip.paste" // 粘贴 clip
    | "clip.split" // 分割 clip
    // PianoRoll 操作
    | "pianoRoll.copy" // PianoRoll 内复制参数帧
    | "pianoRoll.paste" // PianoRoll 内粘贴参数帧
    | "pianoRoll.shiftParamUp" // 选中 clip 参数线整体上移
    | "pianoRoll.shiftParamDown" // 选中 clip 参数线整体下移
    // 模式切换
    | "mode.toggle" // 切换选区/编辑模式
    // 修饰键行为
    | "modifier.clipSlipEdit" // 拖动 clip 时进入 slip edit
    | "modifier.clipStretch" // clip 边缘拖动时从 trim 变为 stretch
    | "modifier.clipNoSnap" // clip 移动/trim/stretch 时不吸附
    | "modifier.clipCopyDrag" // 拖动 clip 时进入复制模式
    | "modifier.pianoRollVerticalZoom" // PianoRoll Ctrl+滚轮垂直缩放
    // 快速搜索
    | "quickSearch.open" // 打开快速搜索弹窗
    | "quickSearch.navigate.up" // 快速搜索：向上切换候选项
    | "quickSearch.navigate.down" // 快速搜索：向下切换候选项
    | "quickSearch.preview" // 快速搜索：预览/试听
    | "quickSearch.confirm" // 快速搜索：确认放置
    | "quickSearch.close"; // 快速搜索：关闭弹窗

/** 单个快捷键绑定 */
export interface Keybinding {
    /** 主键名称（小写），如 "space", "s", "delete", "backspace" */
    key: string;
    /** 是否需要 Ctrl (Windows) / Cmd (Mac) */
    ctrl?: boolean;
    /** 是否需要 Shift */
    shift?: boolean;
    /** 是否需要 Alt */
    alt?: boolean;
    /** 仅作为修饰键使用（无主键），用于 modifier 类绑定 */
    modifierOnly?: boolean;
}

/** 操作元信息（用于 UI 显示） */
export interface ActionMeta {
    /** 国际化文本的 key（用于操作名称显示） */
    labelKey: string;
    /** 分组（用于设置面板分组展示） */
    group: "playback" | "edit" | "project" | "clip" | "pianoRoll" | "mode" | "modifier" | "quickSearch";
}

/** 完整的快捷键映射：actionId → Keybinding */
export type KeybindingMap = Record<ActionId, Keybinding>;

/** 用户覆盖项（只存储与默认不同的部分） */
export type KeybindingOverrides = Partial<KeybindingMap>;
