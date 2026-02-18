import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "./index.css";
import App from "./App.tsx";
import { store } from "./app/store";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <Provider store={store}>
            <Theme
                appearance="dark"
                accentColor="blue"
                grayColor="slate"
                radius="medium"
            >
                <App />
            </Theme>
        </Provider>
    </StrictMode>,
);
