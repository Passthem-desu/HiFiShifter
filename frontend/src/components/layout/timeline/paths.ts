export type FadeCurveType = "linear" | "sine" | "exponential" | "logarithmic" | "scurve";

/** 将 t ∈ [0,1] 映射为增益 ∈ [0,1]，根据曲线类型选择不同的插值函数 */
export function fadeCurveGain(t: number, curve: FadeCurveType): number {
    switch (curve) {
        case "linear":      return t;
        case "exponential": return t * t;
        case "logarithmic": return Math.sqrt(t);
        case "scurve":      return 3 * t * t - 2 * t * t * t;
        case "sine":
        default:            return Math.sin((t * Math.PI) / 2);
    }
}

export function waveformAreaPath(
    samples: number[],
    width: number,
    height: number,
    ampScale: number = 1,
): string {
    if (!samples.length || width <= 0 || height <= 0) return "";
    const mid = height / 2;
    const scale = height * 0.45;
    const step = width / Math.max(1, samples.length - 1);
    const s = Math.max(0, Number(ampScale) || 0);
    let top = `M 0 ${mid.toFixed(2)}`;
    for (let i = 0; i < samples.length; i++) {
        const x = i * step;
        const amp = Math.max(0, Math.min(1, Math.abs(samples[i] ?? 0) * s));
        const y = mid - amp * scale;
        top += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    let bottom = "";
    for (let i = samples.length - 1; i >= 0; i--) {
        const x = i * step;
        const amp = Math.max(0, Math.min(1, Math.abs(samples[i] ?? 0) * s));
        const y = mid + amp * scale;
        bottom += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    return `${top}${bottom} Z`;
}

export function fadeInAreaPath(
    width: number,
    height: number,
    steps = 24,
    curve: FadeCurveType = "sine",
): string {
    if (width <= 0 || height <= 0) return "";
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < steps; i++) {
        const t = i / Math.max(1, steps - 1);
        const x = t * width;
        const g = fadeCurveGain(t, curve);
        const y = height * (1 - g);
        pts.push({ x, y });
    }
    let d = `M 0 ${height.toFixed(2)}`;
    for (const p of pts) d += ` L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
    d += ` L ${width.toFixed(2)} ${height.toFixed(2)} Z`;
    return d;
}

export function fadeOutAreaPath(
    width: number,
    height: number,
    steps = 24,
    curve: FadeCurveType = "sine",
): string {
    if (width <= 0 || height <= 0) return "";
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < steps; i++) {
        const t = i / Math.max(1, steps - 1);
        const x = t * width;
        // fadeOut: t=0 时增益为 1，t=1 时增益为 0，故用 1-t 映射
        const g = fadeCurveGain(1 - t, curve);
        const y = height * (1 - g);
        pts.push({ x, y });
    }
    let d = `M 0 ${height.toFixed(2)}`;
    for (const p of pts) d += ` L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
    d += ` L ${width.toFixed(2)} ${height.toFixed(2)} Z`;
    return d;
}
