# Implementation Plan

## Slice 1: `x18n` Setup & i18n Runtime Helper
- [x] **Status:** Pending
- **Files**:
  - `package.json` (`@x18n/cli` & `@x18n/core` already installed; add `"i18n:check": "x18n check"`)
  - `x18n.config.ts` (configure `sourceLocale: "en"`, `locales: ["en", "zh", "zh-TW", "ja", "ko"]`, `resources`, `usage.calls`, `glossary`, `checks`)
  - `packages/obsidian-plugin/src/i18n.ts` (`resolveObsidianLocale`, `normalizeLocale`, `getLocale`, `t` with `{param}` interpolation and `en` fallback)
  - `packages/obsidian-plugin/src/locales/{en,zh,zh-TW,ja,ko}.json` (initial structure verified by `x18n doctor`)
  - `packages/obsidian-plugin/tests/i18n.test.ts` (unit tests for `getLanguage()`, `localStorage` fallback, `zh` vs `zh-TW` normalization, unknown locale -> `en` fallback, placeholder interpolation, missing key fallback)
- **Verification**:
  - `pnpm --filter @lernstoff/obsidian-plugin test` & `npx x18n doctor --json` pass.

## Slice 2: Extract User-Facing Strings in `main.ts` & `settings-tab.ts`
- [x] **Status:** Pending
- **Files**:
  - `packages/obsidian-plugin/src/main.ts` (replace command names, notices, status bar strings with `t("...")`)
  - `packages/obsidian-plugin/src/settings-tab.ts` (replace cockpit header, 5 modules, controls, placeholders, notices, log UI strings with `t("...")`)
  - `packages/obsidian-plugin/src/locales/en.json` (all source keys populated via `x18n apply` / `x18n set`)
- **Verification**:
  - `npx x18n check --only missing-key,unused-key,placeholder-mismatch,param-mismatch --json` exits 0.
  - Existing `packages/obsidian-plugin/tests/*.test.ts` and `e2e/03-obsidian-plugin-cockpit.e2e.test.ts` pass 100% unchanged.

## Slice 3: Translations (`zh`, `zh-TW`, `ja`, `ko`), Verification & Gate Integration
- [x] **Status:** Pending
- **Files**:
  - `packages/obsidian-plugin/src/locales/zh.json` (via `x18n apply`)
  - `packages/obsidian-plugin/src/locales/zh-TW.json` (via `x18n apply`)
  - `packages/obsidian-plugin/src/locales/ja.json` (via `x18n apply`)
  - `packages/obsidian-plugin/src/locales/ko.json` (via `x18n apply`)
  - `packages/obsidian-plugin/tests/settings-tab.test.ts` (add multi-locale rendering test verifying `zh`/`zh-TW`/`ja`/`ko` UI output when `getLanguage` returns each locale)
  - `scripts/gate-check.sh` (add `pnpm i18n:check`)
- **Verification**:
  - `pnpm i18n:check` passes with 0 errors and 100% coverage across `en`, `zh`, `zh-TW`, `ja`, `ko`.
  - `bash scripts/gate-check.sh` and `pnpm test:e2e` pass completely.
