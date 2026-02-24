export type ToolMode = "draw" | "select";
export type EditParam = "pitch" | "tension" | "breath";
export type GridSize = "1/4" | "1/8" | "1/16" | "1/32";

export interface TrackInfo {
    id: string;
    name: string;
    parentId?: string | null;
    depth?: number;
    childTrackIds?: string[];
    muted: boolean;
    solo: boolean;
    volume: number;

    composeEnabled: boolean;
    pitchAnalysisAlgo: string;
}

export interface ClipInfo {
    id: string;
    trackId: string;
    name: string;
    startBeat: number;
    lengthBeats: number;
    color: "blue" | "violet" | "emerald" | "amber";
    sourcePath?: string;
    durationSec?: number;
    gain: number;
    muted: boolean;
    trimStartBeat: number;
    trimEndBeat: number;
    playbackRate: number;
    fadeInBeats: number;
    fadeOutBeats: number;
}

export type ClipTemplate = Partial<Omit<ClipInfo, "id" | "color">> & {
    trackId: string;
    name: string;
    startBeat: number;
    lengthBeats: number;
};

export interface AutomationPoint {
    id: string;
    beat: number;
    value: number;
}
