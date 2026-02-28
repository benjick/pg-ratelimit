import { defineConfig } from "oxlint";

export default defineConfig({
  categories: {
    correctness: "error",
    suspicious: "warn",
    pedantic: "off",
    perf: "warn",
    style: "off",
  },
  rules: {
    "typescript/no-explicit-any": "error",
    "no-console": "off",
    "no-await-in-loop": "off",
    curly: "error",
  },
  ignorePatterns: ["dist/", "node_modules/", "docs/", "*.d.ts"],
  overrides: [
    {
      files: ["**/__tests__/**"],
      rules: {
        "typescript/no-explicit-any": "off",
        "no-console": "off",
      },
    },
  ],
});
