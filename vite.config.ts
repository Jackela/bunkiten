import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// acp-server 默认监听 7800（被占则 +1）；dev proxy 固定指向首个默认端口
const acpTarget = process.env.ACP_PROXY_TARGET || "http://localhost:7800";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 生产环境由 acp-server 的 /app 路径托管 dist，必须用相对资源路径
  base: "./",
  build: {
    // 大依赖拆成独立 chunk：单包超 500kB 时 Vite 报警，而且任一业务改动都会让整包缓存失效。
    // codeSplitting 只动产物分组，不改任何 import 语义；base:"." 下相对路径照常解析。
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "motion", test: /node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/ },
            { name: "vendor", test: /node_modules[\\/]/ },
          ],
        },
      },
    },
  },
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
