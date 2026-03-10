import { Dialog, Flex, Select, Text, Button } from "@radix-ui/themes";
import { useAppDispatch, useAppSelector } from "../../app/hooks";
import type { RootState } from "../../app/store";
import { useI18n } from "../../i18n/I18nProvider";
import {
    setPitchSnapUnit,
    setPitchSnapScale,
    persistUiSettings,
} from "../../features/session/sessionSlice";
import type { PitchSnapUnit } from "../../features/session/sessionTypes";
import { SCALE_KEYS, SCALE_LABELS } from "../../utils/musicalScales";

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function PitchSnapSettingsDialog({ open, onOpenChange }: Props) {
    const dispatch = useAppDispatch();
    const { pitchSnapUnit, pitchSnapScale } = useAppSelector(
        (state: RootState) => state.session,
    );
    const { t } = useI18n();
    const tAny = t as (key: string) => string;

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Content
                style={{ maxWidth: 360 }}
                onKeyDown={(e) => e.stopPropagation()}
            >
                <Dialog.Title>{tAny("pitch_snap_settings")}</Dialog.Title>

                <Flex direction="column" gap="3" mt="3">
                    {/* Quantize Unit */}
                    <Flex align="center" gap="2">
                        <Text size="2" style={{ minWidth: 80 }}>
                            {tAny("quantize_unit")}
                        </Text>
                        <Select.Root
                            value={pitchSnapUnit}
                            size="2"
                            onValueChange={(v) => {
                                dispatch(
                                    setPitchSnapUnit(v as PitchSnapUnit),
                                );
                                void dispatch(persistUiSettings());
                            }}
                        >
                            <Select.Trigger style={{ flex: 1 }} />
                            <Select.Content>
                                <Select.Item value="semitone">
                                    {tAny("quantize_semitone")}
                                </Select.Item>
                                <Select.Item value="scale">
                                    {tAny("quantize_scale")}
                                </Select.Item>
                            </Select.Content>
                        </Select.Root>
                    </Flex>

                    {/* Base Scale (only when unit=scale) */}
                    {pitchSnapUnit === "scale" && (
                        <Flex align="center" gap="2">
                            <Text size="2" style={{ minWidth: 80 }}>
                                {tAny("base_scale")}
                            </Text>
                            <Select.Root
                                value={pitchSnapScale}
                                size="2"
                                onValueChange={(v) => {
                                    dispatch(setPitchSnapScale(v as import("../../utils/musicalScales").ScaleKey));
                                    void dispatch(persistUiSettings());
                                }}
                            >
                                <Select.Trigger style={{ flex: 1 }} />
                                <Select.Content>
                                    {SCALE_KEYS.map((key) => (
                                        <Select.Item key={key} value={key}>
                                            {SCALE_LABELS[key]}
                                        </Select.Item>
                                    ))}
                                </Select.Content>
                            </Select.Root>
                        </Flex>
                    )}
                </Flex>

                <Flex justify="end" mt="4">
                    <Dialog.Close>
                        <Button variant="soft" color="gray">
                            {tAny("close")}
                        </Button>
                    </Dialog.Close>
                </Flex>
            </Dialog.Content>
        </Dialog.Root>
    );
}
