import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type PropsWithChildren,
} from "react";
import { Theme } from "@radix-ui/themes";

export type ThemeMode = "dark" | "light";

interface ThemeContextValue {
    mode: ThemeMode;
    setMode: (mode: ThemeMode) => void;
    toggleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "hifishifter.theme";

function getDefaultMode(): ThemeMode {
    const fromStorage = localStorage.getItem(STORAGE_KEY);
    if (fromStorage === "light" || fromStorage === "dark") return fromStorage;

    const prefersDark =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
}

export function AppThemeProvider({ children }: PropsWithChildren) {
    const [mode, setModeState] = useState<ThemeMode>(getDefaultMode);

    const setMode = useCallback((next: ThemeMode) => {
        setModeState(next);
        localStorage.setItem(STORAGE_KEY, next);
    }, []);

    const toggleMode = useCallback(() => {
        setMode(mode === "dark" ? "light" : "dark");
    }, [mode, setMode]);

    useEffect(() => {
        document.documentElement.dataset.theme = mode;
    }, [mode]);

    const value = useMemo<ThemeContextValue>(
        () => ({ mode, setMode, toggleMode }),
        [mode, setMode, toggleMode],
    );

    return (
        <ThemeContext.Provider value={value}>
            <Theme
                appearance={mode}
                accentColor="iris"
                grayColor="mauve"
                radius="medium"
                className={`qt-theme ${mode}`}
            >
                {children}
            </Theme>
        </ThemeContext.Provider>
    );
}

export function useAppTheme() {
    const ctx = useContext(ThemeContext);
    if (!ctx) {
        throw new Error("useAppTheme must be used within AppThemeProvider");
    }
    return ctx;
}
