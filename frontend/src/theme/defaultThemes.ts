/**
 * 内置主题颜色常量
 *
 * 从 index.css 中的 .qt-theme.dark / .qt-theme.light 提取为 TypeScript 对象，
 * 用于外观设置中的「重置为默认」功能。
 */

import type { QtColorToken } from "./themeTypes";

/** 深色内置主题的所有 --qt-* 颜色值 */
export const DARK_THEME_COLORS: Record<QtColorToken, string> = {
    "qt-window": "#353535",
    "qt-base": "#2d2d2d",
    "qt-panel": "#2a2a2a",
    "qt-surface": "#404040",
    "qt-text": "#d0d0d0",
    "qt-text-muted": "#909090",
    "qt-highlight": "#3b82f6",
    "qt-playhead": "#f05a5a",
    "qt-button": "#3d3d3d",
    "qt-button-hover": "#484848",
    "qt-border": "#505050",
    "qt-danger-bg": "#4a1a1a",
    "qt-danger-text": "#fca5a5",
    "qt-danger-border": "#ef4444",
    "qt-warning-bg": "#3d2a0a",
    "qt-warning-text": "#fcd34d",
    "qt-warning-border": "#f59e0b",
    "qt-graph-bg": "#232323",
    "qt-graph-grid-strong": "#4a4a4a",
    "qt-graph-grid-weak": "#373737",
    "qt-scrollbar-thumb": "#555555",
    "qt-scrollbar-thumb-hover": "#707070",
};

/**
 * 浅色内置主题 — 使用 Radix var() 引用，不是固定 hex。
 * 在外观设置 UI 中不能直接用作 <input type="color"> 的默认值，
 * 所以这里存放的是「等效 hex」近似值，方便 UI 展示和编辑。
 */
export const LIGHT_THEME_COLORS: Record<QtColorToken, string> = {
    "qt-window": "#f0f0f0",
    "qt-base": "#e8e8ec",
    "qt-panel": "#ffffff",
    "qt-surface": "#d9d9e0",
    "qt-text": "#1c2024",
    "qt-text-muted": "#60646c",
    "qt-highlight": "#5b5bd6",
    "qt-playhead": "#e5484d",
    "qt-button": "#e8e8ec",
    "qt-button-hover": "#d9d9e0",
    "qt-border": "#b9bbc6",
    "qt-danger-bg": "#ffe5e5",
    "qt-danger-text": "#ce2c31",
    "qt-danger-border": "#e5484d",
    "qt-warning-bg": "#fff4d5",
    "qt-warning-text": "#ad5700",
    "qt-warning-border": "#f59e0b",
    "qt-graph-bg": "#ffffff",
    "qt-graph-grid-strong": "#b0b0b8",
    "qt-graph-grid-weak": "#d0d0d8",
    "qt-scrollbar-thumb": "#b0b0b8",
    "qt-scrollbar-thumb-hover": "#8b8d98",
};

/** 根据模式获取内置主题颜色 */
export function getBuiltinThemeColors(
    mode: "dark" | "light",
): Record<QtColorToken, string> {
    return mode === "dark" ? DARK_THEME_COLORS : LIGHT_THEME_COLORS;
}
