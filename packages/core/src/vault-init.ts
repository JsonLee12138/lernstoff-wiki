import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_FILE_NAME,
  DEFAULT_LERNSTOFF_CONFIG,
  LERNSTOFF_DIR,
  loadConfig,
  saveConfig,
} from "./config.js";

export interface InitVaultResult {
  createdFiles: string[];
  skippedFiles: string[];
  configPath: string;
}

export function isVaultInitialized(vaultPath: string): boolean {
  const configPath = join(vaultPath, LERNSTOFF_DIR, CONFIG_FILE_NAME);
  return existsSync(configPath);
}

export function initGitignore(vaultPath: string): boolean {
  const gitignorePath = join(vaultPath, ".gitignore");
  const ignoreEntry = ".lernstoff/";
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${ignoreEntry}\n`, "utf-8");
    return true;
  }

  const content = readFileSync(gitignorePath, "utf-8");
  const lines = content.split("\n").map((l) => l.trim());
  if (!lines.includes(".lernstoff") && !lines.includes(".lernstoff/")) {
    const trailingNewline = content.endsWith("\n") ? "" : "\n";
    writeFileSync(gitignorePath, `${content}${trailingNewline}${ignoreEntry}\n`, "utf-8");
    return true;
  }
  return false;
}

export const TEMPLATES = {
  inquiries: (date: string) => `# 好奇心问题树 (Active Inquiry Tree)

> **注意力滤网说明**：这是当前知识库的核心探索焦点。任何外部输入将先与此问题树对齐，只有能深化、反驳或回答这些问题的增量信息，才会进入永久笔记。

## 核心焦点问题 (Open Questions)

- [OPEN] #q-core: 当前研究与工程中最核心的架构瓶颈、反直觉机制或待证伪假设是什么？
  - context: 零基础开箱即用默认问题，引导主 Agent 与学习者聚焦本质机制与关键冲突
  - created_at: ${date}
`,

  scratchpad: () => `# 闪念缓冲池 (Fast Scratchpad Buffer)

> **双速记忆机制**：记录尚未深入展开或处于探索边缘的闪念概念与推论。当同一概念在不同资料中被碰撞提及 ≥ 2 次时，自动触发晋升合成；驻留超过 14 天未被二次碰撞的碎片将自动修剪归档。

| 首次记录 | 概念 / 临时判断 | 碰撞计数 | 关联实体 | 来源线索 | 状态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
`,

  index: () => `# 全局认知地图 (Knowledge Constellation Index)

> **导航**：由命题笔记双向链接与好奇心问题树自动编织的自愈型网络索引。

## 焦点问题入口
- [[inquiries|好奇心问题树 (Inquiry Tree)]]
- [[scratchpad|闪念缓冲池 (Scratchpad Buffer)]]

## 永久命题笔记网络 (Proposition Notes)
*暂无已结晶的命题笔记。阅读新资料并通过海马体门控后，将在此沉淀。*
`,

  log: () => `# 认知演进与审计日志 (Cognitive Evolution Log)

> **审计与信噪比追踪**：记录海马体门控自动拦截丢弃的冗余已知常识（REDUNDANT_KNOWN）与顺带提及（ASIDE_MENTION），以及通过门控晋升结晶的命题笔记演化历程。

## 统计快照
- 总处理候选命题: 0
- 自动静默丢弃常识/离题: 0 (0%)
- 缓冲暂存闪念: 0
- 正式结晶命题笔记: 0

## 演化事件流
`,
};

export async function initVault(
  vaultPath: string,
  options: { force?: boolean } = {},
): Promise<InitVaultResult> {
  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];

  // 1. Ensure .lernstoff/ directory and config.json
  const configDir = join(vaultPath, LERNSTOFF_DIR);
  mkdirSync(configDir, { recursive: true });
  const archiveDir = join(configDir, "archive");
  mkdirSync(archiveDir, { recursive: true });

  const configPath = join(configDir, CONFIG_FILE_NAME);
  if (!existsSync(configPath) || options.force) {
    saveConfig(vaultPath, DEFAULT_LERNSTOFF_CONFIG);
    createdFiles.push(configPath);
  } else {
    skippedFiles.push(configPath);
  }

  // 2. Ensure .gitignore excludes .lernstoff/
  initGitignore(vaultPath);

  // 3. Resolve path targets from config
  const config = loadConfig(vaultPath);
  const targets = [
    {
      filePath: join(vaultPath, config.paths.inquiriesFile),
      content: TEMPLATES.inquiries(new Date().toISOString().slice(0, 10)),
    },
    {
      filePath: join(vaultPath, config.paths.scratchpadFile),
      content: TEMPLATES.scratchpad(),
    },
    {
      filePath: join(vaultPath, config.paths.indexFile),
      content: TEMPLATES.index(),
    },
    {
      filePath: join(vaultPath, config.paths.logFile),
      content: TEMPLATES.log(),
    },
  ];

  // 4. Ensure conceptsDir exists
  const conceptsDir = join(vaultPath, config.paths.conceptsDir);
  mkdirSync(conceptsDir, { recursive: true });

  for (const { filePath, content } of targets) {
    if (!existsSync(filePath) || options.force) {
      const parentDir = join(filePath, "..");
      mkdirSync(parentDir, { recursive: true });
      writeFileSync(filePath, content, "utf-8");
      createdFiles.push(filePath);
    } else {
      skippedFiles.push(filePath);
    }
  }

  return {
    createdFiles,
    skippedFiles,
    configPath,
  };
}
