import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/hono.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  external: ["pg", "hono"],
  esbuildOptions(options) {
    options.loader = { ...options.loader, ".sql": "text" };
  },
});
