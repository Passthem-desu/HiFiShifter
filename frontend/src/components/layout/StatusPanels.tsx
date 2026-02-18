import { useAppSelector } from "../../app/hooks";
import { useI18n } from "../../i18n/I18nProvider";

export function StatusPanels() {
    const s = useAppSelector((state) => state.session);
    const { t } = useI18n();

    const playbackTargetLabel =
        s.runtime.playbackTarget === "original"
            ? t("status_target_original")
            : s.runtime.playbackTarget === "synthesized"
              ? t("status_target_synthesized")
              : t("status_target_none");

    return (
        <div className="border-t border-zinc-700 bg-zinc-800 px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="rounded border border-zinc-600 bg-zinc-700 px-2 py-0.5 text-zinc-200">
                    {s.status}
                </span>
                {s.error && (
                    <span className="rounded border border-zinc-500 bg-zinc-700 px-2 py-0.5 text-zinc-100">
                        {s.error}
                    </span>
                )}
                <span className="text-zinc-400">
                    {t("status_device")}: {s.runtime.device}
                </span>
                <span className="text-zinc-400">
                    {t("status_model")}: {String(s.runtime.modelLoaded)}
                </span>
                <span className="text-zinc-400">
                    {t("status_audio")}: {String(s.runtime.audioLoaded)}
                </span>
                <span className="text-zinc-400">
                    {t("status_synth")}: {String(s.runtime.hasSynthesized)}
                </span>
                <span className="text-zinc-400">
                    {t("status_playing")}: {playbackTargetLabel}
                </span>
                <span className="text-zinc-400">
                    {t("status_position")}:{" "}
                    {s.runtime.playbackPositionSec.toFixed(2)} /{" "}
                    {s.runtime.playbackDurationSec.toFixed(2)}s
                </span>
                <span className="ml-auto text-zinc-500">
                    BPM {s.bpm} · Grid {s.grid} · Playhead{" "}
                    {s.playheadBeat.toFixed(2)}
                </span>
            </div>

            <details className="mt-1 rounded border border-zinc-700 bg-zinc-900/70 p-2">
                <summary className="cursor-pointer text-xs text-zinc-400">
                    {t("status_last_result")}
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-zinc-800 p-2 text-[11px] text-zinc-200">
                    {JSON.stringify(s.lastResult ?? {}, null, 2)}
                </pre>
            </details>
        </div>
    );
}
