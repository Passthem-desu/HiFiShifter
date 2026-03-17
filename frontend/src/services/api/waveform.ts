import type { WaveformPeaksSegmentPayload, WaveformPeaksV2Payload, WaveformPeaksV2MetaPayload, MipmapLevel } from "../../types/api";

import { invoke } from "../invoke";

export const waveformApi = {
    getWaveformPeaksSegment: (
        sourcePath: string,
        startSec: number,
        durationSec: number,
        columns: number,
    ) =>
        invoke<WaveformPeaksSegmentPayload>(
            "get_waveform_peaks_segment",
            sourcePath,
            startSec,
            durationSec,
            columns,
        ),

    // ============== HFSPeaks v2 API ==============

    /** 获取 v2 波形峰值（自动选择 mipmap 级别） */
    getWaveformPeaksV2: (
        sourcePath: string,
        timeRangeStart?: number,
        timeRangeEnd?: number,
        samplesPerPixel?: number,
    ) =>
        invoke<WaveformPeaksV2Payload>(
            "get_waveform_peaks_v2",
            sourcePath,
            timeRangeStart,
            timeRangeEnd,
            samplesPerPixel,
        ),

    /** 获取指定 mipmap 级别的波形峰值 */
    getWaveformPeaksV2Level: (
        sourcePath: string,
        startSec: number,
        durationSec: number,
        columns: number,
        level: MipmapLevel,
    ) =>
        invoke<WaveformPeaksV2Payload>(
            "get_waveform_peaks_v2_level",
            sourcePath,
            startSec,
            durationSec,
            columns,
            level,
        ),

    /** 获取波形文件元数据 */
    getWaveformPeaksV2Meta: (sourcePath: string) =>
        invoke<WaveformPeaksV2MetaPayload>("get_waveform_peaks_v2_meta", sourcePath),

    // ============== Mix 波形 API ==============

    getRootMixWaveformPeaksSegment: (
        trackId: string,
        startSec: number,
        durationSec: number,
        columns: number,
    ) =>
        invoke<WaveformPeaksSegmentPayload>(
            "get_root_mix_waveform_peaks_segment",
            trackId,
            startSec,
            durationSec,
            columns,
        ),

    getTrackMixWaveformPeaksSegment: (
        trackId: string,
        startSec: number,
        durationSec: number,
        columns: number,
    ) =>
        invoke<WaveformPeaksSegmentPayload>(
            "get_track_mix_waveform_peaks_segment",
            trackId,
            startSec,
            durationSec,
            columns,
        ),
};
