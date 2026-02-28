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

    // 仅用于初始查询的请求 ID，防止过期响应覆盖最新状态
    const lastReqIdRef = useRef(0);

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

    // 当 upstream 提供 status prop 时，直接同步到本地状态
    useEffect(() => {
        if (derived) {
            setKind(derived.kind);
            setProgress(derived.progress);
        }
    }, [derived]);

    // 事件驱动：监听后端 pitch 分析生命周期事件（Tauri 环境）
    // 无 upstream status prop 时才接管状态；有 status prop 时由 derived 驱动
    useEffect(() => {
        if (derived) return; // upstream 已提供状态，无需自行监听
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
        let disposed = false;
        let unlistenUpdated: (() => void) | null = null;
        let unlistenStarted: (() => void) | null = null;
        let unlistenProgress: (() => void) | null = null;

        // 辅助：从后端拉取一次当前状态（初始化 + Tauri 不可用时的降级）
        async function fetchOnce() {
            const reqId = ++lastReqIdRef.current;
            try {
                const res = await paramsApi.getParamFrames(trackId, "pitch", 0, 1, 1);
                if (disposed || reqId !== lastReqIdRef.current) return;
                if (!res?.ok) {
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
                } else if (pending) {
                    setKind("pending");
                    setProgress(
                        typeof res.analysis_progress === "number"
                            ? res.analysis_progress
                            : null,
                    );
                } else if (userModified === false) {
                    setKind("no_edit");
                    setProgress(null);
                } else if (userModified === true) {
                    setKind("ready");
                    setProgress(null);
                } else {
                    setKind("unknown");
                    setProgress(null);
                }
            } catch {
                if (disposed || reqId !== lastReqIdRef.current) return;
                setKind("unknown");
                setProgress(null);
            }
        }

        async function setup() {
            // 先做一次初始查询，确保组件挂载时立即显示正确状态
            await fetchOnce();

            try {
                const mod = await import("@tauri-apps/api/event");

                type PitchOrigUpdatedPayload = { rootTrackId?: string };
                type PitchOrigAnalysisStartedPayload = { rootTrackId?: string };
                type PitchOrigAnalysisProgressPayload = {
                    rootTrackId?: string;
                    progress?: number;
                };

                // 分析完成：立即切换为 ready/no_edit（由下一次 fetchOnce 确认）
                unlistenUpdated = await mod.listen<PitchOrigUpdatedPayload>(
                    "pitch_orig_updated",
                    (event) => {
                        if (disposed) return;
                        const payload = event.payload ?? {};
                        if (payload?.rootTrackId && payload.rootTrackId !== trackId) return;
                        // 分析完成后拉取最新状态（包含 userModified 等字段）
                        void fetchOnce();
                    },
                );

                // 分析开始：立即切换为 pending
                unlistenStarted = await mod.listen<PitchOrigAnalysisStartedPayload>(
                    "pitch_orig_analysis_started",
                    (event) => {
                        if (disposed) return;
                        const payload = event.payload ?? {};
                        if (payload?.rootTrackId && payload.rootTrackId !== trackId) return;
                        setKind("pending");
                        setProgress(0);
                    },
                );

                // 分析进度更新
                unlistenProgress = await mod.listen<PitchOrigAnalysisProgressPayload>(
                    "pitch_orig_analysis_progress",
                    (event) => {
                        if (disposed) return;
                        const payload = event.payload ?? {};
                        if (payload?.rootTrackId && payload.rootTrackId !== trackId) return;
                        const p = Number(payload?.progress);
                        if (!Number.isFinite(p)) return;
                        setKind("pending");
                        setProgress(Math.max(0, Math.min(1, p)));
                    },
                );
            } catch {
                // 非 Tauri 环境（浏览器/pywebview）：仅依赖初始查询，不注册事件监听
            }
        }

        void setup();

        return () => {
            disposed = true;
            if (unlistenUpdated) unlistenUpdated();
            if (unlistenStarted) unlistenStarted();
            if (unlistenProgress) unlistenProgress();
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
