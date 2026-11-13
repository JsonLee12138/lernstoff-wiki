# Specification: Obsidian Plugin Internationalization (`en`, `zh`, `zh-TW`, `ja`, `ko`) via `@x18n/cli`

## 1. Goals & Scope
1. **Obsidian-Native Language Adaptation (`packages/obsidian-plugin/src/i18n.ts`)**:
   - Automatically adapt plugin UI language to Obsidian's app language setting (`getLanguage()` from `obsidian` >= 1.8.7, with safe fallback to `window.localStorage?.getItem("language")` for `minAppVersion: "1.5.0"` compatibility, defaulting to `"en"`).
   - Supported locales (5):
     - `en` — English (source locale & fallback language)
     - `zh` — Simplified Chinese (maps `zh`, `zh-cn`, `zh-sg`, `zh-hans`)
     - `zh-TW` — Traditional Chinese (maps `zh-tw`, `zh-hk`, `zh-mo`, `zh-hant`)
     - `ja` — Japanese (maps `ja`, `ja-jp`)
     - `ko` — Korean (maps `ko`, `ko-kr`)
   - Any unsupported locale (e.g., `de`, `fr`) falls back cleanly to `"en"`.
   - Provide a zero-dependency typed translation helper `t(key, params?)` supporting `{placeholder}` interpolation and key-level fallback (`activeLocale -> en -> key`).
   - Statically import `locales/{en,zh,zh-TW,ja,ko}.json` so `tsdown` inlines all translations into `dist/main.js` without altering `scripts/sync-plugin-assets.mjs`.
2. **UI String Extraction (`main.ts` & `settings-tab.ts`)**:
   - Replace all hardcoded user-facing strings in `packages/obsidian-plugin/src/main.ts` (9 commands, notices, status bar text & tooltip) and `packages/obsidian-plugin/src/settings-tab.ts` (cockpit header/desc, all 5 module headings, setting names/descriptions, button labels, placeholders, notices, log viewer labels) with full-literal `t("...")` calls.
   - Split existing bilingual command names (e.g., `"Open Inquiry Tree (打开好奇心问题树)"`) into clean single-language strings per locale (`en`: `"Open Inquiry Tree"`, `zh`: `"打开好奇心问题树"`, `zh-TW`: `"開啟好奇心問題樹"`, etc.).
   - Keep `packages/obsidian-plugin/src/daemon-client.ts` decoupled from Obsidian/i18n; localize user-facing error prefixes in `settings-tab.ts` / `main.ts` while preserving diagnostic `res.error` payloads.
3. **`@x18n/cli` Configuration & Workflow (`x18n.config.ts`)**:
   - `@x18n/cli` and `@x18n/core` installed as root devDependencies; add `"i18n:check": "x18n check"` in root `package.json`.
   - Configure `x18n.config.ts` at repository root with `sourceLocale: "en"`, `locales: ["en", "zh", "zh-TW", "ja", "ko"]`, `resources: [{ pattern: "packages/obsidian-plugin/src/locales/{locale}.json" }]`, `usage.calls: [{ callee: ["t"], key: 0, params: { arg: 1 } }]`, project glossary (brand terms like `Lernstoff`, `Obsidian`, `QMD`, `MCP`, `SKILL.md`, `Claude Code`, `Cursor`, `Antigravity` marked `doNotTranslate: true`, plus domain terms), and strict checks (`missing-key`, `missing-translation`, `empty-translation`, `placeholder-mismatch`, `param-mismatch`, `unused-key`, `invalid-syntax`, `key-conflict`).
   - Integrate `pnpm i18n:check` into `scripts/gate-check.sh`.

## 2. Non-Goals
- Do not add a manual language override dropdown in the plugin settings (follow Obsidian's language setting directly).
- Do not internationalize CLI output, MCP server tool responses, or `@lernstoff/core` internal logs in this iteration.
- Do not add heavy third-party runtime i18n libraries (e.g., `i18next`); keep the Obsidian plugin bundle lean.
