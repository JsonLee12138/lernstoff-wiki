import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/config.ts", "src/vault-init.ts", "src/algorithms/scratchpad-gc.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
});
