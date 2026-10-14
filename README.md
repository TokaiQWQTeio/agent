# Agent Studio · 多项目 Agent 协作工作台

一个本机安装，在不同项目中复用 **分析与规划并行 → 执行 → 独立审查**。控制台通过 Codex App Server 发起真实任务，展示进度、输出、交接日志和报告，同时提供可安装的个人 Codex Skill。

## 快速开始

需要 Node.js 22+、Git、已安装并登录的 Codex CLI。

```sh
git clone https://github.com/TokaiQWQTeio/agent.git
cd agent
codex login
npm start
```

打开 [本机工作台](http://127.0.0.1:4317)。已有 Codex 登录时无需再次登录。应用无额外 npm 依赖，无需 `npm install`。Windows 可双击 `启动工作台.cmd`；Linux/macOS 使用 `npm start` 后手动打开终端打印的地址。

若找不到 Codex，用 `CODEX_BIN` 指定可执行文件实际路径。`PORT` 可调整端口。命令中的目录名 `agent` 是克隆后的默认目录；已有安装使用实际安装目录。

## 跨项目使用

1. 点击 **添加项目**，填写已有项目文件夹的绝对路径和可选名称。
2. 使用 **当前项目** 列表切换。添加项目不会复制或修改项目文件。
3. 输入目标、选择模型及模式。任务目录可为所选项目根目录或其子目录。
4. 查看各 Agent 输出、日志和当前项目的历史记录。
5. 下载报告，或在 `runtime/reports/<project-id>/` 查看本机记录。

项目列表持久保存，模式和模型偏好按项目存储在浏览器中。移出列表不会删除文件或报告；重新添加同一路径会恢复相同 ID 和历史。

每次运行一个协作任务；运行时可切换项目查看历史。停止按钮标明实际运行的项目。停止请求中断活动 Agent 并阻止后续阶段，已有修改不会自动回滚。

| 模式 | 工作内容 | 真实 Agent 任务数 |
| --- | --- | --- |
| 只读分析 | 分析、规划、审查；跳过执行，不修改文件 | 3 |
| 完整流程 | 分析、规划、实施修改、独立审查 | 4 |

制作网站或修复代码请选择 **完整流程**。只读任务完成后可点击 **用完整流程重新运行**，沿用目标、目录和模型创建新任务。流程完成表示各阶段已结束，目标是否达成仍以实际文件、执行结果和审查报告为准。

每个 Agent 消耗当前 Codex 账号用量，模型从实际可用列表中选择。网络重试会显示在日志中；网页不需要输入 API Key。

## 安装个人 Skill

在仓库根目录运行：

```sh
npm run install:skill
```

默认安装到 `$CODEX_HOME/skills/multi-agent-workflow`，未设置 `CODEX_HOME` 时为 `~/.codex/skills/multi-agent-workflow`。如果当前 Codex 使用个人 `~/.agents/skills` 目录，可以指定：

```sh
node scripts/install-skill.mjs --destination "<个人 skills 目录>"
```

在其他项目的 Codex 聊天中调用：

```text
使用 $multi-agent-workflow 在当前项目完成我的目标：……
```

普通调用通过当前会话的子 Agent 工具执行；指定“通过工作台运行”时才接入已有控制台。未显示新 Skill 时重新打开 Codex。源码位于 [skills/multi-agent-workflow](skills/multi-agent-workflow/SKILL.md)。

更新仓库后显式更新个人副本：

```sh
node scripts/install-skill.mjs --update
```

安装器不会默默覆盖已有 Skill，不会删除用户额外添加的文件；个人副本不会自动随 Git 仓库更新。

## 项目约定

各项目在自己的 `AGENTS.md` 中填写用途、目录、启动方式、测试命令和限制，参考 [项目约定模板](templates/AGENTS.md)。合并到已有文件，不要覆盖原约定。Agent 会遵循目标项目适用的指令。

## 本机数据与边界

- 服务仅监听 `127.0.0.1`，检查 Host 和 Origin，拒绝跨站调用；不要将端口转发到公网。
- 项目注册使用规范化真实路径。任务再次校验范围，拒绝链接到项目外的目录及内部账号配置目录。
- 完整流程只有执行 Agent 获得所选任务目录的写入沙箱；其他角色只读，不自动批准额外权限请求。
- `runtime/` 存放本机项目路径与报告，Git 忽略该目录。登录凭证由 Codex 管理，不写入网页或仓库。
- 旧安装启动时保留原工作区及旧报告；新报告按项目保存。启动时加载最近 200 项记录，较旧报告仍保留在磁盘。

GitHub 保存源码和版本，真实执行仍需本机 Node 服务和 Codex 登录。单独托管静态前端无法执行本机任务。

## 开发与验证

```sh
npm test
node --check server.mjs
node --check dist/app.js
```

测试使用临时项目和模拟 Codex，不产生模型调用。覆盖项目注册与重载、并发保存、目录及链接边界、报告隔离、旧历史迁移、同源限制、阶段交接、失败传播、停止和 Skill 安装。

GitHub Actions 在 Windows 和 Linux 上运行同一测试；本地通过不代表远程 CI 已通过。

```text
dist/                         网页界面
projects.mjs                  项目注册与路径校验
orchestrator.mjs              Agent 调度与报告
codex-client.mjs               Codex JSON-RPC 连接
server.mjs                    本机 HTTP / SSE 服务
skills/multi-agent-workflow/   Skill 源码
scripts/install-skill.mjs      个人 Skill 安装器
templates/AGENTS.md            项目约定模板
tests/                        自动测试
runtime/                      私人运行数据（不提交）
```

参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Skills](https://learn.chatgpt.com/docs/build-skills)。
