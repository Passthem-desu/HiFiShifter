export function gridStepBeats(grid: string): number {
    if (grid === "1/8") return 0.5;
    if (grid === "1/16") return 0.25;
    if (grid === "1/32") return 0.125;
    return 1;
}
