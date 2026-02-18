import { useAppDispatch, useAppSelector } from "../../app/hooks";
import type { RootState } from "../../app/store";
import {
    addClipOnTrack,
    setAudioPath,
    setBpm,
    setBeats,
    setEditParam,
    setGrid,
    setModelDir,
    setOutputPath,
    setPitchShift,
    setToolMode,
    updateTransportBpm,
} from "../../features/session/sessionSlice";
import { useI18n } from "../../i18n/I18nProvider";

const grids = ["1/4", "1/8", "1/16", "1/32"] as const;

export function TopControlsBar() {
    const dispatch = useAppDispatch();
    const s = useAppSelector((state: RootState) => state.session);
    const firstTrack = s.tracks[0];
    const { t } = useI18n();

    const fieldClass =
        "w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 outline-none ring-indigo-400/50 transition focus:ring-1";
    const labelClass =
        "mb-1 block text-[11px] uppercase tracking-wide text-zinc-500";

    return (
        <aside className="flex min-h-0 flex-col gap-3 overflow-auto rounded-lg border border-zinc-700/80 bg-zinc-900/70 p-3">
            <div>
                <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-300">
                    {t("panel_editor")}
                </div>
                <label className={labelClass}>{t("tool_mode")}</label>
                <select
                    value={s.toolMode}
                    onChange={(e) =>
                        dispatch(
                            setToolMode(e.target.value as "draw" | "select"),
                        )
                    }
                    className={fieldClass}
                >
                    <option value="draw">{t("draw")}</option>
                    <option value="select">{t("select")}</option>
                </select>

                <label className={`${labelClass} mt-2`}>
                    {t("edit_param")}
                </label>
                <select
                    value={s.editParam}
                    onChange={(e) =>
                        dispatch(
                            setEditParam(e.target.value as "pitch" | "tension"),
                        )
                    }
                    className={fieldClass}
                >
                    <option value="pitch">{t("pitch")}</option>
                    <option value="tension">{t("tension")}</option>
                </select>
            </div>

            <div>
                <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-300">
                    {t("panel_timeline")}
                </div>
                <div className="grid grid-cols-2 gap-2">
                    <div>
                        <label className={labelClass}>BPM</label>
                        <input
                            type="number"
                            min={10}
                            max={300}
                            value={s.bpm}
                            onChange={(e) =>
                                (() => {
                                    const nextBpm = Number(e.target.value) || 120;
                                    dispatch(setBpm(nextBpm));
                                    void dispatch(updateTransportBpm(nextBpm));
                                })()
                            }
                            className={fieldClass}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>
                            {t("beats_per_bar")}
                        </label>
                        <input
                            type="number"
                            min={1}
                            max={32}
                            value={s.beats}
                            onChange={(e) =>
                                dispatch(setBeats(Number(e.target.value) || 4))
                            }
                            className={fieldClass}
                        />
                    </div>
                </div>

                <label className={`${labelClass} mt-2`}>{t("grid")}</label>
                <select
                    value={s.grid}
                    onChange={(e) =>
                        dispatch(
                            setGrid(e.target.value as (typeof grids)[number]),
                        )
                    }
                    className={fieldClass}
                >
                    {grids.map((g) => (
                        <option key={g} value={g}>
                            {g}
                        </option>
                    ))}
                </select>

                <button
                    type="button"
                    className="mt-2 w-full rounded border border-teal-400/35 bg-teal-500/20 px-2 py-1.5 text-xs font-medium text-teal-100 hover:bg-teal-500/30"
                    onClick={() => {
                        if (firstTrack) {
                            void dispatch(
                                addClipOnTrack({ trackId: firstTrack.id }),
                            );
                        }
                    }}
                >
                    {t("add_clip")}
                </button>
            </div>

            <div>
                <div className="mb-2 text-xs font-semibold tracking-wide text-zinc-300">
                    {t("panel_io")}
                </div>
                <label className={labelClass}>{t("model_dir")}</label>
                <input
                    value={s.modelDir}
                    onChange={(e) => dispatch(setModelDir(e.target.value))}
                    className={fieldClass}
                />

                <label className={`${labelClass} mt-2`}>
                    {t("audio_path")}
                </label>
                <input
                    value={s.audioPath}
                    onChange={(e) => dispatch(setAudioPath(e.target.value))}
                    className={fieldClass}
                />

                <label className={`${labelClass} mt-2`}>
                    {t("pitch_shift")}
                </label>
                <input
                    type="number"
                    value={s.pitchShift}
                    step={0.1}
                    onChange={(e) =>
                        dispatch(setPitchShift(Number(e.target.value) || 0))
                    }
                    className={fieldClass}
                />

                <label className={`${labelClass} mt-2`}>
                    {t("output_path")}
                </label>
                <input
                    value={s.outputPath}
                    onChange={(e) => dispatch(setOutputPath(e.target.value))}
                    className={fieldClass}
                />
            </div>

            <div className="mt-auto rounded border border-zinc-800 bg-zinc-950/60 p-2">
                <div className="text-[11px] leading-5 text-zinc-400">
                    {t("hints")}
                </div>
                <ul className="mt-1 list-disc pl-4 text-[11px] leading-5 text-zinc-500">
                    <li>{t("hint_drag_clip")}</li>
                    <li>{t("hint_alt_drag")}</li>
                    <li>{t("hint_add_point")}</li>
                    <li>{t("hint_drag_point")}</li>
                </ul>
            </div>
        </aside>
    );
}
