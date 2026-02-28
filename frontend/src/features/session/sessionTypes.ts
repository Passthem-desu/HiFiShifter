export type ToolMode = "draw" | "select";
export type FadeCurveType = "linear" | "sine" | "exponential" | "logarithmic" | "scurve";
// 如需新增参数：同步修改 pianoRoll/types.ts 中的 ParamName
export type EditParam = "pitch" | "tension";
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
    /** 轨道主题色，hex 字符串，如 "#4f8ef7" */
    color?: string;
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
    fadeInCurve: FadeCurveType;
    fadeOutCurve: FadeCurveType;
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
