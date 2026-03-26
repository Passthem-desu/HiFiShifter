/**
 * 主题持久化存储工具
 *
 * 使用 localStorage 存储用户的外观设置和自定义主题列表
 */

import type { AppearanceSettings, CustomTheme } from "./themeTypes";
import { DEFAULT_APPEARANCE } from "./themeTypes";

/* ─────────── Storage Keys ─────────── */

const APPEARANCE_KEY = "hifishifter.appearance";
const CUSTOM_THEMES_KEY = "hifishifter.customThemes";
/** 兼容旧版的主题模式 key */
const LEGACY_THEME_KEY = "hifishifter.theme";

/* ─────────── 外观设置 ─────────── */

/** 读取外观设置（带旧版兼容） */
export function loadAppearance(): AppearanceSettings {
    try {
        const raw = localStorage.getItem(APPEARANCE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<AppearanceSettings>;
            return { ...DEFAULT_APPEARANCE, ...parsed };
        }
    } catch {
        // fallthrough
    }

    // 兼容旧版 hifishifter.theme
    const legacyMode = localStorage.getItem(LEGACY_THEME_KEY);
    if (legacyMode === "light" || legacyMode === "dark") {
        return { ...DEFAULT_APPEARANCE, mode: legacyMode };
    }

    // 检测系统偏好
    const prefersDark =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    return { ...DEFAULT_APPEARANCE, mode: prefersDark ? "dark" : "light" };
}

/** 保存外观设置 */
export function saveAppearance(settings: AppearanceSettings): void {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(settings));
    // 同步旧版 key（兼容其他可能直接读取的代码）
    localStorage.setItem(LEGACY_THEME_KEY, settings.mode);
}

/* ─────────── 自定义主题列表 ─────────── */

/** 读取自定义主题列表 */
export function loadCustomThemes(): CustomTheme[] {
    try {
        const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
        if (raw) {
            return JSON.parse(raw) as CustomTheme[];
        }
    } catch {
        // fallthrough
    }
    return [];
}

/** 保存自定义主题列表 */
export function saveCustomThemes(themes: CustomTheme[]): void {
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(themes));
}

/* ─────────── 主题导入/导出 ─────────── */

/** 导出自定义主题为 JSON 字符串 */
export function exportThemeAsJson(theme: CustomTheme): string {
    return JSON.stringify(theme, null, 2);
}

/** 从 JSON 字符串导入自定义主题 */
export function importThemeFromJson(json: string): CustomTheme | null {
    try {
        const parsed = JSON.parse(json);
        if (
            parsed &&
            typeof parsed === "object" &&
            typeof parsed.name === "string" &&
            (parsed.base === "dark" || parsed.base === "light") &&
            typeof parsed.colors === "object"
        ) {
            return {
                id: parsed.id ?? crypto.randomUUID(),
                name: parsed.name,
                base: parsed.base,
                colors: parsed.colors,
                waveformColors: parsed.waveformColors ?? undefined,
            };
        }
    } catch {
        // invalid JSON
    }
    return null;
}
