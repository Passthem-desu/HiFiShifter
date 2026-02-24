import type {
    ModelConfigResult,
    PlaybackStateResult,
    ProcessAudioResult,
    RuntimeInfo,
    SynthesizeResult,
} from "../../types/api";

import { invoke } from "../invoke";

export const coreApi = {
    ping: () => invoke<{ ok: boolean; message: string }>("ping"),
    getRuntimeInfo: () => invoke<RuntimeInfo>("get_runtime_info"),
    getPlaybackState: () => invoke<PlaybackStateResult>("get_playback_state"),

    openAudioDialog: () =>
        invoke<{ ok: boolean; canceled?: boolean; path?: string }>(
            "open_audio_dialog",
        ),

    pickOutputPath: () =>
        invoke<{ ok: boolean; canceled?: boolean; path?: string }>(
            "pick_output_path",
        ),

    closeWindow: () => invoke<{ ok: boolean }>("close_window"),

    clearWaveformCache: () =>
        invoke<{
            ok: boolean;
            removed_files: number;
            removed_bytes: number;
            dir: string;
        }>("clear_waveform_cache"),

    // Model / processing
    loadDefaultModel: () => invoke<ModelConfigResult>("load_default_model"),
    loadModel: (modelDir: string) =>
        invoke<ModelConfigResult>("load_model", modelDir),
    processAudio: (audioPath: string) =>
        invoke<ProcessAudioResult>("process_audio", audioPath),

    setPitchShift: (semitones: number) =>
        invoke<{ ok: boolean; pitch_shift?: number; frames?: number }>(
            "set_pitch_shift",
            semitones,
        ),

    synthesize: () => invoke<SynthesizeResult>("synthesize"),

    saveSynthesized: (outputPath: string) =>
        invoke<{
            ok: boolean;
            path?: string;
            sample_rate?: number;
            num_samples?: number;
        }>("save_synthesized", outputPath),

    playOriginal: (startSec = 0) =>
        invoke<{ ok: boolean; playing?: string; start_sec?: number }>(
            "play_original",
            startSec,
        ),

    playSynthesized: (startSec = 0) =>
        invoke<{ ok: boolean; playing?: string; start_sec?: number }>(
            "play_synthesized",
            startSec,
        ),

    stopAudio: () => invoke<{ ok: boolean }>("stop_audio"),
};
