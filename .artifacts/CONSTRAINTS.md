# Engineering Constraints

1. **MinAppVersion & Mock Safety**: `packages/obsidian-plugin/manifest.json` specifies `minAppVersion: "1.5.0"`, while `obsidian.getLanguage()` was introduced in `1.8.7`. `i18n.ts` MUST use `import * as obsidian from "obsidian"` (never named `import { getLanguage }`) and guard `typeof getLanguage === "function"` and `typeof window !== "undefined"` before reading Obsidian's language, falling back to `"en"` so existing unit/E2E mocks remain 100% green.
2. **Static Literal Keys Only**: Every `t(...)` call MUST use a full string literal key (no template-string concatenation or dynamic keys) so `@x18n/cli` static AST checks achieve 100% key and placeholder verification.
3. **x18n CLI as Locale Resource SSoT**: All locale JSON entries (`en`, `zh`, `zh-TW`, `ja`, `ko`) MUST be managed and validated via `x18n` (`x18n set`, `x18n apply`, `x18n check --json`), never drifting out of sync with `src/` usages.
4. **Decoupled `daemon-client.ts`**: `packages/obsidian-plugin/src/daemon-client.ts` MUST NOT import `obsidian` or UI i18n helpers.
5. **No Weakened Tests or Gates**: `bash scripts/gate-check.sh` (`pnpm check`, `pnpm build`, `pnpm test --run`, `pnpm i18n:check`), `pnpm test:e2e`, and `x18n check --json` MUST pass with 0 errors and no skipped assertions.
