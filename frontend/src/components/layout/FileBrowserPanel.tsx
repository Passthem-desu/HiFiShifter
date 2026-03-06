import React, { useCallback, useEffect, useRef, useState } from "react";
import {
    Flex,
    Text,
    IconButton,
    Slider,
    TextField,
    ScrollArea,
} from "@radix-ui/themes";
import {
    Cross2Icon,
    FileIcon,
    MagnifyingGlassIcon,
    ReloadIcon,
    ChevronUpIcon,
    SpeakerLoudIcon,
    PlayIcon,
    StopIcon,
} from "@radix-ui/react-icons";
import { useAppDispatch, useAppSelector } from "../../app/hooks";
import type { RootState } from "../../app/store";
import { useI18n } from "../../i18n/I18nProvider";
import {
    loadDirectory,
    setPreviewVolume,
    setPreviewingFile,
    setSearchQuery,
    setVisible,
    searchFilesRecursive,
} from "../../features/fileBrowser/fileBrowserSlice";
import { audioPreview } from "../../features/fileBrowser/audioPreview";
import type { FileEntry } from "../../services/api/fileBrowser";

/** 支持的音频扩展名 */
const AUDIO_EXTENSIONS = new Set([
    "wav", "mp3", "flac", "ogg", "aac", "aif", "aiff", "m4a",
]);

function isAudioFile(entry: FileEntry): boolean {
    return !entry.isDir && !!entry.extension && AUDIO_EXTENSIONS.has(entry.extension);
}

/** 格式化文件大小 */
function formatSize(bytes: number | null): string {
    if (bytes == null) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 文件夹图标 SVG */
function FolderIcon({ className }: { className?: string }) {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 15 15"
            fill="none"
            className={className}
        >
            <path
                d="M1 3.5C1 3.22386 1.22386 3 1.5 3H5.29289L6.64645 4.35355C6.74021 4.44732 6.86739 4.5 7 4.5H13.5C13.7761 4.5 14 4.72386 14 5V12.5C14 12.7761 13.7761 13 13.5 13H1.5C1.22386 13 1 12.7761 1 12.5V3.5Z"
                fill="currentColor"
            />
        </svg>
    );
}

/** 音频文件图标 SVG */
function AudioIcon({ className }: { className?: string }) {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 15 15"
            fill="none"
            className={className}
        >
            <path
                d="M7.5 0.75L7.5 14.25M10.5 3L10.5 12M4.5 3L4.5 12M13.5 5.5L13.5 9.5M1.5 5.5L1.5 9.5"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
            />
        </svg>
    );
}

export const FileBrowserPanel: React.FC = () => {
    const dispatch = useAppDispatch();
    const { t } = useI18n();
    const fb = useAppSelector((state: RootState) => state.fileBrowser);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 清除 debounce
    useEffect(() => () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
    }, []);

    // 预览音量同步
    useEffect(() => {
        audioPreview.setVolume(fb.previewVolume);
    }, [fb.previewVolume]);

    // 组件挂载时，如果有上次的路径，自动加载
    useEffect(() => {
        if (fb.currentPath && fb.entries.length === 0 && !fb.loading) {
            void dispatch(loadDirectory(fb.currentPath));
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // 根据搜索模式决定展示配表
    const isSearchMode = fb.searchQuery.trim().length > 0;
    const displayEntries = isSearchMode
        ? (fb.searchResults ?? [])
        : fb.entries;

    // 计算展示相对路径（搜索模式下显示文件所在目录）
    function getRelativeDirHint(fullPath: string): string {
        const normalFull = fullPath.replace(/\\/g, "/");
        const normalBase = fb.currentPath.replace(/\\/g, "/").replace(/\/$/, "");
        if (normalFull.toLowerCase().startsWith(normalBase.toLowerCase() + "/")) {
            const rel = normalFull.slice(normalBase.length + 1);
            const lastSlash = rel.lastIndexOf("/");
            return lastSlash >= 0 ? rel.slice(0, lastSlash) : "";
        }
        return "";
    }

    // 选择文件夹（通过后端 rfd dialog）
    const handleOpenFolder = useCallback(async () => {
        try {
            const { fileBrowserApi } = await import(
                "../../services/api/fileBrowser"
            );
            const result = await fileBrowserApi.pickDirectory();
            if (result.ok && !result.canceled && result.path) {
                void dispatch(loadDirectory(result.path));
            }
        } catch {
            // 忽略错误
        }
    }, [dispatch]);

    // 刷新当前目录
    const handleRefresh = useCallback(() => {
        if (fb.currentPath) {
            void dispatch(loadDirectory(fb.currentPath));
        }
    }, [dispatch, fb.currentPath]);

    // 返回上级目录
    const handleParentDir = useCallback(() => {
        if (!fb.currentPath) return;
        // 处理 Windows 和 Unix 路径
        const normalized = fb.currentPath.replace(/\\/g, "/");
        const parts = normalized.split("/").filter(Boolean);
        if (parts.length <= 1) return; // 已经是根目录
        parts.pop();
        // Windows 路径恢复
        let parentPath = parts.join("/");
        if (/^[A-Za-z]:$/.test(parts[0])) {
            parentPath = parts[0] + "/" + parts.slice(1).join("/");
        }
        if (fb.currentPath.includes("\\")) {
            parentPath = parentPath.replace(/\//g, "\\");
        }
        void dispatch(loadDirectory(parentPath));
    }, [dispatch, fb.currentPath]);

    // 进入子目录
    const handleEnterDir = useCallback(
        (dirPath: string) => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            dispatch(setSearchQuery(""));
            void dispatch(loadDirectory(dirPath));
        },
        [dispatch],
    );

    // 点击音频文件 → 预览播放/停止
    const handleClickAudio = useCallback(
        (entry: FileEntry) => {
            if (fb.previewingFile === entry.path) {
                // 停止播放
                audioPreview.stop();
                dispatch(setPreviewingFile(null));
            } else {
                // 开始播放
                dispatch(setPreviewingFile(entry.path));
                void audioPreview.play(entry.path, () => {
                    // 播放结束回调
                    dispatch(setPreviewingFile(null));
                });
            }
        },
        [dispatch, fb.previewingFile],
    );

    // 拖拽开始 — 使用自定义 pointer 事件实现，替代 HTML5 drag API
    const [dragState, setDragState] = useState<{
        filePath: string;
        fileName: string;
        startX: number;
        startY: number;
        active: boolean; // 超过阈值后才真正激活拖拽
    } | null>(null);
    const dragStateRef = useRef(dragState);
    dragStateRef.current = dragState;

    // ghost 元素跟随鼠标
    const ghostRef = useRef<HTMLDivElement | null>(null);

    const DRAG_THRESHOLD = 5; // 像素阈值，防止误触

    const handlePointerDownForDrag = useCallback(
        (e: React.PointerEvent<HTMLDivElement>, entry: FileEntry) => {
            // 仅左键
            if (e.button !== 0) return;
            // 不拦截 pointer，让 click 事件仍能触发预览
            setDragState({
                filePath: entry.path,
                fileName: entry.name,
                startX: e.clientX,
                startY: e.clientY,
                active: false,
            });
        },
        [],
    );

    useEffect(() => {
        if (!dragState) return;

        function onPointerMove(e: PointerEvent) {
            const ds = dragStateRef.current;
            if (!ds) return;

            if (!ds.active) {
                const dx = e.clientX - ds.startX;
                const dy = e.clientY - ds.startY;
                if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
                // 激活拖拽
                dragStateRef.current = { ...ds, active: true };
                setDragState(dragStateRef.current);
                // 发送拖拽开始事件
                window.dispatchEvent(
                    new CustomEvent("hifi-file-drag", {
                        detail: {
                            type: "start",
                            filePath: ds.filePath,
                            fileName: ds.fileName,
                            clientX: e.clientX,
                            clientY: e.clientY,
                        },
                    }),
                );
            }

            // 更新 ghost 位置
            if (ghostRef.current) {
                ghostRef.current.style.left = `${e.clientX + 12}px`;
                ghostRef.current.style.top = `${e.clientY + 12}px`;
            }

            // 发送拖拽移动事件（TimelinePanel 监听）
            window.dispatchEvent(
                new CustomEvent("hifi-file-drag", {
                    detail: {
                        type: "move",
                        filePath: dragStateRef.current!.filePath,
                        fileName: dragStateRef.current!.fileName,
                        clientX: e.clientX,
                        clientY: e.clientY,
                    },
                }),
            );
        }

        function onPointerUp(e: PointerEvent) {
            const ds = dragStateRef.current;
            if (ds?.active) {
                // 发送拖拽结束（drop）事件
                window.dispatchEvent(
                    new CustomEvent("hifi-file-drag", {
                        detail: {
                            type: "drop",
                            filePath: ds.filePath,
                            fileName: ds.fileName,
                            clientX: e.clientX,
                            clientY: e.clientY,
                        },
                    }),
                );
            }
            setDragState(null);
        }

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        return () => {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
        };
    }, [dragState !== null]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <Flex
            direction="column"
            className="h-full bg-qt-window text-qt-text select-none"
        >
            {/* 标题栏 */}
            <Flex
                align="center"
                justify="between"
                className="h-8 px-2 border-b border-qt-border shrink-0"
            >
                <Text size="2" weight="medium" className="truncate">
                    {(t as (key: string) => string)("fb_title")}
                </Text>
                <Flex align="center" gap="1">
                    <IconButton
                        size="1"
                        variant="ghost"
                        color="gray"
                        title={(t as (key: string) => string)("fb_open_folder")}
                        onClick={handleOpenFolder}
                    >
                        <FileIcon />
                    </IconButton>
                    <IconButton
                        size="1"
                        variant="ghost"
                        color="gray"
                        title={(t as (key: string) => string)("fb_refresh")}
                        onClick={handleRefresh}
                    >
                        <ReloadIcon />
                    </IconButton>
                    <IconButton
                        size="1"
                        variant="ghost"
                        color="gray"
                        title={t("fb_close")}
                        onClick={() => dispatch(setVisible(false))}
                    >
                        <Cross2Icon />
                    </IconButton>
                </Flex>
            </Flex>

            {/* 搜索栏 */}
            <div className="px-2 py-1 border-b border-qt-border shrink-0">
                <TextField.Root
                    ref={searchInputRef}
                    size="1"
                    placeholder={(t as (key: string) => string)("fb_search_placeholder")}
                    value={fb.searchQuery}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        const q = e.target.value;
                        dispatch(setSearchQuery(q));
                        if (debounceRef.current) clearTimeout(debounceRef.current);
                        if (q.trim() && fb.currentPath) {
                            debounceRef.current = setTimeout(() => {
                                void dispatch(searchFilesRecursive({ dirPath: fb.currentPath, query: q.trim() }));
                            }, 300);
                        }
                    }}
                    style={{ backgroundColor: "var(--qt-base)" }}
                >
                    <TextField.Slot>
                        <MagnifyingGlassIcon height="12" width="12" />
                    </TextField.Slot>
                    {fb.searchQuery && (
                        <TextField.Slot>
                            <IconButton
                                size="1"
                                variant="ghost"
                                color="gray"
                                onClick={() => dispatch(setSearchQuery(""))}
                                style={{ width: 16, height: 16 }}
                            >
                                <Cross2Icon width="10" height="10" />
                            </IconButton>
                        </TextField.Slot>
                    )}
                </TextField.Root>
            </div>

            {/* 路径栏 */}
            {fb.currentPath && (
                <Flex
                    align="center"
                    gap="1"
                    className="px-2 py-1 border-b border-qt-border shrink-0 min-h-[28px]"
                >
                    <IconButton
                        size="1"
                        variant="ghost"
                        color="gray"
                        title={(t as (key: string) => string)("fb_parent_dir")}
                        onClick={handleParentDir}
                    >
                        <ChevronUpIcon />
                    </IconButton>
                    <Text
                        size="1"
                        color="gray"
                        className="truncate flex-1"
                        title={fb.currentPath}
                    >
                        {fb.currentPath}
                    </Text>
                </Flex>
            )}

            {/* 文件列表 */}
            <ScrollArea
                className="flex-1 min-h-0"
                scrollbars="vertical"
            >
                <div className="py-1">
                    {fb.loading ? (
                        <Text size="1" color="gray" className="px-3 py-4 block text-center">
                            {(t as (key: string) => string)("fb_loading")}
                        </Text>
                    ) : fb.error ? (
                        <Text size="1" color="red" className="px-3 py-4 block text-center">
                            {(t as (key: string) => string)("fb_error")}: {fb.error}
                        </Text>
                    ) : !fb.currentPath ? (
                        <Text size="1" color="gray" className="px-3 py-4 block text-center">
                            {(t as (key: string) => string)("fb_no_folder")}
                        </Text>
                    ) : isSearchMode && fb.searchLoading ? (
                        <Text size="1" color="gray" className="px-3 py-4 block text-center">
                            {(t as (key: string) => string)("fb_searching")}
                        </Text>
                    ) : displayEntries.length === 0 ? (
                        <Text size="1" color="gray" className="px-3 py-4 block text-center">
                            {isSearchMode
                                ? (t as (key: string) => string)("fb_no_results")
                                : (t as (key: string) => string)("fb_empty_folder")}
                        </Text>
                    ) : (
                        displayEntries.map((entry) => (
                            <FileEntryRow
                                key={entry.path}
                                entry={entry}
                                isPlaying={fb.previewingFile === entry.path}
                                onDoubleClickDir={handleEnterDir}
                                onClickAudio={handleClickAudio}
                                onPointerDownForDrag={handlePointerDownForDrag}
                                isDragging={dragState?.active === true && dragState.filePath === entry.path}
                                pathHint={isSearchMode ? getRelativeDirHint(entry.path) : undefined}
                            />
                        ))
                    )}
                </div>
            </ScrollArea>

            {/* 底部音量滑块 */}
            <Flex
                align="center"
                gap="2"
                className="px-2 py-1.5 border-t border-qt-border shrink-0"
            >
                <SpeakerLoudIcon
                    width="14"
                    height="14"
                    className="text-qt-text-muted shrink-0"
                />
                <Slider
                    size="1"
                    min={0}
                    max={100}
                    step={1}
                    value={[Math.round(fb.previewVolume * 100)]}
                    onValueChange={(values: number[]) => {
                        dispatch(setPreviewVolume(values[0] / 100));
                    }}
                    className="flex-1"
                />
                <Text
                    size="1"
                    color="gray"
                    className="w-[32px] text-right shrink-0"
                >
                    {Math.round(fb.previewVolume * 100)}%
                </Text>
            </Flex>

            {/* 拖拽 ghost 元素 */}
            {dragState?.active && (
                <div
                    ref={ghostRef}
                    style={{
                        position: "fixed",
                        left: 0,
                        top: 0,
                        pointerEvents: "none",
                        zIndex: 99999,
                        background: "var(--qt-highlight)",
                        color: "#fff",
                        padding: "2px 8px",
                        borderRadius: 4,
                        fontSize: 11,
                        whiteSpace: "nowrap",
                        opacity: 0.9,
                        boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
                    }}
                >
                    🎵 {dragState.fileName}
                </div>
            )}
        </Flex>
    );
};

// ============================================================
// 文件条目行组件
// ============================================================

interface FileEntryRowProps {
    entry: FileEntry;
    isPlaying: boolean;
    onDoubleClickDir: (dirPath: string) => void;
    onClickAudio: (entry: FileEntry) => void;
    onPointerDownForDrag: (e: React.PointerEvent<HTMLDivElement>, entry: FileEntry) => void;
    isDragging: boolean;
    pathHint?: string;
}

const FileEntryRow: React.FC<FileEntryRowProps> = React.memo(
    ({ entry, isPlaying, onDoubleClickDir, onClickAudio, onPointerDownForDrag, isDragging, pathHint }) => {
        const isAudio = isAudioFile(entry);

        return (
            <div
                className={[
                    "flex items-center gap-1.5 px-2 py-[3px] cursor-default",
                    "hover:bg-[color-mix(in_oklab,var(--qt-highlight)_12%,transparent)]",
                    isPlaying
                        ? "bg-[color-mix(in_oklab,var(--qt-highlight)_20%,transparent)]"
                        : "",
                    isDragging
                        ? "opacity-50"
                        : "",
                    !entry.isDir && !isAudio
                        ? "opacity-50"
                        : "",
                ]
                    .filter(Boolean)
                    .join(" ")}
                onPointerDown={
                    isAudio ? (e) => onPointerDownForDrag(e, entry) : undefined
                }
                onDoubleClick={
                    entry.isDir
                        ? () => onDoubleClickDir(entry.path)
                        : undefined
                }
                onClick={isAudio ? () => onClickAudio(entry) : undefined}
            >
                {/* 图标 */}
                <span className="shrink-0 w-[14px] flex items-center justify-center">
                    {entry.isDir ? (
                        <FolderIcon className="text-yellow-500" />
                    ) : isAudio ? (
                        isPlaying ? (
                            <StopIcon
                                width="12"
                                height="12"
                                className="text-qt-highlight"
                            />
                        ) : (
                            <AudioIcon className="text-blue-400" />
                        )
                    ) : (
                        <FileIcon
                            width="12"
                            height="12"
                            className="text-qt-text-muted"
                        />
                    )}
                </span>

                {/* 文件名 + 路径提示 */}
                <div className="flex flex-col min-w-0 flex-1">
                    <Text
                        size="1"
                        className="truncate"
                        title={entry.name}
                    >
                        {entry.name}
                        {entry.isDir ? "/" : ""}
                    </Text>
                    {pathHint && (
                        <Text size="1" color="gray" className="truncate leading-none" style={{ fontSize: 10 }}>
                            {pathHint}
                        </Text>
                    )}
                </div>

                {/* 右侧信息 */}
                {!entry.isDir && entry.size != null && (
                    <Text size="1" color="gray" className="shrink-0 text-[10px]">
                        {formatSize(entry.size)}
                    </Text>
                )}

                {/* 音频播放指示 */}
                {isPlaying && (
                    <PlayIcon
                        width="10"
                        height="10"
                        className="shrink-0 text-qt-highlight animate-pulse"
                    />
                )}
            </div>
        );
    },
);

FileEntryRow.displayName = "FileEntryRow";
