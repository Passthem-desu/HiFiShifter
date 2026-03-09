import {
    getActiveSecondaryParamId,
    resolveSecondaryOverlayValues,
    toggleSecondaryParamVisibility,
} from "./secondaryOverlaySelection.js";

function assertEqual<T>(actual: T, expected: T): void {
    if (actual !== expected) {
        throw new Error(
            `Expected ${String(expected)}, received ${String(actual)}`,
        );
    }
}

function assertDeepEqual<T>(actual: T, expected: T): void {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);
    if (actualJson !== expectedJson) {
        throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
    }
}

const processorParamIds = ["tension", "breathiness", "energy"];

assertDeepEqual(toggleSecondaryParamVisibility({}, "tension"), {
    tension: true,
});

assertDeepEqual(
    toggleSecondaryParamVisibility({ tension: true }, "breathiness"),
    {
        breathiness: true,
    },
);

assertDeepEqual(
    toggleSecondaryParamVisibility({ breathiness: true }, "breathiness"),
    {},
);

assertEqual(
    getActiveSecondaryParamId({
        editParam: "pitch",
        processorParamIds,
        secondaryParamVisible: { energy: true },
    }),
    "energy",
);

assertEqual(
    getActiveSecondaryParamId({
        editParam: "tension",
        processorParamIds,
        secondaryParamVisible: { breathiness: true },
    }),
    "breathiness",
);

assertEqual(
    getActiveSecondaryParamId({
        editParam: "tension",
        processorParamIds,
        secondaryParamVisible: { pitch: true },
    }),
    "pitch",
);

assertEqual(
    getActiveSecondaryParamId({
        editParam: "breathiness",
        processorParamIds,
        secondaryParamVisible: { breathiness: true },
    }),
    null,
);

assertDeepEqual(
    resolveSecondaryOverlayValues({
        orig: [1, 2, 3, 4],
        edit: [1, 9, Number.NaN, 4],
    }),
    [1, 9, 3, 4],
);

assertDeepEqual(
    resolveSecondaryOverlayValues({
        orig: [4, 5, 6],
        edit: [7],
    }),
    [7, 5, 6],
);

console.log("secondary overlay selection checks passed");
