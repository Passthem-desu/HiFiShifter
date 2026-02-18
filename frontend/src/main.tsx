import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "./index.css";
import App from "./App.tsx";
import { store } from "./app/store";
import { I18nProvider } from "./i18n/I18nProvider";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <Provider store={store}>
            <I18nProvider>
                <Theme
                    appearance="dark"
                    accentColor="iris"
                    grayColor="mauve"
                    radius="medium"
                >
                    <App />
                </Theme>
            </I18nProvider>
        </Provider>
    </StrictMode>,
);
