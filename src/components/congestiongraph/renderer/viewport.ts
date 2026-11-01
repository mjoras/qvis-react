// Zoom / pan arithmetic of the congestion graph (parity/congestion-graph.md §2.8, §3.5, §3.7). Pure.

/** qvis xScalingFunction (R:1778-1780): sigmoid-like, 1.4689 at 1x zoom, approaching 2.2. */
export function xDrawScale(zoom: number): number {
    return 1 / (1 + Math.exp(-(zoom - 2))) + 1.2;
}

/**
 * Cursor-anchored wheel zoom (R:1481-1511): one 1.5x step per wheel event; wheel down zooms out. The time under the
 * cursor stays fixed; zooming out stops at `[0, maxX]`. Returns undefined for `deltaY === 0` (FIX Q14: horizontal
 * swipes zoomed in).
 */
export function wheelZoom(
    deltaY: number,
    mouseX: number,
    range: readonly [number, number],
    maxX: number,
): [number, number] | undefined {
    if (deltaY === 0 || Number.isNaN(deltaY)) return undefined;
    const zoomFactor = deltaY > 0 ? 1 / 1.5 : 1.5;
    const [leftX, rightX] = range;
    const zoomedLeftPortion = (mouseX - leftX) / zoomFactor;
    const zoomedRightPortion = (rightX - mouseX) / zoomFactor;
    const newLeftX = mouseX - zoomedLeftPortion >= 0 ? mouseX - zoomedLeftPortion : 0;
    const newRightX = mouseX + zoomedRightPortion <= maxX ? mouseX + zoomedRightPortion : maxX;
    return [newLeftX, newRightX];
}

/**
 * Pan with clamping (panCanvas, R:1699-1723): a delta that would leave `[0, original[1]]` snaps to the boundary.
 * Returns the new x and y ranges.
 */
export function panClamp(
    deltaXin: number,
    deltaYin: number,
    rangeX: readonly [number, number],
    rangeY: readonly [number, number],
    originalRangeX: readonly [number, number],
    originalRangeY: readonly [number, number],
): { x: [number, number]; y: [number, number] } {
    let deltaX = deltaXin;
    let deltaY = deltaYin;
    if (rangeX[0] + deltaX < 0) {
        deltaX = 0 - rangeX[0];
    } else if (rangeX[1] + deltaX > originalRangeX[1]) {
        deltaX = originalRangeX[1] - rangeX[1];
    }
    if (rangeY[0] + deltaY < 0) {
        deltaY = 0 - rangeY[0];
    } else if (rangeY[1] + deltaY > originalRangeY[1]) {
        deltaY = originalRangeY[1] - rangeY[1];
    }
    return {
        x: [rangeX[0] + deltaX, rangeX[1] + deltaX],
        y: [rangeY[0] + deltaY, rangeY[1] + deltaY],
    };
}
