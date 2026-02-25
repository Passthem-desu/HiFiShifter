import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@radix-ui/themes";

import { useI18n } from "../../i18n/I18nProvider";
import { paramsApi } from "../../services/api";
import { resolveRootTrackId } from "../../features/session/trackUtils";

type TrackLite = {
    id: string;
    parentId?: string | null;
    composeEnabled?: boolean;
    pitchAnalysisAlgo?: string;
};

type PitchStatusKind =
    | "off"
    | "pending"
    | "ready"
    | "no_edit"
    | "unavailable"
    | "unknown";

export type PitchStatusSnapshot = {
    analysisPending: boolean;
    analysisProgress: number | null;
    pitchEditUserModified: boolean | null;
    pitchEditBackendAvailable: boolean | null;
};

export function PitchStatusBadge(props: {
    tracks: TrackLite[];
    selectedTrackId: string | null;
    status?: PitchStatusSnapshot;
    className?: string;
}) {
    const { tracks, selectedTrackId, status, className } = props;
    const { t } = useI18n();

    const rootTrackId = useMemo(
        () => resolveRootTrackId(tracks, selectedTrackId),
        [selectedTrackId, tracks],
    );

    const rootTrack = useMemo(() => {
        if (!rootTrackId) return null;
        return tracks.find((tr) => tr.id === rootTrackId) ?? null;
    }, [tracks, rootTrackId]);

    const hardDisableReason = useMemo(() => {
        if (!rootTrack) return null;
        if (!rootTrack.composeEnabled) return t("pitch_requires_compose");
        if (String(rootTrack.pitchAnalysisAlgo ?? "") === "none") {
            return t("pitch_requires_algo");
        }
        return null;
    }, [rootTrack, t]);

    const [kind, setKind] = useState<PitchStatusKind>(
        hardDisableReason ? "off" : "unknown",
    );
    const [progress, setProgress] = useState<number | null>(null);

    const lastReqIdRef = useRef(0);
    const pollDelayMsRef = useRef(1500);

    const derived = useMemo(() => {
        if (hardDisableReason) {
            return {
                kind: "off" as const,
                progress: null as number | null,
            };
        }

        if (!status) return null;

        const pending = Boolean(status.analysisPending);
        const backendAvail =
            status.pitchEditBackendAvailable === undefined
                ? null
                : status.pitchEditBackendAvailable;
        const userModified =
            status.pitchEditUserModified === undefined
                ? null
                : status.pitchEditUserModified;

        if (backendAvail === false) {
            return { kind: "unavailable" as const, progress: null };
        }
        if (pending) {
            return {
                kind: "pending" as const,
                progress:
                    typeof status.analysisProgress === "number"
                        ? status.analysisProgress
                        : null,
            };
        }
        if (userModified === false) {
            return { kind: "no_edit" as const, progress: null };
        }
        if (userModified === true) {
            return { kind: "ready" as const, progress: null };
        }
        return { kind: "unknown" as const, progress: null };
    }, [hardDisableReason, status]);

    useEffect(() => {
        if (derived) {
            setKind(derived.kind);
            setProgress(derived.progress);
        }
    }, [derived]);

    useEffect(() => {
        if (derived) return; // Upstream provided state; no need to poll.

        if (hardDisableReason) {
            setKind("off");
            setProgress(null);
            return;
        }
        if (!rootTrackId) {
            setKind("unknown");
            setProgress(null);
            return;
        }

        const trackId = rootTrackId;

        let cancelled = false;
        let timer: number | null = null;

        async function tick() {
            const reqId = ++lastReqIdRef.current;
            try {
                const res = await paramsApi.getParamFrames(
                    trackId,
                    "pitch",
                    0,
                    1,
                    1,
                );
                if (cancelled || reqId !== lastReqIdRef.current) return;
                if (!res || !res.ok) {
                    setKind("unknown");
                    setProgress(null);
                    return;
                }

                const pending = Boolean(res.analysis_pending);
                const backendAvail =
                    res.pitch_edit_backend_available === undefined
                        ? null
                        : Boolean(res.pitch_edit_backend_available);
                const userModified =
                    res.pitch_edit_user_modified === undefined
                        ? null
                        : Boolean(res.pitch_edit_user_modified);

                if (backendAvail === false) {
                    setKind("unavailable");
                    setProgress(null);
                    pollDelayMsRef.current = 4000;
                } else if (pending) {
                    setKind("pending");
                    const p =
                        typeof res.analysis_progress === "number"
                            ? res.analysis_progress
                            : null;
                    setProgress(p);
                    pollDelayMsRef.current = Math.min(
                        3000,
                        Math.max(500, pollDelayMsRef.current * 1.2),
                    );
                } else if (userModified === false) {
                    setKind("no_edit");
                    setProgress(null);
                    pollDelayMsRef.current = 4000;
                } else if (userModified === true) {
                    setKind("ready");
                    setProgress(null);
                    pollDelayMsRef.current = 4000;
                } else {
                    setKind("unknown");
                    setProgress(null);
                    pollDelayMsRef.current = 4000;
                }
            } catch {
                if (cancelled || reqId !== lastReqIdRef.current) return;
                setKind("unknown");
                setProgress(null);
            }
        }

        function schedule() {
            const delay = pollDelayMsRef.current;
            timer = window.setTimeout(() => {
                timer = null;
                void tick().finally(() => {
                    if (!cancelled) schedule();
                });
            }, delay);
        }

        pollDelayMsRef.current = 1200;
        void tick().finally(() => {
            if (!cancelled) schedule();
        });

        return () => {
            cancelled = true;
            if (timer != null) window.clearTimeout(timer);
        };
    }, [derived, hardDisableReason, rootTrackId]);

    const { color, text, title } = useMemo(() => {
        if (hardDisableReason) {
            return {
                color: "gray" as const,
                text: `${t("pitch_status_label")} ${t("pitch_status_off")}`,
                title: hardDisableReason,
            };
        }

        switch (kind) {
            case "pending": {
                const p =
                    typeof progress === "number" && Number.isFinite(progress)
                        ? Math.round(Math.max(0, Math.min(1, progress)) * 100)
                        : null;
                return {
                    color: "amber" as const,
                    text:
                        p == null
                            ? `${t("pitch_status_label")} ${t("pitch_status_pending")}`
                            : `${t("pitch_status_label")} ${t("pitch_status_pending")} ${p}%`,
                    title: `${t("pitch_status_label")}: ${t("pitch_status_pending")}`,
                };
            }
            case "unavailable":
                return {
                    color: "red" as const,
                    text: `${t("pitch_status_label")} ${t("pitch_status_unavailable")}`,
                    title: t("pitch_backend_unavailable"),
                };
            case "no_edit":
                return {
                    color: "gray" as const,
                    text: `${t("pitch_status_label")} ${t("pitch_status_no_edit")}`,
                    title: t("pitch_edit_not_modified_hint"),
                };
            case "ready":
                return {
                    color: "green" as const,
                    text: `${t("pitch_status_label")} ${t("pitch_status_ready")}`,
                    title: `${t("pitch_status_label")}: ${t("pitch_status_ready")}`,
                };
            case "off":
                return {
                    color: "gray" as const,
                    text: `${t("pitch_status_label")} ${t("pitch_status_off")}`,
                    title: t("pitch_status_off"),
                };
            case "unknown":
            default:
                return {
                    color: "gray" as const,
                    text: `${t("pitch_status_label")} ${t("status_na")}`,
                    title: `${t("pitch_status_label")}: ${t("status_na")}`,
                };
        }
    }, [hardDisableReason, kind, progress, t]);

    return (
        <Badge
            variant="soft"
            size="1"
            color={color}
            title={title}
            className={"select-none " + (className ?? "")}
        >
            {text}
        </Badge>
    );
}
