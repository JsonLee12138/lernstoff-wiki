<div align="center">

# 🧠 lernstoff-wiki

**面向 Obsidian 与 AI 编程智能体的本地优先认知选择性笔记引擎与 MCP 记忆服务**

[![npm](https://img.shields.io/npm/v/@lernstoff/cli/beta?label=npm%20%40lernstoff%2Fcli&color=cb3837)](https://www.npmjs.com/package/@lernstoff/cli)
[![MCP](https://img.shields.io/badge/MCP-Protocol-purple.svg)](https://modelcontextprotocol.io/)
[![Obsidian](https://img.shields.io/badge/Obsidian-Plugin-7C3AED.svg)](https://obsidian.md/)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520.0-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[English](README.md) · [简体中文](README.zh.md)

</div>

---

大多数 AI 笔记工具都陷入了**“收藏家谬误（Collector's Fallacy）”**——把网页剪藏、对话原文与泛泛摘要一股脑塞进仓库，最终让知识库沦为高噪音的文件堆。

**`lernstoff-wiki`** 将你的 Obsidian 知识库转变为**高信噪比的常青认知知识库**，让你与 **Claude Code**、**Cursor**、**Antigravity**、**Codex**、**WorkBuddy** 等 AI 编程智能体协同沉淀真正有价值的知识：

- **$\ge 75\%$ 噪音过滤**：每一条候选知识都会经过三阶新颖度与相关性门控筛查——真正的认知增量结晶为永久笔记，边界模糊的观察暂存至闪念缓冲池（跨多源碰撞 2 次以上触发晋升提示，14 天未引用自动归档回收），冗余与跑题噪音直接丢弃。
- **可证伪命题笔记**：强制使用完整命题作为标题（例如 `PostgreSQL MVCC Eliminates Read Locks Under Snapshot Isolation.md`，而非空洞的 `PostgreSQL.md`），并在写入永久笔记前要求智能体完成苏格拉底式自辩护。
- **反孤岛知识图谱**：要求笔记之间建立具名语义关系（`supports`、`contradicts`、`extends`、`qualifies`），并支持一键巡检孤岛节点、潜在矛盾命题对与待合成问题簇。
- **100% 本地隐私运行**：基于 `@tobilu/qmd` 在本地运行 GGUF 向量嵌入与重排（支持 Apple Metal 加速），**无需任何云端 LLM API Key**。
- **开箱即用的智能体与 Obsidian 集成**：一条命令即可为各大 AI 编程智能体注入 MCP（Stdio 与 HTTP）、Skill 与路由规则；配套原生 Obsidian 插件支持 **5 种语言界面**（简体中文、繁體中文、English、日本語、한국어）。

---

## 📦 安装

### 环境要求

- **Node.js** $\ge 20.0.0$

### 🤖 方式一：通过 AI 编程智能体一键安装（推荐）

将以下 Prompt 直接复制发送给你的 AI 编程助手（Claude Code、Cursor、Antigravity、Codex 或 WorkBuddy）：

> ```text
> 你正在协助我安装并配置 Lernstoff Wiki（Obsidian 沉浸式认知命题笔记引擎）。
> 请按照交互式配置流程执行：
> 1. 检查本机是否已安装 `@lernstoff/cli`（运行 `lernstoff --version`）。若未安装，检查 Node.js 环境（>= 20）并全局安装 `@lernstoff/cli@beta`（`npm install -g @lernstoff/cli@beta`）。
> 2. 询问我以下配置项（请勿替我盲猜决定）：
>    - 我的 Obsidian 知识库路径（`--vault <path>`）；
>    - 安装作用域：全局（`global`）、仅当前项目（`project`）还是两者皆要（`both`）；
>    - 目标智能体：`all` / `claude` / `cursor` / `antigravity` / `codex` / `workbuddy`；
>    - 是否安装 Obsidian 插件（`lernstoff plugin install`）、启动后台守护进程（`lernstoff server start --daemon`）、注册开机自启服务（`lernstoff service install`）以及拉取本地模型（`lernstoff doctor --pull-models`）。
> 3. 严格解耦路径：`--vault` 始终指向我的 Obsidian 知识库目录，`--project` 指向当前代码工程目录（如适用）。
> 4. 依次执行 `lernstoff init`、`lernstoff skill install`、`lernstoff rule install` 及所选增强项，最后通过 `lernstoff doctor` 进行健康检查并汇报结果。
> ```

### 方式二：通过 npm / pnpm 安装

```bash
npm install -g @lernstoff/cli@beta
# 或
pnpm add -g @lernstoff/cli@beta
```

### 方式三：通过 Homebrew 安装（macOS）

```bash
brew install --build-from-source Formula/lernstoff.rb
```

### 方式四：从源码构建安装

```bash
git clone https://github.com/JsonLee12138/lernstoff-wiki.git
cd lernstoff-wiki
pnpm install
pnpm build
cd packages/cli && npm link
```

验证安装：

```bash
lernstoff --version
```

---

## 🚀 快速上手

### 1. 初始化 Obsidian 知识库

在你的 Obsidian 仓库目录执行（或通过 `--vault` 指定路径），全新仓库或已有大量笔记的仓库均可安全初始化，绝不覆盖已有笔记：

```bash
lernstoff init --vault /path/to/my-vault
```

初始化会自动生成：

- `.lernstoff/config.json`：服务、目录、模型、门控阈值、苏格拉底规则与闪念默认配置
- `wiki/inquiries.md`：好奇心问题树
- `inbox/scratchpad.md`：快速闪念缓冲池
- `wiki/index.md` 与 `wiki/log.md`：全局认知地图索引与认知演进审计日志
- `wiki/concepts/`：常青命题笔记存放目录
- 自动在仓库 `.gitignore` 中追加 `.lernstoff/`

### 2. 启动后台服务

```bash
# 在后台启动服务
lernstoff server start --vault /path/to/my-vault --daemon

# 查看运行状态
lernstoff server status --vault /path/to/my-vault
```

可选：注册系统开机自启（支持 macOS LaunchAgent 与 Linux systemd 用户服务），重启电脑后无需手动拉起：

```bash
lernstoff service install --vault /path/to/my-vault
```

### 3. 接入 AI 编程智能体

为本机已安装的智能体配置好 MCP 服务与 Skills（`lernstoff-wiki` 与 `lernstoff-setup`）：

```bash
# 默认：同时安装到全局 (~/.claude.json 等) 与项目级配置
lernstoff skill install --vault /path/to/my-vault --target all

# 仅项目级（仅写入当前代码工程的 .mcp.json、.cursor/、.agents/）
lernstoff skill install --vault /path/to/my-vault --project /path/to/your-project --scope project --target all

# 仅全局（仅写入 ~/.claude.json、~/.gemini/、~/.cursor/、~/.workbuddy/）
lernstoff skill install --vault /path/to/my-vault --scope global --target all
```

支持的目标包括：`claude`（Claude Code）、`cursor`（Cursor）、`antigravity`（Antigravity）、`codex`（Codex）、`workbuddy`（WorkBuddy）或 `all`。

你还可以为代码仓库（或全局）注入认知路由规则，让智能体在调研代码前主动检索已有记忆，并严格遵守门控流程：

```bash
# 注入到指定项目（更新 AGENTS.md，若存在 CLAUDE.md 则自动追加 @AGENTS.md）
lernstoff rule install --project /path/to/your-project --target all

# 注入到全局配置
lernstoff rule install --global --target all
```

### 4. 安装 Obsidian 插件

```bash
lernstoff plugin install --vault /path/to/my-vault
```

随后打开 Obsidian $\to$ **设置** $\to$ **社区插件**，刷新列表并启用 **Lernstoff Wiki**（CLI 也会自动在 `community-plugins.json` 中启用它）。

---

## 🤖 与 AI 智能体协同工作（MCP）

接入后（支持 `lernstoff mcp` Stdio 模式及后台服务 `/mcp` HTTP 端点），AI 编程智能体在阅读源码、排查故障或研读文档时会自动遵循以下工作流：

1. **先检索，再调研**：调用 `lernstoff_search_memory` 回顾已有认知，避免重复劳动。
2. **门控过滤噪音**：将新发现提交给 `lernstoff_probe_delta`，筛掉冗余信息，只保留真正有增量的见解。
3. **苏格拉底辩护与结晶**：调用 `lernstoff_crystallize_note`（支持 `CREATE_PROPOSITION`、`AMEND_EXISTING`、`SYNTHESIZE_CLUSTER`）写入或合成命题笔记，阐明新旧认知差异并关联至少 2 条有向关系。
4. **定期巡检与晋升**：通过 `lernstoff_lint_wiki` 检查孤岛/矛盾笔记与待合成问题簇，通过 `lernstoff_consolidate_scratchpad` 晋升高频碰撞闪念并清理过期条目。

| MCP 工具 / 资源                    | 用途说明                                                         |
| :--------------------------------- | :--------------------------------------------------------------- |
| `lernstoff_search_memory`          | 结合关键词、向量语义与关联图谱的混合记忆检索                     |
| `lernstoff_probe_delta`            | 三阶新颖度与相关性门控（丢弃噪音、暂存边缘观察、放行高价值增量） |
| `lernstoff_crystallize_note`       | 创建、修订或簇合成可证伪命题笔记，并校验苏格拉底自辩护与关系链接 |
| `lernstoff_manage_inquiries`       | 管理好奇心问题树（`list` / `add` / `close` / `reopen`）          |
| `lernstoff_consolidate_scratchpad` | 检查多源碰撞待晋升闪念、标记晋升或自动归档超过 14 天的过期条目   |
| `lernstoff_lint_wiki`              | 全库健康体检（检测孤岛笔记、潜在矛盾命题对、待合成问题簇）       |
| `lernstoff_get_note`               | 按行号切片读取笔记内容（`path:from:count`）及反向链接            |
| `lernstoff_status`                 | 获取知识库健康度、QMD 状态、活跃问题数与闪念/噪音过滤指标快照    |
| `lernstoff_install_rule`           | 幂等安装或移除项目 `AGENTS.md` 或全局智能体记忆路由规则          |
| `lernstoff://guide/best-practices` | 内置认知最佳实践与苏格拉底辩护协议指南                           |
| `lernstoff://{+path}`              | 作为 MCP Resource 直接读取笔记 Markdown 原文                     |

完整的智能体行为规范请参阅 [`skills/lernstoff-wiki/SKILL.md`](skills/lernstoff-wiki/SKILL.md)。

---

## 💻 CLI 使用参考

所有命令均支持 `--vault <path>` 参数（不传时默认使用当前工作目录）。

### 知识库、检索与诊断

```bash
# 初始化知识库模板与默认配置
lernstoff init [--vault <path>]

# 混合记忆检索（守护进程离线时自动降级本地检索；终端支持点击 obsidian:// 链接跳转）
lernstoff search "分布式共识" --limit 5 [--lex|--vec] [--json]

# 运行苏格拉底知识库健康巡检（孤岛、矛盾、可合成簇）
lernstoff lint [--vault <path>] [--json]

# 环境诊断、拉取本地模型与清理孤立/过期索引数据
lernstoff doctor [--pull-models] [--cleanup]
```

### 好奇心问题树与闪念缓冲池

```bash
# 好奇心问题树管理
lernstoff inquiry list [--json]
lernstoff inquiry add "LSM 压缩机制如何权衡读放大与写放大？"
lernstoff inquiry close #q-01
lernstoff inquiry reopen #q-01

# 闪念缓冲池管理
lernstoff scratchpad list [--json]
lernstoff scratchpad add "RocksDB 默认使用 Leveled Compaction 策略"
lernstoff scratchpad consolidate   # 查看跨 >= 2 个来源碰撞的候选条目
lernstoff scratchpad gc            # 清理并归档超过 14 天未晋升的过期条目
```

### 配置与后台服务管理

配置保存在 `.lernstoff/config.json`，包含 6 个配置段（`server`、`paths`、`models`、`gate`、`socratic`、`scratchpad`），通过 CLI 或 Obsidian 设置修改后会自动通知运行中的服务热重载：

```bash
# 查看与修改配置
lernstoff config list
lernstoff config get gate.tauCore
lernstoff config set gate.tauCore 0.72
lernstoff config reset [server|paths|models|gate|socratic|scratchpad]
lernstoff config path

# 后台服务启停与日志
lernstoff server start [--daemon|--foreground] [--port <n>]
lernstoff server status [--json]
lernstoff server list [--json]       # 支持别名 ls / ps；列出本机所有知识库服务并识别孤立进程
lernstoff server stop [--all|--pid <pid>|--port <n>]
lernstoff server restart [--foreground] [--port <n>]
lernstoff server logs

# 系统开机自启管理（macOS LaunchAgent / Linux systemd --user / Windows 启动脚本）
lernstoff service <install|uninstall|status>
```

### AI 智能体与 Obsidian 插件配置

```bash
# 为编程智能体一键注入 MCP 配置与 SKILL.md
# 参数说明：
#   --scope <both|global|project>（默认 both）
#   --global                     （--scope global 的简写）
#   --project <path>             （代码工程目录，默认等于 --vault 路径）
lernstoff skill install [--target <all|claude|cursor|antigravity|codex|workbuddy>] [--scope <both|global|project>] [--global] [--project <path>] [--vault <path>]
lernstoff skill show

# 注入或移除智能体路由规则（AGENTS.md / CLAUDE.md / GEMINI.md / WorkBuddy）
lernstoff rule install [--global] [--target <all|codex|claude|antigravity|workbuddy>] [--project <path>] [--no-sync-claude]
lernstoff rule remove [--global] [--target <all|codex|claude|antigravity|workbuddy>] [--project <path>]
lernstoff rule show

# 一键安装并自动启用 Obsidian 插件（优先使用内置资源，缺失时自动回退 GitHub Releases）
lernstoff plugin install [--vault <path>]

# 启动 MCP stdio 服务（通常由智能体自动拉起）
lernstoff mcp [--vault <path>]
```

---

## 🔮 Obsidian 插件

**Lernstoff Wiki** 插件完全保留 Obsidian 原生 Markdown 编辑体验，同时提供直观的状态监控、守护进程自动管理与可视化配置工作台。

### 手动安装（`lernstoff plugin install` 的替代方式）

如果是从源码自行构建并手动拷贝，请确保将 `manifest.json`、`main.js`、`styles.css` 直接平铺放到 `<vault>/.obsidian/plugins/lernstoff-wiki/` 目录下：

```bash
mkdir -p /path/to/my-vault/.obsidian/plugins/lernstoff-wiki
cp packages/obsidian-plugin/dist/* /path/to/my-vault/.obsidian/plugins/lernstoff-wiki/
```

> [!IMPORTANT]
> `manifest.json`、`main.js` 与 `styles.css` 必须直接位于 `.obsidian/plugins/lernstoff-wiki/` 根目录，不能多套一层 `dist/` 文件夹。

### 插件功能一览

- **守护进程自动托管**：打开 Obsidian 时自动拉起后台服务（可关闭），默认端口被占用时自动在 `8188–8288` 切换可用端口；即使服务离线，选中文本暂存至闪念缓冲池时也能自动回退到本地文件写入。
- **底部状态栏实时监控**：直观展示服务运行状态、活跃问题数、待晋升闪念数以及噪音过滤比例；点击状态栏即可快速打开配置页。
- **5 大可视化配置面板**（**设置 $\to$ Lernstoff Wiki**）：
  1. **守护进程与开机自启**：一键启动/停止/重启后台服务、开关打开 Obsidian 时自启或系统开机自启、设置端口与 CLI 路径。
  2. **AI 编程智能体集成**：一键为 Claude Code、Cursor、Antigravity 写入配置，或点击**复制 MCP JSON**。
  3. **QMD 模型与存储**：配置本地 GGUF 嵌入/重排/生成模型 URI 与空闲卸载超时，一键更新索引、拉取模型或清理孤立项与衰退项。
  4. **认知门禁与记忆阈值**：通过滑块实时调节偏题截断（$\tau_{\text{off}}$）、核心通过阈值（$\tau_{\text{core}}$）、冗余相似度、最小词汇新颖度、最小出链数、闪念保留天数与晋升命中次数，支持一键恢复默认。
  5. **仓库文件夹与文件映射**：自定义问题树、闪念缓冲池、概念笔记、Wiki 根目录、索引和日志路径，并内置近期日志查看与一键清空功能。
- **多语言界面**：根据 Obsidian 语言自动切换简体中文、繁體中文、English、日本語与 한국어。
- **命令面板快捷操作**：
  - `Lernstoff Wiki: 打开好奇心问题树`
  - `Lernstoff Wiki: 打开闪念缓冲池`
  - `Lernstoff Wiki: 添加选中内容至好奇心问题树`
  - `Lernstoff Wiki: 暂存选中内容至闪念缓冲池`
  - `Lernstoff Wiki: 运行苏格拉底式 Wiki 巡检`
  - `Lernstoff Wiki: 整理并回收闪念缓冲池`
  - `Lernstoff Wiki: 启动后台守护进程`
  - `Lernstoff Wiki: 停止后台守护进程`
  - `Lernstoff Wiki: 重启后台守护进程`

---

## 📄 开源许可证

MIT © [JsonLee12138](https://github.com/JsonLee12138)
