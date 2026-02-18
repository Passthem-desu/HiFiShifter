import { useAppDispatch, useAppSelector } from "../../app/hooks";
import type { RootState } from "../../app/store";
import {
    applyPitchShift,
    exportAudio,
    loadModel,
    playOriginal,
    playSynthesized,
    processAudio,
    refreshRuntime,
    seekPlayhead,
    setBpm,
    setProjectLengthRemote,
    stopAudioPlayback,
    synthesizeAudio,
    updateTransportBpm,
} from "../../features/session/sessionSlice";
import { useI18n } from "../../i18n/I18nProvider";

function btnClass(primary = false) {
    return primary
        ? "rounded border border-zinc-500 bg-zinc-600 px-2.5 py-1 text-xs font-semibold text-zinc-100 hover:bg-zinc-500 disabled:opacity-50"
        : "rounded border border-zinc-600 bg-zinc-700 px-2.5 py-1 text-xs font-semibold text-zinc-100 hover:bg-zinc-600 disabled:opacity-50";
}

export function ActionBar() {
    const dispatch = useAppDispatch();
    const s = useAppSelector((state: RootState) => state.session);
    const { t } = useI18n();

    return (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-700 bg-zinc-800 px-2 py-1.5">
            <button
                className={btnClass(true)}
                disabled={s.busy}
                onClick={() => dispatch(loadModel(s.modelDir))}
            >
                {t("action_load_model")}
            </button>
            <button
                className={btnClass()}
                disabled={s.busy}
                onClick={() => dispatch(processAudio(s.audioPath))}
            >
                {t("action_analyze_audio")}
            </button>
            <button
                className={btnClass()}
                disabled={s.busy}
                onClick={() => dispatch(applyPitchShift(s.pitchShift))}
            >
                {t("action_apply_pitch")}
            </button>
            <button
                className={btnClass(true)}
                disabled={s.busy}
                onClick={() => dispatch(synthesizeAudio())}
            >
                {t("action_synthesize")}
            </button>
            <button
                className={btnClass()}
                disabled={s.busy}
                onClick={() => dispatch(exportAudio(s.outputPath))}
            >
                {t("action_export_wav")}
            </button>

            <div className="mx-1 h-5 w-px bg-zinc-600" />

            <button
                className={btnClass()}
                disabled={s.busy}
                onClick={() => dispatch(playOriginal())}
            >
                {t("action_play_src")}
            </button>
            <button
                className={btnClass()}
                disabled={s.busy}
                onClick={() => dispatch(playSynthesized())}
            >
                {t("action_play_out")}
            </button>
            <button
                className={btnClass()}
                disabled={s.busy}
                onClick={() => dispatch(stopAudioPlayback())}
            >
                {t("action_stop")}
            </button>

            <div className="mx-1 h-5 w-px bg-zinc-600" />

            <label className="text-[11px] text-zinc-300">{t("playhead")}</label>
            <input
                className="h-1.5 w-40 cursor-pointer accent-cyan-500"
                type="range"
                min={0}
                max={Math.max(4, Math.ceil(s.projectBeats))}
                step={0.25}
                value={s.playheadBeat}
                onChange={(event) =>
                    void dispatch(seekPlayhead(Number(event.target.value)))
                }
            />
            <div className="w-12 text-right text-xs text-zinc-200">
                {s.playheadBeat.toFixed(2)}b
            </div>

            <label className="text-[11px] text-zinc-300">BPM</label>
            <input
                className="w-16 rounded border border-zinc-600 bg-zinc-700 px-1.5 py-0.5 text-xs text-zinc-100"
                type="number"
                min={10}
                max={300}
                step={1}
                value={Math.round(s.bpm)}
                onChange={(event) => {
                    const bpm = Number(event.target.value) || s.bpm;
                    dispatch(setBpm(bpm));
                    void dispatch(updateTransportBpm(bpm));
                }}
            />

            <label className="text-[11px] text-zinc-300">Len</label>
            <input
                className="w-16 rounded border border-zinc-600 bg-zinc-700 px-1.5 py-0.5 text-xs text-zinc-100"
                type="number"
                min={4}
                max={2048}
                step={1}
                value={Math.round(s.projectBeats)}
                onChange={(event) => {
                    const beats = Number(event.target.value) || s.projectBeats;
                    void dispatch(setProjectLengthRemote(beats));
                }}
            />

            <button
                className={btnClass()}
                disabled={s.busy}
                onClick={() => dispatch(refreshRuntime())}
            >
                {t("action_refresh")}
            </button>
        </div>
    );
}
