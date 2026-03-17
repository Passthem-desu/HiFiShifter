const WHEEL_AXIS_EPSILON = 0.5;

export function getWheelGestureAxis(input: {
    deltaX: number;
    deltaY: number;
}): "horizontal" | "vertical" {
    const absX = Math.abs(input.deltaX);
    const absY = Math.abs(input.deltaY);

    if (absX > WHEEL_AXIS_EPSILON && absX > absY) {
        return "horizontal";
    }

    return "vertical";
}
