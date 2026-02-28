import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "raw-sql",
      transform(code, id) {
        if (id.endsWith(".sql")) {
          return { code: `export default ${JSON.stringify(code)}`, map: null };
        }
      },
    },
  ],
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
