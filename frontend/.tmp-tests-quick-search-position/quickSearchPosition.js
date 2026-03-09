export const QUICK_SEARCH_POPUP_WIDTH = 320;
export const QUICK_SEARCH_POPUP_HEIGHT = 400;
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
export function getQuickSearchInitialPosition(input) {
    const maxX = Math.max(0, input.viewportWidth - QUICK_SEARCH_POPUP_WIDTH - 20);
    const maxY = Math.max(0, input.viewportHeight - QUICK_SEARCH_POPUP_HEIGHT);
    if (input.pointer) {
        return {
            x: clamp(input.pointer.x, 0, maxX),
            y: clamp(input.pointer.y, 0, maxY),
        };
    }
    return {
        x: Math.max(0, Math.round(input.viewportWidth / 2 - QUICK_SEARCH_POPUP_WIDTH / 2)),
        y: Math.max(0, Math.round(input.viewportHeight / 2 - QUICK_SEARCH_POPUP_HEIGHT / 2)),
    };
}
