import { getWheelGestureAxis } from "./wheelGesture.js";

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

console.log("wheel gesture checks passed");
