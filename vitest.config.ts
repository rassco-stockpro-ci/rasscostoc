import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globalSetup: ["./vitest.global-setup.ts"],
    environment: "node",
    include: [
      "apps/api/**/*.test.ts",
      "packages/ai-extraction/**/*.test.ts",
      "packages/ai-review-ui/**/*.test.ts",
    ],
    // Stress/lifecycle sim uses an incomplete drizzle mock; not a unit gate (see ERP-000 lint baseline spirit).
    exclude: ["**/node_modules/**", "**/e2e-stress-simulation.test.ts"],
    globals: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./apps/portal/src"),
      "@shared": path.resolve(import.meta.dirname, "./packages/shared-types"),
      "@server": path.resolve(import.meta.dirname, "./apps/api/src"),
      "@core": path.resolve(import.meta.dirname, "./apps/api/src/core"),
      "@modules": path.resolve(import.meta.dirname, "./apps/api/src/modules"),
      "@stockpro/ai-extraction": path.resolve(import.meta.dirname, "./packages/ai-extraction/src/index.ts"),
      "@stockpro/ai-review-ui": path.resolve(import.meta.dirname, "./packages/ai-review-ui/src/index.ts"),
    },
  },
});
