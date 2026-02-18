import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { useAppDispatch, useAppSelector } from "../../app/hooks";
import {
    addTrackRemote,
    exportAudio,
    importAudioFromDialog,
    pickOutputPath,
    removeTrackRemote,
} from "../../features/session/sessionSlice";
import { webApi } from "../../services/webviewApi";

type TopMenu = "file" | "edit" | "view" | "track" | "help";

export function MenuBar() {
    const dispatch = useAppDispatch();
    const { busy, outputPath, selectedTrackId } = useAppSelector((state) => state.session);
    const { locale, setLocale, t } = useI18n();
    const menus = useMemo(
        () => [
            { key: "file" as TopMenu, label: t("menu_file") },
            { key: "edit" as TopMenu, label: t("menu_edit") },
            { key: "view" as TopMenu, label: t("menu_view") },
            { key: "track" as TopMenu, label: t("menu_track") },
            { key: "help" as TopMenu, label: t("menu_help") },
        ],
        [t],
    );
    const [openMenu, setOpenMenu] = useState<TopMenu | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const onClickOutside = (event: MouseEvent) => {
            if (!menuRef.current) return;
            if (!menuRef.current.contains(event.target as Node)) {
                setOpenMenu(null);
            }
        };
        window.addEventListener("mousedown", onClickOutside);
        return () => {
            window.removeEventListener("mousedown", onClickOutside);
        };
    }, []);

    useEffect(() => {
        const isEditable = (target: EventTarget | null): boolean => {
            const element = target as HTMLElement | null;
            if (!element) return false;
            const tagName = element.tagName.toLowerCase();
            return (
                tagName === "input" ||
                tagName === "textarea" ||
                tagName === "select" ||
                element.isContentEditable
            );
        };

        const onKeyDown = (event: KeyboardEvent) => {
            if (!event.ctrlKey || isEditable(event.target)) {
                return;
            }

            const key = event.key.toLowerCase();
            if (key === "o") {
                event.preventDefault();
                if (!busy) {
                    void dispatch(importAudioFromDialog());
                }
                return;
            }

            if (key === "e") {
                event.preventDefault();
                if (!busy) {
                    void dispatch(exportAudio(outputPath));
                }
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [busy, dispatch, outputPath]);

    return (
        <div
            ref={menuRef}
            className="relative flex h-8 items-center gap-1 border-b border-zinc-700 bg-zinc-800 px-2"
        >
            <div className="mr-2 text-xs font-semibold tracking-wide text-zinc-200">
                HiFiShifter
            </div>

            {menus.map((menu) => {
                const isOpen = openMenu === menu.key;
                const topItemClass = `rounded px-2 py-1 text-xs transition ${
                    isOpen
                        ? "bg-zinc-700 text-zinc-100"
                        : "text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
                }`;
                return (
                    <div key={menu.key} className="relative">
                        <button
                            className={topItemClass}
                            type="button"
                            onClick={() =>
                                setOpenMenu((prev) =>
                                    prev === menu.key ? null : menu.key,
                                )
                            }
                        >
                            {menu.label}
                        </button>

                        {menu.key === "file" && isOpen && (
                            <div className="absolute left-0 top-7 z-50 min-w-48 rounded border border-zinc-600 bg-zinc-800 p-1 shadow-lg">
                                <button
                                    type="button"
                                    className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                                    disabled={busy}
                                    onClick={() => {
                                        setOpenMenu(null);
                                        void dispatch(importAudioFromDialog());
                                    }}
                                >
                                    <span>{t("menu_import_audio")}</span>
                                    <span className="text-zinc-500">
                                        {t("shortcut_ctrl_o")}
                                    </span>
                                </button>

                                <button
                                    type="button"
                                    className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                                    disabled={busy}
                                    onClick={() => {
                                        setOpenMenu(null);
                                        void dispatch(exportAudio(outputPath));
                                    }}
                                >
                                    <span>{t("menu_export_audio")}</span>
                                    <span className="text-zinc-500">
                                        {t("shortcut_ctrl_e")}
                                    </span>
                                </button>

                                <button
                                    type="button"
                                    className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                                    disabled={busy}
                                    onClick={() => {
                                        setOpenMenu(null);
                                        void dispatch(pickOutputPath());
                                    }}
                                >
                                    <span>{t("menu_pick_output")}</span>
                                </button>

                                <div className="my-1 h-px bg-zinc-600" />

                                <button
                                    type="button"
                                    className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs text-zinc-200 hover:bg-zinc-700"
                                    onClick={() => {
                                        setOpenMenu(null);
                                        void webApi.closeWindow();
                                    }}
                                >
                                    <span>{t("menu_exit")}</span>
                                </button>
                            </div>
                        )}

                        {menu.key === "track" && isOpen && (
                            <div className="absolute left-0 top-7 z-50 min-w-48 rounded border border-zinc-600 bg-zinc-800 p-1 shadow-lg">
                                <button
                                    type="button"
                                    className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                                    disabled={busy}
                                    onClick={() => {
                                        setOpenMenu(null);
                                        void dispatch(addTrackRemote({}));
                                    }}
                                >
                                    <span>Add Track</span>
                                </button>
                                <button
                                    type="button"
                                    className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                                    disabled={busy || !selectedTrackId}
                                    onClick={() => {
                                        setOpenMenu(null);
                                        if (selectedTrackId) {
                                            void dispatch(
                                                removeTrackRemote(selectedTrackId),
                                            );
                                        }
                                    }}
                                >
                                    <span>Remove Selected Track</span>
                                </button>
                            </div>
                        )}
                    </div>
                );
            })}

            <div className="ml-auto flex items-center gap-2">
                <span className="text-[11px] text-zinc-400">
                    {t("language")}
                </span>
                <select
                    className="rounded border border-zinc-600 bg-zinc-700 px-2 py-0.5 text-xs text-zinc-200"
                    value={locale}
                    onChange={(event) =>
                        setLocale(event.target.value as "en-US" | "zh-CN")
                    }
                >
                    <option value="en-US">{t("lang_en")}</option>
                    <option value="zh-CN">{t("lang_zh")}</option>
                </select>
            </div>
        </div>
    );
}
