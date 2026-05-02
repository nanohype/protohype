import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "cdk.out/", "node_modules/", "coverage/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // core/ MUST be pure — no AWS SDK, no HTTP clients, no adapters.
    // The only I/O core/ knows about is the ports defined in src/core/ports.ts.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@aws-sdk/*"], message: "core/ must not import AWS SDKs. Put that in src/adapters/." },
            { group: ["@octokit/*"], message: "core/ must not import Octokit. Put that in src/adapters/github-app/." },
            { group: ["@slack/*"], message: "core/ must not import Slack SDK. Put that in src/adapters/slack/." },
            { group: ["hono", "hono/*", "@hono/*"], message: "core/ must not import Hono — it's an HTTP framework. core/ is pure." },
            { group: ["jose"], message: "core/ must not import jose — put JWT verify in src/adapters/workos-authkit/." },
            { group: ["**/adapters/*", "**/adapters"], message: "core/ must not import adapters directly. Depend on src/core/ports.ts instead." },
            { group: ["**/handlers/*"], message: "core/ must not import handlers." },
            { group: ["**/api/*"], message: "core/ must not import api/." },
          ],
        },
      ],
    },
  },
  {
    // Tests can use all the things.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
);
