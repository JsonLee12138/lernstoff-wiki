# Constraints Contract

## 1. Zero External Dependencies

- No new npm packages may be added to `packages/core`, `packages/cli`, or `packages/obsidian-plugin`.
- Probes must use native Node.js HTTP/fetch facilities or existing `localHttpJson` helper in plugin.

## 2. Regression & Gate Check Safety

- All 81 existing tests across all packages must continue to pass.
- `bash scripts/gate-check.sh` (formatting, linting, build, and deterministic test suite) must pass with zero errors.

## 3. Strict Port & Vault Security Boundaries

- Probing `/health` must enforce canonical path equivalence: `resolve(data.vault) === resolve(targetVaultPath)`.
- If an occupied port belongs to a different vault or external program, auto-increment fallback is permitted ONLY if the port does not belong to the current vault.
- Probes to localhost must use strict timeouts (<= 1500ms) to prevent UI or startup blocking.

## 4. Single Source of Truth Preservation

- Automatic port incrementing must NOT mutate `config.json` when the conflict is caused by a duplicate daemon for the same vault.
- `ServiceManager.installService()` must guarantee that the target port remains the configured port upon handover.
