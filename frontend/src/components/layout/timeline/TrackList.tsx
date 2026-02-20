import React from "react";
import { Flex, Box, Text, IconButton, Slider } from "@radix-ui/themes";
import { Cross2Icon, PlusIcon } from "@radix-ui/react-icons";
import type { TrackInfo } from "../../../features/session/sessionSlice";

export const TrackList: React.FC<{
    t: (key: any) => string;
    tracks: TrackInfo[];
    selectedTrackId: string | null;
    rowHeight: number;
    trackVolumeUi: Record<string, number>;
    onSelectTrack: (trackId: string) => void;
    onRemoveTrack: (trackId: string) => void;
    onToggleMute: (trackId: string, nextMuted: boolean) => void;
    onToggleSolo: (trackId: string, nextSolo: boolean) => void;
    onVolumeUiChange: (trackId: string, nextVolume: number) => void;
    onVolumeCommit: (trackId: string, nextVolume: number) => void;
    onAddTrack: () => void;
}> = ({
    t,
    tracks,
    selectedTrackId,
    rowHeight,
    trackVolumeUi,
    onSelectTrack,
    onRemoveTrack,
    onToggleMute,
    onToggleSolo,
    onVolumeUiChange,
    onVolumeCommit,
    onAddTrack,
}) => {
    return (
        <Flex
            direction="column"
            className="w-64 border-r border-qt-border bg-qt-window shrink-0"
        >
            <Box className="h-6 border-b border-qt-border px-2 flex items-center bg-qt-window shadow-sm z-10">
                <Text size="1" weight="bold" color="gray">
                    {t("tracks")}
                </Text>
            </Box>
            <div className="flex-1 overflow-y-auto custom-scrollbar">
                {tracks.map((track) => {
                    const selected = selectedTrackId === track.id;
                    const indent = Math.max(0, (track.depth ?? 0) * 12);
                    const muted = Boolean(track.muted);
                    const solo = Boolean(track.solo);
                    const backendVolume = Math.max(
                        0,
                        Math.min(1, Number(track.volume ?? 0.9)),
                    );
                    const uiOverride = trackVolumeUi[track.id];
                    const volume = Number.isFinite(uiOverride)
                        ? uiOverride
                        : backendVolume;

                    return (
                        <Box
                            key={track.id}
                            className={`border-b border-qt-border bg-qt-base relative group transition-colors overflow-hidden ${selected ? "bg-qt-button-hover" : "hover:bg-qt-button-hover"}`}
                            style={{ height: rowHeight }}
                            onClick={() => onSelectTrack(track.id)}
                        >
                            <div
                                className={`absolute left-0 top-0 bottom-0 w-1 bg-qt-highlight transition-opacity ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                            ></div>
                            <Flex
                                direction="column"
                                p="2"
                                gap="2"
                                height="100%"
                                justify="center"
                            >
                                <Flex
                                    justify="between"
                                    align="center"
                                    style={{ paddingLeft: indent }}
                                >
                                    <Text
                                        size="2"
                                        weight="medium"
                                        className="text-gray-200 truncate pr-2"
                                    >
                                        {track.name}
                                    </Text>
                                    <IconButton
                                        size="1"
                                        variant="ghost"
                                        color="gray"
                                        className="opacity-0 group-hover:opacity-100"
                                        disabled={tracks.length <= 1}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onRemoveTrack(track.id);
                                        }}
                                    >
                                        <Cross2Icon />
                                    </IconButton>
                                </Flex>

                                <Flex gap="2" align="center">
                                    <button
                                        className={`w-6 h-5 rounded text-[10px] border transition-all ${muted ? "bg-red-900 text-red-200 border-red-500" : "bg-qt-button text-gray-300 border-transparent hover:border-red-500 hover:bg-red-900 hover:text-red-200"}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onToggleMute(track.id, !muted);
                                        }}
                                    >
                                        M
                                    </button>
                                    <button
                                        className={`w-6 h-5 rounded text-[10px] border transition-all ${solo ? "bg-yellow-900 text-yellow-200 border-yellow-500" : "bg-qt-button text-gray-300 border-transparent hover:border-yellow-500 hover:bg-yellow-900 hover:text-yellow-200"}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onToggleSolo(track.id, !solo);
                                        }}
                                    >
                                        S
                                    </button>
                                    <Box flexGrow="1" />
                                    <Text size="1" color="gray">
                                        {Math.round(volume * 100)}%
                                    </Text>
                                </Flex>

                                <Slider
                                    value={[Math.round(volume * 100)]}
                                    size="1"
                                    className="w-full"
                                    onValueChange={(v) => {
                                        const next =
                                            Math.max(
                                                0,
                                                Math.min(
                                                    100,
                                                    Number(v[0] ?? 0),
                                                ),
                                            ) / 100;
                                        onVolumeUiChange(track.id, next);
                                    }}
                                    onValueCommit={(v) => {
                                        const next =
                                            Math.max(
                                                0,
                                                Math.min(
                                                    100,
                                                    Number(v[0] ?? 0),
                                                ),
                                            ) / 100;
                                        onVolumeCommit(track.id, next);
                                    }}
                                    onPointerDown={(e) => e.stopPropagation()}
                                />
                            </Flex>
                        </Box>
                    );
                })}

                <Flex
                    align="center"
                    justify="center"
                    className="h-8 border-b border-qt-border border-dashed text-gray-500 hover:text-gray-300 hover:bg-qt-button-hover cursor-pointer transition-colors"
                    onClick={onAddTrack}
                >
                    <PlusIcon className="mr-1" />{" "}
                    <Text size="1">{t("track_add")}</Text>
                </Flex>
            </div>
        </Flex>
    );
};
