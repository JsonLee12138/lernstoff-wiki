# 规范契约（SPEC）：`lernstoff-setup` Skill、作用域化 CLI 安装器与 README 智能体安装 Prompt

## 1. 目标与范围
1. **独立的安装配置 Skill（`skills/lernstoff-setup/SKILL.md`）**：
   - 将安装、配置与环境诊断从日常认知笔记协议 `skills/lernstoff-wiki/SKILL.md` 中剥离出来，避免污染日常笔记上下文。
   - 引导 AI 编程智能体按交互式、不盲猜的流程完成配置：
     1. **环境探测**：检查 `lernstoff --version`、`which lernstoff`、`lernstoff server list --json`（如未安装且 Node.js >= 20，引导或执行全局安装 `@lernstoff/cli@beta`）。
     2. **确认用户选项（不擅自替用户决定）**：
        - Obsidian Vault 路径（`--vault`）；
        - 安装作用域：**全局（`global`）**、**仅当前项目（`project`）** 或 **两者都要（`both`）**；
        - 目标智能体：`all` / `claude` / `cursor` / `antigravity` / `codex` / `workbuddy`；
        - 可选增强项：是否安装 Obsidian 插件（`lernstoff plugin install`）、启动后台守护进程（`lernstoff server start --daemon`）、注册开机自启（`lernstoff service install`）、拉取本地模型（`lernstoff doctor --pull-models`）。
     3. **按序执行与解耦**：执行对应 `lernstoff` CLI 命令，严格区分 `--vault`（Obsidian 知识库目录）与 `--project`（代码项目目录）。
     4. **校验与收尾**：执行 `lernstoff doctor` / `lernstoff server status` 确认状态，汇报已写入的配置文件路径与后续手动动作（如重启智能体客户端加载 MCP、在 Obsidian 中启用插件）。
2. **多 Skill 资源同步与作用域化 CLI 安装器（`scripts/sync-plugin-assets.mjs`、`packages/cli/src/agent-installer.ts`、`packages/cli/src/bin.ts`）**：
   - 更新 `scripts/sync-plugin-assets.mjs`：遍历同步 `skills/` 下的所有 skill 目录（包含 `lernstoff-wiki` 与 `lernstoff-setup`）到 `packages/cli/assets/skills/`。
   - 更新 `AgentInstaller.installSkill`：自动发现并安装所有内置/仓库 skill 目录（仅在找不到任何 skill 目录时回退到 `DEFAULT_SKILL_MD`）。
   - 为 `AgentInstaller.installSkill` 和 `AgentInstaller.installMcp` 增加显式作用域与项目目录分离能力：
     - `InstallScope = "both" | "global" | "project"`（默认 `"both"`，完全向后兼容已有 `lernstoff skill install --target <t> --vault <v>` 及 Obsidian 插件中的 `installAgent()` 调用）。
     - `projectPath?: string`（未传时默认回退到 `vaultPath`）：项目级 `.mcp.json`、`.cursor/`、`.claude/`、`.agents/`、`.codebuddy/` 写入代码项目目录，而 MCP 配置参数中的 `--vault <absVault>` 依然准确指向 Obsidian Vault 路径。
     - 对多目标映射出的重复输出路径去重（例如 `.mcp.json` 或 `.agents/skills/`）。
   - 更新 `packages/cli/src/bin.ts` 中的 `lernstoff skill install`：
     - 支持 `--scope <both|global|project>`、`--global`、`--project <path>`。
     - 校验 `--scope` 合法性（非法值或 `--global` 与 `--scope project` 冲突时非零退出）。
     - 未显式传 `--scope` 时：`--global` 解析为 `"global"`；传了 `--project <path>` 解析为 `"project"`；两者均未传时默认 `"both"`。
     - 同步更新 CLI `--help` 用法说明。
3. **中英文 README 智能体一键安装 Prompt（`README.md` & `README.zh.md`）**：
   - 在 `README.md` 与 `README.zh.md` 的安装/快速上手前置位置增加可复制的 **「通过 AI 智能体一键安装与配置（Copy-Paste Prompt）」** 区块。
   - Prompt 指导任意 AI 编程智能体：检查/安装 `@lernstoff/cli@beta` → 询问用户的 Vault 路径、**全局 vs 项目级**作用域、目标智能体 → 自动完成 `init`、`skill install`、`rule install`、`server start --daemon` 及可选的 `plugin install` / `service install` / `doctor --pull-models`。
   - 同步更新两份 README 中 `lernstoff skill install` 的 `--scope`、`--global`、`--project` 参数文档。

## 2. 非目标（Non-Goals）
- 不修改 Obsidian 插件前端 UI（`packages/obsidian-plugin/src/settings-tab.ts`）及 `DaemonClient.installAgent` 接口签名；保留默认参数向后兼容。
- 本次不新增 Codex 全局 TOML（`~/.codex/config.toml`）写入器，保持现有 Codex 项目级 `.mcp.json` 注入方式。
- 不改动 `packages/core/src/rule-installer.ts` 核心逻辑（`lernstoff rule install` 已支持 `--global`、`--project` 与 `--target`）。

## 3. 验收标准（Acceptance Criteria）
1. `skills/lernstoff-setup/SKILL.md` 存在且清晰覆盖 Vault 初始化、全局/项目级选择、MCP + Skill + Rule 安装、Obsidian 插件安装、Daemon/开机自启配置及 `doctor` 诊断。
2. `pnpm build` 触发 `scripts/sync-plugin-assets.mjs` 后，`packages/cli/assets/skills/` 下同时包含 `lernstoff-wiki` 与 `lernstoff-setup`。
3. `AgentInstaller.installSkill` 与 `AgentInstaller.installMcp` 正确支持 `scope`（`global` / `project` / `both`）与 `projectPath`，确保 MCP 参数中的 `--vault` 与项目写入目录 `projectPath` 互不混淆；`packages/cli/tests/cli.test.ts` 覆盖多 skill 安装、作用域过滤、`--vault` 与 `--project` 分离及 CLI 参数校验。
4. `README.md` 与 `README.zh.md` 包含可直接复制给智能体的安装 Prompt 及更新后的 CLI 参数说明。
5. 全量门禁 `bash scripts/gate-check.sh` 零错误通过。
