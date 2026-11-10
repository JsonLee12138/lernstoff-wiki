import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLI_VERSION } from "./version.js";

export interface InstallPluginOptions {
  vaultPath: string;
  version?: string;
  silent?: boolean;
}

export interface InstallPluginResult {
  targetPluginDir: string;
  source: "local" | "release";
}

/**
 * Known locations where plugin assets might reside in development or production.
 */
export function getPluginCandidateDirs(): string[] {
  return [
    join(import.meta.dirname, "../assets/plugin"),
    join(import.meta.dirname, "assets/plugin"),
    join(import.meta.dirname, "../../obsidian-plugin/dist"),
    join(import.meta.dirname, "../node_modules/@lernstoff/obsidian-plugin/dist"),
    join(process.cwd(), "packages/obsidian-plugin/dist"),
    join(process.cwd(), "assets/plugin"),
  ];
}

/**
 * Locate directory containing compiled Obsidian plugin assets (main.js, manifest.json).
 */
export function findLocalPluginAssetsDir(): string | null {
  const candidates = getPluginCandidateDirs();
  for (const dir of candidates) {
    if (existsSync(join(dir, "main.js")) && existsSync(join(dir, "manifest.json"))) {
      return dir;
    }
  }
  return null;
}

/**
 * Attempt to download a single file from GitHub Releases.
 * Tries versioned tag first, falls back to latest release.
 */
export async function downloadReleaseAsset(
  version: string,
  filename: string,
): Promise<Buffer | null> {
  const urls = [
    `https://github.com/JsonLee12138/lernstoff-wiki/releases/download/v${version}/${filename}`,
    `https://github.com/JsonLee12138/lernstoff-wiki/releases/latest/download/${filename}`,
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (response.ok) {
        const arrayBuf = await response.arrayBuffer();
        return Buffer.from(arrayBuf);
      }
    } catch {
      // Continue to next candidate URL
    }
  }
  return null;
}

/**
 * Downloads compiled plugin assets from GitHub Releases directly into target directory.
 */
export async function downloadPluginAssets(targetDir: string, version: string): Promise<boolean> {
  const mainJs = await downloadReleaseAsset(version, "main.js");
  const manifestJson = await downloadReleaseAsset(version, "manifest.json");

  if (!mainJs || !manifestJson) {
    return false;
  }

  writeFileSync(join(targetDir, "main.js"), mainJs);
  writeFileSync(join(targetDir, "manifest.json"), manifestJson);

  const stylesCss = await downloadReleaseAsset(version, "styles.css");
  if (stylesCss) {
    writeFileSync(join(targetDir, "styles.css"), stylesCss);
  }

  return true;
}

/**
 * Installs the Obsidian plugin into the specified vault.
 */
export async function installObsidianPlugin(
  options: InstallPluginOptions,
): Promise<InstallPluginResult> {
  const version = options.version || CLI_VERSION;
  const resolvedVault = resolve(options.vaultPath);
  const obsidianDir = join(resolvedVault, ".obsidian");
  const targetPluginDir = join(obsidianDir, "plugins", "lernstoff-wiki");

  mkdirSync(targetPluginDir, { recursive: true });

  const localDir = findLocalPluginAssetsDir();
  let source: "local" | "release";

  if (localDir) {
    copyFileSync(join(localDir, "main.js"), join(targetPluginDir, "main.js"));
    copyFileSync(join(localDir, "manifest.json"), join(targetPluginDir, "manifest.json"));
    if (existsSync(join(localDir, "styles.css"))) {
      copyFileSync(join(localDir, "styles.css"), join(targetPluginDir, "styles.css"));
    }
    source = "local";
  } else {
    if (!options.silent) {
      console.log(
        `📡 Local assets not found. Fetching plugin assets from GitHub Releases (v${version})...`,
      );
    }
    const downloaded = await downloadPluginAssets(targetPluginDir, version);
    if (!downloaded) {
      throw new Error(
        `Could not find local plugin assets and failed to download from GitHub Releases (v${version}). ` +
          "Please verify your internet connection or build the plugin locally using 'pnpm build'.",
      );
    }
    source = "release";
  }

  // Enable plugin in community-plugins.json if .obsidian exists
  const communityPluginsPath = join(obsidianDir, "community-plugins.json");
  try {
    let plugins: string[] = [];
    if (existsSync(communityPluginsPath)) {
      plugins = JSON.parse(readFileSync(communityPluginsPath, "utf-8"));
    }
    if (!plugins.includes("lernstoff-wiki")) {
      plugins.push("lernstoff-wiki");
      writeFileSync(communityPluginsPath, JSON.stringify(plugins, null, 2), "utf-8");
    }
  } catch {
    // Non-fatal if community-plugins.json cannot be updated
  }

  return { targetPluginDir, source };
}
