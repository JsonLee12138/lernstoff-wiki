# Lernstoff MCP Tools & Resources Reference

This reference documents all native MCP tools and resource templates registered by the Lernstoff MCP server (`@lernstoff/core`).

---

## 1. `lernstoff_probe_delta`

Evaluates external text or paper candidates against the 3-stage hippocampal gate (Syntax -> Inquiry Tree -> QMD recall / PPR / entailment). Discards redundant and off-topic items, defers borderline items to `inbox/scratchpad.md`, and escalates true epistemic survivors for Socratic crystallization.

### Input Schema

| Parameter                 | Type     | Required | Description                                                                                                |
| :------------------------ | :------- | :------- | :--------------------------------------------------------------------------------------------------------- |
| `sourceId`                | `string` | Yes      | Source identifier (e.g. `paper:arxiv-2605.12345`, `file:src/auth.ts`, `url:...`).                          |
| `sourceText`              | `string` | Yes      | Original paragraph or excerpt for Gate 1 syntax verification.                                              |
| `language`                | `string` | No       | Language code (`"zh"`, `"en"`, `"de"`, default: auto-detected).                                            |
| `candidates`              | `array`  | Yes      | List of candidate proposition claims extracted from text.                                                  |
| `candidates[].entityName` | `string` | Yes      | Core anchor concept or entity name (e.g. `PostgreSQL MVCC`).                                               |
| `candidates[].claim`      | `string` | Yes      | Candidate proposition (must be a falsifiable statement, not a bare noun).                                  |
| `candidates[].evidence`   | `string` | No       | Supporting quote or excerpt from `sourceText`.                                                             |
| `candidates[].coverage`   | `enum`   | No       | `"substantially covered"` \| `"briefly mentioned"` \| `"named only"` (default: `"substantially covered"`). |

### Return Value

Returns formatted text summary plus JSON payload with:

- `stats`: `totalCandidates`, `discardedGate1`, `discardedGate2`, `discardedGate3`, `deferredScratchpad`, `noiseFilteredRatio`.
- `survivors`: Array of candidate claims that passed all 3 gates and require Socratic defense.

### Error Cases

- Missing required fields (`sourceId`, `sourceText`, or empty `candidates`).
- Unparseable candidate structure.

---

## 2. `lernstoff_crystallize_note`

Crystallizes an Evergreen proposition note with Socratic defense guards (anti-noun topic check and $\ge 2$ outbound typed links). Formats native Obsidian YAML Frontmatter, Callouts, and links without write loops.

### Input Schema

| Parameter                                    | Type       | Required | Description                                                                   |
| :------------------------------------------- | :--------- | :------- | :---------------------------------------------------------------------------- |
| `operation`                                  | `enum`     | Yes      | `"CREATE_PROPOSITION"` \| `"AMEND_EXISTING"` \| `"SYNTHESIZE_CLUSTER"`.       |
| `propositionTitle`                           | `string`   | Yes      | Falsifiable proposition title (must not be a bare noun).                      |
| `targetPath`                                 | `string`   | No       | Target note path if amending an existing note (e.g. `wiki/concepts/note.md`). |
| `inquiryRefs`                                | `string[]` | No       | Associated inquiry IDs (e.g. `["#q-01", "#q-core"]`, default: `[]`).          |
| `socraticDefense`                            | `object`   | Yes      | Socratic defense proof structure.                                             |
| `socraticDefense.deltaExplanation`           | `string`   | Yes      | Q1: Irreplaceable epistemic delta compared to recalled notes.                 |
| `socraticDefense.beliefUpdate`               | `string`   | Yes      | Q2: Which prior assumption or belief is revised or qualified.                 |
| `socraticDefense.outboundLinks`              | `array`    | Yes      | Q3: Outbound typed logical links ($\ge 2$ required after cold start).         |
| `socraticDefense.outboundLinks[].targetNote` | `string`   | Yes      | Target note slug or title.                                                    |
| `socraticDefense.outboundLinks[].relation`   | `enum`     | Yes      | `"supports"` \| `"contradicts"` \| `"extends"` \| `"qualifies"`.              |
| `markdownBody`                               | `string`   | Yes      | Atomic proposition note body in Markdown.                                     |
| `sources`                                    | `string[]` | No       | Exact source citations (default: `[]`).                                       |

### Return Value

- Success: `{ content: [{ type: "text", text: "Successfully crystallized proposition note: wiki/concepts/<slug>.md (...)" }] }`.
- Error: `{ isError: true, content: [{ type: "text", text: "Crystallization failed: <reason>" }] }`.

### Error Cases

- Bare noun title rejected by anti-noun guard (e.g. `Docker` or `PostgreSQL` instead of a full claim).
- Fewer than 2 typed outbound links when vault has $\ge 2$ concept notes.
- Empty or boilerplate answers for Q1/Q2 Socratic questions.
- Target path not found when `operation` is `AMEND_EXISTING`.

---

## 3. `lernstoff_manage_inquiries`

Manages the curiosity inquiry tree stored in `wiki/inquiries.md` across its lifecycle (`list`, `add`, `close`, `reopen`).

### Input Schema

| Parameter        | Type     | Required | Description                                                     |
| :--------------- | :------- | :------- | :-------------------------------------------------------------- |
| `action`         | `enum`   | Yes      | `"list"` \| `"add"` \| `"close"` \| `"reopen"`.                 |
| `id`             | `string` | No       | Inquiry ID (e.g. `"#q-01"`). Required for `close` and `reopen`. |
| `question`       | `string` | No       | Question statement. Required when `action: "add"`.              |
| `context`        | `string` | No       | Background motivation or engineering context.                   |
| `resolutionNote` | `string` | No       | Note slug resolving this inquiry when closing.                  |

### Return Value

- `list`: Array of inquiry objects with `id`, `status` (`OPEN` \| `CLOSED`), `question`, `supportingNoteCount`, and `resolutionNote`.
- `add`: Created inquiry object with assigned ID.
- `close` / `reopen`: Updated inquiry state.
- Error: `{ isError: true, content: [{ type: "text", text: "manage_inquiries error: <reason>" }] }`.

---

## 4. `lernstoff_consolidate_scratchpad`

Inspects entries ready for promotion in `inbox/scratchpad.md` ($\ge 2$ collisions across independent sources), marks entries as promoted, or runs TTL garbage collection.

### Input Schema

| Parameter | Type       | Required | Description                                                    |
| :-------- | :--------- | :------- | :------------------------------------------------------------- |
| `action`  | `enum`     | Yes      | `"inspect"` \| `"promote"` \| `"gc"`.                          |
| `itemIds` | `string[]` | No       | Entry claims or IDs to mark promoted when `action: "promote"`. |

### Return Value

- `inspect`: List of items with `hitCount >= 2` across multiple sources, status `READY_FOR_PROMOTION`.
- `promote`: Confirmation of promoted item claims.
- `gc`: Count of pruned stale items older than 14 days archived to `.lernstoff/archive/decayed.jsonl`.
- Error: `{ isError: true, content: [{ type: "text", text: "consolidate_scratchpad error: <reason>" }] }`.

---

## 5. `lernstoff_lint_wiki`

Runs automated epistemic audits on the Vault to maintain knowledge health and identify synthesis opportunities.

### Input Schema

| Parameter             | Type      | Required | Description                                                                                           |
| :-------------------- | :-------- | :------- | :---------------------------------------------------------------------------------------------------- |
| `checkOrphans`        | `boolean` | No       | Flags concept notes with in-degree 0 (no inbound links). Default: `true`.                             |
| `checkContradictions` | `boolean` | No       | Finds unresolved contradiction pairs (`contradicts` relation). Default: `true`.                       |
| `checkSynthesisReady` | `boolean` | No       | Identifies inquiries with $\ge 5$ supporting notes ready for higher-order synthesis. Default: `true`. |

### Return Value

JSON report containing:

- `orphans`: Note slugs without inbound links.
- `contradictions`: Pairs of contradictory claims.
- `synthesisReady`: Inquiries meeting cluster threshold ($\ge 5$ supporting notes).
- `summary`: Counts of total notes, orphans, contradictions, and synthesis opportunities.

---

## 6. `lernstoff_search_memory`

Hybrid search across Vault notes using `@tobilu/qmd` (lexical BM25, dense vector, and HyDE) combined with Monte Carlo Personalized PageRank (PPR) 2-hop associative graph walk.

### Input Schema

| Parameter    | Type      | Required | Description                                                                       |
| :----------- | :-------- | :------- | :-------------------------------------------------------------------------------- |
| `query`      | `string`  | No       | Plaintext search query string (shorthand for dual lex+vec search).                |
| `searches`   | `array`   | No       | Explicit multi-query list: `[{ type: "lex" \| "vec" \| "hyde", query: string }]`. |
| `limit`      | `number`  | No       | Maximum direct search results (default: `5`).                                     |
| `includePpr` | `boolean` | No       | Run Monte Carlo PPR graph walk from direct hits (default: `true`).                |

### Return Value

JSON payload with:

- `directHits`: Ranked search hits with `file`, `displayPath`, `title`, `snippet`, and `score`.
- `pprAssociativeNeighborhood`: Associatively related notes found via random walk with `nodeId` and `score`.

---

## 7. `lernstoff_get_note`

Reads a note from the Vault with optional line slicing (`path:fromLine:maxLines` or `#docid`) and extracts backlinks without consuming excessive context window tokens.

### Input Schema

| Parameter          | Type      | Required | Description                                                                                       |
| :----------------- | :-------- | :------- | :------------------------------------------------------------------------------------------------ |
| `path`             | `string`  | Yes      | Note path (e.g. `wiki/concepts/note.md`), line slice (`wiki/concepts/note.md:1:30`), or `#docid`. |
| `includeBacklinks` | `boolean` | No       | Returns list of inbound referencing notes (default: `true`).                                      |

### Return Value

Formatted text output containing:

- Sliced line content with line number prefixes (`0001 | ...`).
- Inbound backlinks list.
- Error if note not found or path traversal outside vault root is attempted.

---

## 8. `lernstoff_status`

Returns a real-time health and metrics snapshot of the Lernstoff cognitive engine.

### Input Schema

Empty object `{}`.

### Return Value

JSON payload containing:

- `version`: Lernstoff version.
- `vaultPath`: Absolute path to active Obsidian Vault.
- `qmd`: QMD SQLite database status (`online`, `offline`, or `unknown`).
- `metrics`: Counts for `conceptNotes`, `totalInquiries`, `openInquiries`, `scratchpadEntries`, `readyForPromotion`, and `noiseFilteredRatio`.
- `config`: Loaded active configuration.

---

## 9. `lernstoff_install_rule`

Idempotently installs or removes Lernstoff Wiki memory routing rules in project `AGENTS.md` (with optional `@AGENTS.md` sync into `CLAUDE.md`) or global agent configurations (`codex`, `claude`, `antigravity`, `workbuddy`).

### Input Schema

- `action` (`"install" | "remove"`, required): Action to perform.
- `global` (`boolean`, default `false`): Install/remove rules at global user scope instead of project scope.
- `target` (`"all" | "codex" | "claude" | "antigravity" | "workbuddy"`, default `"all"`): Target agent environment for global installation.
- `projectPath` (`string`, optional): Project directory for project-level installation (defaults to vault directory or cwd).
- `homeDir` (`string`, optional): User home directory override.
- `syncClaude` (`boolean`, default `true`): Append `@AGENTS.md` to project `CLAUDE.md` if present and not yet referencing `AGENTS.md`.

### Return Value

Summary string listing `updatedFiles` and `syncedClaudeFiles`.

---

## 10. Static Resource: `lernstoff://guide/best-practices`

Provides the built-in Lernstoff Best Practices & Socratic Defense Protocol guide (`text/markdown`).

---

## 11. Dynamic Resource: `lernstoff://{+path}`

Provides direct read access to any markdown document or note in the Vault via MCP Resource URI.

### URI Template

- `lernstoff://{+path}` (e.g. `lernstoff://wiki/concepts/mvcc.md`, `lernstoff://wiki/inquiries.md`, `lernstoff://inbox/scratchpad.md`).

### Response

- MIME Type: `text/markdown`.
- Content: Raw UTF-8 text of the requested document.
- Safety: Throws access denied error if `{+path}` attempts directory traversal outside the vault root.
