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
): string {
    if (width <= 0 || height <= 0) return "";
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < steps; i++) {
        const t = i / Math.max(1, steps - 1);
        const x = t * width;
        const g = Math.sin((t * Math.PI) / 2); // curved
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
): string {
    if (width <= 0 || height <= 0) return "";
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < steps; i++) {
        const t = i / Math.max(1, steps - 1);
        const x = t * width;
        const g = Math.cos((t * Math.PI) / 2); // curved
        const y = height * (1 - g);
        pts.push({ x, y });
    }
    let d = `M 0 ${height.toFixed(2)}`;
    // first point is near top; the polygon still references bottom-left first.
    for (const p of pts) d += ` L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
    d += ` L ${width.toFixed(2)} ${height.toFixed(2)} Z`;
    return d;
}
