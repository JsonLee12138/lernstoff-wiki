import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const srcDir = join(root, "packages/obsidian-plugin/dist");
const targetDir = join(root, "packages/cli/assets/plugin");

if (!existsSync(srcDir)) {
  console.warn("⚠️ Plugin dist does not exist yet. Run build on obsidian-plugin first.");
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });
const files = ["main.js", "manifest.json", "styles.css"];
for (const file of files) {
  const src = join(srcDir, file);
  if (existsSync(src)) {
    copyFileSync(src, join(targetDir, file));
    console.log(`Synced ${file} to packages/cli/assets/plugin/`);
  }
}
