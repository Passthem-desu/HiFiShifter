import { useEffect, useRef, useState } from "react";
import {
    Flex,
    Select,
    TextField,
    Button,
    Separator,
    Text,
} from "@radix-ui/themes";
import {
    PlayIcon,
    StopIcon,
    LightningBoltIcon,
    MagnifyingGlassIcon,
} from "@radix-ui/react-icons";
import { useAppDispatch, useAppSelector } from "../../app/hooks";
import type { RootState } from "../../app/store";
import { useI18n } from "../../i18n/I18nProvider";
import {
    loadModel,
    playOriginal,
    playSynthesized,
    processAudio,
    stopAudioPlayback,
    synthesizeAudio,
    setBpm,
    updateTransportBpm,
    setBeats,
    setToolMode,
    setEditParam,
    setGrid,
    importAudioFromDialog,
} from "../../features/session/sessionSlice";

export function ActionBar() {
    const dispatch = useAppDispatch();
    const s = useAppSelector((state: RootState) => state.session);
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
            className="h-10 bg-qt-window border-b border-qt-border px-2 text-qt-text flex-nowrap overflow-x-auto overflow-y-hidden min-w-0 custom-scrollbar"
        >
            {/* Mode & Param Group */}
            <Flex align="center" gap="2" className="shrink-0">
                <Text size="1" color="gray">
                    {t("tool_mode")}:
                </Text>
                <Select.Root
                    value={s.toolMode}
                    size="1"
                    onValueChange={(v) =>
                        dispatch(setToolMode(v as typeof s.toolMode))
                    }
                >
                    <Select.Trigger style={{ backgroundColor: "#303030" }} />
                    <Select.Content>
                        <Select.Item value="select">{t("select")}</Select.Item>
                        <Select.Item value="draw">{t("draw")}</Select.Item>
                    </Select.Content>
                </Select.Root>
            </Flex>

            <Flex align="center" gap="2" className="shrink-0">
                <Text size="1" color="gray">
                    {t("edit_param")}:
                </Text>
                <Select.Root
                    value={s.editParam}
                    size="1"
                    onValueChange={(v) =>
                        dispatch(setEditParam(v as typeof s.editParam))
                    }
                >
                    <Select.Trigger style={{ backgroundColor: "#303030" }} />
                    <Select.Content>
                        <Select.Item value="pitch">{t("pitch")}</Select.Item>
                        <Select.Item value="tension">
                            {t("tension")}
                        </Select.Item>
                        <Select.Item value="breath">{t("breath")}</Select.Item>
                    </Select.Content>
                </Select.Root>
            </Flex>

            <Separator orientation="vertical" size="2" />

            {/* BPM & Time */}
            <Flex align="center" gap="2" className="shrink-0">
                <Text size="1" color="gray">
                    BPM:
                </Text>
                <TextField.Root
                    size="1"
                    value={bpmText}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        bpmDirtyRef.current = true;
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
                <Text size="1" color="gray">
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
                    <Text size="1" color="gray">
                        / 4
                    </Text>
                </Flex>

                <Text size="1" color="gray">
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
                <Button
                    variant="soft"
                    color="gray"
                    size="1"
                    onClick={() => dispatch(playOriginal())}
                    title={t("action_play_src")}
                >
                    <PlayIcon /> {t("action_play_src")}
                </Button>
                <Button
                    variant="solid"
                    size="1"
                    onClick={() => dispatch(playSynthesized())}
                    title={t("action_play_out")}
                >
                    <PlayIcon /> {t("action_play_out")}
                </Button>
            </Flex>

            <Separator orientation="vertical" size="2" />

            {/* Actions */}
            <Flex gap="1" className="shrink-0">
                <Button
                    variant="surface"
                    color="gray"
                    size="1"
                    onClick={() => dispatch(loadModel(s.modelDir))}
                >
                    {t("action_load_model")}
                </Button>
                <Button
                    variant="surface"
                    color="gray"
                    size="1"
                    onClick={() =>
                        s.audioPath
                            ? dispatch(processAudio(s.audioPath))
                            : dispatch(importAudioFromDialog())
                    }
                >
                    <MagnifyingGlassIcon /> {t("action_analyze_audio")}
                </Button>
                <Button
                    variant="classic"
                    highContrast
                    size="1"
                    onClick={() => dispatch(synthesizeAudio())}
                >
                    <LightningBoltIcon /> {t("action_synthesize")}
                </Button>
            </Flex>
        </Flex>
    );
}
