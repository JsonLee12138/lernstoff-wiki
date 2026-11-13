# 实施计划（PLAN）

## 切片 1：多 Skill 同步与作用域化 CLI 安装器（`sync-plugin-assets.mjs`、`agent-installer.ts`、`bin.ts`、`cli.test.ts`）
- [x] **状态:** 已完成
- **涉及文件**:
  - `scripts/sync-plugin-assets.mjs`（同步 `skills/` 下全部 skill 目录到 `packages/cli/assets/skills/`）
  - `packages/cli/src/agent-installer.ts`（新增 `InstallScope`、`projectPath`、多 skill 发现与安装、按作用域过滤路径及结果去重）
  - `packages/cli/src/bin.ts`（为 `lernstoff skill install` 解析并校验 `--scope`、`--global`、`--project`，更新帮助信息）
  - `packages/cli/tests/cli.test.ts`（补充多 skill 安装、`global`/`project`/`both` 作用域、`--vault` 与 `--project` 解耦及 CLI 参数校验测试）
- **验证方式**:
  - `pnpm --filter @lernstoff/cli test` 全部通过。

## 切片 2：`lernstoff-setup` Skill 与中英文 README 安装 Prompt
- [x] **状态:** 已完成
- **涉及文件**:
  - `skills/lernstoff-setup/SKILL.md`（交互式安装配置 skill：环境探测、Vault 与项目路径分离、全局/项目级选择、MCP/Skills/Rules/Obsidian 插件/Daemon/开机自启/Doctor 全流程）
  - `README.md`（新增英文版「Install via AI Agent」可复制 Prompt 并更新 `lernstoff skill install` 参数文档）
  - `README.zh.md`（新增中文版「通过 AI 智能体一键安装」可复制 Prompt 并更新 `lernstoff skill install` 参数文档）
- **验证方式**:
  - `pnpm build` 将 `lernstoff-wiki` 与 `lernstoff-setup` 均同步至 `packages/cli/assets/skills/`。
  - `bash scripts/gate-check.sh` 全量通过（`pnpm check`、`pnpm i18n:check`、`pnpm build`、`pnpm test --run`）。
