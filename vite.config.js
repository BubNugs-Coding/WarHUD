import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Embedded WebViews (Even simulator) sometimes miss HMR; explicit client helps some hosts.
    hmr: {
      protocol: "ws",
      host: "localhost",
      port: 5173,
      clientPort: 5173
    },
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true
      }
    }
  }
});
