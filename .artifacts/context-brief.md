# Context Brief: Obsidian Plugin i18n (`x18n`)

## 1. Architecture & Build Constraints
- **Package**: `packages/obsidian-plugin` (`@lernstoff/obsidian-plugin`)
- **Bundler**: `packages/obsidian-plugin/tsdown.config.mts` compiles `src/main.ts` -> `dist/main.js` (CJS) with `neverBundle: ["obsidian"]`, `alwaysBundle: [/^@lernstoff\//, /^zod/]`.
- **Asset Sync**: `scripts/sync-plugin-assets.mjs` copies only `["main.js", "manifest.json", "styles.css"]`. Static JSON imports (`resolveJsonModule: true` in `tsconfig.base.json:L14`) are bundled inline into `main.js`.
- **Separation of Concerns**:
  - `packages/obsidian-plugin/src/daemon-client.ts` does NOT import `obsidian`; it communicates via Node `http`/`child_process`/`fs` and returns `ActionResult { success: boolean; error?: string }`.
  - `packages/obsidian-plugin/src/main.ts` & `packages/obsidian-plugin/src/settings-tab.ts` import `obsidian` and render all UI surfaces (commands, status bar, notices, 5-module settings cockpit, logs).

## 2. Obsidian Official Language API
- `packages/obsidian-plugin/node_modules/obsidian/obsidian.d.ts:L5076-L5081`:
  - `export function getLanguage(): string;` (`@since 1.8.7`, defaults to `'en'`).
- `packages/obsidian-plugin/manifest.json:L5`:
  - `"minAppVersion": "1.5.0"` -> `getLanguage` may be `undefined` in Obsidian 1.5.0–1.8.6 or in Vitest mocks (`settings-tab.test.ts` and `e2e/03-obsidian-plugin-cockpit.e2e.test.ts` mock `obsidian` without `getLanguage`).
- **Vitest Namespace Import Requirement**:
  - `settings-tab.test.ts:L8-L224` & `e2e/03-obsidian-plugin-cockpit.e2e.test.ts:L15-L229` use `vi.mock("obsidian", () => ({ ... }))` without exporting `getLanguage`.
  - `i18n.ts` MUST use `import * as obsidian from "obsidian"` (NOT named `import { getLanguage } from "obsidian"`) and inspect `typeof (obsidian as { getLanguage?: () => string }).getLanguage === "function"`, else fall back to `window?.localStorage?.getItem("language")` -> `"en"`.
- Obsidian official language codes (`obsidianmd/obsidian-translations`): `en`, `zh` (Simplified Chinese), `zh-TW` (Traditional Chinese), `ja`, `ko`.

## 3. Existing Test Assertions (Blast Radius)
- `packages/obsidian-plugin/tests/settings-tab.test.ts` & `e2e/03-obsidian-plugin-cockpit.e2e.test.ts` assert exact English UI strings (`"1. Daemon & OS Boot Auto-Start"`, `"Daemon Service Status"`, `"Server Port"`, `"Start"`, `"Stop"`, `"Restart"`, `"Offline"`, `"Stopped"`, `"Port ... saved"`, `"⚠️ Restart -> :..."`, etc.).
- Falling back to `"en"` when `getLanguage` is unmocked/absent preserves 100% backward compatibility with all existing tests.

## 4. `@x18n/cli` Integration
- Installed at repo root: `@x18n/cli@0.1.14`, `@x18n/core@0.1.14`.
- Custom lightweight `t(key, params?)` helper is configured via `x18n.config.ts`:
  - `sourceLocale: "en"`
  - `locales: ["en", "zh", "zh-TW", "ja", "ko"]`
  - `resources: [{ pattern: "packages/obsidian-plugin/src/locales/{locale}.json" }]`
  - `usage: { include: ["packages/obsidian-plugin/src/**/*.ts"], calls: [{ callee: ["t"], key: 0, params: { arg: 1 } }] }`
