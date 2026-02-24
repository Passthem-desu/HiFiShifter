/** @type {import('tailwindcss').Config} */
export default {
    content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
    theme: {
        extend: {
            colors: {
                qt: {
                    window: "var(--qt-window)",
                    base: "var(--qt-base)",
                    panel: "var(--qt-panel)",
                    surface: "var(--qt-surface)",
                    text: "var(--qt-text)",
                    "text-muted": "var(--qt-text-muted)",
                    highlight: "var(--qt-highlight)",
                    playhead: "var(--qt-playhead)",
                    button: "var(--qt-button)",
                    "button-hover": "var(--qt-button-hover)",
                    border: "var(--qt-border)",
                    "danger-bg": "var(--qt-danger-bg)",
                    "danger-text": "var(--qt-danger-text)",
                    "danger-border": "var(--qt-danger-border)",
                    "warning-bg": "var(--qt-warning-bg)",
                    "warning-text": "var(--qt-warning-text)",
                    "warning-border": "var(--qt-warning-border)",
                    "graph-bg": "var(--qt-graph-bg)",
                    "graph-grid-strong": "var(--qt-graph-grid-strong)",
                    "graph-grid-weak": "var(--qt-graph-grid-weak)",
                    "scrollbar-thumb": "var(--qt-scrollbar-thumb)",
                    "scrollbar-thumb-hover": "var(--qt-scrollbar-thumb-hover)",
                },
            },
            fontFamily: {
                sans: [
                    "Segoe UI",
                    "Roboto",
                    "Helvetica",
                    "Arial",
                    "sans-serif",
                ],
            },
            fontSize: {
                xs: "0.7rem",
                sm: "0.8rem",
                base: "0.9rem",
            },
        },
    },
    plugins: [],
};
