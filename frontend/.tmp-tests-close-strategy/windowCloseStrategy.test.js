import { getConfirmedExitCloseStrategy } from "./windowCloseStrategy.js";
function assertEqual(actual, expected) {
    if (actual !== expected) {
        throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
    }
}
assertEqual(getConfirmedExitCloseStrategy(), "destroy");
console.log("window close strategy checks passed");
