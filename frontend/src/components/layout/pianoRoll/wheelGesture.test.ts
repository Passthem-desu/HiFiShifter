import {
    getParamEditorWheelAction,
    getWheelGestureAxis,
} from "./wheelGesture.js";

function assertEqual<T>(actual: T, expected: T): void {
    if (actual !== expected) {
        throw new Error(
            `Expected ${String(expected)}, received ${String(actual)}`,
        );
    }
}

assertEqual(getWheelGestureAxis({ deltaX: 48, deltaY: 6 }), "horizontal");
assertEqual(getWheelGestureAxis({ deltaX: 6, deltaY: 48 }), "vertical");
assertEqual(getWheelGestureAxis({ deltaX: 0.2, deltaY: 0.1 }), "vertical");
assertEqual(
    getParamEditorWheelAction({
        deltaX: 48,
        deltaY: 6,
        horizontalScrollModifier: false,
        verticalPanModifier: false,
    }),
    "horizontal-scroll",
);
assertEqual(
    getParamEditorWheelAction({
        deltaX: 6,
        deltaY: 48,
        horizontalScrollModifier: false,
        verticalPanModifier: false,
    }),
    "vertical-zoom",
);
assertEqual(
    getParamEditorWheelAction({
        deltaX: 6,
        deltaY: 48,
        horizontalScrollModifier: false,
        verticalPanModifier: true,
    }),
    "vertical-pan",
);
assertEqual(
    getParamEditorWheelAction({
        deltaX: 0,
        deltaY: 48,
        horizontalScrollModifier: true,
        verticalPanModifier: false,
    }),
    "horizontal-scroll",
);

console.log("wheel gesture checks passed");
