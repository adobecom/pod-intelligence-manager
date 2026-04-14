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
      "@council/shared": path.resolve(__dirname, "../shared/src"),
    },
  },
});
