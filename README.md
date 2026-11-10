# Agent 调度中心

在一个项目里，让 Claude Code 拆分任务、安排多位 Agent 并行工作，再整理交付与未完成项。面板显示分工、执行状态、结果、Git 补丁和历史记录。

## 启动

需要 macOS 或 Linux，以及 Python 3.9+ 和 Git。调度中心本身只用 Python 标准库。

- **macOS**：在 Finder 里双击 `start.command`。它会在本机启动服务，并打开浏览器。
- **终端**：进入 `agent-center` 目录后运行以下命令。终端会打印本次访问地址，按 Ctrl+C 可停止服务。

```sh
python3 -B center.py --open --port 0
```

点 **运行演示** 体验完整流程。演示用模拟结果，运行期间可看到五个执行 Agent 同时工作，并下载由三个示例文件组成的合并补丁。

## 真实运行

1. 安装并登录 Claude Code CLI，确认终端可找到 `claude`。如果执行文件位于自定义目录，在启动服务前设置 `AGENT_CENTER_CLAUDE_BIN`。
2. 选择 **真实运行**，填写项目名称和任务目标，勾选参与的 Agent。已有项目填写本机 Git 仓库目录，留空会创建空白仓库。
3. 点击 **启动项目**。Claude 会为每位已选 Agent 生成一项可独立完成的任务。编程 Agent 会在独立副本里执行，WorkBuddy 和 Grok Bot 可承担基于项目说明的文本交付。
4. 在运行面板查看结果与日志。成功任务的补丁依计划顺序尝试合并到预览副本，冲突任务会保留单独补丁。预览路径和合并补丁出现在面板底部。

现有仓库的基线是运行开始时已提交的 HEAD。把希望 Agent 读取的改动先提交到 Git。副本不带源仓库的远程地址。调度中心在预览副本应用补丁，正式合入由你在原仓库审阅后执行。预览的 Git 暂存区保存已成功应用的改动，运行 `git diff --cached` 即可查看。

## Agent 接入

| Agent | 接入方式 | 准备事项 |
| --- | --- | --- |
| Claude Code | `claude -p`，结构化分工与文本汇总 | 安装并登录近期版本 CLI，需支持 `--safe-mode` 和 `--json-schema`。[Claude Code 文档](https://code.claude.com/docs/en/headless) |
| Codex | `codex exec` | 使用已登录的 CLI。macOS 会尝试发现 ChatGPT 应用内的 CLI。[OpenAI 官方文档](https://learn.chatgpt.com/docs/non-interactive-mode) |
| Muse Code | `muse exec` | 安装并登录 Meta Muse Code CLI，或按 Meta 文档配置 `META_API_KEY`。[Meta 文档](https://dev.meta.ai/docs/muse-code/extending?project_id=1775916636764246&team_id=1331104075427093) |
| DeepSeek Harness | `dsh --profile headless` | 配置可用于 headless 的模型凭证。macOS 会尝试发现 DeepSeek Harness 应用内的 CLI。[DeepSeek Harness 文档](https://deepseek-harness.github.io/deepseek-harness/en/reference/) |
| WorkBuddy | 本地助理 API，或手动交接 | 自动派发与轮询需要有效的 `WORKBUDDY_ACCESS_TOKEN`，授权范围为 `user.localassistant.invokable` 和 `user.localassistant.readable`，同时 PC 本地助理需在线。未设置时可复制任务和粘贴结果。[WorkBuddy 开放平台](https://open.workbuddy.cn/docs/openapi) |
| Grok Bot | Routine Webhook，或手动交接 | 自动触发需要 `GROK_BOT_WEBHOOK_URL` 和 `GROK_BOT_WEBHOOK_KEY`。请让 Routine 读取收到的 JSON 中的 `prompt` 字段，在 Bot 对话中输出结果，再粘贴回面板。[Grok Bot Webhook 文档](https://docs.x.ai/grok-bot/skills-routines-and-automations#webhooks) |

可用 `AGENT_CENTER_CODEX_BIN`、`AGENT_CENTER_MUSE_BIN`、`AGENT_CENTER_DEEPSEEK_BIN` 指定 CLI 的绝对路径。需要传入环境变量时，从同一个已配置变量的终端启动服务。面板的连接状态只检查执行文件或变量是否存在，CLI 登录和外部凭证在真正执行时验证。

WorkBuddy 或 Grok Bot 的手动交接任务会等待回填。可在任务卡片中提交结果或跳过，让 Claude 继续汇总。停止运行会结束本地 CLI 进程并停止等待，已派发到外部平台的任务可在各自平台查看和处理。

## 数据与验证

- 默认把历史、日志、项目副本和补丁保存在程序目录的 `.runs`。可用 `--state /绝对路径` 指定其他目录。服务仅绑定本机回环地址。
- 使用真实模式时，项目说明和必要的任务上下文会发给所选供应商。各 CLI 按各自权限处理文件和工具。Git 副本隔离的是项目改动。
- 每次运行一个项目，项目内的执行 Agent 同时启动。当前按单轮并行任务调度，适合可独立交付的分工。
- 已在浏览器验证五个模拟任务并行、汇总和补丁下载。使用模拟 CLI 验证了真实模式的分工解析、进程并行、回填、冲突和停止。各供应商的真实账号连接需在配置后验证。
