import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
    base: "./",
    plugins: [react()],
    server: {
        port: 5173,
        strictPort: true,
        watch: {
            // 避免监听过多文件
            ignored: ["**/node_modules/**", "**/dist/**"],
        },
    },
    // 开发模式下清除缓存，确保总是重新构建
    clearScreen: false,
});
