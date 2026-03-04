# API 设计

本文档规范了客户端与 Agent 通信的 RESTful API 和 WebSocket 协议。

## 认证

所有端点都需要在 `Authorization` 头中包含 Bearer Token (JWT)。

## REST API 端点

### 项目 (Projects)

#### 创建项目
`POST /api/v1/projects`
-   **Body**: `{ "name": "我的视频", "description": "..." }`
-   **Response**: `{ "id": "uuid", "name": "我的视频", ... }`

#### 获取项目列表
`GET /api/v1/projects`
-   **Response**: `[ { "id": "...", "name": "..." }, ... ]`

### 任务 (Agent 交互)

#### 提交任务
启动一个新的 Agent 执行。
`POST /api/v1/projects/:projectId/tasks`
-   **Body**:
    ```json
    {
      "input_prompt": "制作一个关于太空探索的 30 秒视频。",
      "settings": {
        "model": "gpt-4",
        "style": "cinematic"
      }
    }
    ```
-   **Response**: `{ "id": "taskId", "status": "pending" }`

#### 获取任务状态
`GET /api/v1/projects/:projectId/tasks/:taskId`
-   **Response**:
    ```json
    {
      "id": "taskId",
      "status": "running",
      "progress": 45,
      "result_summary": null
    }
    ```

#### 获取任务事件 (日志)
检索执行日志以进行调试或 UI 显示。
`GET /api/v1/projects/:projectId/tasks/:taskId/events`
-   **Response**:
    ```json
    [
      {
        "id": "evt_1",
        "type": "thought",
        "payload": { "text": "正在分析请求..." },
        "created_at": "..."
      }
    ]
    ```

## WebSocket API

用于实时更新任务进度和流式传输 Token。

**端点**: `wss://api.kairomovie.com/ws`

### 协议

1.  **连接**: 客户端携带 `?token=JWT` 连接。
2.  **订阅**: 客户端订阅特定任务。
    -   `{ "type": "subscribe", "taskId": "..." }`
3.  **事件**: 服务器推送更新。
    -   **任务更新**: `{ "type": "task_update", "taskId": "...", "status": "running", "progress": 50 }`
    -   **日志**: `{ "type": "log", "taskId": "...", "message": "正在生成脚本..." }`
    -   **错误**: `{ "type": "error", "taskId": "...", "message": "生成图像失败。" }`

## 错误处理

标准 HTTP 状态码：
-   `200 OK`: 成功。
-   `400 Bad Request`: 输入无效。
-   `401 Unauthorized`: 令牌丢失或无效。
-   `403 Forbidden`: 用户无权访问该项目。
-   `404 Not Found`: 资源未找到。
-   `500 Internal Server Error`: 服务器端故障。
