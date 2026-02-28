// 如需新增参数：1) 在此联合类型中添加字面量；2) 在 render.ts 的 PARAM_AXIS_CONFIGS 中添加配置；3) 后端实现对应的 get_param_frames 分支
export type ParamName = "pitch" | "tension";

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
