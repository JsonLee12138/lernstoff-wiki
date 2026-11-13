<div align="center">

# 🧠 lernstoff-wiki

**Local-First Cognitive Selective Note-Taking Engine & MCP Memory Server for Obsidian and AI Coding Agents**

[![npm](https://img.shields.io/npm/v/@lernstoff/cli/beta?label=npm%20%40lernstoff%2Fcli&color=cb3837)](https://www.npmjs.com/package/@lernstoff/cli)
[![MCP](https://img.shields.io/badge/MCP-Protocol-purple.svg)](https://modelcontextprotocol.io/)
[![Obsidian](https://img.shields.io/badge/Obsidian-Plugin-7C3AED.svg)](https://obsidian.md/)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520.0-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[English](README.md) · [简体中文](README.zh.md)

</div>

---

Most AI note-taking tools fall into the **Collector's Fallacy**—dumping raw clips, repetitive summaries, and vague topic files into your vault until it becomes noisy and unusable.

**`lernstoff-wiki`** turns any Obsidian vault into a **high-signal, evergreen knowledge base** for both you and your AI coding agents (**Claude Code**, **Cursor**, **Antigravity**, **Codex**, and **WorkBuddy**):

- **$\ge 75\%$ Noise Filtering**: Every candidate insight passes through a 3-stage novelty and relevance gate—novel knowledge crystallizes into permanent notes, borderline observations buffer in a scratchpad (auto-promoted on multi-source collision and archived after 14 days), and redundant or off-topic noise is discarded.
- **Falsifiable Proposition Notes**: Enforces proposition-as-title naming (e.g., `PostgreSQL MVCC Eliminates Read Locks Under Snapshot Isolation.md` instead of `PostgreSQL.md`) and requires Socratic justification before writing permanent notes.
- **Anti-Orphan Knowledge Graph**: Connects notes with typed semantic links (`supports`, `contradicts`, `extends`, `qualifies`) and audits orphan notes, latent contradictions, and clusters ready for synthesis.
- **100% Local & Private**: Powered by local GGUF embeddings and reranking via `@tobilu/qmd`—**zero cloud LLM API keys required**.
- **One-Command Agent & Obsidian Setup**: Automatically configures MCP servers (Stdio & HTTP), agent skills, and project/global routing rules, paired with a native Obsidian plugin supporting **5 languages** (`en`, `zh`, `zh-TW`, `ja`, `ko`).

---

## 📦 Installation

### Prerequisites

- **Node.js** $\ge 20.0.0$

### Option 1: Install via npm / pnpm (Recommended)

```bash
npm install -g @lernstoff/cli@beta
# or
pnpm add -g @lernstoff/cli@beta
```

### Option 2: Install via Homebrew (macOS)

```bash
brew install --build-from-source Formula/lernstoff.rb
```

### Option 3: Build from Source

```bash
git clone https://github.com/JsonLee12138/lernstoff-wiki.git
cd lernstoff-wiki
pnpm install
pnpm build
cd packages/cli && npm link
```

Verify installation:

```bash
lernstoff --version
```

---

## 🚀 Quick Start

### 1. Initialize Your Obsidian Vault

Run inside your Obsidian vault (or pass `--vault`), whether it's brand new or already full of notes—existing files are never overwritten:

```bash
lernstoff init --vault /path/to/my-vault
```

This initializes:

- `.lernstoff/config.json` — default settings for server, paths, models, gate thresholds, Socratic rules, and scratchpad
- `wiki/inquiries.md` — your curiosity inquiry tree
- `inbox/scratchpad.md` — fast buffer for borderline observations
- `wiki/index.md` & `wiki/log.md` — knowledge constellation index and cognitive audit log
- `wiki/concepts/` — evergreen proposition notes folder
- Appends `.lernstoff/` to `.gitignore`

### 2. Start the Background Service

```bash
# Start in the background
lernstoff server start --vault /path/to/my-vault --daemon

# Check status
lernstoff server status --vault /path/to/my-vault
```

Optional: Register OS boot auto-start (macOS LaunchAgent / Linux systemd user service) so it's always ready:

```bash
lernstoff service install --vault /path/to/my-vault
```

### 3. Connect Your AI Coding Agents

Install the MCP server and `lernstoff-wiki` skill across all detected agents in one command:

```bash
lernstoff skill install --vault /path/to/my-vault --target all
```

Supported targets: `claude` (Claude Code), `cursor` (Cursor), `antigravity` (Antigravity), `codex` (Codex), `workbuddy` (WorkBuddy), or `all`.

You can also inject cognitive routing rules into a repository (or globally) so agents automatically search memory before researching and never bypass the gate:

```bash
# Project-level rules (updates AGENTS.md and appends @AGENTS.md to CLAUDE.md if present)
lernstoff rule install --project /path/to/your-project --target all

# Global user rules
lernstoff rule install --global --target all
```

### 4. Install the Obsidian Plugin

```bash
lernstoff plugin install --vault /path/to/my-vault
```

Then open Obsidian $\to$ **Settings** $\to$ **Community Plugins**, reload plugins, and enable **Lernstoff Wiki** (the CLI also enables it automatically in `community-plugins.json`).

---

## 🤖 Working with AI Agents (MCP)

Once connected (via `lernstoff mcp` stdio or the daemon's `/mcp` HTTP endpoint), your AI agent automatically follows a disciplined memory workflow whenever you research codebases, debug issues, or read docs:

1. **Recall first** with `lernstoff_search_memory` before re-exploring familiar topics.
2. **Filter noise** with `lernstoff_probe_delta` so only genuinely new insights move forward.
3. **Crystallize claims** with `lernstoff_crystallize_note` (`CREATE_PROPOSITION`, `AMEND_EXISTING`, or `SYNTHESIZE_CLUSTER`), defending the epistemic delta and linking $\ge 2$ related notes.
4. **Maintain vault health** with `lernstoff_lint_wiki` and `lernstoff_consolidate_scratchpad`.

| MCP Tool / Resource                | What It Does                                                                                                     |
| :--------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| `lernstoff_search_memory`          | Hybrid keyword + semantic + graph associative search across your vault                                           |
| `lernstoff_probe_delta`            | 3-stage novelty & relevance check (drops noise, buffers borderline claims, escalates novel deltas)               |
| `lernstoff_crystallize_note`       | Creates, amends, or cluster-synthesizes falsifiable proposition notes with typed links                           |
| `lernstoff_manage_inquiries`       | Manage curiosity questions (`list`, `add`, `close`, `reopen`)                                                    |
| `lernstoff_consolidate_scratchpad` | Inspect multi-source scratchpad collisions for promotion, mark promoted items, or prune expired items (>14 days) |
| `lernstoff_lint_wiki`              | Audit orphan notes, unresolved contradictions, and inquiries ready for synthesis                                 |
| `lernstoff_get_note`               | Read exact line ranges (`path:from:count`) and inbound backlinks                                                 |
| `lernstoff_status`                 | Snapshot of vault health, QMD status, open inquiries, and scratchpad/noise metrics                               |
| `lernstoff_install_rule`           | Idempotently install or remove memory routing rules in project `AGENTS.md` or global agent configs               |
| `lernstoff://guide/best-practices` | Built-in best practices & Socratic defense protocol guide                                                        |
| `lernstoff://{+path}`              | Read raw note Markdown directly as an MCP resource                                                               |

For full agent protocol details, see [`skills/lernstoff-wiki/SKILL.md`](skills/lernstoff-wiki/SKILL.md).

---

## 💻 CLI Usage Reference

All commands accept `--vault <path>` (defaults to current working directory).

### Vault, Search & Diagnostics

```bash
# Initialize vault templates and default config
lernstoff init [--vault <path>]

# Hybrid memory search (works with or without running daemon; clickable obsidian:// terminal links)
lernstoff search "distributed consensus" --limit 5 [--lex|--vec] [--json]

# Run Socratic health audit (orphans, contradictions, synthesis candidates)
lernstoff lint [--vault <path>] [--json]

# Diagnostics, model download, and SQLite/orphan cleanup
lernstoff doctor [--pull-models] [--cleanup]
```

### Curiosity Inquiries & Scratchpad

```bash
# Manage your curiosity tree
lernstoff inquiry list [--json]
lernstoff inquiry add "How does LSM compaction trade off read and write amplification?"
lernstoff inquiry close #q-01
lernstoff inquiry reopen #q-01

# Manage fast scratchpad buffer
lernstoff scratchpad list [--json]
lernstoff scratchpad add "RocksDB defaults to Leveled Compaction"
lernstoff scratchpad consolidate   # Surface items seen across >= 2 sources
lernstoff scratchpad gc            # Prune & archive entries older than 14 days
```

### Configuration & Background Service

Configuration is stored in `.lernstoff/config.json` across 6 sections (`server`, `paths`, `models`, `gate`, `socratic`, `scratchpad`) and automatically hot-reloads on the running daemon when updated:

```bash
# Inspect or update config
lernstoff config list
lernstoff config get gate.tauCore
lernstoff config set gate.tauCore 0.72
lernstoff config reset [server|paths|models|gate|socratic|scratchpad]
lernstoff config path

# Manage background daemon
lernstoff server start [--daemon|--foreground] [--port <n>]
lernstoff server status [--json]
lernstoff server list [--json]       # Aliases: ls, ps; lists all daemons & detects orphans
lernstoff server stop [--all|--pid <pid>|--port <n>]
lernstoff server restart [--foreground] [--port <n>]
lernstoff server logs

# Manage OS boot auto-start (macOS LaunchAgent / Linux systemd --user / Windows fallback)
lernstoff service <install|uninstall|status>
```

### AI Agents & Obsidian Setup

```bash
# Install MCP config + SKILL.md for AI agents
lernstoff skill install [--target <all|claude|cursor|antigravity|codex|workbuddy>]
lernstoff skill show

# Inject or remove cognitive routing rules (AGENTS.md / CLAUDE.md / GEMINI.md / WorkBuddy)
lernstoff rule install [--global] [--target <all|codex|claude|antigravity|workbuddy>] [--project <path>] [--no-sync-claude]
lernstoff rule remove [--global] [--target <all|codex|claude|antigravity|workbuddy>] [--project <path>]
lernstoff rule show

# Install and auto-enable the Obsidian plugin in your vault (bundled assets or GitHub Releases fallback)
lernstoff plugin install [--vault <path>]

# Run MCP stdio server directly (used by agent MCP configs)
lernstoff mcp [--vault <path>]
```

---

## 🔮 Obsidian Plugin

The **Lernstoff Wiki** Obsidian plugin keeps your native Markdown editing experience untouched while giving you live status visibility, automatic daemon management, and visual controls.

### Manual Installation (Alternative to `lernstoff plugin install`)

If you built from source and prefer copying files manually, place `manifest.json`, `main.js`, and `styles.css` directly inside `<vault>/.obsidian/plugins/lernstoff-wiki/`:

```bash
mkdir -p /path/to/my-vault/.obsidian/plugins/lernstoff-wiki
cp packages/obsidian-plugin/dist/* /path/to/my-vault/.obsidian/plugins/lernstoff-wiki/
```

> [!IMPORTANT]
> `manifest.json`, `main.js`, and `styles.css` must sit **directly** in `.obsidian/plugins/lernstoff-wiki/`, not nested inside a `dist/` folder.

### Features Inside Obsidian

- **Automatic Daemon Lifecycle**: Automatically starts the local daemon when Obsidian opens (configurable), switches to a free port (`8188–8288`) if the preferred port is occupied, and supports local fallback writing to `inbox/scratchpad.md` if the daemon is offline.
- **Live Status Bar**: Shows daemon state, open inquiry count, scratchpad promotions ready, and filtered noise percentage. Click it anytime to jump straight to plugin settings.
- **Visual Settings Cockpit** (**Settings $\to$ Lernstoff Wiki**):
  1. **Daemon & OS Boot Auto-Start**: Start/stop/restart the daemon, toggle auto-start on Obsidian launch or OS boot, and set custom port/CLI path.
  2. **AI Programming Agent Integration**: One-click setup buttons for Claude Code, Cursor, and Antigravity, plus **Copy MCP JSON**.
  3. **QMD Models & Storage**: Configure local GGUF embedding/reranking/generation models and inactivity timeout, trigger index updates, pull models, or clean up orphans & decayed items.
  4. **Cognitive Gate & Memory Thresholds**: Real-time sliders for $\tau_{\text{off}}$, $\tau_{\text{core}}$, redundancy similarity, lexical novelty, minimum Socratic links, scratchpad TTL, and promotion hit count—with one-click reset.
  5. **Vault Folder & File Mapping**: Customize paths for inquiries, scratchpad, concepts, wiki root, index, and logs, plus a live daemon log viewer with one-click log clearing.
- **Multi-Language UI**: Automatically adapts to English, 简体中文, 繁體中文, 日本語, and 한국어.
- **Command Palette Commands**:
  - `Lernstoff Wiki: Open Inquiry Tree`
  - `Lernstoff Wiki: Open Scratchpad`
  - `Lernstoff Wiki: Add Selection to Inquiry Tree`
  - `Lernstoff Wiki: Defer Selection to Scratchpad`
  - `Lernstoff Wiki: Run Socratic Wiki Lint`
  - `Lernstoff Wiki: Consolidate & GC Scratchpad`
  - `Lernstoff Wiki: Start Background Daemon`
  - `Lernstoff Wiki: Stop Background Daemon`
  - `Lernstoff Wiki: Restart Background Daemon`

---

## 📄 License

MIT © [JsonLee12138](https://github.com/JsonLee12138)
