import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { z } from "zod";

function getCorePackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json");
    return pkg.version || "0.1.0-beta.6";
  } catch {
    return "0.1.0-beta.6";
  }
}

export const LERNSTOFF_VERSION = getCorePackageVersion();

export const LERNSTOFF_DIR = ".lernstoff";
export const CONFIG_FILE_NAME = "config.json";

export const ServerConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1024).max(65535).default(8188),
  autoStartOnBoot: z.boolean().default(false),
  autoStartOnObsidianOpen: z.boolean().default(true),
  watchDebounceMs: z.number().int().min(100).default(500),
});

export const PathsConfigSchema = z.object({
  wikiDir: z.string().default("wiki"),
  conceptsDir: z.string().default("wiki/concepts"),
  inquiriesFile: z.string().default("wiki/inquiries.md"),
  indexFile: z.string().default("wiki/index.md"),
  logFile: z.string().default("wiki/log.md"),
  scratchpadFile: z.string().default("inbox/scratchpad.md"),
  editorUriTemplate: z.string().default("obsidian://open?path={path}"),
});

export const ModelsConfigSchema = z.object({
  embed: z.string().default("hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf"),
  rerank: z
    .string()
    .default("hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf"),
  generate: z
    .string()
    .default("hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf"),
  inactivityTimeoutMs: z.number().int().min(10000).default(300_000),
  disposeModelsOnInactivity: z.boolean().default(true),
});

export const GateConfigSchema = z.object({
  tauOff: z.number().min(0).max(1).default(0.35),
  tauCore: z.number().min(0).max(1).default(0.65),
  maxSemRedundant: z.number().min(0).max(1).default(0.82),
  minLexNovelty: z.number().min(0).max(1).default(0.15),
  entailmentTriggerScore: z.number().min(0).max(1).default(0.7),
  pprNumWalks: z.number().int().min(10).default(200),
  pprMaxSteps: z.number().int().min(1).default(6),
  pprDamping: z.number().min(0).max(1).default(0.25),
  pprTopK: z.number().int().min(1).default(3),
});

export const SocraticConfigSchema = z.object({
  minPropositionCharsZh: z.number().int().min(2).default(8),
  minPropositionWordsLatin: z.number().int().min(2).default(4),
  minOutboundLinks: z.number().int().min(1).default(2),
  coldStartGraceNotes: z.number().int().min(0).default(3),
  synthesisThreshold: z.number().int().min(2).default(5),
});

export const ScratchpadConfigSchema = z.object({
  promoteHitCount: z.number().int().min(1).default(2),
  promoteMinSources: z.number().int().min(1).default(2),
  ttlDays: z.number().int().min(1).default(14),
});

export const DEFAULT_SERVER_CONFIG = ServerConfigSchema.parse({});
export const DEFAULT_PATHS_CONFIG = PathsConfigSchema.parse({});
export const DEFAULT_MODELS_CONFIG = ModelsConfigSchema.parse({});
export const DEFAULT_GATE_CONFIG = GateConfigSchema.parse({});
export const DEFAULT_SOCRATIC_CONFIG = SocraticConfigSchema.parse({});
export const DEFAULT_SCRATCHPAD_CONFIG = ScratchpadConfigSchema.parse({});

export const LernstoffConfigSchema = z.object({
  version: z.string().default(LERNSTOFF_VERSION),
  server: ServerConfigSchema.default(DEFAULT_SERVER_CONFIG),
  paths: PathsConfigSchema.default(DEFAULT_PATHS_CONFIG),
  models: ModelsConfigSchema.default(DEFAULT_MODELS_CONFIG),
  gate: GateConfigSchema.default(DEFAULT_GATE_CONFIG),
  socratic: SocraticConfigSchema.default(DEFAULT_SOCRATIC_CONFIG),
  scratchpad: ScratchpadConfigSchema.default(DEFAULT_SCRATCHPAD_CONFIG),
});

export type LernstoffConfig = z.infer<typeof LernstoffConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type PathsConfig = z.infer<typeof PathsConfigSchema>;
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type GateConfig = z.infer<typeof GateConfigSchema>;
export type SocraticConfig = z.infer<typeof SocraticConfigSchema>;
export type ScratchpadConfig = z.infer<typeof ScratchpadConfigSchema>;

export const DEFAULT_LERNSTOFF_CONFIG: Readonly<LernstoffConfig> = Object.freeze(
  LernstoffConfigSchema.parse({}),
);

function cloneDefaultConfig(): LernstoffConfig {
  return structuredClone(DEFAULT_LERNSTOFF_CONFIG);
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

export function getConfigPath(vaultPath: string): string {
  return join(vaultPath, LERNSTOFF_DIR, CONFIG_FILE_NAME);
}

export function loadConfig(vaultPath: string): LernstoffConfig {
  const configPath = getConfigPath(vaultPath);
  if (!existsSync(configPath)) {
    return cloneDefaultConfig();
  }

  try {
    const raw = readFileSync(configPath, "utf-8").trim();
    if (!raw) return cloneDefaultConfig();
    const parsed = JSON.parse(raw);
    return LernstoffConfigSchema.parse(parsed);
  } catch (err) {
    console.warn(`[Config] Failed to parse ${configPath}, falling back to defaults:`, err);
    return cloneDefaultConfig();
  }
}

export function saveConfig(vaultPath: string, updates: Partial<LernstoffConfig>): LernstoffConfig {
  const current = loadConfig(vaultPath);
  const merged = {
    ...current,
    ...updates,
    server: { ...current.server, ...updates.server },
    paths: { ...current.paths, ...updates.paths },
    models: { ...current.models, ...updates.models },
    gate: { ...current.gate, ...updates.gate },
    socratic: { ...current.socratic, ...updates.socratic },
    scratchpad: { ...current.scratchpad, ...updates.scratchpad },
  };

  const validated = LernstoffConfigSchema.parse(merged);
  atomicWriteJson(getConfigPath(vaultPath), validated);
  return validated;
}

export function getConfigValue(vaultPath: string, keyPath: string): unknown {
  const config = loadConfig(vaultPath);
  const segments = keyPath.split(".");
  let cur: any = config;
  for (const seg of segments) {
    if (cur === undefined || cur === null || typeof cur !== "object") {
      return undefined;
    }
    cur = cur[seg];
  }
  return cur;
}

export function setConfigValue(
  vaultPath: string,
  keyPath: string,
  rawValue: unknown,
): LernstoffConfig {
  const current = loadConfig(vaultPath);
  const segments = keyPath.split(".");
  if (segments.length === 0 || !segments[0]) {
    throw new Error(`Invalid empty key path: ${keyPath}`);
  }

  // Parse raw value if passed as string (e.g. CLI argument "true" -> true, "0.65" -> 0.65)
  let parsedValue = rawValue;
  if (typeof rawValue === "string") {
    if (rawValue === "true") parsedValue = true;
    else if (rawValue === "false") parsedValue = false;
    else if (!Number.isNaN(Number(rawValue)) && rawValue.trim() !== "") {
      parsedValue = Number(rawValue);
    }
  }

  const clone = JSON.parse(JSON.stringify(current));
  let target = clone;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (target[seg] === undefined || typeof target[seg] !== "object") {
      target[seg] = {};
    }
    target = target[seg];
  }
  target[segments[segments.length - 1]!] = parsedValue;

  const validated = LernstoffConfigSchema.parse(clone);
  atomicWriteJson(getConfigPath(vaultPath), validated);
  return validated;
}

export function resetConfigToDefaults(vaultPath: string, section?: string): LernstoffConfig {
  if (!section) {
    const defaults = cloneDefaultConfig();
    atomicWriteJson(getConfigPath(vaultPath), defaults);
    return defaults;
  }

  const current = loadConfig(vaultPath);
  const validSections = ["server", "paths", "models", "gate", "socratic", "scratchpad"] as const;
  if (!validSections.includes(section as any)) {
    throw new Error(`Invalid section '${section}'. Valid sections: ${validSections.join(", ")}`);
  }

  const updated = {
    ...current,
    [section]: cloneDefaultConfig()[section as keyof LernstoffConfig],
  };
  const validated = LernstoffConfigSchema.parse(updated);
  atomicWriteJson(getConfigPath(vaultPath), validated);
  return validated;
}
