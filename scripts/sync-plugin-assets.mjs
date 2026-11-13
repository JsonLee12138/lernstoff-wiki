import { existsSync, mkdirSync, copyFileSync, cpSync, readdirSync } from "node:fs";
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

// 2. Sync agent skills
const skillsRoot = join(root, "skills");
const skillsTargetBase = join(root, "packages/cli/assets/skills");

if (existsSync(skillsRoot)) {
  mkdirSync(skillsTargetBase, { recursive: true });
  const entries = readdirSync(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillDir = join(skillsRoot, entry.name);
      if (existsSync(join(skillDir, "SKILL.md"))) {
        const targetDir = join(skillsTargetBase, entry.name);
        mkdirSync(targetDir, { recursive: true });
        cpSync(skillDir, targetDir, { recursive: true });
        console.log(`Synced skills/${entry.name} to packages/cli/assets/skills/${entry.name}`);
      }
    }
  }
}
