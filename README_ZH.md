<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/wordmark-light.svg">
    <img src="docs/assets/wordmark-light.svg" alt="Kinetick Code" width="784">
  </picture>
</p>

<h1 align="center">Kinetick Code</h1>
<p align="center">A terminal coding agent with MiniMax, your own models, and tools beyond code.</p>

> **说明。** **Kinetick Code** 是 [`MiniMax-AI/minimax-code`](https://github.com/MiniMax-AI/minimax-code) 的社区分叉，
> 维护于 [`tournierjc/kinetick-code`](https://github.com/tournierjc/kinetick-code)。定期合并上游，并保留分叉边界
> （无遥测、无托管服务客户端——见[网络出口](#网络出口)）。
>
> **请安装本产品**：从[本仓库 GitHub Releases](https://github.com/tournierjc/kinetick-code/releases)
> 下载已校验的归档（`kinetick-code-<version>.tar.gz` 与 `.sha256`），或[从本仓库源码构建](#从源码构建)。
> 上游 MiniMax 安装器与公开 npm 包 `@minimax-ai/code` 发布的是**上游构建**，不包含本分叉改动——请勿用它们安装 Kinetick Code。
> 发布流程见 [docs/releasing.md](docs/releasing.md)。
>
> **本分叉新增的能力：** Session 标签栏与后台多任务（切换 Session 后任务继续运行并持续流式输出）、
> 在 `/provider` 中配置 OpenRouter、DeepSeek、GitHub Copilot 与免鉴权本地端点、状态栏与 `/usage`
> 中的整场会话成本统计、独立的更新通道，以及无遥测——见
> [Session 标签栏](#session-标签栏与多任务)与[网络出口](#网络出口)。

<p align="center">
  <a href="#快速开始">Get started</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="docs/examples.md">Examples</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>
<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>
<p align="center">
  <img src="docs/assets/source-preview.svg" alt="Source preview">
  <img src="docs/assets/node.svg" alt="Compatibility: Node.js 22.19+, 24.2+, 25, and 26">
  <a href="LICENSE-STATUS.md"><img src="docs/assets/license.svg" alt="First-party default license: MIT"></a>
</p>

在终端里读懂项目、修改代码并运行测试。使用 MiniMax 账号或自己的模型，把搜索、插件和多模态工具接入同一个工作流。

<p align="center">
  <img src="docs/assets/tui-demo.png" alt="Kinetick Code TUI：Session 标签栏、Plan Mode 与正在运行的任务" width="784">
</p>

## 快速开始

### 1. 安装 KCode

**GitHub Release 归档（推荐）。** 从
[本仓库最新 Release](https://github.com/tournierjc/kinetick-code/releases/latest)
下载 `kinetick-code-X.Y.Z.tar.gz` 与配套 `.sha256`，校验后用 npm 安装。需要 Node.js
**22.19+（22.x）、24.2+（24.x）、25 或 26**；npm 仍需访问公共 registry 以拉取运行时依赖。

```bash
# Linux；macOS 使用：shasum -a 256 -c kinetick-code-X.Y.Z.tar.gz.sha256
sha256sum -c kinetick-code-X.Y.Z.tar.gz.sha256
npm install --global ./kinetick-code-X.Y.Z.tar.gz --registry=https://registry.npmjs.org/ --include=optional --ignore-scripts=false --allow-scripts=better-sqlite3
kcode --version
```

详见[安装 GitHub Release 归档](docs/installation.md#install-a-github-release-archive)与
[发布流程](docs/releasing.md#fork-release-process-tournierjckinetick-code)。

**备选 — 从本仓库源码构建。** 见下方「从源码构建」。

重新打开终端后检查安装：

```bash
kcode --version
kcode --help
```

文档见[安装说明](docs/installation.md)、[使用示例](docs/examples.md)与 [TUI 能力](docs/tui-capabilities.md)。
`kcode update` 只安装本仓库发布的归档；见[更新](docs/installation.md#updating)。

### 2. 选择提供方或登录

优先使用 **`/provider`**（或在 shell 中运行 `kcode provider`）。适用于运行时支持的任意连接：
OpenRouter、DeepSeek、GitHub Copilot、免鉴权本地端点、自定义 OpenAI/Anthropic 兼容 API，以及可用时的 MiniMax。
连接提供方后用 `/model` 选择模型，用 `/status` 查看当前配置。

<details>
<summary>使用自己的 API Key（BYOK）</summary>

BYOK 无需先登录 MiniMax。先在当前 shell 中设置 `MCODE_PROVIDER_API_KEY`，再添加提供方；将下方示例地址和模型名替换为实际配置：

```bash
kcode provider add --name my-provider --base-url https://example.com/v1 \
  --api-format openai-completions --model my-model \
  --api-key-env MCODE_PROVIDER_API_KEY --use
kcode
```

`--use` 会先测试第一个模型，成功后保存并设为默认模型；连接测试失败时不保存。省略 `--use` 则仅保存，不测试，也不改变默认模型。对于自定义或本地模型，可添加 `--context-limit 32768 --output-limit 4096`（请填写服务器的实际限制）。两个值都必须是正安全整数，并应用于所有重复指定的 `--model`。可通过 `kcode provider list --json` 查看已配置的限制。省略这两个参数时保持现有的模型限制默认值。

支持 `openai-completions`、`openai-responses` 和 `anthropic-messages`。连接测试、单次模型切换及环境变量设置见 [模型示例](docs/examples.md#2-choose-your-own-model)。

通过该命令添加的提供方保存在当前 profile `config.yaml` 的 `custom_provider` 下；第三方或自建端点一律走这条路径，`minimax_api` 保留给官方 MiniMax API。若中转端点只提供 Anthropic 兼容接口且要求 `Authorization: Bearer` 鉴权，可在 `config.yaml` 中为提供方配置自定义 headers；见[第三方中转与自定义鉴权头](docs/examples.md#third-party-relays-and-custom-auth-headers)。

</details>

<details>
<summary>可选：MiniMax 账号 / Token Plan</summary>

若使用 MiniMax OAuth 或 Token Plan，运行 `kcode login`（账号需要时可加 `--region cn|global`），
在浏览器中完成登录，再用 `/status` 与 `/provider`。退出登录使用 `kcode logout`。Token Plan 需要账号与可用额度。

</details>

从本仓库构建的版本默认将用户数据保存在 `~/.minimax`（选择 profile 时为 `~/.minimax-<profile>`）。
`MINIMAX_DATA_DIR` 或 `MAVIS_DATA_DIR` 可以覆盖数据目录。该路径与 npm 安装 `kinetick-code` 包的位置无关。
查找或删除配置和会话前，请参阅[账号与数据](docs/installation.md#accounts-and-data)。

### 3. 完成第一个任务

进入要处理的项目目录：

```bash
cd /path/to/your/project
kcode
```

在 TUI 中描述任务，也可以在启动时直接提交：

```bash
kcode "Find a failing test, fix the implementation, and run the relevant tests."
```

使用 `kcode init .` 生成或更新 `AGENTS.md` 项目指导。任务中应说明期望结果、修改边界和验证方式。

| 入口 | 命令 | 适用场景 |
| --- | --- | --- |
| 交互式 TUI | `kcode [prompt]` | 探索代码、持续对话、审阅修改与权限确认。 |
| Headless | `kcode exec [prompt]` | Shell、CI、批处理与评测。 |
| ACP | `kcode acp` | 支持 Agent Client Protocol 的编辑器与客户端。 |

### 继续之前的工作

```bash
# 恢复当前工作区最近的会话
kcode --continue

# 打开会话选择器
kcode --session
```

在 TUI 中输入 `/sessions` 查找历史会话，输入 `/help` 查看完整命令与快捷键。

| 操作 | 快捷键 |
| --- | --- |
| 发送消息，或在任务运行中调整当前响应 | `Enter` |
| 在任务运行中将后续消息加入队列 | `Alt+Enter` |
| 在输入框中换行 | `Shift+Enter` |
| 引用工作区文件或目录 | `@` |
| 切换 Plan Mode | `Shift+Tab` |
| 切换权限模式 | `Alt+M` |
| 切换 Session 标签 | `Ctrl+Shift+Left` / `Ctrl+Shift+Right` |
| 按槽位直达 Session 标签 | `Alt+1`…`Alt+9` |
| 新建 Session 标签 | `Alt+N` |
| 关闭当前 Session 标签 | `Alt+W` |
| 重命名当前 Session 标签 | `Alt+R` |
| 关闭面板或中断正在运行的任务；在模型回复之前中断会把消息放回输入框 | `Esc` |

### Session 标签栏与多任务

Kinetick Code 可以在 Composer 上方的标签栏中并行运行多个 Session：

- **每个打开的 Session 都是一个标签**，带实时状态（`working`、`waiting`、`unread`）。等待你输入的回答的 Session 会在标签栏中高亮显示，即使画面很繁忙也能一眼看到。`/new`（或 `Alt+N`）新开标签，`/clear` 在当前标签内开始新会话，`/clone` 把 Session 复制为新会话。
- **后台任务持续运行。** 切换走之后，运行中的任务继续在自己的标签里流式输出；切回来即回到离开时的画面。任务在你离开期间完成时会出现 `unread` 标记。
- **按你的方式整理标签栏：** `Alt+R` 重命名标签，`Shift+Alt+Left` / `Shift+Alt+Right` 把标签移动到指定槽位；来自多个项目的标签会自动按项目分组。
- **用 `/pin` 固定常用 Session**：被固定的 Session 在 `/sessions` 列表中置顶，并在标签栏上标记。
- **快速找到任意会话：** `/sessions` 按项目分组、支持按会话内容搜索，删除时默认归档。

完整按键绑定与语义见 [Open Session tabs](docs/tui-capabilities.md#open-session-tabs)。

## 卸载

卸载前请关闭正在运行的 KCode 会话，包括编辑器中的集成。先通过 `command -v kcode`（macOS / Linux / WSL）或 `Get-Command kcode -All`（PowerShell）定位命令，再按对应方式操作。

### 通过 Release 归档（npm 全局）或源码安装

全局 npm 安装请使用当初安装时的同一套 npm 和安装前缀：

```bash
npm uninstall -g kinetick-code
```

源码构建请先保存工作，再仅删除自己创建的源码目录，详见[更新或移除](docs/installation.md#update-or-remove)。

卸载后重新打开终端（编辑器集成终端需要完全重启编辑器），再次运行 `command -v kcode` 或 `Get-Command kcode -All`。没有结果表示 PATH 中已找不到该命令。如果出现另一份安装，请先确认它的安装方式再移除。

<details>
<summary>可选说明：残留的上游 MiniMax 安装器安装</summary>

上游 MiniMax 一键安装器（不是本分叉）会把文件放在 `~/.minimax-code`（POSIX）或 `%USERPROFILE%\.minimax-code`（Windows），并可能修改 PATH。那些脚本**不会**安装 Kinetick Code。若曾使用过且要清理：

```bash
# macOS / Linux / WSL
rm -rf -- "$HOME/.minimax-code"
# 同时从 shell 配置中删除安装器写入的对应 PATH 行。
```

```powershell
Remove-Item -LiteralPath "$env:USERPROFILE\.minimax-code" -Recurse -Force
# 如有对应的用户 Path 条目，一并删除。
```

名为 `@minimax-ai/code` 的旧全局 npm 包同样是上游（或更名前残留）；若仍在磁盘上，用 `npm uninstall -g @minimax-ai/code` 卸载。

</details>

### 可选：删除用户数据

移除程序会保留单独存储的用户数据。如果还要删除本地登录状态、提供方配置、缓存和会话，请先按[账号与数据](docs/installation.md#accounts-and-data)确认实际数据目录，并备份需要保留的内容。其他 KCode 安装可能共用该目录。以下命令仅适用于默认的 `~/.minimax`：

```bash
# macOS / Linux / WSL — 永久删除默认用户数据
rm -rf -- "$HOME/.minimax"
```

```powershell
# Windows — 永久删除默认用户数据
Remove-Item -LiteralPath "$env:USERPROFILE\.minimax" -Recurse -Force
```

profile 使用 `~/.minimax-<profile>`；`MINIMAX_DATA_DIR` 或 `MAVIS_DATA_DIR` 可以指定其他位置。只删除确定不再需要的具体目录，不要使用通配符批量删除。如果不再需要自行添加的 KCode 环境变量，也请从 shell 配置或用户环境变量设置中移除对应赋值。

## 通过脚本安装

以下命令会删除默认安装目录，包括两个启动器、下载的版本，以及安装器管理的 Node.js 运行时。如果使用过 `MCODE_INSTALL_DIR`，请替换为实际安装目录。删除前请先检查：早期源码构建曾将用户数据保存在 `~/.minimax-code`，自定义数据目录也可能与安装目录重合。请先备份需要保留的配置和会话。

**macOS / Linux / WSL**

```bash
rm -rf -- "$HOME/.minimax-code"
```

从安装器修改的 shell 配置文件中删除 `# Kinetick Code CLI` 注释及其下一行 PATH 配置：zsh 使用 `~/.zshrc`；bash 依次选择 `~/.bashrc`、`~/.bash_profile`、`~/.profile` 中第一个已存在的文件，均不存在时创建 `~/.bashrc`；fish 使用 `~/.config/fish/config.fish`；其他 shell 使用 `~/.profile`。对应配置为 `export PATH="/absolute/install/path/bin:$PATH"`，fish 则为 `fish_add_path -g "/absolute/install/path/bin"`。只移除 KCode 对应的条目，保留其他 PATH 设置。如果设置了 `MCODE_NO_MODIFY_PATH` 或路径已存在，安装器会跳过此修改。

**Windows（PowerShell）**

```powershell
Remove-Item -LiteralPath "$env:USERPROFILE\.minimax-code" -Recurse -Force
```

打开“编辑账户的环境变量”，编辑用户 **Path**，仅删除安装目录对应的条目（默认为 `%USERPROFILE%\.minimax-code`，也可能显示为展开后的绝对路径）。Windows 安装器修改的是用户 Path，不是 PowerShell 配置文件；设置 `MCODE_NO_MODIFY_PATH` 会跳过此持久化修改。

### 通过 npm 或源码安装

全局 npm 安装请使用当初安装 KCode 时的同一套 npm 和安装前缀：

```bash
npm uninstall -g kinetick-code
```

在本产品使用自有包名之前安装的实例名为 `@minimax-ai/code`；如仍存在于磁盘上，用同样方式卸载。

源码构建请先保存工作，再仅删除自己创建的源码目录，详见[更新或移除](docs/installation.md#update-or-remove)。

卸载后重新打开终端（编辑器集成终端需要完全重启编辑器），再次运行 `command -v kcode` 或 `Get-Command kcode -All`。没有结果表示 PATH 中已找不到该命令。如果出现另一份安装，请先确认它的安装方式再移除。

### 可选：删除用户数据

移除程序会保留单独存储的用户数据。如果还要删除本地登录状态、提供方配置、缓存和会话，请先按[账号与数据](docs/installation.md#accounts-and-data)确认实际数据目录，并备份需要保留的内容。其他 KCode 安装可能共用该目录。以下命令仅适用于默认的 `~/.minimax`：

```bash
# macOS / Linux / WSL — 永久删除默认用户数据
rm -rf -- "$HOME/.minimax"
```

```powershell
# Windows — 永久删除默认用户数据
Remove-Item -LiteralPath "$env:USERPROFILE\.minimax" -Recurse -Force
```

profile 使用 `~/.minimax-<profile>`；`MINIMAX_DATA_DIR` 或 `MAVIS_DATA_DIR` 可以指定其他位置。只删除确定不再需要的具体目录，不要使用通配符批量删除。如果不再需要自行添加的 KCode 环境变量，也请从 shell 配置或用户环境变量设置中移除对应赋值。

## 可以做什么

| 场景 | 使用方式 |
| --- | --- |
| **修改与验证代码** | 读取文件、编辑 diff、执行 Shell 和测试；通过权限与沙箱控制工具执行。 |
| **选择模型** | MiniMax 账号 / Token Plan，或兼容 OpenAI、Anthropic 格式的自定义提供方——包括 OpenRouter、DeepSeek、GitHub Copilot 与免鉴权本地端点，均可在 `/provider` 中配置。 |
| **搜索与多模态** | 内置搜索、`mcode-tools` 媒体工具、MCP 和托管连接器；按账号权限和服务额度使用。 |
| **多 Session 并行** | Session 标签栏与实时状态、切换后继续流式输出的后台任务、固定 Session、项目分组与 `/clone`。 |
| **延续工作** | 会话恢复、任务规划、子 Agent、状态栏与 `/usage` 的整场会话成本统计、插件与内置 Skills。 |
| **接入工作流** | Headless CLI 用于脚本任务，ACP 用于兼容的编辑器和客户端。 |

账号、更新、反馈与诊断能力也在。托管工具需要网络和相应授权，详细边界见 [能力与服务边界](docs/tui-capabilities.md)。

## 试一试

在示例目录启动 TUI，输入：

> Read clamp.mjs and clamp.test.mjs. Run node --test to reproduce the failure, fix clamp without changing the tests, then run the tests again.

这个 [可复现的小项目](examples/clamp) 适合作为第一个任务。[更多示例](docs/examples.md) 包括切换模型、执行真实搜索，以及使用自己的图片输入。

## 从源码构建

开发 KCode 或运行本仓库源码需要 Git、Node.js **22.19+（22 系列）、24.2+（24 系列）、25 或 26**，以及 **pnpm 9.12.0**。在 Windows 上，请将源码放在本地 NTFS 卷上，并避开云同步目录；下面的预检命令会在 pnpm 创建 workspace link 前检查卷类型。
```bash
git clone https://github.com/tournierjc/kinetick-code.git
cd kinetick-code
node scripts/check-windows-source-location.mjs
pnpm install --frozen-lockfile
pnpm build
pnpm kcode
```

首次构建需要联网；依赖和经过校验的 `mcode-tools` 均来自公共 npm。pnpm 安装、系统依赖和更新方法见[源码安装指南](docs/installation.md)。

从源码目录运行时，将上方示例中的 `kcode` 替换为 `pnpm kcode`。要在自己的项目中工作，先切换到项目目录，再运行构建产物：

```bash
node /absolute/path/to/kinetick-code/dist/cli.js
```

安装 [Release 归档](#1-安装-kcode) 与构建本检出是两条独立路径。版本关系见[版本与证据基线](docs/open-source-status.md#version-and-evidence-baseline)。

## 文档与贡献

- [安装与更新](docs/installation.md) · [使用示例](docs/examples.md) · [TUI 状态栏](packages/tui/docs/status-line-config.md)
- [贡献指南](CONTRIBUTING.md) · [分叉发布流程](docs/releasing.md) · [报告安全问题](SECURITY.md)
- [全部文档](docs/README.md)：架构、能力对照、验证记录、源码同步和发布流程。

项目文档以英文为主，本页为首页的简体中文译文。

目前仅接受仓库协作者提交代码和文档 Pull Request。本分叉的开发一律通过功能分支和针对 `main` 的审阅 PR 进行（包括上游同步 PR），禁止直接推送 `main`；见 [docs/releasing.md](docs/releasing.md) 与 [docs/source-sync.md](docs/source-sync.md)。

## 问题反馈

本仓库覆盖 Kinetick Code 终端 CLI：TUI、Headless CLI 与 ACP。报告问题或提问请在本仓库
[提交 issue](https://github.com/tournierjc/kinetick-code/issues/new/choose)。报告缺陷时请附上
`kcode --version`、使用的界面与最小复现步骤，并删除报告中的凭据和私有项目内容。

## 许可

Kinetick Code 是 [MiniMax Code](https://github.com/MiniMax-AI/minimax-code)（`MiniMax-AI/minimax-code`）的分叉，
上游代码版权归 MiniMax Code（Copyright (c) 2026 MiniMax Code）。上游采用 MIT 许可证，**本分叉对整个代码库——
包括上游代码与 Kinetick Code 的改动——保持相同的 [MIT 许可证](LICENSE)**。原始项目的全部功劳归属于 MiniMax Code。
文件或子包已有独立声明时保留原许可。依赖、资源与 `mcode-tools` 的许可分别见 [第三方声明](THIRD_PARTY_NOTICES.md) 和 [许可状态](LICENSE-STATUS.md)。
