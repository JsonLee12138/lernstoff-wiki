---
name: lernstoff-wiki
description: Cognitive selective note-taking protocol and MCP engine for Obsidian. Activate when exploring codebases, researching architectures, conducting bug postmortems, reading technical papers/docs, recalling prior decisions, or persisting project knowledge to Obsidian.
---

# `lernstoff-wiki` Cognitive Protocol

Headless cognitive note-taking engine implementing a 3-stage hippocampal novelty gate, Socratic proposition defense, curiosity inquiry tracking, and Monte Carlo Personalized PageRank memory search.

## 1. Decision Tree & Core Workflows

Choose the matching workflow based on your current task:

```mermaid
flowchart TD
    Start[Task Trigger] --> Type{Task Type}
    Type -->|Reading code/docs/papers/bugs| W1[1. Research & Crystallize]
    Type -->|Vault maintenance/orphans/synthesis| W2[2. Vault Health & Synthesize]
    Type -->|Reviewing buffer/deferred notes| W3[3. Scratchpad & Consolidate]

    W1 --> Rec[lernstoff_search_memory recall]
    Rec --> Probe[lernstoff_probe_delta filter]
    Probe -->|Survivor| Def[Socratic Defense & lernstoff_crystallize_note]

    W2 --> Lint[lernstoff_lint_wiki audit]
    Lint -->|Inquiry >= 5 notes| Synth[SYNTHESIZE_CLUSTER]

    W3 --> Insp[lernstoff_consolidate_scratchpad inspect]
    Insp -->|>= 2 collisions| Prom[Promote to Proposition Note]
```

### Workflow 1: Research & Crystallize

1. **Recall Prior Knowledge**: Query memory before exploring new territory using `lernstoff_search_memory`.
2. **Probe Epistemic Delta**: Submit candidate claims to `lernstoff_probe_delta`. Discard ~75% noise; defer borderline items to scratchpad.
3. **Socratic Defense**: For escalated survivors, answer Q1 (epistemic delta), Q2 (belief revision), and connect $\ge 2$ typed links (`supports`, `contradicts`, `extends`, `qualifies`).
4. **Crystallize**: Call `lernstoff_crystallize_note(operation: "CREATE_PROPOSITION")`.

### Workflow 2: Vault Health & Synthesize

1. Run `lernstoff_lint_wiki` to spot orphan notes, contradictions, and synthesis-ready inquiries ($\ge 5$ notes).
2. Read supporting notes via `lernstoff_get_note` and synthesize a higher-order principle with `operation: "SYNTHESIZE_CLUSTER"`.
3. Resolve the inquiry via `lernstoff_manage_inquiries(action: "close")`.

### Workflow 3: Scratchpad & Consolidate

1. Run `lernstoff_consolidate_scratchpad(action: "inspect")` to detect multi-source collisions ($\ge 2$).
2. Promote confirmed insights into full proposition notes; prune expired items (> 14d) with `action: "gc"`.

## 2. Non-Negotiable Guardrails

- **Proposition-as-Title Rule**: Titles MUST express a complete falsifiable claim (e.g., `PostgreSQL MVCC Eliminates Read Locks Under Snapshot Isolation`), NEVER bare nouns or topics (e.g., `PostgreSQL`, `MVCC`).
- **Anti-Orphan Requirement**: Every permanent note MUST connect $\ge 2$ typed links (`supports`, `contradicts`, `extends`, `qualifies`) to existing notes.
- **Hippocampal Gate First**: NEVER write directly to `wiki/` or `inbox/scratchpad.md` without running `lernstoff_probe_delta`.

## 3. Progressive References

- Detailed MCP tool schemas, parameters, and error cases: [mcp-tools.md](references/mcp-tools.md)
- Concrete good/bad titles, Socratic proofs, and synthesis patterns: [best-practices.md](references/best-practices.md)
