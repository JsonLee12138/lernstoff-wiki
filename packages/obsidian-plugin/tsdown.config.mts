import { defineConfig } from "tsdown";
import { resolve } from "node:path";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["cjs"],
  outDir: "dist",
  dts: false,
  outExtensions: () => ({ js: ".js" }),
  copy: ["manifest.json", "styles.css"],
  alias: {
    "@lernstoff/core/config": resolve(import.meta.dirname, "../core/src/config.ts"),
  },
  deps: {
    neverBundle: ["obsidian"],
    alwaysBundle: [/^@lernstoff\//, /^zod/],
    onlyBundle: false,
  },
  clean: true,
});
