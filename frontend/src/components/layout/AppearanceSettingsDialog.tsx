/**
 * 外观设置对话框
 *
 * 提供完整的主题配置界面，左侧 Tab 导航分为三个区域：
 * - 基础设置（主题模式、强调色、灰阶色、圆角、快捷颜色调整）
 * - 字体设置（手动输入 + 系统字体自动检测 + 搜索选择）
 * - 颜色设置（直接编辑所有颜色 token、主题管理、波形颜色）
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Dialog, Flex, Button, Text, ScrollArea, Tooltip } from "@radix-ui/themes";
import { MagnifyingGlassIcon } from "@radix-ui/react-icons";
import { useI18n } from "../../i18n/I18nProvider";
import { useAppTheme } from "../../theme/AppThemeProvider";
import { ColorPickerField } from "./ColorPickerField";
import {
    RADIX_ACCENT_COLORS,
    RADIX_GRAY_COLORS,
    RADIX_RADIUS_OPTIONS,
    QT_COLOR_TOKENS,
    QT_COLOR_TOKEN_LABELS,
    DEFAULT_FONT_FAMILY,
    type RadixAccentColor,
    type RadixGrayColor,
    type RadixRadius,
    type CustomTheme,
    type QtColorToken,
} from "../../theme/themeTypes";
import { getBuiltinThemeColors } from "../../theme/defaultThemes";
import {
    loadCustomThemes,
    saveCustomThemes,
    exportThemeAsJson,
    importThemeFromJson,
} from "../../theme/themeStorage";

/* ─────────── Radix 色块对照表（用于选择器显示） ─────────── */
const RADIX_ACCENT_HEX: Record<RadixAccentColor, string> = {
    gray: "#8b8d98", gold: "#978365", bronze: "#a18072", brown: "#ad7f58",
    yellow: "#ffe16a", amber: "#ffc53d", orange: "#f76b15", tomato: "#e54d2e",
    red: "#e5484d", ruby: "#e54666", crimson: "#e93d82", pink: "#d6409f",
    plum: "#ab4aba", purple: "#8e4ec6", violet: "#6e56cf", iris: "#5b5bd6",
    indigo: "#3e63dd", blue: "#0090ff", cyan: "#00a2c7", teal: "#12a594",
    jade: "#29a383", green: "#30a46c", grass: "#46a758", lime: "#bdee63",
    mint: "#86ead4", sky: "#7ce2fe",
};

const RADIX_GRAY_HEX: Record<RadixGrayColor, string> = {
    auto: "#8b8d98", gray: "#8b8d98", mauve: "#8e8c99", slate: "#8b8d98",
    sage: "#868e8b", olive: "#898e87", sand: "#8f8b83",
};

/* ─────────── Tab 类型 ─────────── */
type SettingsTab = "basic" | "font" | "colors";

/* ─────────── 颜色分组定义 ─────────── */
interface ColorGroup {
    labelKey: string;
    tokens: QtColorToken[];
}

const COLOR_GROUPS: ColorGroup[] = [
    {
        labelKey: "appearance_color_group_base",
        tokens: ["qt-window", "qt-base", "qt-panel", "qt-surface"],
    },
    {
        labelKey: "appearance_color_group_text",
        tokens: ["qt-text", "qt-text-muted"],
    },
    {
        labelKey: "appearance_color_group_ui",
        tokens: ["qt-highlight", "qt-playhead", "qt-button", "qt-button-hover", "qt-border"],
    },
    {
        labelKey: "appearance_color_group_danger",
        tokens: ["qt-danger-bg", "qt-danger-text", "qt-danger-border"],
    },
    {
        labelKey: "appearance_color_group_warning",
        tokens: ["qt-warning-bg", "qt-warning-text", "qt-warning-border"],
    },
    {
        labelKey: "appearance_color_group_graph",
        tokens: ["qt-graph-bg", "qt-graph-grid-strong", "qt-graph-grid-weak"],
    },
    {
        labelKey: "appearance_color_group_scrollbar",
        tokens: ["qt-scrollbar-thumb", "qt-scrollbar-thumb-hover"],
    },
];

/** 基础 Tab 中的快捷颜色（最常调整的） */
const QUICK_COLOR_TOKENS: QtColorToken[] = [
    "qt-highlight", "qt-playhead", "qt-text", "qt-text-muted",
    "qt-window", "qt-base", "qt-border",
];

/* ─────────── 系统字体检测 Hook ─────────── */

interface FontInfo {
    family: string;
    fullName: string;
    postscriptName: string;
    style: string;
}

function useSystemFonts() {
    const [fonts, setFonts] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [supported, setSupported] = useState(true);
    const loadedRef = useRef(false);

    const detect = useCallback(async () => {
        if (loadedRef.current || !("queryLocalFonts" in window)) {
            if (!("queryLocalFonts" in window)) setSupported(false);
            return;
        }

        setLoading(true);
        try {
            const fontData: FontInfo[] = await (window as unknown as {
                queryLocalFonts: () => Promise<FontInfo[]>;
            }).queryLocalFonts();

            const families = [...new Set(fontData.map((f) => f.family))].sort(
                (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }),
            );
            setFonts(families);
            loadedRef.current = true;
        } catch {
            setSupported(false);
        } finally {
            setLoading(false);
        }
    }, []);

    return { fonts, loading, supported, detect };
}

/* ─────────── 折叠分组组件 ─────────── */
const CollapsibleGroup: React.FC<{
    title: string;
    defaultOpen?: boolean;
    children: React.ReactNode;
}> = ({ title, defaultOpen = false, children }) => {
    const [isOpen, setIsOpen] = useState(defaultOpen);

    return (
        <div className="border border-qt-border rounded overflow-hidden">
            <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-qt-text bg-qt-panel hover:bg-qt-button-hover transition-colors"
                onClick={() => setIsOpen(!isOpen)}
            >
                <span className={`transition-transform text-[10px] ${isOpen ? "rotate-90" : ""}`}>▶</span>
                {title}
            </button>
            {isOpen && (
                <div className="px-3 py-2 space-y-1.5 bg-qt-base/50">
                    {children}
                </div>
            )}
        </div>
    );
};

/* ─────────── 主对话框组件 ─────────── */

interface AppearanceSettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export const AppearanceSettingsDialog: React.FC<AppearanceSettingsDialogProps> = ({
    open,
    onOpenChange,
}) => {
    const { t } = useI18n();
    const tAny = t as (key: string) => string;
    const theme = useAppTheme();

    /* ─────────── Tab 状态 ─────────── */
    const [activeTab, setActiveTab] = useState<SettingsTab>("basic");

    /* ─────────── 本地编辑状态 ─────────── */
    const [accentColor, setAccentColor] = useState<RadixAccentColor>(theme.accentColor);
    const [grayColor, setGrayColor] = useState<RadixGrayColor>(theme.grayColor);
    const [radius, setRadius] = useState<RadixRadius>(theme.radius);
    const [fontFamily, setFontFamily] = useState(theme.fontFamily);

    // 自定义主题
    const [customThemes, setCustomThemes] = useState<CustomTheme[]>([]);
    const [activeThemeId, setActiveThemeId] = useState<string | null>(theme.activeCustomThemeId);
    const [editColors, setEditColors] = useState<Partial<Record<QtColorToken, string>>>({});
    const [editWaveform, setEditWaveform] = useState<{ fill: string; stroke: string } | undefined>(undefined);
    const [editThemeName, setEditThemeName] = useState("");

    // 字体
    const [fontSearch, setFontSearch] = useState("");
    const systemFonts = useSystemFonts();

    const fileInputRef = useRef<HTMLInputElement>(null);

    /* ─────────── 打开时同步 & 自动检测字体 ─────────── */
    useEffect(() => {
        if (open) {
            setAccentColor(theme.accentColor);
            setGrayColor(theme.grayColor);
            setRadius(theme.radius);
            setFontFamily(theme.fontFamily);
            setActiveThemeId(theme.activeCustomThemeId);

            const themes = loadCustomThemes();
            setCustomThemes(themes);

            const active = themes.find((t) => t.id === theme.activeCustomThemeId);
            if (active) {
                setEditColors(active.colors);
                setEditWaveform(active.waveformColors);
                setEditThemeName(active.name);
            } else {
                setEditColors({});
                setEditWaveform(undefined);
                setEditThemeName("");
            }

            // 自动检测系统字体（无需手动点击按钮）
            systemFonts.detect();
        }
    }, [open, theme.accentColor, theme.grayColor, theme.radius, theme.fontFamily, theme.activeCustomThemeId]);

    /* ─────────── 内置颜色 ─────────── */
    const builtinColors = useMemo(
        () => getBuiltinThemeColors(theme.mode),
        [theme.mode],
    );

    /** 获取某个 token 的显示颜色：优先用户编辑值 > 内置值 */
    const getDisplayColor = useCallback(
        (token: QtColorToken) => editColors[token] ?? builtinColors[token] ?? "#000000",
        [editColors, builtinColors],
    );

    /* ─────────── 实时预览 ─────────── */
    useEffect(() => {
        if (!open) return;
        theme.setAccentColor(accentColor);
    }, [accentColor, open]);

    useEffect(() => {
        if (!open) return;
        theme.setGrayColor(grayColor);
    }, [grayColor, open]);

    useEffect(() => {
        if (!open) return;
        theme.setRadius(radius);
    }, [radius, open]);

    useEffect(() => {
        if (!open) return;
        theme.setFontFamily(fontFamily);
    }, [fontFamily, open]);

    useEffect(() => {
        if (!open) return;
        const root = document.documentElement;
        for (const token of QT_COLOR_TOKENS) {
            const val = editColors[token];
            if (val) {
                root.style.setProperty(`--${token}`, val);
            } else {
                root.style.removeProperty(`--${token}`);
            }
        }
    }, [editColors, open]);

    /* ─────────── 应用 & 关闭 ─────────── */
    const handleApply = useCallback(() => {
        const hasCustomColors = Object.keys(editColors).length > 0 || editWaveform;
        let themeId: string | null = null;

        if (hasCustomColors) {
            const existing = customThemes.find((t) => t.id === activeThemeId);
            const id = existing?.id ?? crypto.randomUUID();
            const newTheme: CustomTheme = {
                id,
                name: editThemeName || tAny("appearance_custom_theme"),
                base: theme.mode,
                colors: editColors,
                waveformColors: editWaveform,
            };

            const updated = existing
                ? customThemes.map((t) => (t.id === id ? newTheme : t))
                : [...customThemes, newTheme];

            setCustomThemes(updated);
            saveCustomThemes(updated);
            themeId = id;
            setActiveThemeId(id);
        } else {
            setActiveThemeId(null);
            themeId = null;
        }

        theme.applySettings({
            mode: theme.mode,
            accentColor,
            grayColor,
            radius,
            fontFamily,
            activeCustomThemeId: themeId,
        });

        onOpenChange(false);
    }, [
        accentColor, grayColor, radius, fontFamily,
        editColors, editWaveform, editThemeName,
        activeThemeId, customThemes, theme, onOpenChange, tAny,
    ]);

    const handleClose = useCallback(() => {
        theme.revertPreview();
        onOpenChange(false);
    }, [theme, onOpenChange]);

    /* ─────────── 颜色操作 ─────────── */
    const handleResetColors = useCallback(() => {
        setEditColors({});
        setEditWaveform(undefined);
        setEditThemeName("");
        setActiveThemeId(null);
    }, []);

    const handleResetSingleColor = useCallback((token: QtColorToken) => {
        setEditColors((prev) => {
            const next = { ...prev };
            delete next[token];
            return next;
        });
    }, []);

    const handleSelectTheme = useCallback((themeItem: CustomTheme) => {
        setActiveThemeId(themeItem.id);
        setEditColors(themeItem.colors);
        setEditWaveform(themeItem.waveformColors);
        setEditThemeName(themeItem.name);
    }, []);

    const handleDeleteTheme = useCallback((id: string) => {
        const updated = customThemes.filter((t) => t.id !== id);
        setCustomThemes(updated);
        saveCustomThemes(updated);
        if (activeThemeId === id) {
            setActiveThemeId(null);
            setEditColors({});
            setEditWaveform(undefined);
            setEditThemeName("");
        }
    }, [customThemes, activeThemeId]);

    const handleExportTheme = useCallback(() => {
        const themeData: CustomTheme = {
            id: activeThemeId ?? crypto.randomUUID(),
            name: editThemeName || "Custom Theme",
            base: theme.mode,
            colors: editColors,
            waveformColors: editWaveform,
        };
        const json = exportThemeAsJson(themeData);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${themeData.name.replace(/\s+/g, "_")}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }, [activeThemeId, editThemeName, theme.mode, editColors, editWaveform]);

    const handleImportTheme = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const result = importThemeFromJson(reader.result as string);
            if (result) {
                const updated = [...customThemes, result];
                setCustomThemes(updated);
                saveCustomThemes(updated);
                handleSelectTheme(result);
            }
        };
        reader.readAsText(file);
        e.target.value = "";
    }, [customThemes, handleSelectTheme]);

    const updateColorToken = useCallback((token: QtColorToken, value: string) => {
        setEditColors((prev) => ({ ...prev, [token]: value }));
    }, []);

    const hasCustomColors = Object.keys(editColors).length > 0;

    /* ─────────── 字体过滤结果（缓存） ─────────── */
    const filteredFonts = useMemo(() => {
        if (!fontSearch) return systemFonts.fonts;
        const q = fontSearch.toLowerCase();
        return systemFonts.fonts.filter((f) => f.toLowerCase().includes(q));
    }, [systemFonts.fonts, fontSearch]);

    /* ─────────── Tab 配置 ─────────── */
    const TABS: { id: SettingsTab; labelKey: string; icon: string }[] = [
        { id: "basic", labelKey: "appearance_tab_basic", icon: "🎨" },
        { id: "font", labelKey: "appearance_tab_font", icon: "𝐀" },
        { id: "colors", labelKey: "appearance_tab_colors", icon: "🖌" },
    ];

    /** 深色/浅色自适应：选中色块的边框和 ring */
    const isDark = theme.mode === "dark";
    const selectedBorderClass = isDark ? "border-white" : "border-gray-800";
    const selectedRingClass = isDark ? "ring-white/30" : "ring-gray-800/30";

    /* ─────────── 渲染 ─────────── */
    return (
        <Dialog.Root open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
            <Dialog.Content
                maxWidth="760px"
                className="!p-0 !overflow-hidden"
            >
                <Dialog.Title className="px-5 pt-4 pb-2 text-base font-semibold">
                    {tAny("appearance_title")}
                </Dialog.Title>

                {/* ═══════ 主体：左 Tab 栏 + 右内容 ═══════ */}
                <div className="flex" style={{ minHeight: "460px" }}>
                    {/* 左侧 Tab 导航 */}
                    <nav className="w-[130px] shrink-0 border-r border-qt-border bg-qt-panel/50 py-1">
                        {TABS.map((tab) => (
                            <button
                                key={tab.id}
                                className={`w-full text-left px-4 py-2.5 text-xs transition-colors flex items-center gap-2 ${
                                    activeTab === tab.id
                                        ? "bg-qt-highlight/15 text-qt-highlight border-r-2 border-qt-highlight font-medium"
                                        : "text-qt-text-muted hover:text-qt-text hover:bg-qt-button-hover"
                                }`}
                                onClick={() => setActiveTab(tab.id)}
                            >
                                <span className="text-sm">{tab.icon}</span>
                                {tAny(tab.labelKey)}
                            </button>
                        ))}
                    </nav>

                    {/* 右侧内容区 */}
                    <div className="flex-1 min-w-0">
                        <ScrollArea scrollbars="vertical" style={{ height: "460px" }}>
                            <div className="p-5">

                                {/* ═══════ Tab: 基础设置 ═══════ */}
                                {activeTab === "basic" && (
                                    <div className="space-y-5">
                                        {/* 主题模式 - 大按钮切换 */}
                                        <div>
                                            <Text size="1" weight="medium" className="block mb-2 text-qt-text-muted uppercase tracking-wider">
                                                {tAny("appearance_mode")}
                                            </Text>
                                            <div className="grid grid-cols-2 gap-2">
                                                <button
                                                    className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 transition-all ${
                                                        theme.mode === "dark"
                                                            ? "border-qt-highlight bg-qt-highlight/10 text-qt-text shadow-sm"
                                                            : "border-qt-border text-qt-text-muted hover:border-qt-text-muted hover:bg-qt-button-hover"
                                                    }`}
                                                    onClick={() => theme.setMode("dark")}
                                                >
                                                    <span className="text-lg">🌙</span>
                                                    <span className="text-sm font-medium">{tAny("theme_dark")}</span>
                                                </button>
                                                <button
                                                    className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 transition-all ${
                                                        theme.mode === "light"
                                                            ? "border-qt-highlight bg-qt-highlight/10 text-qt-text shadow-sm"
                                                            : "border-qt-border text-qt-text-muted hover:border-qt-text-muted hover:bg-qt-button-hover"
                                                    }`}
                                                    onClick={() => theme.setMode("light")}
                                                >
                                                    <span className="text-lg">☀️</span>
                                                    <span className="text-sm font-medium">{tAny("theme_light")}</span>
                                                </button>
                                            </div>
                                        </div>

                                        {/* 强调色 */}
                                        <div>
                                            <Text size="1" weight="medium" className="block mb-2 text-qt-text-muted uppercase tracking-wider">
                                                {tAny("appearance_accent")}
                                            </Text>
                                            <div className="flex flex-wrap gap-1.5">
                                                {RADIX_ACCENT_COLORS.map((c) => (
                                                    <Tooltip key={c} content={c}>
                                                        <button
                                                            className={`w-7 h-7 rounded-full border-2 transition-all ${
                                                                accentColor === c
                                                                    ? `${selectedBorderClass} scale-110 shadow-lg ring-2 ${selectedRingClass}`
                                                                    : "border-transparent hover:scale-110 hover:shadow-md"
                                                            }`}
                                                            style={{ backgroundColor: RADIX_ACCENT_HEX[c] }}
                                                            onClick={() => setAccentColor(c)}
                                                        />
                                                    </Tooltip>
                                                ))}
                                            </div>
                                        </div>

                                        {/* 灰阶色系 */}
                                        <div>
                                            <Text size="1" weight="medium" className="block mb-2 text-qt-text-muted uppercase tracking-wider">
                                                {tAny("appearance_gray")}
                                            </Text>
                                            <div className="flex flex-wrap gap-2">
                                                {RADIX_GRAY_COLORS.map((c) => (
                                                    <Tooltip key={c} content={c}>
                                                        <button
                                                            className={`w-7 h-7 rounded-full border-2 transition-all ${
                                                                grayColor === c
                                                                    ? `${selectedBorderClass} scale-110 shadow-lg ring-2 ${selectedRingClass}`
                                                                    : "border-transparent hover:scale-110 hover:shadow-md"
                                                            }`}
                                                            style={{ backgroundColor: RADIX_GRAY_HEX[c] }}
                                                            onClick={() => setGrayColor(c)}
                                                        />
                                                    </Tooltip>
                                                ))}
                                            </div>
                                        </div>

                                        {/* 圆角风格 */}
                                        <div>
                                            <Text size="1" weight="medium" className="block mb-2 text-qt-text-muted uppercase tracking-wider">
                                                {tAny("appearance_radius")}
                                            </Text>
                                            <div className="flex gap-1.5">
                                                {RADIX_RADIUS_OPTIONS.map((r) => (
                                                    <button
                                                        key={r}
                                                        className={`flex-1 py-2 text-xs rounded-md border-2 transition-all ${
                                                            radius === r
                                                                ? "border-qt-highlight bg-qt-highlight/10 text-qt-text font-medium"
                                                                : "border-qt-border text-qt-text-muted hover:border-qt-text-muted hover:bg-qt-button-hover"
                                                        }`}
                                                        onClick={() => setRadius(r)}
                                                    >
                                                        {r}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>

                                        {/* 快捷颜色调整 */}
                                        <div>
                                            <Text size="1" weight="medium" className="block mb-2 text-qt-text-muted uppercase tracking-wider">
                                                {tAny("appearance_quick_colors")}
                                            </Text>
                                            <div className="space-y-1.5 border border-qt-border rounded p-3 bg-qt-base/30">
                                                {QUICK_COLOR_TOKENS.map((token) => (
                                                    <div key={token} className="flex items-center gap-1">
                                                        <div className="flex-1">
                                                            <ColorPickerField
                                                                label={tAny(QT_COLOR_TOKEN_LABELS[token])}
                                                                value={getDisplayColor(token)}
                                                                onChange={(v) => updateColorToken(token, v)}
                                                            />
                                                        </div>
                                                        {editColors[token] && (
                                                            <button
                                                                className="text-[10px] text-qt-text-muted hover:text-qt-danger-text transition-colors px-1 shrink-0"
                                                                onClick={() => handleResetSingleColor(token)}
                                                                title={tAny("appearance_reset")}
                                                            >
                                                                ↺
                                                            </button>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                            <Text size="1" className="block mt-1.5 text-qt-text-muted opacity-70 italic">
                                                {tAny("appearance_quick_colors_hint")}
                                            </Text>
                                        </div>
                                    </div>
                                )}

                                {/* ═══════ Tab: 字体设置 ═══════ */}
                                {activeTab === "font" && (
                                    <div className="space-y-4">
                                        {/* 当前字体 + 手动输入 */}
                                        <div>
                                            <Text size="1" weight="medium" className="block mb-2 text-qt-text-muted uppercase tracking-wider">
                                                {tAny("appearance_font")}
                                            </Text>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="text"
                                                    value={fontFamily}
                                                    onChange={(e: ChangeEvent<HTMLInputElement>) => setFontFamily(e.target.value)}
                                                    className="flex-1 px-3 py-2 text-xs rounded-md border border-qt-border bg-qt-base text-qt-text font-mono focus:border-qt-highlight focus:outline-none transition-colors"
                                                    placeholder={DEFAULT_FONT_FAMILY}
                                                    spellCheck={false}
                                                />
                                                <button
                                                    className="px-3 py-2 text-xs rounded-md border border-qt-border bg-qt-button text-qt-text hover:bg-qt-button-hover transition-colors shrink-0"
                                                    onClick={() => setFontFamily(DEFAULT_FONT_FAMILY)}
                                                >
                                                    {tAny("appearance_reset")}
                                                </button>
                                            </div>
                                        </div>

                                        {/* 字体预览 */}
                                        <div className="px-4 py-3 rounded-lg border border-qt-border bg-qt-base text-qt-text" style={{ fontFamily }}>
                                            <div className="text-sm mb-1">The quick brown fox jumps over the lazy dog.</div>
                                            <div className="text-sm mb-1">中文字体预览：你好世界</div>
                                            <div className="text-xs text-qt-text-muted">0123456789 ABCDEFG abcdefg !@#$%</div>
                                        </div>

                                        {/* 系统字体选择 */}
                                        <div>
                                            <Text size="1" weight="medium" className="block mb-2 text-qt-text-muted uppercase tracking-wider">
                                                {tAny("appearance_font_system")}
                                                {systemFonts.fonts.length > 0 && (
                                                    <span className="ml-2 font-normal normal-case">
                                                        ({systemFonts.fonts.length})
                                                    </span>
                                                )}
                                            </Text>

                                            {/* 加载中 / 不支持 */}
                                            {systemFonts.fonts.length === 0 && (
                                                <div className="text-xs text-qt-text-muted py-2">
                                                    {systemFonts.loading
                                                        ? tAny("appearance_font_detecting")
                                                        : !systemFonts.supported
                                                            ? tAny("appearance_font_not_supported")
                                                            : tAny("appearance_font_detecting")}
                                                </div>
                                            )}

                                            {/* 搜索框 + 字体列表（始终展开） */}
                                            {systemFonts.fonts.length > 0 && (
                                                <>
                                                    <div className="relative mb-2">
                                                        <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-qt-text-muted" />
                                                        <input
                                                            type="text"
                                                            value={fontSearch}
                                                            onChange={(e: ChangeEvent<HTMLInputElement>) => setFontSearch(e.target.value)}
                                                            className="w-full pl-8 pr-8 py-2 text-xs rounded-md border border-qt-border bg-qt-base text-qt-text focus:border-qt-highlight focus:outline-none transition-colors"
                                                            placeholder={tAny("appearance_font_search_placeholder")}
                                                            spellCheck={false}
                                                        />
                                                        {fontSearch && (
                                                            <button
                                                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-qt-text-muted hover:text-qt-text transition-colors"
                                                                onClick={() => setFontSearch("")}
                                                            >
                                                                ✕
                                                            </button>
                                                        )}
                                                    </div>

                                                    {/* 字体列表 */}
                                                    <div className="max-h-[220px] overflow-y-auto rounded-md border border-qt-border bg-qt-base custom-scrollbar">
                                                        {filteredFonts.length > 0 ? (
                                                            filteredFonts.map((f) => (
                                                                <button
                                                                    key={f}
                                                                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors border-b border-qt-border/30 last:border-b-0 ${
                                                                        fontFamily === f
                                                                            ? "bg-qt-highlight/20 text-qt-highlight font-medium"
                                                                            : "text-qt-text hover:bg-qt-highlight/10"
                                                                    }`}
                                                                    style={{ fontFamily: f }}
                                                                    onClick={() => {
                                                                        setFontFamily(f);
                                                                        setFontSearch("");
                                                                    }}
                                                                >
                                                                    {f}
                                                                </button>
                                                            ))
                                                        ) : (
                                                            <div className="px-3 py-4 text-xs text-qt-text-muted italic text-center">
                                                                {tAny("appearance_font_no_results")}
                                                            </div>
                                                        )}
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* ═══════ Tab: 颜色设置 ═══════ */}
                                {activeTab === "colors" && (
                                    <div className="space-y-4">
                                        {/* 主题管理操作栏 */}
                                        <div>
                                            <Text size="1" weight="medium" className="block mb-2 text-qt-text-muted uppercase tracking-wider">
                                                {tAny("appearance_theme_management")}
                                            </Text>
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <button
                                                    className="px-3 py-1.5 text-xs rounded-md border border-qt-border bg-qt-button text-qt-text hover:bg-qt-button-hover transition-colors"
                                                    onClick={() => fileInputRef.current?.click()}
                                                >
                                                    {tAny("appearance_import_theme")}
                                                </button>
                                                <input
                                                    ref={fileInputRef}
                                                    type="file"
                                                    accept=".json"
                                                    className="hidden"
                                                    onChange={handleImportTheme}
                                                />
                                                {hasCustomColors && (
                                                    <>
                                                        <button
                                                            className="px-3 py-1.5 text-xs rounded-md border border-qt-border bg-qt-button text-qt-text hover:bg-qt-button-hover transition-colors"
                                                            onClick={handleExportTheme}
                                                        >
                                                            {tAny("appearance_export_theme")}
                                                        </button>
                                                        <div className="flex-1" />
                                                        <button
                                                            className="px-3 py-1.5 text-xs rounded-md border border-qt-danger-border text-qt-danger-text hover:bg-qt-danger-bg transition-colors"
                                                            onClick={handleResetColors}
                                                        >
                                                            {tAny("appearance_reset_all_colors")}
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </div>

                                        {/* 已保存的主题列表 */}
                                        {customThemes.length > 0 && (
                                            <div>
                                                <Text size="1" weight="medium" className="block mb-1.5 text-qt-text-muted uppercase tracking-wider">
                                                    {tAny("appearance_saved_themes")}
                                                </Text>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {customThemes.map((ct) => (
                                                        <div
                                                            key={ct.id}
                                                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border cursor-pointer transition-all ${
                                                                activeThemeId === ct.id
                                                                    ? "bg-qt-highlight/15 text-qt-highlight border-qt-highlight font-medium"
                                                                    : "bg-qt-button text-qt-text border-qt-border hover:bg-qt-button-hover"
                                                            }`}
                                                        >
                                                            <span onClick={() => handleSelectTheme(ct)}>
                                                                {ct.name}
                                                            </span>
                                                            <button
                                                                className="ml-1 text-[10px] opacity-50 hover:opacity-100 transition-opacity"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleDeleteTheme(ct.id);
                                                                }}
                                                            >
                                                                ✕
                                                            </button>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {/* 主题名称（有自定义颜色时） */}
                                        {hasCustomColors && (
                                            <div className="flex items-center gap-2">
                                                <Text size="1" className="text-qt-text-muted shrink-0">
                                                    {tAny("appearance_theme_name")}
                                                </Text>
                                                <input
                                                    type="text"
                                                    value={editThemeName}
                                                    onChange={(e) => setEditThemeName(e.target.value)}
                                                    className="flex-1 px-3 py-1.5 text-xs rounded-md border border-qt-border bg-qt-base text-qt-text focus:border-qt-highlight focus:outline-none transition-colors"
                                                    placeholder={tAny("appearance_custom_theme")}
                                                />
                                            </div>
                                        )}

                                        {/* 所有颜色分组 - 直接展示 */}
                                        <div className="space-y-2">
                                            {COLOR_GROUPS.map((group, gi) => (
                                                <CollapsibleGroup
                                                    key={group.labelKey}
                                                    title={tAny(group.labelKey)}
                                                    defaultOpen={gi === 0}
                                                >
                                                    {group.tokens.map((token) => (
                                                        <div key={token} className="flex items-center gap-1">
                                                            <div className="flex-1">
                                                                <ColorPickerField
                                                                    label={tAny(QT_COLOR_TOKEN_LABELS[token])}
                                                                    value={getDisplayColor(token)}
                                                                    onChange={(v) => updateColorToken(token, v)}
                                                                />
                                                            </div>
                                                            {editColors[token] && (
                                                                <button
                                                                    className="text-[10px] text-qt-text-muted hover:text-qt-danger-text transition-colors px-1 shrink-0"
                                                                    onClick={() => handleResetSingleColor(token)}
                                                                    title={tAny("appearance_reset")}
                                                                >
                                                                    ↺
                                                                </button>
                                                            )}
                                                        </div>
                                                    ))}
                                                </CollapsibleGroup>
                                            ))}

                                            {/* 波形颜色 */}
                                            <CollapsibleGroup
                                                title={tAny("appearance_waveform_colors")}
                                            >
                                                <ColorPickerField
                                                    label={tAny("appearance_waveform_fill")}
                                                    value={editWaveform?.fill ?? (isDark ? "rgba(255,255,255,0.34)" : "rgba(60,90,130,0.22)")}
                                                    onChange={(v) =>
                                                        setEditWaveform((prev) => ({
                                                            fill: v,
                                                            stroke: prev?.stroke ?? (isDark ? "rgba(255,255,255,0.92)" : "rgba(60,90,130,0.65)"),
                                                        }))
                                                    }
                                                />
                                                <ColorPickerField
                                                    label={tAny("appearance_waveform_stroke")}
                                                    value={editWaveform?.stroke ?? (isDark ? "rgba(255,255,255,0.92)" : "rgba(60,90,130,0.65)")}
                                                    onChange={(v) =>
                                                        setEditWaveform((prev) => ({
                                                            fill: prev?.fill ?? (isDark ? "rgba(255,255,255,0.34)" : "rgba(60,90,130,0.22)"),
                                                            stroke: v,
                                                        }))
                                                    }
                                                />
                                            </CollapsibleGroup>
                                        </div>

                                        {/* 已修改颜色计数提示 */}
                                        {hasCustomColors && (
                                            <div className="flex items-center justify-between text-xs text-qt-text-muted border-t border-qt-border pt-2">
                                                <span>
                                                    {tAny("appearance_modified_count").replace("{count}", String(Object.keys(editColors).length))}
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                )}

                            </div>
                        </ScrollArea>
                    </div>
                </div>

                {/* ═══════ 底部按钮 ═══════ */}
                <Flex
                    justify="end"
                    gap="2"
                    className="px-5 py-3 border-t border-qt-border"
                >
                    <Button variant="soft" color="gray" onClick={handleClose}>
                        {tAny("close")}
                    </Button>
                    <Button onClick={handleApply}>
                        {tAny("appearance_apply")}
                    </Button>
                </Flex>
            </Dialog.Content>
        </Dialog.Root>
    );
};
