export type TrackParentRef = {
    id: string;
    parentId?: string | null;
};

export function resolveRootTrackId(
    tracks: TrackParentRef[],
    selectedTrackId: string | null,
): string | null {
    const selected = selectedTrackId ?? tracks[0]?.id ?? null;
    if (!selected) return null;

    const byId = new Map(tracks.map((tr) => [tr.id, tr] as const));
    let cur = selected;
    let guard = 0;
    while (guard++ < 2048) {
        const tr = byId.get(cur);
        const parent = tr?.parentId ?? null;
        if (!parent) return cur;
        cur = parent;
    }

    return selected;
}
