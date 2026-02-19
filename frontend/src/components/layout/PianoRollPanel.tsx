import React, { useEffect, useState } from "react";
import { Flex, Box, Text, Button } from "@radix-ui/themes";
import { useAppDispatch, useAppSelector } from "../../app/hooks";
import type { RootState } from "../../app/store";
import { useI18n } from "../../i18n/I18nProvider";
import { setEditParam } from "../../features/session/sessionSlice";

export const PianoRollPanel: React.FC = () => {
    const dispatch = useAppDispatch();
    const { t } = useI18n();
    const editParam = useAppSelector(
        (state: RootState) => state.session.editParam,
    );

    const [gridY, setGridY] = useState(() => {
        const stored = Number(localStorage.getItem("hifishifter.paramGridY"));
        return Number.isFinite(stored)
            ? Math.min(60, Math.max(10, stored))
            : 20;
    });

    useEffect(() => {
        localStorage.setItem("hifishifter.paramGridY", String(gridY));
    }, [gridY]);

    return (
        <Flex
            direction="column"
            className="h-full w-full bg-qt-graph-bg border-t border-qt-border"
        >
            {/* Header / Parameter Switch */}
            <Flex
                align="center"
                justify="between"
                className="h-8 bg-qt-base border-b border-qt-border px-2 shrink-0"
            >
                <Text size="1" weight="bold" color="gray">
                    {t("param_editor")}
                </Text>

                <Flex gap="1">
                    <Button
                        size="1"
                        variant={editParam === "pitch" ? "solid" : "soft"}
                        color={editParam === "pitch" ? "grass" : "gray"}
                        onClick={() => dispatch(setEditParam("pitch"))}
                        style={{ cursor: "pointer" }}
                    >
                        {t("pitch")}
                    </Button>
                    <Button
                        size="1"
                        variant={editParam === "tension" ? "solid" : "soft"}
                        color={editParam === "tension" ? "amber" : "gray"}
                        onClick={() => dispatch(setEditParam("tension"))}
                        style={{ cursor: "pointer" }}
                    >
                        {t("tension")}
                    </Button>
                    <Button
                        size="1"
                        variant={editParam === "breath" ? "solid" : "soft"}
                        color={editParam === "breath" ? "cyan" : "gray"}
                        onClick={() => dispatch(setEditParam("breath"))}
                        style={{ cursor: "pointer" }}
                    >
                        {t("breath")}
                    </Button>
                </Flex>
            </Flex>

            {/* Note/Curve Editor Area */}
            <Flex className="flex-1 overflow-hidden relative">
                {/* Left Piano Keys (Y-Axis) */}
                <Flex
                    direction="column"
                    justify="end"
                    className="w-12 bg-qt-window border-r border-qt-border shrink-0"
                >
                    {/* Mock keys */}
                    {[
                        "C5",
                        "B4",
                        "A#4",
                        "A4",
                        "G#4",
                        "G4",
                        "F#4",
                        "F4",
                        "E4",
                    ].map((k) => (
                        <Flex
                            key={k}
                            align="center"
                            justify="end"
                            className={`flex-1 border-b border-[#444] pr-1 text-[9px] ${k.includes("#") ? "bg-[#303030] text-gray-500" : "bg-[#383838] text-gray-400"}`}
                        >
                            {!k.includes("#") && k}
                        </Flex>
                    ))}
                </Flex>

                {/* Grid / Content */}
                <div
                    className="flex-1 bg-qt-graph-bg relative overflow-hidden custom-scrollbar"
                    onWheel={(e) => {
                        if (!e.altKey) return;
                        e.preventDefault();
                        const dir = e.deltaY < 0 ? 1 : -1;
                        const factor = dir > 0 ? 1.1 : 0.9;
                        setGridY((prev) =>
                            Math.min(60, Math.max(10, prev * factor)),
                        );
                    }}
                >
                    {/* Grid Lines */}
                    <div
                        className="absolute inset-0 pointer-events-none"
                        style={{
                            backgroundImage: `
                                linear-gradient(to right, #333 1px, transparent 1px),
                                linear-gradient(to bottom, #2a2a2a 1px, transparent 1px)
                            `,
                            backgroundSize: `100px ${gridY}px`,
                            opacity: 0.6,
                        }}
                    ></div>

                    {/* Example Pitch Curve */}
                    <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
                        {/* Shadow/Glow */}
                        <path
                            d="M 100 150 C 150 120, 200 180, 250 160 S 350 140, 450 170"
                            stroke="#00ff00"
                            strokeWidth="4"
                            strokeOpacity="0.2"
                            fill="none"
                        />
                        {/* Use Green for Pitch, Red/Yellow for others */}
                        <path
                            d="M 100 150 C 150 120, 200 180, 250 160 S 350 140, 450 170"
                            stroke={
                                editParam === "pitch"
                                    ? "#00ff00"
                                    : editParam === "tension"
                                      ? "#ffcc00"
                                      : "#0099ff"
                            }
                            strokeWidth="2"
                            fill="none"
                            strokeLinecap="round"
                        />

                        {/* Note Blocks (Background Reference) */}
                        <rect
                            x="200"
                            y="80"
                            width="100"
                            height="20"
                            fill="rgba(255,255,255,0.1)"
                            stroke="none"
                        />
                        <rect
                            x="300"
                            y="60"
                            width="80"
                            height="20"
                            fill="rgba(255,255,255,0.1)"
                            stroke="none"
                        />
                    </svg>

                    {/* Playhead Sync */}
                    <div className="absolute top-0 bottom-0 left-[350px] w-px bg-red-500 opacity-50 pointer-events-none z-20"></div>
                </div>

                {/* Vertical Scrollbar Area Mock */}
                <Box className="w-3 bg-qt-base border-l border-qt-border flex flex-col justify-between py-1">
                    <Box className="w-full h-8 bg-[#555] opacity-50 rounded-sm mx-[2px]"></Box>
                </Box>
            </Flex>
        </Flex>
    );
};
