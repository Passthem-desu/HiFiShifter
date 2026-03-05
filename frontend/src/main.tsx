import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import "@radix-ui/themes/styles.css";
import "./index.css";
import App from "./App.tsx";
import { store } from "./app/store";
import { I18nProvider } from "./i18n/I18nProvider";
import { AppThemeProvider } from "./theme/AppThemeProvider";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <Provider store={store}>
            <I18nProvider>
                <AppThemeProvider>
                    <App />
                </AppThemeProvider>
            </I18nProvider>
        </Provider>
    </StrictMode>,
);

// React 渲染完成后显示窗口，避免首屏白屏
import("@tauri-apps/api/window").then((mod) => {
    mod.getCurrentWindow().show();
}).catch(() => {
    // 非 Tauri 环境（如浏览器开发）忽略错误
});
