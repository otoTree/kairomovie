# 云端架构总览

本文档概述了将本地 Kairo Agent 迁移到云端视频创作平台的架构设计。

## 架构组件

系统由以下关键组件组成：

1.  **客户端应用 (Client Application)**：用于与 Agent 交互的用户界面（Web/Mobile）。
2.  **API 网关 / 后端服务 (API Gateway / Backend Service)**：
    -   处理身份验证和授权。
    -   管理用户会话和项目数据。
    -   将请求路由到 Agent 服务。
    -   提供 RESTful API 和 WebSocket 连接以实现实时交互。
3.  **Agent 服务 (Worker)**：
    -   托管 `AgentRuntime`。
    -   执行用于视频创作的 Skill 和工具。
    -   异步处理任务。
    -   根据负载进行水平扩展。
4.  **数据库 (PostgreSQL)**：
    -   存储结构化数据：用户、项目、任务、Agent 记忆、检查点。
    -   替代本地 SQLite 数据库。
5.  **对象存储 (火山引擎 TOS)**：
    -   存储非结构化数据：视频素材、生成的内容、大型中间文件。
    -   替代本地文件系统进行持久化存储。

## 数据流

1.  **用户交互**：用户通过客户端发送请求（例如，“制作一个关于猫的视频”）。
2.  **任务创建**：后端服务接收请求，在 PostgreSQL 中创建任务记录，并将消息推送到任务队列（例如 Redis 或基于 PG 的队列）。
3.  **Agent 执行**：
    -   空闲的 Agent 服务 Worker 获取任务。
    -   它使用特定的用户和项目上下文初始化 `AgentRuntime`。
    -   Agent 使用 LLM（通过 OpenAI/Ollama 提供商）规划视频创作。
4.  **Skill 执行**：
    -   Agent 调用 Skill（例如，剧本编写、图像生成、视频合成）。
    -   中间资产上传到火山引擎 TOS。
5.  **完成**：
    -   最终视频存储在 TOS 中。
    -   数据库更新结果 URL。
    -   通过 WebSocket/推送通知通知用户。

## 技术栈

-   **运行时**: Node.js / Bun (云兼容)
-   **数据库**: PostgreSQL
-   **存储**: 火山引擎 TOS (兼容腾讯云对象存储 API / S3 API)
-   **消息队列**: Redis / PostgreSQL (SKIP LOCKED)
-   **Agent 核心**: Kairo Agent Runtime (现有)

## 迁移策略

1.  **数据库适配器**: 实现 PostgreSQL 适配器以替换 `bun:sqlite` (基于 `kysely`)。
2.  **存储适配器**: 为 `FileSystem` 抽象实现 `VolcengineTOS` 适配器。
3.  **无状态 Agent**: 确保 `AgentRuntime` 可以使用数据库中的状态进行初始化，使其成为临时的、无状态的。
4.  **API 层**: 将 Agent 交互封装在服务 API 中。
