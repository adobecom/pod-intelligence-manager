import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import macros from "unplugin-parcel-macros";
import path from "path";

export default defineConfig({
  plugins: [
    macros.vite(),
    react(),
  ],
  resolve: {
    alias: {
      "@pim/shared": path.resolve(__dirname, "../shared/src"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:4000",
      "/ws": {
        target: "ws://localhost:4000",
        ws: true,
      },
      "/tunnel": "http://localhost:4000",
    },
  },
});
