import { useState } from "react";
import { Dialog, Flex, Text, TextField, Button, Select } from "@radix-ui/themes";
import { useI18n } from "../../i18n/I18nProvider";
import { SCALE_KEYS, SCALE_LABELS, type ScaleKey } from "../../utils/musicalScales";

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm?: (cents: number) => void;
}

export function TransposeCentsDialog({ open, onOpenChange, onConfirm }: Props) {
    const { t } = useI18n();
    const tAny = t as (key: string) => string;
    const [cents, setCents] = useState("0");

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Content style={{ maxWidth: 340 }} onKeyDown={(e) => e.stopPropagation()}>
                <Dialog.Title>{tAny("menu_transpose_cents")}</Dialog.Title>
                <Flex direction="column" gap="3" mt="3">
                    <Flex align="center" gap="2">
                        <Text size="2" style={{ minWidth: 80 }}>{tAny("dlg_cents")}</Text>
                        <TextField.Root
                            size="2"
                            type="number"
                            value={cents}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCents(e.target.value)}
                            style={{ flex: 1 }}
                        />
                    </Flex>
                </Flex>
                <Flex justify="end" gap="2" mt="4">
                    <Dialog.Close>
                        <Button variant="soft" color="gray">{tAny("cancel")}</Button>
                    </Dialog.Close>
                    <Button onClick={() => { onConfirm?.(Number(cents) || 0); onOpenChange(false); }}>
                        {tAny("ok")}
                    </Button>
                </Flex>
            </Dialog.Content>
        </Dialog.Root>
    );
}

interface TransposeDegreesProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm?: (degrees: number, scale: ScaleKey) => void;
}

export function TransposeDegreesDialog({ open, onOpenChange, onConfirm }: TransposeDegreesProps) {
    const { t } = useI18n();
    const tAny = t as (key: string) => string;
    const [degrees, setDegrees] = useState("0");
    const [scale, setScale] = useState<ScaleKey>("C");

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Content style={{ maxWidth: 360 }} onKeyDown={(e) => e.stopPropagation()}>
                <Dialog.Title>{tAny("menu_transpose_degrees")}</Dialog.Title>
                <Flex direction="column" gap="3" mt="3">
                    <Flex align="center" gap="2">
                        <Text size="2" style={{ minWidth: 80 }}>{tAny("dlg_degrees")}</Text>
                        <TextField.Root
                            size="2"
                            type="number"
                            value={degrees}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDegrees(e.target.value)}
                            style={{ flex: 1 }}
                        />
                    </Flex>
                    <Flex align="center" gap="2">
                        <Text size="2" style={{ minWidth: 80 }}>{tAny("base_scale")}</Text>
                        <Select.Root value={scale} size="2" onValueChange={(v) => setScale(v as ScaleKey)}>
                            <Select.Trigger style={{ flex: 1 }} />
                            <Select.Content>
                                {SCALE_KEYS.map((k: ScaleKey) => (
                                    <Select.Item key={k} value={k}>{SCALE_LABELS[k]}</Select.Item>
                                ))}
                            </Select.Content>
                        </Select.Root>
                    </Flex>
                </Flex>
                <Flex justify="end" gap="2" mt="4">
                    <Dialog.Close>
                        <Button variant="soft" color="gray">{tAny("cancel")}</Button>
                    </Dialog.Close>
                    <Button onClick={() => { onConfirm?.(Number(degrees) || 0, scale); onOpenChange(false); }}>
                        {tAny("ok")}
                    </Button>
                </Flex>
            </Dialog.Content>
        </Dialog.Root>
    );
}

interface SetPitchProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm?: (midiNote: number) => void;
}

export function SetPitchDialog({ open, onOpenChange, onConfirm }: SetPitchProps) {
    const { t } = useI18n();
    const tAny = t as (key: string) => string;
    const [note, setNote] = useState("60"); // C4

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Content style={{ maxWidth: 340 }} onKeyDown={(e) => e.stopPropagation()}>
                <Dialog.Title>{tAny("menu_set_pitch")}</Dialog.Title>
                <Flex direction="column" gap="3" mt="3">
                    <Flex align="center" gap="2">
                        <Text size="2" style={{ minWidth: 100 }}>{tAny("dlg_midi_note")}</Text>
                        <TextField.Root
                            size="2"
                            type="number"
                            value={note}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNote(e.target.value)}
                            style={{ flex: 1 }}
                        />
                    </Flex>
                </Flex>
                <Flex justify="end" gap="2" mt="4">
                    <Dialog.Close>
                        <Button variant="soft" color="gray">{tAny("cancel")}</Button>
                    </Dialog.Close>
                    <Button onClick={() => { onConfirm?.(Number(note) || 60); onOpenChange(false); }}>
                        {tAny("ok")}
                    </Button>
                </Flex>
            </Dialog.Content>
        </Dialog.Root>
    );
}

interface SmoothProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm?: (strength: number) => void;
}

export function SmoothDialog({ open, onOpenChange, onConfirm }: SmoothProps) {
    const { t } = useI18n();
    const tAny = t as (key: string) => string;
    const [strength, setStrength] = useState("50");

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Content style={{ maxWidth: 340 }} onKeyDown={(e) => e.stopPropagation()}>
                <Dialog.Title>{tAny("menu_smooth")}</Dialog.Title>
                <Flex direction="column" gap="3" mt="3">
                    <Flex align="center" gap="2">
                        <Text size="2" style={{ minWidth: 100 }}>{tAny("dlg_strength")}</Text>
                        <TextField.Root
                            size="2"
                            type="number"
                            value={strength}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setStrength(e.target.value)}
                            style={{ flex: 1 }}
                        />
                        <Text size="1" color="gray">%</Text>
                    </Flex>
                </Flex>
                <Flex justify="end" gap="2" mt="4">
                    <Dialog.Close>
                        <Button variant="soft" color="gray">{tAny("cancel")}</Button>
                    </Dialog.Close>
                    <Button onClick={() => { onConfirm?.(Number(strength) || 50); onOpenChange(false); }}>
                        {tAny("ok")}
                    </Button>
                </Flex>
            </Dialog.Content>
        </Dialog.Root>
    );
}

interface VibratoProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    editParam?: string;
    onConfirm?: (amplitude: number, rate: number) => void;
}

export function VibratoDialog({ open, onOpenChange, onConfirm, editParam }: VibratoProps) {
    const { t } = useI18n();
    const tAny = t as (key: string) => string;
    const [amplitude, setAmplitude] = useState("30");
    const [rate, setRate] = useState("5.5");

    const isPitch = editParam === "pitch";

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Content style={{ maxWidth: 360 }} onKeyDown={(e) => e.stopPropagation()}>
                <Dialog.Title>{tAny("menu_add_vibrato")}</Dialog.Title>
                <Flex direction="column" gap="3" mt="3">
                    <Flex align="center" gap="2">
                        <Text size="2" style={{ minWidth: 100 }}>{isPitch ? tAny("dlg_amplitude_cents") : tAny("dlg_amplitude")}</Text>
                        <TextField.Root
                            size="2"
                            type="number"
                            value={amplitude}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAmplitude(e.target.value)}
                            style={{ flex: 1 }}
                        />
                    </Flex>
                    <Flex align="center" gap="2">
                        <Text size="2" style={{ minWidth: 100 }}>{tAny("dlg_rate_hz")}</Text>
                        <TextField.Root
                            size="2"
                            type="number"
                            value={rate}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRate(e.target.value)}
                            style={{ flex: 1 }}
                        />
                    </Flex>
                </Flex>
                <Flex justify="end" gap="2" mt="4">
                    <Dialog.Close>
                        <Button variant="soft" color="gray">{tAny("cancel")}</Button>
                    </Dialog.Close>
                    <Button onClick={() => { onConfirm?.(Number(amplitude) || 30, Number(rate) || 5.5); onOpenChange(false); }}>
                        {tAny("ok")}
                    </Button>
                </Flex>
            </Dialog.Content>
        </Dialog.Root>
    );
}

interface QuantizeProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm?: (unit: "semitone" | "scale", scale: ScaleKey) => void;
}

export function QuantizeDialog({ open, onOpenChange, onConfirm }: QuantizeProps) {
    const { t } = useI18n();
    const tAny = t as (key: string) => string;
    const [unit, setUnit] = useState<"semitone" | "scale">("semitone");
    const [scale, setScale] = useState<ScaleKey>("C");

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Content style={{ maxWidth: 360 }} onKeyDown={(e) => e.stopPropagation()}>
                <Dialog.Title>{tAny("menu_quantize")}</Dialog.Title>
                <Flex direction="column" gap="3" mt="3">
                    <Flex align="center" gap="2">
                        <Text size="2" style={{ minWidth: 80 }}>{tAny("quantize_unit")}</Text>
                        <Select.Root value={unit} size="2" onValueChange={(v) => setUnit(v as "semitone" | "scale")}>
                            <Select.Trigger style={{ flex: 1 }} />
                            <Select.Content>
                                <Select.Item value="semitone">{tAny("quantize_semitone")}</Select.Item>
                                <Select.Item value="scale">{tAny("quantize_scale")}</Select.Item>
                            </Select.Content>
                        </Select.Root>
                    </Flex>
                    {unit === "scale" && (
                        <Flex align="center" gap="2">
                            <Text size="2" style={{ minWidth: 80 }}>{tAny("base_scale")}</Text>
                            <Select.Root value={scale} size="2" onValueChange={(v) => setScale(v as ScaleKey)}>
                                <Select.Trigger style={{ flex: 1 }} />
                                <Select.Content>
                                    {SCALE_KEYS.map((k: ScaleKey) => (
                                        <Select.Item key={k} value={k}>{SCALE_LABELS[k]}</Select.Item>
                                    ))}
                                </Select.Content>
                            </Select.Root>
                        </Flex>
                    )}
                </Flex>
                <Flex justify="end" gap="2" mt="4">
                    <Dialog.Close>
                        <Button variant="soft" color="gray">{tAny("cancel")}</Button>
                    </Dialog.Close>
                    <Button onClick={() => { onConfirm?.(unit, scale); onOpenChange(false); }}>
                        {tAny("ok")}
                    </Button>
                </Flex>
            </Dialog.Content>
        </Dialog.Root>
    );
}

interface MeanQuantizeProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm?: (unit: "semitone" | "scale", scale: ScaleKey) => void;
}

export function MeanQuantizeDialog({ open, onOpenChange, onConfirm }: MeanQuantizeProps) {
    const { t } = useI18n();
    const tAny = t as (key: string) => string;
    const [unit, setUnit] = useState<"semitone" | "scale">("semitone");
    const [scale, setScale] = useState<ScaleKey>("C");

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Content style={{ maxWidth: 360 }} onKeyDown={(e) => e.stopPropagation()}>
                <Dialog.Title>{tAny("mean_quantize_title")}</Dialog.Title>
                <Flex direction="column" gap="3" mt="3">
                    <Flex align="center" gap="2">
                        <Text size="2" style={{ minWidth: 80 }}>{tAny("quantize_unit")}</Text>
                        <Select.Root value={unit} size="2" onValueChange={(v) => setUnit(v as "semitone" | "scale")}>
                            <Select.Trigger style={{ flex: 1 }} />
                            <Select.Content>
                                <Select.Item value="semitone">{tAny("quantize_semitone")}</Select.Item>
                                <Select.Item value="scale">{tAny("quantize_scale")}</Select.Item>
                            </Select.Content>
                        </Select.Root>
                    </Flex>
                    {unit === "scale" && (
                        <Flex align="center" gap="2">
                            <Text size="2" style={{ minWidth: 80 }}>{tAny("base_scale")}</Text>
                            <Select.Root value={scale} size="2" onValueChange={(v) => setScale(v as ScaleKey)}>
                                <Select.Trigger style={{ flex: 1 }} />
                                <Select.Content>
                                    {SCALE_KEYS.map((k: ScaleKey) => (
                                        <Select.Item key={k} value={k}>{SCALE_LABELS[k]}</Select.Item>
                                    ))}
                                </Select.Content>
                            </Select.Root>
                        </Flex>
                    )}
                </Flex>
                <Flex justify="end" gap="2" mt="4">
                    <Dialog.Close>
                        <Button variant="soft" color="gray">{tAny("cancel")}</Button>
                    </Dialog.Close>
                    <Button onClick={() => { onConfirm?.(unit, scale); onOpenChange(false); }}>
                        {tAny("ok")}
                    </Button>
                </Flex>
            </Dialog.Content>
        </Dialog.Root>
    );
}
