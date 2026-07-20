import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    setupFiles: ["./src/test/setup-db.ts"],
  },
});
