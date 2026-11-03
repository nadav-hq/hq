import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    // DB tests share one database; run files sequentially.
    fileParallelism: false,
  },
});
