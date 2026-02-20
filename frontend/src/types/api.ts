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
}

export interface TimelineClip {
    id: string;
    track_id: string;
    name: string;
    start_beat: number;
    length_beats: number;
    color: string;
    source_path?: string;
    duration_sec?: number;
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
    trim_start_beat?: number;
    trim_end_beat?: number;
    playback_rate?: number;
    fade_in_beats?: number;
    fade_out_beats?: number;
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
    playhead_beat: number;
    project_beats?: number;
    project?: ProjectMeta;
}

export interface TimelineResult {
    ok: true;
    tracks: TimelineTrack[];
    clips: TimelineClip[];
    selected_track_id: string | null;
    selected_clip_id: string | null;
    bpm: number;
    playhead_beat: number;
    project_beats?: number;
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
    sample_rate: number;
    hop: number;
}
