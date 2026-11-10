import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const CLI_VERSION: string = (() => {
  try {
    return require("../package.json").version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
