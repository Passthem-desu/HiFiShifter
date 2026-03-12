import React, { useEffect, useMemo, useRef, useState } from "react";
import { Flex } from "@radix-ui/themes";
import { useAppDispatch, useAppSelector } from "../../app/hooks";
import type { RootState } from "../../app/store";
import { useI18n } from "../../i18n/I18nProvider";
import {
    addTrackRemote,
    removeTrackRemote,
    selectTrackRemote,
    setTrackStateRemote,
    seekPlayhead,
    selectClipRemote,
    setplayheadSec,
    moveTrackRemote,
    setClipMuted,
    importAudioAtPosition,
    importAudioFileAtPosition,
    importMultipleAudioAtPosition,
    setClipStateRemote,
    setClipGain,
    setClipFades,
    glueClipsRemote,
    removeClipRemote,
    splitClipRemote,
    setMultiSelectedClipIds as setMultiSelectedClipIdsAction,
} from "../../features/session/sessionSlice";

import type { ClipTemplate } from "../../features/session/sessionTypes";
import { dbToGain } from "./timeline/math";
import { useClipDrag } from "./timeline/hooks/useClipDrag";
import { useEditDrag } from "./timeline/hooks/useEditDrag";
import { useSlipDrag } from "./timeline/hooks/useSlipDrag";
import { useKeyboardShortcuts } from "./timeline/hooks/useKeyboardShortcuts";
import { selectKeybinding } from "../../features/keybindings/keybindingsSlice";
import type { Keybinding } from "../../features/keybindings/types";

import {
    BackgroundGrid,
    ClipContextMenu,
    DEFAULT_PX_PER_SEC,
    DEFAULT_ROW_HEIGHT,
    MAX_PX_PER_SEC,
    MAX_ROW_HEIGHT,
    MIN_PX_PER_SEC,
    MIN_ROW_HEIGHT,
    TimelineScrollArea,
    TimeRuler,
    TrackLane,
    TrackList,
    useTimelineSelectionRect,
    extractLocalFilePath,
    gridStepBeats,
    hasFileDrag,
} from "./timeline";

export const TimelinePanel: React.FC = () => {
    const dispatch = useAppDispatch();
    const { t } = useI18n();
    const s = useAppSelector((state: RootState) => state.session);
    const sessionRef = useRef(s);
    useEffect(() => {
        sessionRef.current = s;
    }, [s]);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const trackListScrollRef = useRef<HTMLDivElement | null>(null);
    const rulerContentRef = useRef<HTMLDivElement | null>(null);
    const scrollLeftRef = useRef(0);
    const scrollStateRafRef = useRef<number | null>(null);
    const playheadDragRef = useRef<{
        pointerId: number;
        lastBeat: number;
    } | null>(null);

    const [scrollLeft, setScrollLeft] = useState(0);
    useEffect(() => {
        scrollLeftRef.current = scrollLeft;
    }, [scrollLeft]);

    function syncScrollLeft(next: number) {
        scrollLeftRef.current = next;
        if (rulerContentRef.current) {
            rulerContentRef.current.style.transform = `translateX(${-next}px)`;
        }
        if (scrollStateRafRef.current == null) {
            scrollStateRafRef.current = requestAnimationFrame(() => {
                scrollStateRafRef.current = null;
                setScrollLeft(scrollLeftRef.current);
            });
        }
    }

    const setScrollLeftAction: React.Dispatch<React.SetStateAction<number>> = (
        action,
    ) => {
        const next =
            typeof action === "function"
                ? (action as (prev: number) => number)(scrollLeftRef.current)
                : action;
        syncScrollLeft(next);
    };
    const [pxPerSec, setPxPerSec] = useState(() => {
        const stored = Number(localStorage.getItem("hifishifter.pxPerSec"));
        return Number.isFinite(stored) && stored > 0
            ? Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, stored))
            : DEFAULT_PX_PER_SEC;
    });
    // 渲染时根据 BPM 计算 pxPerBeat，仅用于网格/标尺渲染
    // pxPerBeat = pxPerSec × secPerBeat = pxPerSec × (60 / bpm)
    const secPerBeat = 60 / Math.max(1, s.bpm);
    const pxPerBeat = pxPerSec * secPerBeat;
    // clip 位置/宽度/交互坐标统一使用 pxPerSec（不随 BPM 变化）

    const [rowHeight, setRowHeight] = useState(() => {
        const stored = Number(localStorage.getItem("hifishifter.rowHeight"));
        return Number.isFinite(stored)
            ? Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, stored))
            : DEFAULT_ROW_HEIGHT;
    });

    const panRef = useRef<{
        pointerId: number | null;
        startX: number;
        startY: number;
        scrollLeft: number;
        scrollTop: number;
    } | null>(null);

    // clip ��ק���༭��ק��slip ��ק�� ref �����������ɸ��� hook �ṩ��
    // ���·� snapBeat / beatFromClientX / trackIdFromClientY ������ʼ����

    const [trackVolumeUi, setTrackVolumeUi] = useState<Record<string, number>>(
        {},
    );
    const [dropPreview, setDropPreview] = useState<{
        path: string;
        fileName: string;
        trackId: string | null;
        startSec: number;
        durationSec: number;
    } | null>(null);

    const [clipDropNewTrack, setClipDropNewTrack] = useState(false);

    const [altPressed, setAltPressed] = useState(false);

    // 从 store 读取 modifier.clipStretch 绑定，动态检测对应修饰键
    const stretchKb = useAppSelector((state) =>
        selectKeybinding(state, "modifier.clipStretch"),
    );
    const slipEditKb = useAppSelector((state) =>
        selectKeybinding(state, "modifier.clipSlipEdit"),
    );
    const noSnapKb = useAppSelector((state) =>
        selectKeybinding(state, "modifier.clipNoSnap"),
    );
    const copyDragKb = useAppSelector((state) =>
        selectKeybinding(state, "modifier.clipCopyDrag"),
    );
    const scrollHorizontalKb = useAppSelector((state) =>
        selectKeybinding(state, "modifier.scrollHorizontal"),
    );
    const scrollVerticalKb = useAppSelector((state) =>
        selectKeybinding(state, "modifier.scrollVertical"),
    );
    const stretchKbRef = useRef<Keybinding>(stretchKb);
    useEffect(() => {
        stretchKbRef.current = stretchKb;
    }, [stretchKb]);

    const clipClipboardRef = useRef<ClipTemplate[] | null>(null);

    const tauriDraggedPathRef = useRef<string | null>(null);
    const tauriLastDropPathRef = useRef<string | null>(null);
    const tauriDropHandledAtRef = useRef<number>(0);

    useEffect(() => {
        /** 检测当前按下的键是否匹配 modifier.clipStretch 绑定 */
        function isStretchModifier(e: KeyboardEvent): boolean {
            const kb = stretchKbRef.current;
            if (kb.ctrl && (e.key === "Control" || e.ctrlKey || e.metaKey))
                return true;
            if (kb.alt && (e.key === "Alt" || e.altKey)) return true;
            if (kb.shift && (e.key === "Shift" || e.shiftKey)) return true;
            return false;
        }
        function checkStretchState(e: KeyboardEvent): boolean {
            const kb = stretchKbRef.current;
            if (kb.ctrl) return e.ctrlKey || e.metaKey;
            if (kb.alt) return e.altKey;
            if (kb.shift) return e.shiftKey;
            return false;
        }
        function onKeyDown(e: KeyboardEvent) {
            if (isStretchModifier(e)) setAltPressed(true);
        }
        function onKeyUp(e: KeyboardEvent) {
            if (!checkStretchState(e)) setAltPressed(false);
        }
        function onBlur() {
            setAltPressed(false);
        }
        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("keyup", onKeyUp, true);
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("keyup", onKeyUp, true);
            window.removeEventListener("blur", onBlur);
        };
    }, []);

    useEffect(() => {
        let disposed = false;
        let unlisten: null | (() => void) = null;

        const debugDnd = localStorage.getItem("hifishifter.debugDnd") === "1";

        async function setup() {
            try {
                const mod = await import("@tauri-apps/api/window");
                const win = mod.getCurrentWindow();

                if (debugDnd) {
                    console.log("[dnd] attaching tauri drag-drop listener");
                }

                type TauriDragDropPayload = {
                    type?: string;
                    event?: string;
                    paths?: string[];
                    position?: { x?: number; y?: number };
                    pos?: { x?: number; y?: number };
                    cursorPosition?: { x?: number; y?: number };
                };

                type TauriDragDropEvent =
                    | { payload?: TauriDragDropPayload }
                    | TauriDragDropPayload;

                unlisten = await win.onDragDropEvent(
                    (event: TauriDragDropEvent) => {
                        if (disposed) return;
                        const payload = (
                            "payload" in event ? event.payload : event
                        ) as TauriDragDropPayload | undefined;
                        const type = String(
                            payload?.type ?? payload?.event ?? "",
                        );
                        const paths: string[] = Array.isArray(payload?.paths)
                            ? payload.paths
                            : [];

                        if (debugDnd) {
                            console.log("[dnd] tauri event", {
                                type,
                                pathsCount: paths.length,
                                hasPosition: Boolean(
                                    payload?.position ??
                                    payload?.pos ??
                                    payload?.cursorPosition,
                                ),
                            });
                        }

                        // Some platforms don't dispatch DOM dragover/drop for external file drags.
                        // Use Tauri's drag-drop event as the source of truth, including ghost + import.
                        const scroller = scrollRef.current;
                        const bounds =
                            scroller?.getBoundingClientRect() ?? null;
                        const pos = (payload?.position ??
                            payload?.pos ??
                            payload?.cursorPosition) as
                            | { x?: number; y?: number }
                            | undefined;
                        // Tauri reports physical (screen) pixels; convert to CSS logical pixels.
                        const dpr = window.devicePixelRatio || 1;
                        const clientX =
                            typeof pos?.x === "number" ? pos.x / dpr : undefined;
                        const clientY =
                            typeof pos?.y === "number" ? pos.y / dpr : undefined;
                        const fallbackBeat =
                            sessionRef.current.playheadSec ?? 0;
                        const beat =
                            clientX !== undefined && bounds && scroller
                                ? beatFromClientX(
                                      clientX,
                                      bounds,
                                      scroller.scrollLeft,
                                  )
                                : fallbackBeat;
                        const trackId =
                            clientY !== undefined
                                ? trackIdFromClientY(clientY)
                                : null;

                        const primaryPath = paths.length > 0 ? paths[0] : null;
                        function fileNameFromPath(p: string) {
                            return String(p.split(/[\\/]/).pop() ?? p);
                        }

                        if (type === "enter" || type === "over") {
                            if (primaryPath) {
                                tauriDraggedPathRef.current = primaryPath;
                            }
                            // On some platforms, `paths` may only be populated on `drop`.
                            // Still update the ghost position on every `over`.
                            setDropPreview((prev) => {
                                const path =
                                    primaryPath ??
                                    tauriDraggedPathRef.current ??
                                    prev?.path ??
                                    null;
                                if (!path) return prev;
                                const nextFileName = fileNameFromPath(path);
                                return {
                                    path,
                                    fileName: prev?.fileName ?? nextFileName,
                                    trackId,
                                    startSec: beat,
                                    durationSec: prev?.durationSec ?? 0,
                                };
                            });
                            return;
                        }

                        if (type === "leave") {
                            tauriDraggedPathRef.current = null;
                            setDropPreview(null);
                            return;
                        }

                        if (type === "drop") {
                            if (primaryPath) {
                                tauriDraggedPathRef.current = primaryPath;
                                tauriLastDropPathRef.current = primaryPath;
                            }
                            setDropPreview(null);

                            // Multi-file drop: if multiple paths, show import mode menu
                            if (paths.length > 1) {
                                tauriDropHandledAtRef.current = Date.now();
                                tauriDraggedPathRef.current = null;
                                tauriLastDropPathRef.current = null;
                                setImportModeMenu({
                                    x: Math.round(window.innerWidth / 2),
                                    y: Math.round(window.innerHeight / 2),
                                    audioPaths: paths,
                                    trackId,
                                    startSec: beat,
                                });
                                return;
                            }

                            const resolvedPath =
                                primaryPath ||
                                tauriDraggedPathRef.current ||
                                tauriLastDropPathRef.current;
                            if (resolvedPath) {
                                tauriDropHandledAtRef.current = Date.now();
                                tauriDraggedPathRef.current = null;
                                tauriLastDropPathRef.current = null;
                                void dispatch(
                                    importAudioAtPosition({
                                        audioPath: resolvedPath,
                                        trackId,
                                        startSec: beat,
                                    }),
                                );
                            }
                        }
                    },
                );
            } catch (err) {
                // Safe no-op: browser/pywebview builds won't have the Tauri API.
                if (debugDnd) {
                    console.warn(
                        "Failed to attach Tauri drag-drop listener",
                        err,
                    );
                }
            }
        }

        void setup();

        return () => {
            disposed = true;
            if (unlisten) unlisten();
        };
    }, [dispatch, pxPerSec, rowHeight]);

    // ========== 监听文件浏览器面板的自定义拖拽事件 ==========
    useEffect(() => {
        function onHifiFileDrag(e: Event) {
            const detail = (e as CustomEvent).detail as {
                type: string;
                filePath: string;
                fileName: string;
                clientX: number;
                clientY: number;
            };
            if (!detail) return;

            const scroller = scrollRef.current;
            const bounds = scroller?.getBoundingClientRect() ?? null;

            // 判断鼠标是否在 timeline 滚动区域内
            const isOverTimeline =
                bounds &&
                detail.clientX >= bounds.left &&
                detail.clientX <= bounds.right &&
                detail.clientY >= bounds.top &&
                detail.clientY <= bounds.bottom;

            // 异步获取到音频时长后更新 ghost 宽度
            if (detail.type === "duration") {
                setDropPreview((prev) => {
                    if (prev && prev.path === detail.filePath) {
                        return {
                            ...prev,
                            durationSec: (detail as any).durationSec,
                        };
                    }
                    return prev;
                });
                return;
            }

            if (detail.type === "move" || detail.type === "start") {
                if (isOverTimeline && scroller) {
                    const beat = beatFromClientX(
                        detail.clientX,
                        bounds!,
                        scroller.scrollLeft,
                    );
                    const trackId = trackIdFromClientY(detail.clientY);
                    setDropPreview((prev) => ({
                        path: detail.filePath,
                        fileName: detail.fileName,
                        trackId,
                        startSec: beat,
                        durationSec:
                            prev?.path === detail.filePath
                                ? prev.durationSec
                                : 2,
                    }));
                } else {
                    setDropPreview(null);
                }
                return;
            }

            if (detail.type === "drop") {
                setDropPreview(null);
                if (isOverTimeline && scroller) {
                    const beat = beatFromClientX(
                        detail.clientX,
                        bounds!,
                        scroller.scrollLeft,
                    );
                    const trackId = trackIdFromClientY(detail.clientY);
                    const filePaths: string[] = (detail as any).filePaths;
                    const isRightDrag = !!(detail as any).isRightDrag;
                    const isMulti = Array.isArray(filePaths) && filePaths.length > 1;

                    // 右键拖拽或多文件 → 弹出导入模式菜单
                    if (isRightDrag || isMulti) {
                        setImportModeMenu({
                            x: detail.clientX,
                            y: detail.clientY,
                            audioPaths: isMulti ? filePaths : [detail.filePath],
                            trackId,
                            startSec: beat,
                        });
                    } else {
                        void dispatch(
                            importAudioAtPosition({
                                audioPath: detail.filePath,
                                trackId,
                                startSec: beat,
                            }),
                        );
                    }
                }
                return;
            }
        }

        window.addEventListener("hifi-file-drag", onHifiFileDrag);
        return () => {
            window.removeEventListener("hifi-file-drag", onHifiFileDrag);
        };
    }, [dispatch, pxPerSec, rowHeight]);

    const multiSelectedClipIds = useAppSelector(
        (state: RootState) => state.session.multiSelectedClipIds,
    );
    const setMultiSelectedClipIds = React.useCallback(
        (ids: string[] | ((prev: string[]) => string[])) => {
            if (typeof ids === "function") {
                // 支持 callback 形式（与旧 useState dispatch 兼容）
                const next = ids(multiSelectedClipIds);
                dispatch(setMultiSelectedClipIdsAction(next));
            } else {
                dispatch(setMultiSelectedClipIdsAction(ids));
            }
        },
        [dispatch, multiSelectedClipIds],
    );
    // 切换工具时清除多选
    useEffect(() => {
        dispatch(setMultiSelectedClipIdsAction([]));
    }, [s.toolMode, dispatch]);
    const multiSelectedSet = useMemo(
        () => new Set(multiSelectedClipIds),
        [multiSelectedClipIds],
    );

    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        clipId: string;
    } | null>(null);

    /** 导入模式选择菜单 */
    const [importModeMenu, setImportModeMenu] = useState<{
        x: number;
        y: number;
        audioPaths: string[];
        trackId: string | null;
        startSec: number;
    } | null>(null);

    /** �Ҽ��˵��д����������� clipId */
    const [renamingClipId, setRenamingClipId] = useState<string | null>(null);

    const { selectionRect, onPointerDown: onSelectionRectPointerDown } =
        useTimelineSelectionRect({
            scrollRef,
            sessionRef,
            pxPerBeat: pxPerSec,
            rowHeight,
            clearContextMenu: () => {
                setContextMenu(null);
            },
            setMultiSelectedClipIds,
            onSingleSelect: (clipId) => {
                void dispatch(selectClipRemote(clipId));
            },
        });

    const contentWidth = useMemo(() => {
        return Math.max(8 * (60 / Math.max(1, s.bpm)), s.projectSec) * pxPerSec;
    }, [s.projectSec, pxPerSec, s.bpm]);

    const dropExtraRows =
        (dropPreview && !dropPreview.trackId ? 1 : 0) +
        (clipDropNewTrack ? 1 : 0);
    const contentHeight = (s.tracks.length + dropExtraRows) * rowHeight;

    const bars = useMemo(() => {
        const beatsPerBar = Math.max(1, Math.round(s.beats || 4));
        const secPerBeat = 60 / Math.max(1, s.bpm);
        // totalBeats 必须用秒/每拍换算，确保覆盖整个 projectSec 范围
        const totalBeats = Math.max(1, Math.ceil(s.projectSec / secPerBeat));
        const result: Array<{ beat: number; label: string }> = [];
        let barIndex = 1;
        for (let beat = 0; beat <= totalBeats; beat += beatsPerBar) {
            result.push({ beat, label: `${barIndex}.1` });
            barIndex += 1;
        }
        return result;
    }, [s.beats, s.projectSec, s.bpm]);

    const clipsByTrackId = useMemo(() => {
        const map = new Map<string, typeof s.clips>();
        for (const clip of s.clips) {
            const arr = map.get(clip.trackId);
            if (arr) {
                arr.push(clip);
            } else {
                map.set(clip.trackId, [clip]);
            }
        }

        for (const arr of map.values()) {
            arr.sort((a, b) => {
                const d = (a.startSec ?? 0) - (b.startSec ?? 0);
                if (Math.abs(d) > 1e-9) return d;
                return String(a.id).localeCompare(String(b.id));
            });
        }

        return map;
    }, [s.clips]);

    /** 将客户端 X 坐标转换为秒（seconds-based，不受 BPM 影响） */
    function secFromClientX(clientX: number, bounds: DOMRect, xScroll: number) {
        const x = clientX - bounds.left + xScroll;
        return Math.max(0, x / pxPerSec);
    }

    /** 兼容旧名称，内部统一使用 secFromClientX */
    const beatFromClientX = secFromClientX;

    function trackIdFromClientY(clientY: number) {
        const scroller = scrollRef.current;
        if (!scroller) return null;
        const bounds = scroller.getBoundingClientRect();
        const y = clientY - bounds.top + scroller.scrollTop;
        const idx = Math.floor(y / rowHeight);
        const tracks = sessionRef.current.tracks;
        if (idx < 0 || idx >= tracks.length) return null;
        return tracks[idx]?.id ?? null;
    }

    function rowTopForTrackId(trackId: string | null) {
        if (!trackId) {
            return s.tracks.length * rowHeight;
        }
        const idx = s.tracks.findIndex((t) => t.id === trackId);
        if (idx < 0) {
            return s.tracks.length * rowHeight;
        }
        return idx * rowHeight;
    }

    function setPlayheadFromClientX(
        clientX: number,
        bounds: DOMRect,
        xScroll: number,
        commit: boolean,
    ) {
        const beat = beatFromClientX(clientX, bounds, xScroll);
        dispatch(setplayheadSec(beat));
        if (commit) {
            void dispatch(seekPlayhead(beat));
        }
        return beat;
    }

    function startPanPointer(e: React.PointerEvent) {
        const scroller = scrollRef.current;
        if (!scroller) return;
        if (e.pointerType !== "mouse") return;
        panRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            scrollLeft: scroller.scrollLeft,
            scrollTop: scroller.scrollTop,
        };

        const prevCursor = document.body.style.cursor;
        const prevSelect = document.body.style.userSelect;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";

        try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
            // ignore
        }

        function onMove(ev: PointerEvent) {
            const pan = panRef.current;
            const el = scrollRef.current;
            if (!pan || !el) return;
            if (pan.pointerId != null && ev.pointerId !== pan.pointerId) return;
            el.scrollLeft = pan.scrollLeft - (ev.clientX - pan.startX);
            el.scrollTop = pan.scrollTop - (ev.clientY - pan.startY);
            syncScrollLeft(el.scrollLeft);
        }

        function end(ev: PointerEvent) {
            const pan = panRef.current;
            if (!pan) return;
            if (pan.pointerId != null && ev.pointerId !== pan.pointerId) return;
            panRef.current = null;
            document.body.style.cursor = prevCursor;
            document.body.style.userSelect = prevSelect;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
        }

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
    }

    /** 将秒数 snap 到最近的 beat 对齐位置（seconds-based） */
    function snapSec(sec: number) {
        const stepBeats = gridStepBeats(s.grid);
        const stepSec = stepBeats * (60 / Math.max(1, s.bpm));
        return Math.round(sec / stepSec) * stepSec;
    }

    /** 兼容旧名称，内部统一使用 snapSec */
    const snapBeat = snapSec;

    function isEditableTarget(target: EventTarget | null): boolean {
        const el = target as HTMLElement | null;
        if (!el) return false;
        const tag = (el.tagName ?? "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") {
            return true;
        }
        if (el.isContentEditable) return true;
        if (el.closest?.('input,textarea,select,[contenteditable="true"]')) {
            return true;
        }
        return false;
    }

    // ���� ��ק hooks ��������������������������������������������������������������������������������������������������������������������
    const { editDragRef: _editDragRef, startEditDrag } = useEditDrag({
        scrollRef,
        sessionRef,
        dispatch,
        snapBeat,
        beatFromClientX,
        noSnapKb,
        gridSnapEnabled: s.gridSnapEnabled,
    });

    const { slipDragRef: _slipDragRef, startSlipDrag } = useSlipDrag({
        scrollRef,
        sessionRef,
        dispatch,
        multiSelectedClipIds,
        multiSelectedSet,
        beatFromClientX,
    });

    const {
        clipDragRef: _clipDragRef,
        startClipDrag: _startClipDragInner,
        ghostDrag,
    } = useClipDrag({
        scrollRef,
        sessionRef,
        rowHeight,
        multiSelectedClipIds,
        multiSelectedSet,
        dispatch,
        snapBeat,
        beatFromClientX,
        trackIdFromClientY,
        setClipDropNewTrack,
        setMultiSelectedClipIds,
        slipEditKb,
        noSnapKb,
        gridSnapEnabled: s.gridSnapEnabled,
        copyDragKb,
        autoCrossfadeEnabled: s.autoCrossfadeEnabled,
        onCtrlClick: (clipId: string) => {
            setMultiSelectedClipIds((prev) => {
                if (prev.includes(clipId)) {
                    return prev.filter((id) => id !== clipId);
                }
                return [...prev, clipId];
            });
            void dispatch(selectClipRemote(clipId));
        },
    });

    function startClipDrag(
        e: React.PointerEvent<HTMLDivElement>,
        clipId: string,
        clipstartSec: number,
        altPressedHint?: boolean,
    ) {
        _startClipDragInner(
            e,
            clipId,
            clipstartSec,
            altPressedHint,
            startSlipDrag,
        );
    }

    // ���� ���̿�ݼ� hook ������������������������������������������������������������������������������������������������������������
    // 规格化 clip 音量（快捷键 & 右键菜单共用）
    const normalizeClips = React.useCallback(
        (ids: string[]) => {
            for (const id of ids) {
                const waveform = sessionRef.current.clipWaveforms[id];
                if (!waveform) continue;
                const samples = Array.isArray(waveform)
                    ? waveform
                    : [...waveform.l, ...waveform.r];
                if (samples.length === 0) continue;
                const peak = Math.max(...samples.map(Math.abs));
                if (peak <= 0) continue;
                const newGain = Math.min(
                    Math.max(1.0 / peak, dbToGain(-12)),
                    dbToGain(12),
                );
                dispatch(setClipGain({ clipId: id, gain: newGain }));
                void dispatch(
                    setClipStateRemote({ clipId: id, gain: newGain }),
                );
            }
        },
        [dispatch, sessionRef],
    );

    useKeyboardShortcuts({
        sessionRef,
        dispatch,
        multiSelectedClipIds,
        setMultiSelectedClipIds,
        clipClipboardRef,
        isEditableTarget,
        autoCrossfadeEnabled: s.autoCrossfadeEnabled,
        onNormalize: normalizeClips,
    });
    useEffect(() => {
        if (!contextMenu) return;
        function onAnyPointerDown(e: PointerEvent) {
            const target = e.target as HTMLElement | null;
            if (target?.closest?.("[data-hs-context-menu='1']")) return;
            setContextMenu(null);
        }
        window.addEventListener("pointerdown", onAnyPointerDown, true);
        return () =>
            window.removeEventListener("pointerdown", onAnyPointerDown, true);
    }, [contextMenu]);

    // Auto-scroll: keep playhead visible during playback
    useEffect(() => {
        if (!s.autoScrollEnabled || !s.runtime.isPlaying) return;
        const scroller = scrollRef.current;
        if (!scroller) return;
        const playheadX = s.playheadSec * pxPerSec;
        const viewLeft = scroller.scrollLeft;
        const viewRight = viewLeft + scroller.clientWidth;
        if (playheadX < viewLeft || playheadX > viewRight) {
            const next = Math.max(0, playheadX - scroller.clientWidth / 2);
            scroller.scrollLeft = next;
            syncScrollLeft(next);
        }
    }, [s.autoScrollEnabled, s.runtime.isPlaying, s.playheadSec, pxPerSec]);

    // Focus cursor: scroll to center the playhead in the viewport
    useEffect(() => {
        function handler() {
            const scroller = scrollRef.current;
            if (!scroller) return;
            const playheadX = s.playheadSec * pxPerSec;
            const next = Math.max(0, playheadX - scroller.clientWidth / 2);
            scroller.scrollLeft = next;
            syncScrollLeft(next);
        }
        window.addEventListener("hifi:focusCursor", handler);
        return () => window.removeEventListener("hifi:focusCursor", handler);
    }, [s.playheadSec, pxPerSec]);

    return (
        <Flex className="h-full w-full bg-qt-graph-bg overflow-hidden">
            <TrackList
                t={t}
                tracks={s.tracks}
                selectedTrackId={s.selectedTrackId}
                rowHeight={rowHeight}
                trackVolumeUi={trackVolumeUi}
                listScrollRef={trackListScrollRef}
                onSelectTrack={(trackId) => {
                    dispatch(selectTrackRemote(trackId));
                }}
                onRemoveTrack={(trackId) => {
                    dispatch(removeTrackRemote(trackId));
                }}
                onMoveTrack={(payload) => {
                    dispatch(
                        moveTrackRemote({
                            trackId: payload.trackId,
                            targetIndex: payload.targetIndex,
                            parentTrackId: payload.parentTrackId,
                        }),
                    );
                }}
                onToggleMute={(trackId, nextMuted) => {
                    dispatch(
                        setTrackStateRemote({
                            trackId,
                            muted: nextMuted,
                        }),
                    );
                }}
                onToggleSolo={(trackId, nextSolo) => {
                    dispatch(
                        setTrackStateRemote({
                            trackId,
                            solo: nextSolo,
                        }),
                    );
                }}
                onToggleCompose={(trackId, nextComposeEnabled) => {
                    dispatch(
                        setTrackStateRemote({
                            trackId,
                            composeEnabled: nextComposeEnabled,
                        }),
                    );
                }}
                onVolumeUiChange={(trackId, nextVolume) => {
                    setTrackVolumeUi((prev) => ({
                        ...prev,
                        [trackId]: nextVolume,
                    }));
                }}
                onVolumeCommit={(trackId, nextVolume) => {
                    setTrackVolumeUi((prev) => {
                        const copy = { ...prev };
                        delete copy[trackId];
                        return copy;
                    });
                    dispatch(
                        setTrackStateRemote({
                            trackId,
                            volume: nextVolume,
                        }),
                    );
                }}
                onAddTrack={() => {
                    dispatch(addTrackRemote({}));
                }}
                onTrackColorChange={(trackId, color) => {
                    dispatch(
                        setTrackStateRemote({
                            trackId,
                            color,
                        }),
                    );
                }}
                onAlgoChange={(trackId, algo) => {
                    dispatch(
                        setTrackStateRemote({
                            trackId,
                            pitchAnalysisAlgo: algo,
                        }),
                    );
                }}
                onTrackNameChange={(trackId, name) => {
                    dispatch(
                        setTrackStateRemote({
                            trackId,
                            name,
                        }),
                    );
                }}
            />

            {/* Timeline View (Right) */}
            <Flex
                direction="column"
                className="flex-1 relative overflow-hidden bg-qt-graph-bg"
            >
                <TimeRuler
                    contentWidth={contentWidth}
                    scrollLeft={scrollLeft}
                    bars={bars}
                    pxPerBeat={pxPerBeat}
                    pxPerSec={pxPerSec}
                    secPerBeat={secPerBeat}
                    playheadSec={s.playheadSec}
                    contentRef={rulerContentRef}
                    onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        const scroller = scrollRef.current;
                        if (!scroller) return;
                        const bounds = (
                            e.currentTarget as HTMLDivElement
                        ).getBoundingClientRect();
                        setPlayheadFromClientX(
                            e.clientX,
                            bounds,
                            scroller.scrollLeft,
                            true,
                        );
                    }}
                />

                {/* Tracks Area */}
                <TimelineScrollArea
                    scrollRef={scrollRef}
                    projectSec={s.projectSec}
                    bpm={s.bpm}
                    pxPerSec={pxPerSec}
                    setPxPerSec={setPxPerSec}
                    rowHeight={rowHeight}
                    setRowHeight={setRowHeight}
                    setScrollLeft={setScrollLeftAction}
                    scrollHorizontalKb={scrollHorizontalKb}
                    scrollVerticalKb={scrollVerticalKb}
                    playheadSec={s.playheadSec}
                    playheadZoomEnabled={s.playheadZoomEnabled}
                    className="flex-1 bg-qt-graph-bg overflow-auto relative custom-scrollbar"
                    onScroll={(e) => {
                        const el = e.currentTarget as HTMLDivElement;
                        if (trackListScrollRef.current) {
                            trackListScrollRef.current.scrollTop = el.scrollTop;
                        }
                    }}
                    onMouseDownCapture={(e) => {
                        if (e.button === 1) {
                            e.preventDefault();
                        }
                    }}
                    onAuxClick={(e) => {
                        if (e.button === 1) {
                            e.preventDefault();
                        }
                    }}
                    onContextMenu={(e) => {
                        e.preventDefault();
                    }}
                    onPointerDown={onSelectionRectPointerDown}
                    onDragOver={(e) => {
                        const dt = e.dataTransfer;
                        const tauriPath = tauriDraggedPathRef.current;
                        const hasDomFile = Boolean(
                            dt?.files && dt.files.length > 0,
                        );
                        const isTauri = Boolean(
                            (window as unknown as { __TAURI__?: unknown })
                                .__TAURI__,
                        );
                        if (
                            !isTauri &&
                            !hasFileDrag(dt) &&
                            !hasDomFile &&
                            !tauriPath
                        )
                            return;
                        e.preventDefault();
                        const info = extractLocalFilePath(dt);
                        const el = e.currentTarget as HTMLDivElement;
                        const bounds = el.getBoundingClientRect();
                        const beat = beatFromClientX(
                            e.clientX,
                            bounds,
                            el.scrollLeft,
                        );
                        const trackId = trackIdFromClientY(e.clientY);
                        const path = info?.path || tauriPath || "";
                        const fileName =
                            info?.name ||
                            (tauriPath
                                ? String(
                                      tauriPath.split(/[\\/]/).pop() ??
                                          tauriPath,
                                  )
                                : hasDomFile
                                  ? String(dt?.files?.[0]?.name ?? "Audio")
                                  : "Audio");
                        setDropPreview({
                            path,
                            fileName,
                            trackId,
                            startSec: beat,
                            durationSec: 0,
                        });
                    }}
                    onDragLeave={(e) => {
                        const related = e.relatedTarget as Node | null;
                        if (
                            related &&
                            (e.currentTarget as HTMLDivElement).contains(
                                related,
                            )
                        )
                            return;
                        setDropPreview(null);
                    }}
                    onDrop={(e) => {
                        const dt = e.dataTransfer;
                        const tauriPath = tauriDraggedPathRef.current;
                        const lastTauriDropPath = tauriLastDropPathRef.current;
                        const hasDomFile = Boolean(
                            dt?.files && dt.files.length > 0,
                        );
                        const isTauri = Boolean(
                            (window as unknown as { __TAURI__?: unknown })
                                .__TAURI__,
                        );
                        if (
                            !isTauri &&
                            !hasFileDrag(dt) &&
                            !hasDomFile &&
                            !tauriPath
                        )
                            return;
                        e.preventDefault();

                        if (
                            isTauri &&
                            Date.now() - (tauriDropHandledAtRef.current || 0) <
                                500
                        ) {
                            setDropPreview(null);
                            return;
                        }

                        const info = extractLocalFilePath(dt);
                        const el = e.currentTarget as HTMLDivElement;
                        const bounds = el.getBoundingClientRect();
                        const beat = beatFromClientX(
                            e.clientX,
                            bounds,
                            el.scrollLeft,
                        );
                        const trackId = trackIdFromClientY(e.clientY);
                        setDropPreview(null);
                        const resolvedPath =
                            info?.path || lastTauriDropPath || tauriPath;
                        if (resolvedPath) {
                            tauriDraggedPathRef.current = null;
                            tauriLastDropPathRef.current = null;
                            void dispatch(
                                importAudioAtPosition({
                                    audioPath: resolvedPath,
                                    trackId,
                                    startSec: beat,
                                }),
                            );
                            return;
                        }

                        if (isTauri) {
                            window.setTimeout(() => {
                                const p =
                                    tauriLastDropPathRef.current ||
                                    tauriDraggedPathRef.current;
                                if (!p) return;
                                tauriDraggedPathRef.current = null;
                                tauriLastDropPathRef.current = null;
                                void dispatch(
                                    importAudioAtPosition({
                                        audioPath: p,
                                        trackId,
                                        startSec: beat,
                                    }),
                                );
                            }, 0);
                        }

                        const fallbackFile = dt.files?.[0] ?? null;
                        if (fallbackFile) {
                            void dispatch(
                                importAudioFileAtPosition({
                                    file: fallbackFile,
                                    trackId,
                                    startSec: beat,
                                }),
                            );
                        }
                    }}
                    onPointerDownCapture={(e) => {
                        if (e.button !== 1) return;
                        if (isEditableTarget(e.target)) return;
                        e.preventDefault();
                        startPanPointer(e);
                    }}
                    onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        setContextMenu(null);
                        setMultiSelectedClipIds([]);
                        const scroller = scrollRef.current;
                        if (!scroller) return;
                        const bounds = scroller.getBoundingClientRect();
                        // Ignore clicks on the native scrollbar region
                        if (
                            e.clientY >
                            bounds.bottom -
                                (scroller.offsetHeight - scroller.clientHeight)
                        )
                            return;
                        if (
                            e.clientX >
                            bounds.right -
                                (scroller.offsetWidth - scroller.clientWidth)
                        )
                            return;
                        setPlayheadFromClientX(
                            e.clientX,
                            bounds,
                            scroller.scrollLeft,
                            true,
                        );
                    }}
                >
                    {/* Track Lanes */}
                    <div
                        className="relative"
                        style={{ width: contentWidth, height: contentHeight }}
                    >
                        {selectionRect ? (
                            <div
                                className="absolute z-40 pointer-events-none"
                                style={{
                                    left: selectionRect.x1,
                                    top: selectionRect.y1,
                                    width: Math.max(
                                        1,
                                        selectionRect.x2 - selectionRect.x1,
                                    ),
                                    height: Math.max(
                                        1,
                                        selectionRect.y2 - selectionRect.y1,
                                    ),
                                    border: "1px dashed var(--qt-highlight)",
                                    backgroundColor:
                                        "color-mix(in oklab, var(--qt-highlight) 12%, transparent)",
                                }}
                            />
                        ) : null}

                        <BackgroundGrid
                            contentWidth={contentWidth}
                            contentHeight={contentHeight}
                            pxPerBeat={pxPerBeat}
                            grid={s.grid}
                            beatsPerBar={Math.max(1, Math.round(s.beats || 4))}
                        />

                        {clipDropNewTrack ? (
                            <div
                                className="absolute left-0 right-0 pointer-events-none z-20"
                                style={{
                                    top: s.tracks.length * rowHeight,
                                    height: rowHeight,
                                }}
                            >
                                <div
                                    className="absolute inset-0"
                                    style={{
                                        border: "1px dashed var(--qt-highlight)",
                                        backgroundColor:
                                            "color-mix(in oklab, var(--qt-highlight) 10%, transparent)",
                                    }}
                                />
                            </div>
                        ) : null}

                        {s.tracks.map((track) => {
                            const trackClips =
                                clipsByTrackId.get(track.id) ??
                                ([] as typeof s.clips);

                            return (
                                <TrackLane
                                    key={track.id}
                                    track={track}
                                    trackClips={trackClips}
                                    rowHeight={rowHeight}
                                    pxPerSec={pxPerSec}
                                    bpm={s.bpm}
                                    clipWaveforms={s.clipWaveforms}
                                    altPressed={altPressed}
                                    selectedClipId={s.selectedClipId}
                                    multiSelectedClipIds={multiSelectedClipIds}
                                    multiSelectedSet={multiSelectedSet}
                                    trackColor={track.color || undefined}
                                    ensureSelected={(clipId) => {
                                        if (
                                            multiSelectedClipIds.length === 0 ||
                                            !multiSelectedSet.has(clipId)
                                        ) {
                                            setMultiSelectedClipIds([clipId]);
                                        }
                                    }}
                                    selectClipRemote={(clipId) => {
                                        void dispatch(selectClipRemote(clipId));
                                    }}
                                    openContextMenu={(
                                        clipId,
                                        clientX,
                                        clientY,
                                    ) => {
                                        setContextMenu({
                                            x: clientX,
                                            y: clientY,
                                            clipId,
                                        });
                                    }}
                                    seekFromClientX={(clientX, commit) => {
                                        const scroller = scrollRef.current;
                                        if (!scroller) return;
                                        const bounds =
                                            scroller.getBoundingClientRect();
                                        setPlayheadFromClientX(
                                            clientX,
                                            bounds,
                                            scroller.scrollLeft,
                                            commit,
                                        );
                                    }}
                                    ghostDrag={ghostDrag}
                                    allClips={s.clips}
                                    startClipDrag={startClipDrag}
                                    startEditDrag={startEditDrag}
                                    toggleClipMuted={(clipId, nextMuted) => {
                                        dispatch(
                                            setClipMuted({
                                                clipId,
                                                muted: nextMuted,
                                            }),
                                        );
                                        void dispatch(
                                            setClipStateRemote({
                                                clipId,
                                                muted: nextMuted,
                                            }),
                                        );
                                    }}
                                    clearContextMenu={() => {
                                        setContextMenu(null);
                                    }}
                                    toggleMultiSelect={(clipId) => {
                                        setMultiSelectedClipIds((prev) => {
                                            if (prev.includes(clipId)) {
                                                return prev.filter(
                                                    (id) => id !== clipId,
                                                );
                                            }
                                            return [...prev, clipId];
                                        });
                                    }}
                                    renamingClipId={renamingClipId}
                                    onRenameCommit={(clipId, newName) => {
                                        void dispatch(
                                            setClipStateRemote({
                                                clipId,
                                                name: newName,
                                            }),
                                        );
                                    }}
                                    onRenameDone={() => {
                                        setRenamingClipId(null);
                                    }}
                                    onGainCommit={(clipId, db) => {
                                        const gain = Math.pow(10, db / 20);
                                        void dispatch(
                                            setClipStateRemote({
                                                clipId,
                                                gain,
                                            }),
                                        );
                                    }}
                                />
                            );
                        })}

                        {/* Drop preview (ghost item) */}
                        {dropPreview ? (
                            <div
                                className="absolute z-30 pointer-events-none"
                                style={{
                                    left: Math.max(
                                        0,
                                        dropPreview.startSec * pxPerSec,
                                    ),
                                    top:
                                        rowTopForTrackId(dropPreview.trackId) +
                                        8,
                                    width: Math.max(
                                        80,
                                        pxPerSec * dropPreview.durationSec,
                                    ),
                                    height: rowHeight - 16,
                                }}
                            >
                                <div className="h-full w-full rounded-sm border border-dashed border-qt-highlight bg-[color-mix(in_oklab,var(--qt-highlight)_20%,transparent)]">
                                    <div className="px-2 pt-1 text-[10px] text-qt-text truncate">
                                        {dropPreview.fileName}
                                    </div>
                                </div>
                            </div>
                        ) : null}

                        {/* Playhead Cursor */}
                        <div
                            className="absolute top-0 bottom-0 w-px bg-qt-playhead z-20 cursor-ew-resize"
                            style={{ left: s.playheadSec * pxPerSec }}
                            onPointerDown={(e) => {
                                if (e.button !== 0) return;
                                e.stopPropagation();
                                const scroller = scrollRef.current;
                                if (!scroller) return;
                                const bounds = scroller.getBoundingClientRect();
                                const beat = setPlayheadFromClientX(
                                    e.clientX,
                                    bounds,
                                    scroller.scrollLeft,
                                    false,
                                );
                                playheadDragRef.current = {
                                    pointerId: e.pointerId,
                                    lastBeat: beat,
                                };
                                (
                                    e.currentTarget as HTMLDivElement
                                ).setPointerCapture(e.pointerId);

                                function onPointerMove(ev: PointerEvent) {
                                    const drag = playheadDragRef.current;
                                    const currentScroller = scrollRef.current;
                                    if (
                                        !drag ||
                                        drag.pointerId !== e.pointerId ||
                                        !currentScroller
                                    ) {
                                        return;
                                    }
                                    const currentBounds =
                                        currentScroller.getBoundingClientRect();
                                    drag.lastBeat = setPlayheadFromClientX(
                                        ev.clientX,
                                        currentBounds,
                                        currentScroller.scrollLeft,
                                        false,
                                    );
                                }

                                function endDrag() {
                                    const drag = playheadDragRef.current;
                                    if (!drag || drag.pointerId !== e.pointerId)
                                        return;
                                    playheadDragRef.current = null;
                                    void dispatch(seekPlayhead(drag.lastBeat));
                                    window.removeEventListener(
                                        "pointermove",
                                        onPointerMove,
                                    );
                                    window.removeEventListener(
                                        "pointerup",
                                        endDrag,
                                    );
                                    window.removeEventListener(
                                        "pointercancel",
                                        endDrag,
                                    );
                                }

                                window.addEventListener(
                                    "pointermove",
                                    onPointerMove,
                                );
                                window.addEventListener("pointerup", endDrag);
                                window.addEventListener(
                                    "pointercancel",
                                    endDrag,
                                );
                            }}
                        />
                    </div>
                </TimelineScrollArea>

                {/* 导入模式选择菜单 */}
                {importModeMenu && (
                    <div
                        className="fixed inset-0 z-[9999]"
                        onClick={() => setImportModeMenu(null)}
                        onContextMenu={(e) => { e.preventDefault(); setImportModeMenu(null); }}
                    >
                        <div
                            className="absolute bg-qt-panel border border-qt-border rounded shadow-lg py-1 min-w-[180px]"
                            style={{
                                left: importModeMenu.x,
                                top: importModeMenu.y,
                            }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <button
                                className="w-full text-left px-3 py-1.5 text-sm text-qt-text hover:bg-qt-hover"
                                onClick={() => {
                                    const m = importModeMenu;
                                    setImportModeMenu(null);
                                    if (m.audioPaths.length === 1) {
                                        void dispatch(importAudioAtPosition({
                                            audioPath: m.audioPaths[0],
                                            trackId: m.trackId,
                                            startSec: m.startSec,
                                        }));
                                    } else {
                                        void dispatch(importMultipleAudioAtPosition({
                                            audioPaths: m.audioPaths,
                                            mode: "across-time",
                                            trackId: m.trackId,
                                            startSec: m.startSec,
                                        }));
                                    }
                                }}
                            >
                                {t("import_across_time" as any) || "Import across time (same track)"}
                            </button>
                            <button
                                className="w-full text-left px-3 py-1.5 text-sm text-qt-text hover:bg-qt-hover"
                                onClick={() => {
                                    const m = importModeMenu;
                                    setImportModeMenu(null);
                                    if (m.audioPaths.length === 1) {
                                        void dispatch(importAudioAtPosition({
                                            audioPath: m.audioPaths[0],
                                            trackId: null,
                                            startSec: m.startSec,
                                        }));
                                    } else {
                                        void dispatch(importMultipleAudioAtPosition({
                                            audioPaths: m.audioPaths,
                                            mode: "across-tracks",
                                            trackId: m.trackId,
                                            startSec: m.startSec,
                                        }));
                                    }
                                }}
                            >
                                {t("import_across_tracks" as any) || "Import across tracks (one per track)"}
                            </button>
                        </div>
                    </div>
                )}

                {contextMenu
                    ? (() => {
                          const ctxClip = sessionRef.current.clips.find(
                              (c) => c.id === contextMenu.clipId,
                          );
                          if (!ctxClip) return null;

                          const selectedIds =
                              multiSelectedClipIds.length >= 2
                                  ? multiSelectedClipIds
                                  : [contextMenu.clipId];
                          const selectedClips = sessionRef.current.clips.filter(
                              (c) => selectedIds.includes(c.id),
                          );

                          // Find all clips on the same track that overlap with the clicked clip
                          const overlappingClips = sessionRef.current.clips
                              .filter(
                                  (c) =>
                                      c.trackId === ctxClip.trackId &&
                                      c.id !== ctxClip.id &&
                                      c.startSec < ctxClip.startSec + ctxClip.lengthSec &&
                                      c.startSec + c.lengthSec > ctxClip.startSec,
                              )
                              .sort((a, b) => a.startSec - b.startSec);

                          const playheadSec = sessionRef.current.playheadSec;
                          const playheadInClip =
                              playheadSec >= ctxClip.startSec &&
                              playheadSec <=
                                  ctxClip.startSec + ctxClip.lengthSec;

                          return (
                              <ClipContextMenu
                                  x={contextMenu.x}
                                  y={contextMenu.y}
                                  clip={ctxClip}
                                  selectedClips={selectedClips}
                                  overlappingClips={overlappingClips}
                                  playheadInClip={playheadInClip}
                                  onClose={() => setContextMenu(null)}
                                  onDelete={(ids) => {
                                      setContextMenu(null);
                                      setMultiSelectedClipIds([]);
                                      for (const id of ids) {
                                          void dispatch(removeClipRemote(id));
                                      }
                                  }}
                                  onMute={(ids, muted) => {
                                      for (const id of ids) {
                                          dispatch(
                                              setClipMuted({
                                                  clipId: id,
                                                  muted,
                                              }),
                                          );
                                          void dispatch(
                                              setClipStateRemote({
                                                  clipId: id,
                                                  muted,
                                              }),
                                          );
                                      }
                                  }}
                                  onRename={(clipId) => {
                                      setContextMenu(null);
                                      setRenamingClipId(clipId);
                                  }}
                                  onCopy={(ids) => {
                                      const templates = sessionRef.current.clips
                                          .filter((c) => ids.includes(c.id))
                                          .map((c) => ({ ...c }));
                                      if (templates.length > 0) {
                                          clipClipboardRef.current = templates;
                                      }
                                  }}
                                  onCut={(ids) => {
                                      const templates = sessionRef.current.clips
                                          .filter((c) => ids.includes(c.id))
                                          .map((c) => ({ ...c }));
                                      if (templates.length > 0) {
                                          clipClipboardRef.current = templates;
                                      }
                                      setContextMenu(null);
                                      setMultiSelectedClipIds([]);
                                      for (const id of ids) {
                                          void dispatch(removeClipRemote(id));
                                      }
                                  }}
                                  onSplit={(clipId) => {
                                      setContextMenu(null);
                                      void dispatch(
                                          splitClipRemote({
                                              clipId,
                                              splitSec:
                                                  sessionRef.current
                                                      .playheadSec,
                                          }),
                                      );
                                  }}
                                  onGlue={(ids) => {
                                      setContextMenu(null);
                                      if (ids.length >= 2) {
                                          void dispatch(glueClipsRemote(ids));
                                          setMultiSelectedClipIds([]);
                                      }
                                  }}
                                  onFadeCurveChange={(
                                      clipId,
                                      target,
                                      curve,
                                  ) => {
                                      dispatch(
                                          setClipFades({
                                              clipId,
                                              ...(target === "in"
                                                  ? { fadeInCurve: curve }
                                                  : { fadeOutCurve: curve }),
                                          }),
                                      );
                                      void dispatch(
                                          setClipStateRemote({
                                              clipId,
                                              ...(target === "in"
                                                  ? { fadeInCurve: curve }
                                                  : { fadeOutCurve: curve }),
                                          }),
                                      );
                                  }}
                                  onNormalize={normalizeClips}
                              />
                          );
                      })()
                    : null}
            </Flex>
        </Flex>
    );
};
