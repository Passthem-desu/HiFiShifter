import React from "react";
import { Flex, DropdownMenu, Button } from "@radix-ui/themes";
import { useI18n } from "../../i18n/I18nProvider";
import { useAppDispatch, useAppSelector } from "../../app/hooks";
import type { RootState } from "../../app/store";
import {
    importAudioFromDialog,
    exportAudio,
    pickOutputPath,
    addTrackRemote,
    removeTrackRemote,
    refreshRuntime,
} from "../../features/session/sessionSlice";
import { webApi } from "../../services/webviewApi";
import { useAppTheme } from "../../theme/AppThemeProvider";

export const MenuBar: React.FC = () => {
    const { t, setLocale } = useI18n();
    const dispatch = useAppDispatch();
    const s = useAppSelector((state: RootState) => state.session);
    const theme = useAppTheme();

    async function handleExport() {
        const outputPath = s.outputPath?.trim();
        if (!outputPath) {
            const picked = await dispatch(pickOutputPath()).unwrap();
            if (picked.ok && !picked.canceled && picked.path) {
                await dispatch(exportAudio(picked.path));
            }
            return;
        }
        await dispatch(exportAudio(outputPath));
    }

    return (
        <Flex
            align="center"
            className="h-8 bg-qt-window border-b border-qt-border px-1 select-none z-50 flex-nowrap gap-1 overflow-hidden min-w-0"
        >
            {/* File Menu */}
            <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                    <Button
                        variant="ghost"
                        size="1"
                        color="gray"
                        className="hover:bg-qt-highlight hover:text-white shrink-0"
                        style={{ fontWeight: "normal" }}
                    >
                        {t("menu_file")}
                    </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content variant="soft" color="gray">
                    <DropdownMenu.Item
                        onSelect={() => dispatch(importAudioFromDialog())}
                    >
                        {t("menu_import_audio")}{" "}
                        <div className="ml-auto pl-4 text-xs text-gray-500">
                            {t("shortcut_ctrl_o")}
                        </div>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onSelect={handleExport}>
                        {t("menu_export_audio")}{" "}
                        <div className="ml-auto pl-4 text-xs text-gray-500">
                            {t("shortcut_ctrl_e")}
                        </div>
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item
                        onSelect={() => dispatch(pickOutputPath())}
                    >
                        {t("menu_pick_output")}
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item
                        onSelect={() => webApi.closeWindow()}
                        color="red"
                    >
                        {t("menu_exit")}
                    </DropdownMenu.Item>
                </DropdownMenu.Content>
            </DropdownMenu.Root>

            {/* Edit Menu */}
            <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                    <Button
                        variant="ghost"
                        size="1"
                        color="gray"
                        className="hover:bg-qt-highlight hover:text-white shrink-0"
                        style={{ fontWeight: "normal" }}
                    >
                        {t("menu_edit")}
                    </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content variant="soft" color="gray">
                    <DropdownMenu.Item disabled>
                        Undo{" "}
                        <div className="ml-auto pl-4 text-xs text-gray-500">
                            Ctrl+Z
                        </div>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item disabled>
                        Redo{" "}
                        <div className="ml-auto pl-4 text-xs text-gray-500">
                            Ctrl+Y
                        </div>
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item>
                        Select All{" "}
                        <div className="ml-auto pl-4 text-xs text-gray-500">
                            Ctrl+A
                        </div>
                    </DropdownMenu.Item>
                </DropdownMenu.Content>
            </DropdownMenu.Root>

            {/* Track Menu */}
            <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                    <Button
                        variant="ghost"
                        size="1"
                        color="gray"
                        className="hover:bg-qt-highlight hover:text-white shrink-0"
                        style={{ fontWeight: "normal" }}
                    >
                        {t("menu_track")}
                    </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content variant="soft" color="gray">
                    <DropdownMenu.Item
                        onSelect={() => dispatch(addTrackRemote({}))}
                    >
                        {t("track_add")}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                        disabled={!s.selectedTrackId}
                        onSelect={() =>
                            s.selectedTrackId &&
                            dispatch(removeTrackRemote(s.selectedTrackId))
                        }
                    >
                        {t("track_remove_selected")}
                    </DropdownMenu.Item>
                </DropdownMenu.Content>
            </DropdownMenu.Root>

            {/* View Menu */}
            <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                    <Button
                        variant="ghost"
                        size="1"
                        color="gray"
                        className="hover:bg-qt-highlight hover:text-white shrink-0"
                        style={{ fontWeight: "normal" }}
                    >
                        {t("menu_view")}
                    </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content variant="soft" color="gray">
                    <DropdownMenu.Item
                        onSelect={() => dispatch(refreshRuntime())}
                    >
                        {t("action_refresh")}
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item onSelect={() => theme.toggleMode()}>
                        {t("theme")}:{" "}
                        {theme.mode === "dark"
                            ? t("theme_dark")
                            : t("theme_light")}
                    </DropdownMenu.Item>
                </DropdownMenu.Content>
            </DropdownMenu.Root>

            {/* Help Menu */}
            <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                    <Button
                        variant="ghost"
                        size="1"
                        color="gray"
                        className="hover:bg-qt-highlight hover:text-white shrink-0"
                        style={{ fontWeight: "normal" }}
                    >
                        {t("menu_help")}
                    </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content variant="soft" color="gray">
                    <DropdownMenu.Item>About HiFiShifter</DropdownMenu.Item>
                </DropdownMenu.Content>
            </DropdownMenu.Root>

            <Flex ml="auto" gap="2" align="center" className="shrink-0">
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger>
                        <Button
                            variant="ghost"
                            size="1"
                            color="gray"
                            className="shrink-0"
                        >
                            {t("language")}
                        </Button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content>
                        <DropdownMenu.Item onSelect={() => setLocale("en-US")}>
                            {t("lang_en")}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item onSelect={() => setLocale("zh-CN")}>
                            {t("lang_zh")}
                        </DropdownMenu.Item>
                    </DropdownMenu.Content>
                </DropdownMenu.Root>
            </Flex>
        </Flex>
    );
};
