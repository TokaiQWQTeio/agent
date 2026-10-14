# Agent Studio 接入

本机控制台源码：https://github.com/TokaiQWQTeio/agent

默认地址 `http://127.0.0.1:4317`。先请求 `GET /api/state`，确认服务连接、登录状态、可用模型及已注册项目。未运行时使用用户已安装目录中的 `npm start`，按实际输出确认地址；没有安装时给出仓库安装方法。不要猜测安装路径。

项目使用明确选择的绝对路径注册。用户指定的当前项目不在列表时，可使用 `POST /api/projects`，JSON 为 `{"root":"<absolute-path>","name":"<optional-name>"}`。使用返回的项目 ID；不要沿用其他项目的目录或 ID。

开始任务使用 `POST /api/runs`：

```json
{
  "projectId": "<returned-project-id>",
  "cwd": "<project-root-or-subdirectory>",
  "goal": "<user-goal-and-acceptance-criteria>",
  "model": "<available-model-id>",
  "mode": "write"
}
```

`read` 只分析，必定跳过执行 Agent；`write` 才会实施修改。模型来自 `/api/state` 的目录或用户明确选择，不能编造模型 ID。

所有 POST 请求使用 `Content-Type: application/json` 和与本机服务一致的 `Origin`（默认 `http://127.0.0.1:4317`）。服务仅接受本机同源请求。

接收 `GET /api/events` 的 `run`、`connection`、`projects` 事件，或以适度间隔读取状态；只跟踪返回的 run ID。等待终态，`completed` 才是流程完成；还需要查看审查结果与执行输出判断目标是否达成。

报告为 `GET /api/runs/<run-id>/report`。停止为 `POST /api/runs/<run-id>/stop`，提交 `{}`。停止不撤销已经发生的文件修改。不要同时把相同任务交给本机会话和控制台执行两次。
