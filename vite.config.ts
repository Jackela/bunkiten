import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// acp-server 默认监听 7800（被占则 +1）；dev proxy 固定指向首个默认端口
const acpTarget = process.env.ACP_PROXY_TARGET || "http://localhost:7800";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 生产环境由 acp-server 的 /app 路径托管 dist，必须用相对资源路径
  base: "./",
  server: {
    proxy: {
      "/api": acpTarget,
      "/events": acpTarget,
      "/prompt": acpTarget,
      "/img": acpTarget,
      "/audio": acpTarget,
    },
  },
});
