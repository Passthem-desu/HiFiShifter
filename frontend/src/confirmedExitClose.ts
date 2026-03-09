export async function runConfirmedExitClose(args: {
    markAllowClose: () => void;
    destroyWindow: () => Promise<void>;
    closeWindow: () => Promise<void>;
}): Promise<void> {
    const { markAllowClose, destroyWindow, closeWindow } = args;

    const runWithAllowClose = async (action: () => Promise<void>) => {
        markAllowClose();
        await action();
    };

    try {
        await runWithAllowClose(destroyWindow);
        return;
    } catch {
        await runWithAllowClose(closeWindow);
    }
}
