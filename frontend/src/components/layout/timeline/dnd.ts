export function hasFileDrag(dt: DataTransfer): boolean {
    if (!dt) return false;
    if (dt.files && dt.files.length > 0) return true;
    const types = Array.from(dt.types ?? []);
    if (types.includes("Files")) return true;
    const items = Array.from(dt.items ?? []);
    return items.some((it) => it.kind === "file");
}

export function extractLocalFilePath(
    dt: DataTransfer,
): { path: string; name: string } | null {
    const itemFile = Array.from(dt.items ?? [])
        .find((it) => it.kind === "file")
        ?.getAsFile() as any;
    const file = (dt.files?.[0] as any) ?? itemFile;

    const directPath = String(file?.path ?? "").trim();
    if (directPath) {
        return {
            path: directPath,
            name: String(file?.name ?? directPath),
        };
    }

    const uriList = String(dt.getData("text/uri-list") ?? "").trim();
    if (uriList) {
        const first = uriList
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line && !line.startsWith("#"));
        if (first) {
            try {
                const url = new URL(first);
                if (url.protocol === "file:") {
                    let p = decodeURIComponent(url.pathname);
                    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
                    if (p) {
                        return {
                            path: p,
                            name: String(file?.name ?? p),
                        };
                    }
                }
            } catch {
                // ignore
            }
        }
    }

    const text = String(dt.getData("text/plain") ?? "").trim();
    if (text && (text.includes("\\") || /^[A-Za-z]:\\/.test(text))) {
        return {
            path: text,
            name: String(file?.name ?? text),
        };
    }

    return null;
}
