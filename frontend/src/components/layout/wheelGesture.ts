const WHEEL_AXIS_EPSILON = 0.5;

export type ParamEditorWheelAction =
    | "horizontal-scroll"
    | "vertical-pan"
    | "vertical-zoom";

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

export function getParamEditorWheelAction(input: {
    deltaX: number;
    deltaY: number;
    horizontalScrollModifier: boolean;
    verticalPanModifier: boolean;
}): ParamEditorWheelAction {
    if (input.horizontalScrollModifier) {
        return "horizontal-scroll";
    }

    if (input.verticalPanModifier) {
        return "vertical-pan";
    }

    return getWheelGestureAxis(input) === "horizontal"
        ? "horizontal-scroll"
        : "vertical-zoom";
}
