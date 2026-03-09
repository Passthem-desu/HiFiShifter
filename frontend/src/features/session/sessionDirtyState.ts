export function markProjectDirty(project: { dirty: boolean }): void {
    project.dirty = true;
}