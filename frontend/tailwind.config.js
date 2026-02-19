/** @type {import('tailwindcss').Config} */
export default {
    content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
    theme: {
        extend: {
            colors: {
                qt: {
                    window: "var(--qt-window)",
                    base: "var(--qt-base)",
                    text: "var(--qt-text)",
                    highlight: "var(--qt-highlight)",
                    button: "var(--qt-button)",
                    "button-hover": "var(--qt-button-hover)",
                    border: "var(--qt-border)",
                    "graph-bg": "var(--qt-graph-bg)",
                    "graph-grid-strong": "var(--qt-graph-grid-strong)",
                    "graph-grid-weak": "var(--qt-graph-grid-weak)",
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
