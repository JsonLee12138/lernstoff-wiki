import { existsSync, mkdirSync, copyFileSync, cpSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");

// 1. Sync Obsidian plugin distribution assets
const pluginSrcDir = join(root, "packages/obsidian-plugin/dist");
const pluginTargetDir = join(root, "packages/cli/assets/plugin");

if (!existsSync(pluginSrcDir)) {
  console.warn("⚠️ Plugin dist does not exist yet. Run build on obsidian-plugin first.");
} else {
  mkdirSync(pluginTargetDir, { recursive: true });
  const files = ["main.js", "manifest.json", "styles.css"];
  for (const file of files) {
    const src = join(pluginSrcDir, file);
    if (existsSync(src)) {
      copyFileSync(src, join(pluginTargetDir, file));
      console.log(`Synced ${file} to packages/cli/assets/plugin/`);
    }
  }
}

// 2. Sync lernstoff-wiki agent skill
const skillSrcDir = join(root, "skills/lernstoff-wiki");
const skillTargetDir = join(root, "packages/cli/assets/skills/lernstoff-wiki");

if (existsSync(skillSrcDir)) {
  mkdirSync(skillTargetDir, { recursive: true });
  cpSync(skillSrcDir, skillTargetDir, { recursive: true });
  console.log("Synced skills/lernstoff-wiki to packages/cli/assets/skills/lernstoff-wiki");
}
