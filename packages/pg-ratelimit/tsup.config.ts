import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  external: ["pg"],
  esbuildOptions(options) {
    options.loader = { ...options.loader, ".sql": "text" };
  },
});
