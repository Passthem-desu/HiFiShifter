/**
 * Piano Roll coordinate transformation utilities
 *
 * Ensures consistent frame ↔ time conversion across all components.
 */

/**
 * Convert frame number to time in seconds.
 *
 * @param frame - Frame index (0-based)
 * @param framePeriodMs - Frame period in milliseconds (typically 5.0ms)
 * @returns Time in seconds
 *
 * Formula: time_sec = (frame * framePeriodMs) / 1000
 */
export function framesToTime(frame: number, framePeriodMs: number): number {
    const fp = Math.max(1e-6, framePeriodMs); // Prevent division by zero
    return (frame * fp) / 1000;
}

/**
 * Convert time in seconds to frame number.
 *
 * @param timeSec - Time in seconds
 * @param framePeriodMs - Frame period in milliseconds (typically 5.0ms)
 * @returns Frame index (floored to integer)
 *
 * Formula: frame = floor(timeSec * 1000 / framePeriodMs)
 */
export function timeToFrame(timeSec: number, framePeriodMs: number): number {
    const fp = Math.max(1e-6, framePeriodMs); // Prevent division by zero
    return Math.floor((timeSec * 1000) / fp);
}

/**
 * Convert time in seconds to canvas pixel position.
 *
 * @param timeSec - Time in seconds
 * @param visibleStartSec - Start of visible time range
 * @param visibleDurSec - Duration of visible time range
 * @param canvasWidth - Width of canvas in pixels
 * @returns Pixel position (0 = left edge, canvasWidth = right edge)
 */
export function timeToPixel(
    timeSec: number,
    visibleStartSec: number,
    visibleDurSec: number,
    canvasWidth: number,
): number {
    const denom = Math.max(1e-9, visibleDurSec);
    return ((timeSec - visibleStartSec) / denom) * canvasWidth;
}

/**
 * Convert canvas pixel position to time in seconds.
 *
 * @param pixelX - Pixel position on canvas
 * @param visibleStartSec - Start of visible time range
 * @param visibleDurSec - Duration of visible time range
 * @param canvasWidth - Width of canvas in pixels
 * @returns Time in seconds
 */
export function pixelToTime(
    pixelX: number,
    visibleStartSec: number,
    visibleDurSec: number,
    canvasWidth: number,
): number {
    const w = Math.max(1, canvasWidth);
    return visibleStartSec + (pixelX / w) * visibleDurSec;
}
