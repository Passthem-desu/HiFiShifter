export type ParamName = "pitch" | "tension" | "breath";

export type StrokeMode = "draw" | "restore";

export type StrokePoint = { frame: number; value: number };

export type ValueViewport = { center: number; span: number };

export type WavePeaksSegment = {
    key: string;
    startSec: number;
    durSec: number;
    columns: number;
    min: number[];
    max: number[];
};

export type ParamViewSegment = {
    key: string;
    framePeriodMs: number;
    startFrame: number;
    stride: number;
    orig: number[];
    edit: number[];
};
