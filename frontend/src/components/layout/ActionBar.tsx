import { useEffect, useRef, useState } from "react";
import {
    Flex,
    Select,
    TextField,
    Button,
    IconButton,
    Separator,
    Text,
} from "@radix-ui/themes";
import {
    PlayIcon,
    StopIcon,
    CursorArrowIcon,
    Pencil1Icon,
} from "@radix-ui/react-icons";
import { useAppDispatch, useAppSelector } from "../../app/hooks";
import type { RootState } from "../../app/store";
import { useI18n } from "../../i18n/I18nProvider";

import {
    playOriginal,
    stopAudioPlayback,
    setBpm,
    updateTransportBpm,
    setBeats,
    setToolMode,
    setGrid,
} from "../../features/session/sessionSlice";
import { toggleVisible } from "../../features/fileBrowser/fileBrowserSlice";

export function ActionBar() {
    const dispatch = useAppDispatch();
    const s = useAppSelector((state: RootState) => state.session);
    const fileBrowserVisible = useAppSelector(
        (state: RootState) => state.fileBrowser.visible,
    );
    const { t } = useI18n();

    const [bpmText, setBpmText] = useState(() =>
        String(Math.round(s.bpm || 120)),
    );
    const bpmDirtyRef = useRef(false);

    useEffect(() => {
        if (!bpmDirtyRef.current) {
            setBpmText(String(Math.round(s.bpm || 120)));
        }
    }, [s.bpm]);

    function commitBpm(nextText?: string) {
        const raw = (nextText ?? bpmText).trim();
        const next = Number(raw);
        bpmDirtyRef.current = false;
        if (!Number.isFinite(next)) {
            setBpmText(String(Math.round(s.bpm || 120)));
            return;
        }
        dispatch(setBpm(next));
        void dispatch(updateTransportBpm(next));
        setBpmText(String(Math.round(next)));
    }

    // Custom styles for Radix components to match Qt look
    // Note: Radix Themes handles a lot, but we might need overrides for exact pixel matching if needed.
    // For now, we use standard Radix "gray" theme which fits well.

    return (
        <Flex
            align="center"
            gap="3"
            className="h-8 bg-qt-window border-b border-qt-border px-1 text-qt-text flex-nowrap overflow-x-auto overflow-y-hidden min-w-0 custom-scrollbar"
        >
            {/* Mode & Param Group */}
            <Flex align="center" gap="1" className="shrink-0">
                <IconButton
                    size="1"
                    variant={s.toolMode === "select" ? "solid" : "ghost"}
                    color="gray"
                    title={t("select")}
                    tabIndex={-1}
                    onClick={() => dispatch(setToolMode("select"))}
                >
                    <CursorArrowIcon />
                </IconButton>
                <IconButton
                    size="1"
                    variant={s.toolMode === "draw" ? "solid" : "ghost"}
                    color="gray"
                    title={t("draw")}
                    tabIndex={-1}
                    onClick={() => dispatch(setToolMode("draw"))}
                >
                    <Pencil1Icon />
                </IconButton>
            </Flex>



            {/* BPM & Time */}
            <Flex align="center" gap="2" className="shrink-0">
                <Text size="1" className="text-qt-text-muted">
                    {t("bpm")}:
                </Text>
                <TextField.Root
                    size="1"
                    value={bpmText}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setBpmText(e.target.value);
                    }}
                    onBlur={() => commitBpm()}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            commitBpm();
                            (e.currentTarget as HTMLInputElement).blur();
                        } else if (e.key === "Escape") {
                            e.preventDefault();
                            bpmDirtyRef.current = false;
                            setBpmText(String(Math.round(s.bpm || 120)));
                            (e.currentTarget as HTMLInputElement).blur();
                        }
                    }}
                    style={{
                        width: 60,
                        textAlign: "right",
                        backgroundColor: "var(--qt-base)",
                    }}
                />
                <Text size="1" className="text-qt-text-muted">
                    {t("beats_per_bar")}:
                </Text>
                <Flex align="center" gap="1">
                    <TextField.Root
                        size="1"
                        type="number"
                        value={
                            Number.isFinite(s.beats)
                                ? Math.round(s.beats).toString()
                                : "4"
                        }
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                            const v = Number(e.target.value);
                            if (!Number.isFinite(v)) return;
                            dispatch(setBeats(v));
                        }}
                        style={{
                            width: 42,
                            textAlign: "center",
                            backgroundColor: "var(--qt-base)",
                        }}
                    />
                    <Text size="1" className="text-qt-text-muted">
                        / 4
                    </Text>
                </Flex>

                <Text size="1" className="text-qt-text-muted">
                    {t("grid")}:
                </Text>
                <Select.Root
                    value={s.grid}
                    size="1"
                    onValueChange={(v) => dispatch(setGrid(v as typeof s.grid))}
                >
                    <Select.Trigger
                        style={{ backgroundColor: "var(--qt-base)" }}
                    />
                    <Select.Content>
                        <Select.Item value="1/4">1/4</Select.Item>
                        <Select.Item value="1/8">1/8</Select.Item>
                        <Select.Item value="1/16">1/16</Select.Item>
                        <Select.Item value="1/32">1/32</Select.Item>
                    </Select.Content>
                </Select.Root>
            </Flex>

            <Separator orientation="vertical" size="2" />

            {/* Transport */}
            <Flex gap="1" className="shrink-0">
                <Button
                    variant="soft"
                    color="gray"
                    size="1"
                    onClick={() => dispatch(stopAudioPlayback())}
                    title={t("action_stop")}
                >
                    <StopIcon />
                </Button>
                <IconButton
                    variant="solid"
                    size="1"
onClick={() => dispatch(playOriginal())}
                    title={t("action_play_out")}
                >
                    <PlayIcon />
                </IconButton>
            </Flex>

            <Separator orientation="vertical" size="2" />

            {/* File Browser Toggle */}
            <Flex gap="1" className="shrink-0">
                <IconButton
                    size="1"
                    variant={fileBrowserVisible ? "solid" : "ghost"}
                    color="gray"
                    title={(t as (key: string) => string)("fb_title")}
                    onClick={() => dispatch(toggleVisible())}
                >
                    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M2 3.5C2 3.22386 2.22386 3 2.5 3H5.29289L6.64645 4.35355C6.74021 4.44732 6.86739 4.5 7 4.5H12.5C12.7761 4.5 13 4.72386 13 5V11.5C13 11.7761 12.7761 12 12.5 12H2.5C2.22386 12 2 11.7761 2 11.5V3.5Z" fill="currentColor"/>
                    </svg>
                </IconButton>
            </Flex>
        </Flex>
    );
}
