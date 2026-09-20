import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: [".review-tmp/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    reporters: ["default"],
  },
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
});
