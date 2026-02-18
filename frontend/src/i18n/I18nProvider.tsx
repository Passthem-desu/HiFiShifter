import {
    createContext,
    useContext,
    useMemo,
    useState,
    type PropsWithChildren,
} from "react";
import { messages, type Locale, type MessageKey } from "./messages";

interface I18nContextValue {
    locale: Locale;
    setLocale: (locale: Locale) => void;
    t: (key: MessageKey) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const STORAGE_KEY = "hifishifter.locale";

function getDefaultLocale(): Locale {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "zh-CN" || stored === "en-US") {
        return stored;
    }
    return navigator.language.toLowerCase().startsWith("zh")
        ? "zh-CN"
        : "en-US";
}

export function I18nProvider({ children }: PropsWithChildren) {
    const [localeState, setLocaleState] = useState<Locale>(getDefaultLocale);

    const value = useMemo<I18nContextValue>(() => {
        return {
            locale: localeState,
            setLocale: (nextLocale: Locale) => {
                setLocaleState(nextLocale);
                localStorage.setItem(STORAGE_KEY, nextLocale);
            },
            t: (key: MessageKey) =>
                messages[localeState][key] ?? messages["en-US"][key],
        };
    }, [localeState]);

    return (
        <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
    );
}

export function useI18n() {
    const context = useContext(I18nContext);
    if (!context) {
        throw new Error("useI18n must be used within I18nProvider");
    }
    return context;
}
