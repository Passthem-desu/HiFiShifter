/**
 * 波形渲染颜色配置
 *
 * 定义深色和浅色主题下的波形填充和描边颜色，
 * 并支持从自定义主题中读取覆盖值。
 */

import type { ThemeMode } from "./AppThemeProvider";
import { loadAppearance } from "./themeStorage";
import { loadCustomThemes } from "./themeStorage";

export interface WaveformColors {
    /** 波形填充颜色 */
    fill: string;
    /** 波形描边颜色 */
    stroke: string;
}

/**
 * 深色主题波形颜色
 */
const darkWaveformColors: WaveformColors = {
    fill: "rgba(255,255,255,0.34)",
    stroke: "rgba(255,255,255,0.92)",
};

/**
 * 浅色主题波形颜色（蓝灰色调，避免纯黑过于刺眼）
 */
const lightWaveformColors: WaveformColors = {
    fill: "rgba(60,90,130,0.22)",
    stroke: "rgba(60,90,130,0.65)",
};

/**
 * 根据主题模式获取波形颜色配置
 *
 * 优先使用自定义主题中的波形颜色（如果有激活的自定义主题且设置了波形颜色），
 * 否则回退到内置的主题默认波形颜色。
 *
 * @param mode - 主题模式 ('dark' | 'light')
 * @returns 波形颜色配置对象
 *
 * @example
 * const colors = getWaveformColors('dark');
 * // { fill: 'rgba(255,255,255,0.34)', stroke: 'rgba(255,255,255,0.92)' }
 */
export function getWaveformColors(mode: ThemeMode): WaveformColors {
    // 尝试从自定义主题读取波形颜色
    try {
        const appearance = loadAppearance();
        if (appearance.activeCustomThemeId) {
            const themes = loadCustomThemes();
            const active = themes.find((t) => t.id === appearance.activeCustomThemeId);
            if (active?.waveformColors) {
                return active.waveformColors;
            }
        }
    } catch {
        // fallthrough to default
    }

    return mode === "dark" ? darkWaveformColors : lightWaveformColors;
}
