function normalizeStep(step) {
    if (!Number.isFinite(step) || step <= 0) {
        return 0.05;
    }
    if (step >= 1) {
        return Number(step.toFixed(2));
    }
    if (step >= 0.1) {
        return Number(step.toFixed(2));
    }
    return Number(step.toFixed(3));
}
export function getParamShiftStep(paramId, descriptor) {
    if (paramId === "pitch") {
        return 1;
    }
    if (descriptor?.kind.type === "automation_curve") {
        const range = Math.abs(descriptor.kind.max_value - descriptor.kind.min_value);
        return normalizeStep(range / 40);
    }
    return 0.05;
}
