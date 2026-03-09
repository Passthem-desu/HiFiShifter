export async function runConfirmedExitClose(args) {
    const { markAllowClose, destroyWindow, closeWindow } = args;
    markAllowClose();
    try {
        await destroyWindow();
        return;
    }
    catch {
        await closeWindow();
    }
}
