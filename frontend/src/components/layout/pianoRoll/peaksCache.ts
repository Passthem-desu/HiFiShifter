export type CachedPeaks = { min: number[]; max: number[]; t: number };

export function lruGet<K, V>(m: Map<K, V>, k: K): V | null {
    const v = m.get(k);
    if (v === undefined) return null;
    m.delete(k);
    m.set(k, v);
    return v;
}

export function lruSet<K, V>(m: Map<K, V>, k: K, v: V, limit: number) {
    m.set(k, v);
    while (m.size > limit) {
        const oldest = m.keys().next().value as K | undefined;
        if (oldest === undefined) break;
        m.delete(oldest);
    }
}
