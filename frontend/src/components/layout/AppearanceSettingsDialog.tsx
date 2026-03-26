/**
 * 外观设置对话框
 *
 * 提供完整的主题配置界面，左侧 Tab 导航分为两个区域：
 * - 主题设置（主题模式、强调色、圆角、主题管理、颜色编辑、波形颜色）
 * - 字体设置（手动输入 + 系统字体自动检测 + 搜索选择）
 *
 * 支持导出当前完整主题（含通用设置 + 颜色覆盖），
 * 无论是否有自定义颜色都可导出当前配置。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Dialog, Flex, Button, Text, ScrollArea, Tooltip } from "@radix-ui/themes";
import { MagnifyingGlassIcon } from "@radix-ui/react-icons";
import { useI18n } from "../../i18n/I18nProvider";
import { useAppTheme } from "../../theme/AppThemeProvider";
import {
    RADIX_ACCENT_COLORS,
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

/** 强调色 → 推荐灰阶自动映射 */
const ACCENT_TO_GRAY: Partial<Record<RadixAccentColor, RadixGrayColor>> = {
    crimson: "mauve", pink: "mauve", plum: "mauve", purple: "mauve", violet: "mauve",
    iris: "mauve", ruby: "mauve",
    indigo: "slate", blue: "slate", sky: "slate", cyan: "slate",
    teal: "sage", jade: "sage", mint: "sage", green: "sage",
    grass: "olive", lime: "olive",
    gold: "sand", bronze: "sand", brown: "sand", orange: "sand", amber: "sand",
    yellow: "sand", tomato: "mauve", red: "mauve",
};

function getAutoGray(accent: RadixAccentColor): RadixGrayColor {
    return ACCENT_TO_GRAY[accent] ?? "auto";
}

/* ─────────── Tab 类型 ─────────── */
type SettingsTab = "theme" | "font";

/* ─────────── 颜色分组定义 ─────────── */
interface ColorGroup {
    labelKey: string;
    tokens: QtColorToken[];
    icon: string;
}

const COLOR_GROUPS: ColorGroup[] = [
    {
        labelKey: "appearance_color_group_base",
        tokens: ["qt-window", "qt-base", "qt-panel", "qt-surface"],
        icon: "◻",
    },
    {
        labelKey: "appearance_color_group_text",
        tokens: ["qt-text", "qt-text-muted"],
        icon: "T",
    },
    {
        labelKey: "appearance_color_group_ui",
        tokens: ["qt-highlight", "qt-playhead", "qt-button", "qt-button-hover", "qt-border"],
        icon: "◈",
    },
    {
        labelKey: "appearance_color_group_danger",
        tokens: ["qt-danger-bg", "qt-danger-text", "qt-danger-border"],
        icon: "⚠",
    },
    {
        labelKey: "appearance_color_group_warning",
        tokens: ["qt-warning-bg", "qt-warning-text", "qt-warning-border"],
        icon: "△",
    },
    {
        labelKey: "appearance_color_group_graph",
        tokens: ["qt-graph-bg", "qt-graph-grid-strong", "qt-graph-grid-weak"],
        icon: "▦",
    },
    {
        labelKey: "appearance_color_group_scrollbar",
        tokens: ["qt-scrollbar-thumb", "qt-scrollbar-thumb-hover"],
        icon: "▮",
    },
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
const CollapsibleColorGroup: React.FC<{
    title: string;
    icon: string;
    defaultOpen?: boolean;
    modifiedCount?: number;
    children: React.ReactNode;
}> = ({ title, icon, defaultOpen = false, modifiedCount = 0, children }) => {
    const [isOpen, setIsOpen] = useState(defaultOpen);

    return (
        <div className="rounded-md overflow-hidden">
            <button
                className="w-full flex items-center gap-2 px-2.5 py-2 text-xs font-medium text-qt-text hover:bg-qt-subtle-hover transition-colors"
                onClick={() => setIsOpen(!isOpen)}
            >
                <span className={`transition-transform duration-200 text-[10px] leading-none text-qt-text-muted/50 ${isOpen ? "rotate-90" : ""}`}>▶</span>
                <span className="text-qt-text-muted/50 text-[11px]">{icon}</span>
                <span className="flex-1 text-left">{title}</span>
                {modifiedCount > 0 && (
                    <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-qt-highlight/10 text-qt-highlight font-medium">
                        {modifiedCount}
                    </span>
                )}
            </button>
            {isOpen && (
                <div className="px-1 pb-2 pt-1">
                    {children}
                </div>
            )}
        </div>
    );
};

/* ─────────── 设置卡片包装 ─────────── */
const SettingsCard: React.FC<{
    children: React.ReactNode;
    className?: string;
}> = ({ children, className = "" }) => (
    <div className={`rounded-lg bg-qt-subtle-1 p-4 ${className}`}>
        {children}
    </div>
);

/* ─────────── 区段标题 ─────────── */
const SectionLabel: React.FC<{
    children: React.ReactNode;
}> = ({ children }) => (
    <Text size="1" weight="medium" className="block mb-2.5 text-qt-text-muted text-[11px] uppercase tracking-wider">
        {children}
    </Text>
);

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
    const [activeTab, setActiveTab] = useState<SettingsTab>("theme");

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
    const prevOpenRef = useRef(false);
    useEffect(() => {
        // 只在 open 由 false→true（对话框刚打开）时同步一次，
        // 避免预览期间 theme.* 变化反复触发重置 editColors 导致屏幕全黑
        const justOpened = open && !prevOpenRef.current;
        prevOpenRef.current = open;
        if (!justOpened) return;

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

        // 自动检测系统字体
        systemFonts.detect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    /* ─────────── 强调色变更时自动更新灰阶色 ─────────── */
    useEffect(() => {
        setGrayColor(getAutoGray(accentColor));
    }, [accentColor]);

    /* ─────────── 内置颜色 ─────────── */
    const builtinColors = useMemo(
        () => getBuiltinThemeColors(theme.mode),
        [theme.mode],
    );

    /** 获取某个 token 的显示颜色 */
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
                accentColor,
                grayColor,
                radius,
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
        // 恢复通用设置（如果主题中保存了）
        if (themeItem.accentColor) setAccentColor(themeItem.accentColor);
        if (themeItem.grayColor) setGrayColor(themeItem.grayColor);
        if (themeItem.radius) setRadius(themeItem.radius);
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

    /** 导出当前主题（无论是否有自定义颜色，都导出完整配置） */
    const handleExportTheme = useCallback(() => {
        const themeData: CustomTheme = {
            id: activeThemeId ?? crypto.randomUUID(),
            name: editThemeName || `${theme.mode === "dark" ? "Dark" : "Light"} Theme`,
            base: theme.mode,
            colors: editColors,
            waveformColors: editWaveform,
            accentColor,
            grayColor,
            radius,
        };
        const json = exportThemeAsJson(themeData, { accentColor, grayColor, radius });
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${themeData.name.replace(/\s+/g, "_")}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }, [activeThemeId, editThemeName, theme.mode, editColors, editWaveform, accentColor, grayColor, radius]);

    const handleImportTheme = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const result = importThemeFromJson(reader.result as string);
            if (result) {
                const updated = [...customThemes, result.theme];
                setCustomThemes(updated);
                saveCustomThemes(updated);
                // 选中导入的主题
                setActiveThemeId(result.theme.id);
                setEditColors(result.theme.colors);
                setEditWaveform(result.theme.waveformColors);
                setEditThemeName(result.theme.name);
                // 恢复通用设置
                if (result.accentColor) setAccentColor(result.accentColor);
                if (result.grayColor) setGrayColor(result.grayColor);
                if (result.radius) setRadius(result.radius);
            }
        };
        reader.readAsText(file);
        e.target.value = "";
    }, [customThemes]);

    const updateColorToken = useCallback((token: QtColorToken, value: string) => {
        setEditColors((prev) => ({ ...prev, [token]: value }));
    }, []);

    const modifiedColorCount = Object.keys(editColors).length;
    const hasCustomColors = modifiedColorCount > 0;

    /* ─────────── 字体过滤 ─────────── */
    const filteredFonts = useMemo(() => {
        if (!fontSearch) return systemFonts.fonts;
        const q = fontSearch.toLowerCase();
        return systemFonts.fonts.filter((f) => f.toLowerCase().includes(q));
    }, [systemFonts.fonts, fontSearch]);

    /* ─────────── Tab 配置 ─────────── */
    const TABS: { id: SettingsTab; labelKey: string; icon: string }[] = [
        { id: "theme", labelKey: "appearance_tab_theme", icon: "🎨" },
        { id: "font", labelKey: "appearance_tab_font", icon: "𝐀" },
    ];

    const isDark = theme.mode === "dark";

    /* ─────────── 渲染 ─────────── */
    return (
        <Dialog.Root open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
            <Dialog.Content
                maxWidth="780px"
                className="!p-0 !overflow-hidden"
                style={{ borderRadius: "12px" }}
            >
                {/* ═══════ 标题栏 ═══════ */}
                <div className="flex items-center justify-between px-5 pt-4 pb-3">
                    <Dialog.Title className="text-base font-semibold m-0">
                        {tAny("appearance_title")}
                    </Dialog.Title>
                    {modifiedColorCount > 0 && (
                        <span className="text-[11px] text-qt-highlight bg-qt-highlight/10 px-2.5 py-1 rounded-full font-medium">
                            {tAny("appearance_modified_count").replace("{count}", String(modifiedColorCount))}
                        </span>
                    )}
                </div>

                {/* ═══════ 主体：左 Tab 栏 + 右内容 ═══════ */}
                <div className="flex" style={{ minHeight: "480px" }}>
                    {/* 左侧 Tab 导航 */}
                    <nav className="w-[120px] shrink-0 py-2 flex flex-col gap-0.5">
                        {TABS.map((tab) => (
                            <button
                                key={tab.id}
                                className={`mx-1.5 rounded-md text-left px-3 py-2.5 text-xs transition-colors duration-150 flex items-center gap-2 ${
                                    activeTab === tab.id
                                        ? "text-white font-medium"
                                        : "text-qt-text-muted hover:text-qt-text"
                                }`}
                                style={{
                                    backgroundColor: activeTab === tab.id
                                        ? "var(--qt-highlight)"
                                        : "rgba(255,255,255,0.06)",
                                }}
                                onClick={() => setActiveTab(tab.id)}
                            >
                                <span className="text-sm w-4 text-center">{tab.icon}</span>
                                <span>{tAny(tab.labelKey)}</span>
                            </button>
                        ))}
                    </nav>

                    {/* 右侧内容区 */}
                    <div className="flex-1 min-w-0">
                        <ScrollArea scrollbars="vertical" style={{ height: "480px" }}>
                            <div className="p-5 space-y-1">

                                {/* ═══════ Tab: 主题设置（合并原基础+颜色） ═══════ */}
                                {activeTab === "theme" && (
                                    <div className="space-y-5">

                                        {/* ── 主题管理工具栏 ── */}
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <button
                                                className="px-3 py-1.5 text-xs rounded-md bg-qt-subtle-2 text-qt-text hover:bg-qt-subtle-3 transition-colors"
                                                onClick={() => fileInputRef.current?.click()}
                                            >
                                                📥 {tAny("appearance_import_theme")}
                                            </button>
                                            <input
                                                ref={fileInputRef}
                                                type="file"
                                                accept=".json"
                                                className="hidden"
                                                onChange={handleImportTheme}
                                            />
                                            <button
                                                className="px-3 py-1.5 text-xs rounded-md bg-qt-subtle-2 text-qt-text hover:bg-qt-subtle-3 transition-colors"
                                                onClick={handleExportTheme}
                                            >
                                                📤 {tAny("appearance_export_theme")}
                                            </button>
                                            {hasCustomColors && (
                                                <>
                                                    <div className="flex-1" />
                                                    <button
                                                        className="px-3 py-1.5 text-xs rounded-md text-qt-danger-text hover:bg-qt-danger-bg/20 transition-colors"
                                                        onClick={handleResetColors}
                                                    >
                                                        {tAny("appearance_reset_all_colors")}
                                                    </button>
                                                </>
                                            )}
                                        </div>

                                        {/* ── 已保存主题列表 ── */}
                                        {customThemes.length > 0 && (
                                            <SettingsCard className="!p-3">
                                                <Text size="1" className="block mb-2 text-qt-text-muted/50 text-[10px] uppercase tracking-wider">
                                                    {tAny("appearance_saved_themes")}
                                                </Text>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {customThemes.map((ct) => (
                                                        <div
                                                            key={ct.id}
                                                            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md cursor-pointer transition-all ${
                                                                activeThemeId === ct.id
                                                                    ? "bg-qt-highlight/12 text-qt-highlight font-medium"
                                                                    : "bg-qt-subtle-2 text-qt-text hover:bg-qt-subtle-3"
                                                            }`}
                                                        >
                                                            <span onClick={() => handleSelectTheme(ct)}>
                                                                {ct.name}
                                                            </span>
                                                            <button
                                                                className="ml-1 text-[10px] opacity-30 hover:opacity-100 hover:text-qt-danger-text transition-all"
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
                                            </SettingsCard>
                                        )}

                                        {/* ── 主题名称（有自定义颜色时显示） ── */}
                                        {hasCustomColors && (
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs text-qt-text-muted/60 shrink-0">
                                                    {tAny("appearance_theme_name")}
                                                </span>
                                                <input
                                                    type="text"
                                                    value={editThemeName}
                                                    onChange={(e) => setEditThemeName(e.target.value)}
                                                    className="flex-1 px-3 py-1.5 text-xs rounded-md bg-qt-subtle-2 text-qt-text focus:bg-qt-subtle-3 focus:outline-none focus:ring-1 focus:ring-qt-highlight/30 transition-all"
                                                    placeholder={tAny("appearance_custom_theme")}
                                                />
                                            </div>
                                        )}

                                        {/* ── 通用设置区域 ── */}

                                        {/* 主题模式 */}
                                        <SettingsCard>
                                            <SectionLabel>{tAny("appearance_mode")}</SectionLabel>
                                            <div className="grid grid-cols-2 gap-3">
                                                <button
                                                    className="group flex flex-col items-center gap-2 px-4 py-4 rounded-xl transition-colors duration-150"
                                                    style={{
                                                        backgroundColor: theme.mode === "dark"
                                                            ? "rgba(59,130,246,0.25)"
                                                            : "rgba(255,255,255,0.06)",
                                                    }}
                                                    onClick={() => theme.setMode("dark")}
                                                >
                                                    {/* 深色预览缩略图 */}
                                                    <div
                                                        className="w-full h-14 rounded-lg bg-[#2d2d2d] flex items-center justify-center overflow-hidden relative"
                                                        style={theme.mode === "dark" ? { outline: "2px solid var(--qt-highlight)", outlineOffset: "-2px" } : undefined}
                                                    >
                                                        <div className="absolute inset-x-0 top-0 h-4 bg-[#353535]" />
                                                        <div className="absolute bottom-1.5 left-2 right-2 flex gap-1">
                                                            <div className="h-2 flex-1 rounded-sm bg-[#3b82f6]/40" />
                                                            <div className="h-2 flex-1 rounded-sm bg-[#404040]" />
                                                        </div>
                                                    </div>
                                                    <span
                                                        className="text-xs font-medium"
                                                        style={{ color: theme.mode === "dark" ? "var(--qt-highlight)" : "var(--qt-text-muted)" }}
                                                    >
                                                        {tAny("theme_dark")}
                                                    </span>
                                                </button>
                                                <button
                                                    className="group flex flex-col items-center gap-2 px-4 py-4 rounded-xl transition-colors duration-150"
                                                    style={{
                                                        backgroundColor: theme.mode === "light"
                                                            ? "rgba(59,130,246,0.25)"
                                                            : "rgba(255,255,255,0.06)",
                                                    }}
                                                    onClick={() => theme.setMode("light")}
                                                >
                                                    {/* 浅色预览缩略图 */}
                                                    <div
                                                        className="w-full h-14 rounded-lg bg-[#f0f0f0] flex items-center justify-center overflow-hidden relative"
                                                        style={theme.mode === "light" ? { outline: "2px solid var(--qt-highlight)", outlineOffset: "-2px" } : undefined}
                                                    >
                                                        <div className="absolute inset-x-0 top-0 h-4 bg-white" />
                                                        <div className="absolute bottom-1.5 left-2 right-2 flex gap-1">
                                                            <div className="h-2 flex-1 rounded-sm bg-[#5b5bd6]/30" />
                                                            <div className="h-2 flex-1 rounded-sm bg-[#d9d9e0]" />
                                                        </div>
                                                    </div>
                                                    <span
                                                        className="text-xs font-medium"
                                                        style={{ color: theme.mode === "light" ? "var(--qt-highlight)" : "var(--qt-text-muted)" }}
                                                    >
                                                        {tAny("theme_light")}
                                                    </span>
                                                </button>
                                            </div>
                                        </SettingsCard>

                                        {/* 强调色 */}
                                        <SettingsCard>
                                            <SectionLabel>{tAny("appearance_accent")}</SectionLabel>
                                            <div className="flex flex-wrap gap-1">
                                                {RADIX_ACCENT_COLORS.map((c) => {
                                                    const isSelected = accentColor === c;
                                                    return (
                                                        <Tooltip key={c} content={c}>
                                                            <button
                                                                className={`w-6 h-6 rounded-md transition-all duration-150 ${
                                                                    isSelected
                                                                        ? `scale-110 shadow-lg ring-2 ${isDark ? "ring-white/80" : "ring-gray-900/70"}`
                                                                        : "hover:scale-110 hover:shadow-md"
                                                                }`}
                                                                style={{ backgroundColor: RADIX_ACCENT_HEX[c] }}
                                                                onClick={() => setAccentColor(c)}
                                                            />
                                                        </Tooltip>
                                                    );
                                                })}
                                            </div>
                                            <div className="mt-2.5 flex items-center gap-2">
                                                <div
                                                    className="w-5 h-5 rounded-md"
                                                    style={{ backgroundColor: RADIX_ACCENT_HEX[accentColor] }}
                                                />
                                                <span className="text-xs text-qt-text capitalize">{accentColor}</span>
                                                <span className="text-[10px] text-qt-text-muted ml-auto">{RADIX_ACCENT_HEX[accentColor]}</span>
                                            </div>
                                        </SettingsCard>

                                        {/* 圆角风格 */}
                                        <SettingsCard>
                                            <SectionLabel>{tAny("appearance_radius")}</SectionLabel>
                                            <div className="flex gap-2">
                                                {RADIX_RADIUS_OPTIONS.map((r) => {
                                                    const isSelected = radius === r;
                                                    // 每种圆角风格的预览
                                                    const radiusMap: Record<string, string> = {
                                                        none: "0px", small: "4px", medium: "8px", large: "12px", full: "9999px",
                                                    };
                                                    return (
                                                        <button
                                                            key={r}
                                                            className="flex-1 flex flex-col items-center gap-1.5 py-2.5 px-1 rounded-lg transition-colors duration-150"
                                                            style={{
                                                                backgroundColor: isSelected
                                                                    ? "rgba(59,130,246,0.25)"
                                                                    : "rgba(255,255,255,0.06)",
                                                            }}
                                                            onClick={() => setRadius(r)}
                                                        >
                                                            <div
                                                                className="w-8 h-6 border-2 transition-colors duration-150"
                                                                style={{
                                                                    borderRadius: radiusMap[r],
                                                                    borderColor: isSelected ? "var(--qt-highlight)" : "rgba(144,144,144,0.4)",
                                                                    backgroundColor: isSelected ? "rgba(59,130,246,0.15)" : "transparent",
                                                                }}
                                                            />
                                                            <span
                                                                className={`text-[10px] transition-colors duration-150 ${isSelected ? "font-medium" : ""}`}
                                                                style={{ color: isSelected ? "var(--qt-highlight)" : "var(--qt-text-muted)" }}
                                                            >
                                                                {r}
                                                            </span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </SettingsCard>

                                        {/* ── 颜色编辑区域 ── */}
                                        <div className="space-y-1">
                                            {COLOR_GROUPS.map((group, gi) => {
                                                const groupModifiedCount = group.tokens.filter(t => editColors[t]).length;
                                                return (
                                                    <CollapsibleColorGroup
                                                        key={group.labelKey}
                                                        title={tAny(group.labelKey)}
                                                        icon={group.icon}
                                                        defaultOpen={gi === 0}
                                                        modifiedCount={groupModifiedCount}
                                                    >
                                                        <div className="space-y-0.5">
                                                            {group.tokens.map((token) => {
                                                                const color = getDisplayColor(token);
                                                                const isModified = !!editColors[token];
                                                                return (
                                                                    <div
                                                                        key={token}
                                                                        className={`flex items-center gap-2.5 px-2 py-1.5 rounded-md transition-colors ${
                                                                            isModified ? "bg-qt-highlight/5" : "hover:bg-qt-subtle-hover"
                                                                        }`}
                                                                    >
                                                                        {/* 小色块 */}
                                                                        <label className="relative shrink-0 cursor-pointer">
                                                                            <div
                                                                                className="w-5 h-5 rounded"
                                                                                style={{ backgroundColor: /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#000" }}
                                                                            />
                                                                            <input
                                                                                type="color"
                                                                                value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#000000"}
                                                                                onChange={(e) => updateColorToken(token, e.target.value)}
                                                                                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                                                            />
                                                                        </label>

                                                                        {/* 名称 */}
                                                                        <span className="text-[11px] text-qt-text flex-1 truncate">
                                                                            {tAny(QT_COLOR_TOKEN_LABELS[token])}
                                                                        </span>

                                                                        {/* hex 值 */}
                                                                        <input
                                                                            type="text"
                                                                            value={color}
                                                                            onChange={(e) => updateColorToken(token, e.target.value)}
                                                                            className="w-[80px] px-1.5 py-0.5 text-[10px] bg-transparent text-qt-text-muted/50 font-mono text-right focus:text-qt-text focus:outline-none focus:bg-qt-subtle-hover rounded transition-all"
                                                                            spellCheck={false}
                                                                        />

                                                                        {/* 重置 */}
                                                                        {isModified ? (
                                                                            <Tooltip content={tAny("appearance_reset")}>
                                                                                <button
                                                                                    className="text-xs text-qt-text-muted/30 hover:text-qt-danger-text transition-colors shrink-0"
                                                                                    onClick={() => handleResetSingleColor(token)}
                                                                                >
                                                                                    ↺
                                                                                </button>
                                                                            </Tooltip>
                                                                        ) : (
                                                                            <span className="w-3 shrink-0" />
                                                                        )}
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    </CollapsibleColorGroup>
                                                );
                                            })}

                                            {/* 波形颜色 */}
                                            <CollapsibleColorGroup
                                                title={tAny("appearance_waveform_colors")}
                                                icon="〜"
                                                modifiedCount={editWaveform ? 2 : 0}
                                            >
                                                <div className="space-y-0.5">
                                                    {/* 波形填充 */}
                                                    <div className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-qt-subtle-hover transition-colors">
                                                        <label className="relative shrink-0 cursor-pointer">
                                                            <div
                                                                className="w-5 h-5 rounded"
                                                                style={{ backgroundColor: editWaveform?.fill ?? (isDark ? "rgba(255,255,255,0.34)" : "rgba(60,90,130,0.22)") }}
                                                            />
                                                            <input
                                                                type="color"
                                                                value={editWaveform?.fill && /^#[0-9a-fA-F]{6}$/.test(editWaveform.fill) ? editWaveform.fill : (isDark ? "#ffffff" : "#3c5a82")}
                                                                onChange={(e) =>
                                                                    setEditWaveform((prev) => ({
                                                                        fill: e.target.value,
                                                                        stroke: prev?.stroke ?? (isDark ? "rgba(255,255,255,0.92)" : "rgba(60,90,130,0.65)"),
                                                                    }))
                                                                }
                                                                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                                            />
                                                        </label>
                                                        <span className="text-[11px] text-qt-text flex-1 truncate">
                                                            {tAny("appearance_waveform_fill")}
                                                        </span>
                                                        <span className="text-[10px] text-qt-text-muted/50 font-mono">
                                                            {editWaveform?.fill ?? (isDark ? "rgba(255,255,255,0.34)" : "rgba(60,90,130,0.22)")}
                                                        </span>
                                                    </div>
                                                    {/* 波形描边 */}
                                                    <div className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-qt-subtle-hover transition-colors">
                                                        <label className="relative shrink-0 cursor-pointer">
                                                            <div
                                                                className="w-5 h-5 rounded"
                                                                style={{ backgroundColor: editWaveform?.stroke ?? (isDark ? "rgba(255,255,255,0.92)" : "rgba(60,90,130,0.65)") }}
                                                            />
                                                            <input
                                                                type="color"
                                                                value={editWaveform?.stroke && /^#[0-9a-fA-F]{6}$/.test(editWaveform.stroke) ? editWaveform.stroke : (isDark ? "#ffffff" : "#3c5a82")}
                                                                onChange={(e) =>
                                                                    setEditWaveform((prev) => ({
                                                                        fill: prev?.fill ?? (isDark ? "rgba(255,255,255,0.34)" : "rgba(60,90,130,0.22)"),
                                                                        stroke: e.target.value,
                                                                    }))
                                                                }
                                                                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                                            />
                                                        </label>
                                                        <span className="text-[11px] text-qt-text flex-1 truncate">
                                                            {tAny("appearance_waveform_stroke")}
                                                        </span>
                                                        <span className="text-[10px] text-qt-text-muted/50 font-mono">
                                                            {editWaveform?.stroke ?? (isDark ? "rgba(255,255,255,0.92)" : "rgba(60,90,130,0.65)")}
                                                        </span>
                                                    </div>
                                                </div>
                                            </CollapsibleColorGroup>
                                        </div>
                                    </div>
                                )}

                                {/* ═══════ Tab: 字体设置 ═══════ */}
                                {activeTab === "font" && (
                                    <div className="space-y-5">
                                        {/* 当前字体 + 手动输入 */}
                                        <SettingsCard>
                                            <SectionLabel>{tAny("appearance_font")}</SectionLabel>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="text"
                                                    value={fontFamily}
                                                    onChange={(e: ChangeEvent<HTMLInputElement>) => setFontFamily(e.target.value)}
                                                    className="flex-1 px-3 py-2 text-xs rounded-md bg-qt-subtle-2 text-qt-text font-mono focus:bg-qt-subtle-3 focus:outline-none focus:ring-1 focus:ring-qt-highlight/30 transition-all"
                                                    placeholder={DEFAULT_FONT_FAMILY}
                                                    spellCheck={false}
                                                />
                                                <button
                                                    className="px-3 py-2 text-xs rounded-md bg-qt-subtle-2 text-qt-text-muted hover:bg-qt-subtle-3 hover:text-qt-text transition-colors shrink-0"
                                                    onClick={() => setFontFamily(DEFAULT_FONT_FAMILY)}
                                                >
                                                    {tAny("appearance_reset")}
                                                </button>
                                            </div>

                                            {/* 字体预览 */}
                                            <div
                                                className="mt-3 px-4 py-4 rounded-md bg-qt-subtle-1 text-qt-text"
                                                style={{ fontFamily }}
                                            >
                                                <div className="text-base mb-2 leading-relaxed">The quick brown fox jumps over the lazy dog.</div>
                                                <div className="text-base mb-2 leading-relaxed">中文字体预览：你好世界 ♪ ♫</div>
                                                <div className="text-sm text-qt-text-muted">0123456789 ABCDEFG abcdefg !@#$%</div>
                                            </div>
                                        </SettingsCard>

                                        {/* 系统字体选择 */}
                                        <SettingsCard>
                                            <SectionLabel>
                                                {tAny("appearance_font_system")}
                                                {systemFonts.fonts.length > 0 && (
                                                    <span className="ml-2 font-normal normal-case text-qt-text-muted/50">
                                                        ({systemFonts.fonts.length})
                                                    </span>
                                                )}
                                            </SectionLabel>

                                            {/* 加载中 / 不支持 */}
                                            {systemFonts.fonts.length === 0 && (
                                                <div className="flex items-center gap-2 text-xs text-qt-text-muted py-3">
                                                    {systemFonts.loading ? (
                                                        <>
                                                            <span className="animate-spin inline-block w-3 h-3 border-2 border-qt-text-muted/30 border-t-qt-highlight rounded-full" />
                                                            {tAny("appearance_font_detecting")}
                                                        </>
                                                    ) : !systemFonts.supported ? (
                                                        tAny("appearance_font_not_supported")
                                                    ) : (
                                                        <>
                                                            <span className="animate-spin inline-block w-3 h-3 border-2 border-qt-text-muted/30 border-t-qt-highlight rounded-full" />
                                                            {tAny("appearance_font_detecting")}
                                                        </>
                                                    )}
                                                </div>
                                            )}

                                            {/* 搜索框 + 字体列表 */}
                                            {systemFonts.fonts.length > 0 && (
                                                <>
                                                    <div className="relative mb-2">
                                                        <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-qt-text-muted/40" />
                                                        <input
                                                            type="text"
                                                            value={fontSearch}
                                                            onChange={(e: ChangeEvent<HTMLInputElement>) => setFontSearch(e.target.value)}
                                                            className="w-full pl-8 pr-8 py-2 text-xs rounded-md bg-qt-subtle-2 text-qt-text focus:bg-qt-subtle-3 focus:outline-none focus:ring-1 focus:ring-qt-highlight/30 transition-all"
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

                                                    {/* 字体列表 — 单行：左名称 右预览 */}
                                                    <div className="max-h-[300px] overflow-y-auto rounded-md custom-scrollbar">
                                                        {filteredFonts.length > 0 ? (
                                                            filteredFonts.map((f) => {
                                                                const isActive = fontFamily === f;
                                                                return (
                                                                    <button
                                                                        key={f}
                                                                        className={`w-full text-left px-3 py-1.5 flex items-center gap-3 transition-colors rounded-sm ${
                                                                            isActive
                                                                                ? "bg-qt-highlight/12 text-qt-highlight"
                                                                                : "text-qt-text hover:bg-qt-subtle-hover"
                                                                        }`}
                                                                        onClick={() => {
                                                                            setFontFamily(f);
                                                                            setFontSearch("");
                                                                        }}
                                                                    >
                                                                        <span className={`text-xs shrink-0 w-[140px] truncate ${isActive ? "font-medium" : ""}`}>
                                                                            {f}
                                                                        </span>
                                                                        <span
                                                                            className={`text-xs truncate flex-1 ${isActive ? "text-qt-highlight/60" : "text-qt-text-muted/40"}`}
                                                                            style={{ fontFamily: f }}
                                                                        >
                                                                            AaBbCc 你好世界 123
                                                                        </span>
                                                                        {isActive && (
                                                                            <span className="text-qt-highlight text-[10px] shrink-0">✓</span>
                                                                        )}
                                                                    </button>
                                                                );
                                                            })
                                                        ) : (
                                                            <div className="px-3 py-6 text-xs text-qt-text-muted/50 italic text-center">
                                                                {tAny("appearance_font_no_results")}
                                                            </div>
                                                        )}
                                                    </div>
                                                </>
                                            )}
                                        </SettingsCard>
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
                    className="px-5 py-3"
                >
                    <Button variant="soft" color="gray" onClick={handleClose} style={{ borderRadius: "8px" }}>
                        {tAny("close")}
                    </Button>
                    <Button onClick={handleApply} style={{ borderRadius: "8px" }}>
                        {tAny("appearance_apply")}
                    </Button>
                </Flex>
            </Dialog.Content>
        </Dialog.Root>
    );
};
