export type ToolMode = "draw" | "select";
export type FadeCurveType =
    | "linear"
    | "sine"
    | "exponential"
    | "logarithmic"
    | "scurve";
// EditParam 是一个字符串，可以是 "pitch"、"tension" 或声码器额外参数 ID（如 "formant_shift_cents"）
// 具体可用值由后端 `get_processor_params` 动态返回
export type EditParam = string;
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
    startSec: number;
    lengthSec: number;
    color: "blue" | "violet" | "emerald" | "amber";
    sourcePath?: string;
    durationSec?: number;
    durationFrames?: number; // 精确frame总数
    sourceSampleRate?: number; // 源文件采样率
    gain: number;
    muted: boolean;
    sourceStartSec: number;
    sourceEndSec: number;
    playbackRate: number;
    fadeInSec: number;
    fadeOutSec: number;
    fadeInCurve: FadeCurveType;
    fadeOutCurve: FadeCurveType;
}
export type ClipTemplate = Partial<Omit<ClipInfo, "id" | "color">> & {
    trackId: string;
    name: string;
    startSec: number;
    lengthSec: number;
};
export interface AutomationPoint {
    id: string;
    beat: number;
    value: number;
}
