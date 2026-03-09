export async function runConfirmedExitClose(args) {
    const { markAllowClose, destroyWindow, closeWindow } = args;
    const runWithAllowClose = async (action) => {
        markAllowClose();
        await action();
    };
    try {
        await runWithAllowClose(destroyWindow);
        return;
    }
    catch {
        await runWithAllowClose(closeWindow);
    }
}
