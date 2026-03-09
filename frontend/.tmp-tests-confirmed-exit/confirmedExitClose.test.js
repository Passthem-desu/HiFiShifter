import { runConfirmedExitClose } from "./confirmedExitClose.js";
function assertEqual(actual, expected) {
    if (actual !== expected) {
        throw new Error(`Expected ${String(expected)}, received ${String(actual)}`);
    }
}
async function main() {
    const calls = [];
    await runConfirmedExitClose({
        markAllowClose: () => {
            calls.push("allow");
        },
        destroyWindow: async () => {
            calls.push("destroy");
        },
        closeWindow: async () => {
            calls.push("close");
        },
    });
    assertEqual(calls.join(","), "allow,destroy");
    console.log("confirmed exit close checks passed");
}
void main();
