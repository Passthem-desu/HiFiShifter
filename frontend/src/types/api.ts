export type ApiResult<T> =
    | ({ ok: true } & T)
    | {
          ok: false;
          error: { code?: string; message: string; traceback?: string };
      };

export interface RuntimeInfo {
    ok: true;
    device: string;
    model_loaded: boolean;
    audio_loaded: boolean;
    has_synthesized: boolean;
    is_playing?: boolean;
    playback_target?: string | null;
    timeline?: TimelineState;
}

export interface TimelineTrack {
    id: string;
    name: string;
    parent_id?: string | null;
    depth?: number;
    child_track_ids?: string[];
    muted: boolean;
    solo: boolean;
    volume: number;

    compose_enabled: boolean;
    pitch_analysis_algo: string;
}

export interface TimelineClip {
    id: string;
    track_id: string;
    name: string;
    start_sec: number;
    length_sec: number;
    color: string;
    source_path?: string;
    duration_sec?: number;
    duration_frames?: number; // 精确frame总数
    source_sample_rate?: number; // 源文件采样率
    waveform_preview?:
        | number[]
        | { l: number[]; r: number[] }
        | { min: number[]; max: number[] };
    pitch_range?: {
        min: number;
        max: number;
    };
    gain?: number;
    muted?: boolean;
    trim_start_sec?: number;
    trim_end_sec?: number;
    playback_rate?: number;
    fade_in_sec?: number;
    fade_out_sec?: number;
}

export interface ProjectMeta {
    name: string;
    path?: string | null;
    dirty: boolean;
    recent: string[];
}

export interface TimelineState {
    tracks: TimelineTrack[];
    clips: TimelineClip[];
    selected_track_id: string | null;
    selected_clip_id: string | null;
    bpm: number;
    playhead_sec: number;
    project_sec?: number;
    project?: ProjectMeta;
}

export interface TimelineResult {
    ok: true;
    tracks: TimelineTrack[];
    clips: TimelineClip[];
    selected_track_id: string | null;
    selected_clip_id: string | null;
    bpm: number;
    playhead_sec: number;
    project_sec?: number;
    project?: ProjectMeta;
}

export interface TrackSummaryResult {
    ok: true;
    track_id: string;
    clip_count: number;
    waveform_preview: number[];
    pitch_range: {
        min: number;
        max: number;
    };
}

export interface ModelConfigResult {
    ok: true;
    config: {
        audio_sample_rate: number;
        audio_num_mel_bins: number;
        hop_size: number;
        fmin: number;
        fmax: number;
    };
}

export interface ProcessAudioResult {
    ok: true;
    audio: {
        path: string;
        sample_rate: number;
        duration_sec: number;
    };
    feature: {
        mel_shape: number[];
        f0_frames: number;
        segment_count: number;
        segments_preview: number[][];
        waveform_preview: number[];
        pitch_range: {
            min: number;
            max: number;
        };
    };
    timeline?: TimelineState;
}

export interface SynthesizeResult {
    ok: true;
    sample_rate: number;
    num_samples: number;
    duration_sec: number;
}

export interface PlaybackStateResult {
    ok: true;
    is_playing: boolean;
    target: string | null;
    base_sec: number;
    position_sec: number;
    duration_sec: number;
}

export interface WaveformPeaksSegmentPayload {
    ok: boolean;
    min: number[];
    max: number[];
}

export interface ParamFramesPayload {
    ok: boolean;
    root_track_id: string;
    param: string;
    frame_period_ms: number;
    start_frame: number;
    orig: number[];
    edit: number[];

    analysis_pending?: boolean;
    analysis_progress?: number;

    pitch_edit_user_modified?: boolean;
    pitch_edit_backend_available?: boolean;
}

export interface PitchProgressPayload {
    rootTrackId: string;
    progress: number;
    etaSeconds?: number;
    /** 当前正在分析�?clip 名称 */
    currentClipName?: string | null;
    /** 已完成的 clip 数量 */
    completedClips?: number;
    /** 需要分析的 clip 总数 */
    totalClips?: number;
}

export interface OnnxStatusResult {
    compiled: boolean;
    available: boolean;
    error: string | null;
    ep_choice: string;
}

export interface OnnxDiagnosticResult {
    compiled: boolean;
    available: boolean;
    error: string | null;
    ep_choice: string;
    onnx_version?: string;
    providers?: string[];
}

export interface PitchTaskStatusPayload {
    status: "running" | "completed" | "failed" | "cancelled";
    progress: number;
    error?: string | null;
    result_key?: string | null;
}
