import { defineConfig } from "@x18n/core";

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "zh", "zh-TW", "ja", "ko"],
  resources: [
    {
      pattern: "packages/obsidian-plugin/src/locales/{locale}.json",
    },
  ],
  usage: {
    include: ["packages/obsidian-plugin/src/**/*.ts"],
    calls: [
      {
        callee: ["t"],
        key: 0,
        params: { arg: 1 },
      },
    ],
  },
  glossary: [
    { term: "Lernstoff", doNotTranslate: true },
    { term: "Obsidian", doNotTranslate: true },
    { term: "QMD", doNotTranslate: true },
    { term: "MCP", doNotTranslate: true },
    { term: "SKILL.md", doNotTranslate: true },
    { term: "Claude Code", doNotTranslate: true },
    { term: "Cursor", doNotTranslate: true },
    { term: "Antigravity", doNotTranslate: true },
    { term: "SSE", doNotTranslate: true },
    { term: "CLI", doNotTranslate: true },
    { term: "PID", doNotTranslate: true },
    { term: "HTTP", doNotTranslate: true },
    {
      term: "Inquiry Tree",
      translations: {
        en: "Inquiry Tree",
        zh: "好奇心问题树",
        "zh-TW": "好奇心問題樹",
        ja: "問いの木",
        ko: "질문 트리",
      },
    },
    {
      term: "Scratchpad",
      translations: {
        en: "Scratchpad",
        zh: "闪念缓冲池",
        "zh-TW": "閃念緩衝池",
        ja: "スクラッチパッド",
        ko: "스크래치패드",
      },
      forms: {
        zh: ["{scratchpad}", "闪念"],
        "zh-TW": ["{scratchpad}", "閃念"],
        ja: ["{scratchpad}"],
        ko: ["{scratchpad}"],
      },
    },
    {
      term: "Vault",
      translations: {
        en: "Vault",
        zh: "仓库",
        "zh-TW": "儲存庫",
        ja: "保管庫",
        ko: "보관함",
      },
    },
    {
      term: "Daemon",
      translations: {
        en: "Daemon",
        zh: "守护进程",
        "zh-TW": "守護行程",
        ja: "デーモン",
        ko: "데몬",
      },
      forms: {
        zh: ["daemon.log", "daemon"],
        "zh-TW": ["daemon.log", "daemon"],
        ja: ["daemon.log", "daemon"],
        ko: ["daemon.log", "daemon"],
      },
    },
  ],
  checks: {
    "missing-key": "error",
    "missing-translation": "error",
    "empty-translation": "error",
    "placeholder-mismatch": "error",
    "param-mismatch": "error",
    "unused-key": "error",
    "invalid-syntax": "error",
    "key-conflict": "error",
    glossary: "warning",
  },
});
