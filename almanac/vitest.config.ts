import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts", // bootstrap; only verifiable in real-Slack integration
        "src/connectors/types.ts", // type declarations only
        "src/test-setup.ts",
        "src/**/*.test.ts",
      ],
      thresholds: {
        branches: 60,
        functions: 75,
        lines: 75,
        statements: 75,
      },
    },
  },
});
