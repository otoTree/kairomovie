# Kairo Vercel 改造方案（整体）

本文档定义 Kairo 从“本地/Bun 风格运行时”迁移到“Vercel + 外部托管基础设施”的整体方案。

## 1. 目标与边界

### 1.1 目标

1. **API 无状态化**：所有 API 请求可在任意实例处理，不依赖进程内状态。
2. **事件驱动化**：用户输入、工具执行开始、工具执行完成等统一建模为事件。
3. **状态投递优先**：长时任务可在外部系统完成后，通过 API 回投事件，不要求单请求内持续执行。
4. **云原生持久化**：记忆、事件、会话、产物全部落到外部存储（PostgreSQL/对象存储/队列）。
5. **可观测与可回放**：事件链可追踪、可回放、可审计。

### 1.2 非目标

1. 不在 Vercel Functions 内运行本地沙箱、设备驱动、Wayland UI 组件。
2. 不依赖 Vercel 实例内文件系统作为持久化介质。
3. 不在单次 API 请求中执行完整视频生成链路。

## 2. 当前阻塞点（现状评估）

### 2.1 构建阻塞

目前 `next build` 会被 Kairo 依赖链阻塞，核心原因包括：

- Bun 专有依赖（如 `bun:sqlite`）；
- Kysely Bun 方言依赖（`kysely-bun-sqlite`）；
- 事件总线依赖未在 Next 依赖中声明（`mitt`）；
- App Route 引入 Kairo Runtime 时，触发上述链路进入构建图。

### 2.2 运行阻塞

- 运行时单例 + 进程内总线：多实例下不可共享。
- Memory 默认落地本地文件：不适配无状态实例。
- 长任务依赖请求内执行：不适配 Serverless 生命周期。

## 3. 目标架构（Vercel 可用形态）

### 3.1 控制平面（Vercel）

承载：

- Auth 与用户/项目 API；
- 事件入口 API（发布/查询/订阅令牌）；
- 会话上下文组装 API；
- 任务编排 API（创建运行请求、取消、重试）。

特征：

- 完全无状态；
- 所有状态入库；
- 仅做短时逻辑，不执行重计算与长链路。

### 3.2 异步事件生产平面（外部执行体）

承载：

- 图像生成、视频渲染等长时任务执行；
- 第三方系统任务完成后的状态回投；
- 任何可发起 `kairo.*` 事件的外部执行体。

可选落地：

- 自建容器服务（Fly.io/Render/K8s/ECS）；
- 第三方生成服务回调；
- 轻量任务消费者（仅负责发事件，不维护 Agent 内部状态）。

### 3.3 持久化平面（托管服务）

- PostgreSQL（Neon/Supabase）：用户、项目、事件、会话、任务、记忆索引；
- Redis/消息队列：调度、重试、延时任务；
- 对象存储（TOS/S3）：生成资产、中间产物、用户记忆文件。

## 4. 领域级改造策略（按 Kairo Domains）

### 4.1 保留在 Vercel API 的模块

- `auth`、`projects`、`events`、`session-memory`；
- 轻量编排（只发事件/查事件，不执行重任务）。

### 4.2 迁移到外部执行体的模块

- `skills` 执行层；
- `sandbox`、`kernel`、`device`、`ui/compositor`；
- 图像/视频等长任务执行逻辑。

### 4.3 必须替换的基础实现

1. **数据库层**：`bun:sqlite` / `kysely-bun-sqlite` -> PostgreSQL 驱动。
2. **事件存储**：进程内 Buffer -> PostgreSQL 事件表（或 Redis Stream）作为权威事件源。
3. **记忆存储**：本地文件系统 -> 对象存储文件系统 API（PostgreSQL 仅存索引与元数据）。
4. **执行解耦**：请求内执行 -> 外部执行体回投事件。
5. **接口形态**：移除 Kairo 内建 Server，统一以函数导出能力供 API 层调用。

## 5. 分阶段实施路线

## Phase 0：可构建与可部署（1-2 天）

目标：让项目在 Vercel `next build` 通过。

动作：

1. 拆分 runtime 入口，避免 API 路由直接静态依赖 Bun-only 模块；
2. 增补缺失依赖并清理 Bun 专有 import；
3. 用 feature flag 将不兼容域（sandbox/kernel/device/ui）从 Vercel 路径隔离。

验收：

- Vercel Preview 能构建成功；
- `/api/v1/auth/*`、`/api/v1/projects`、`/api/v1/events*` 可用。

## Phase 1：无状态事件 API（2-4 天）

目标：所有对话/事件入口无状态化。

动作：

1. 统一事件写入 `events`（附带 `correlation_id/session_id/project_id/user_id`）；
2. chat 接口只做：
   - 读会话记忆；
   - 发布 `kairo.session.context`；
   - 发布 `kairo.user.message`；
   - 可选同步等待短结果。
3. 会话记忆结构标准化，限制上下文窗口和 token 预算。

验收：

- 任意实例可处理同一会话后续请求；
- 同一 `session_id` 可重放最近事件链。

## Phase 2：状态投递解耦（4-7 天）

目标：让长任务仅负责产出状态事件，Agent 仍保持无状态函数。

动作：

1. 定义外部执行体回调协议（`kairo.task.started/updated/completed/failed`）；
2. API 只接收状态事件并写入 `events`；
3. Agent 每次被触发时从 `events + memory` 组装输入并计算下一步；
4. 增加幂等键、重放防重和事件审计。

验收：

- API 返回 `accepted`，长任务结束后可异步回投；
- 多次重复回调不会破坏状态（幂等可验证）。

## Phase 3：存储与记忆云化（3-5 天）

目标：移除本地文件依赖。

动作：

1. MemoryStore 改为对象存储文件化存储；
2. PostgreSQL 仅维护记忆清单、标签、版本、权限与路径；
3. 产物写对象存储，事件中记录 URL/Key；
4. 补充记忆整理异步作业（文件裁剪、合并、归档）。

验收：

- 无本地持久化写入依赖；
- 记忆文件读取可跨实例复用。

## 6. 记忆文件系统 API 工具（Agent 可调用）

目标：让 Agent 通过统一工具读取用户记忆文件，而不是依赖向量检索。

### 6.1 存储组织

对象存储路径建议：

- `users/{user_id}/memory/profile.md`
- `users/{user_id}/memory/preferences.md`
- `projects/{project_id}/memory/context.md`
- `projects/{project_id}/memory/timeline/{yyyy-mm-dd}.md`
- `projects/{project_id}/memory/notes/{note_id}.md`

### 6.2 Tool 接口（建议）

1. `memory_fs_list`
   - 输入：`scope(user|project)`, `userId`, `projectId`, `prefix`
   - 输出：文件列表（path, size, updatedAt）

2. `memory_fs_read`
   - 输入：`path`, `offset`, `limit`
   - 输出：文本片段（支持大文件分段读取）

3. `memory_fs_write`
   - 输入：`path`, `content`, `mode(overwrite|append)`
   - 输出：`etag`, `version`

4. `memory_fs_move`
   - 输入：`fromPath`, `toPath`
   - 输出：迁移结果

5. `memory_fs_delete`
   - 输入：`path`
   - 输出：删除结果

6. `memory_fs_search_indexed`
   - 输入：`keyword`, `scope`, `tags`, `limit`
   - 输出：命中文件与片段定位（由 PostgreSQL 关键词索引支持）

### 6.3 安全与权限

1. 路径访问必须绑定 `user_id/project_id` 权限。
2. Tool 层禁止任意路径访问，只允许白名单前缀。
3. 写入操作记录审计事件：`kairo.memory.file.updated`。
4. 关键记忆文件启用版本化，支持回滚。

### 6.4 上下文组装策略

1. API 收到用户输入后，先读取会话关联的记忆清单。
2. 再用 `memory_fs_read` 拉取 Top-N 文件片段，拼装 `kairo.session.context`。
3. 将本次用户消息与新增结论异步写回 `memory` 文件。

### 6.5 工具接入草案

工具注册草案代码已放在：

- `src/kairo/domains/memory/memory-fs-tools.ts`

建议接入方式：

1. 在无状态函数入口创建 `MemoryFsClient`（对接对象存储 API 网关）。
2. 调用 `registerMemoryFsTools(agent, memoryFsClient)` 完成 6 个工具注册。
3. 由网关统一做权限校验、路径白名单与审计事件写入。

## 7. 数据模型建议（在现有表基础上扩展）

建议新增/完善字段：

1. `events`
   - `session_id`（文本或 UUID）
   - `project_id`
   - `user_id`
   - `correlation_id`（索引）
   - `causation_id`
2. `async_tasks`（可选）
   - `status`、`executor`、`idempotency_key`、`callback_event_type`、`updated_at`
3. `api_session_events`（已引入）
   - 增加 `project_id`、`token_estimate` 便于预算控制。
4. `memory_files`
   - `id`, `user_id`, `project_id`, `path`, `etag`, `version`, `tags`, `updated_at`
5. `memory_file_chunks`（可选）
   - `file_id`, `chunk_no`, `text`, `keyword_tsv`（仅关键词检索，不含向量）

## 8. Kairo 导出接口规范

Kairo 不再提供自建 `ServerPlugin` 入口。统一导出无状态函数接口，由宿主 API 网关（如 Next App Route）负责暴露 HTTP 协议。

### 8.1 导出原则

1. 导出函数必须幂等、无会话内存依赖。
2. 每次调用只接收显式输入（事件、会话标识、用户标识）。
3. 内部状态只能来自外部存储（events/memory/object storage）。
4. 返回值必须包含 `correlationId` 与必要事件标识，便于后续查询。

### 8.2 导出方法（建议）

建议对外仅暴露以下能力：

1. `publishEvent(input)`：发布标准事件
2. `sendUserMessage(input)`：发布用户消息事件
3. `queryEvents(filter)`：查询事件流
4. `invokeAgent(input)`：一次无状态推理调用（可选短等待）

参考导出文件：

- `src/kairo/interface.ts`
- `src/kairo/next/runtime.ts`

### 8.3 模块边界（建议）

1. `kairo-runtime-core`：纯领域逻辑，不含 HTTP 监听。
2. `kairo-runtime-interface`：函数导出层（给 Next API 调用）。
3. `kairo-api-vercel`：HTTP 适配层（参数校验、鉴权、响应序列化）。

## 9. 环境变量建议（Vercel）

至少包含：

- `DATABASE_URL`
- `AUTH_SECRET` / `JWT_SECRET`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL_NAME`

执行面（可选）：

- `EVENT_CALLBACK_TOKEN`
- `ASYNC_EXECUTOR_ALLOWLIST`

存储：

- `TOS_ENDPOINT`
- `TOS_ACCESS_KEY`
- `TOS_SECRET_KEY`
- `TOS_BUCKET`

## 10. API 行为约定（无状态）

1. API 不保存进程内会话；
2. 客户端必须传 `sessionId`；
3. 服务端按 `sessionId + userId` 自动检索记忆并注入上下文事件；
4. 返回值以 `correlationId` 作为后续查询主键；
5. 长任务统一返回 `accepted`，通过事件查询进度。
6. 长任务执行体结束后通过 `/api/v1/events/publish` 回投状态事件。

## 11. 风险与规避

1. **风险：构建仍被 Bun 链路污染**
   - 规避：入口分层 + 动态导入 + 运行时特性开关。
2. **风险：多实例事件不一致**
   - 规避：以数据库事件表为唯一事实源。
3. **风险：大模型调用成本上升**
   - 规避：上下文窗口限制、记忆去重、异步固化。
4. **风险：长任务状态丢失或重复投递**
   - 规避：事件幂等键 + 回调签名 + 重放去重。

## 12. 交付清单（建议）

1. `kairo-runtime-core`（与平台无关的核心包）
2. `kairo-async-executors`（外部长任务执行体，可选）
3. `kairo-api-vercel`（Next API）
4. DB Migration（事件/会话/任务字段）
5. 部署模板（Vercel + Neon + Queue + Object Storage）

---

若以“最快上线可用”为优先，建议按 **Phase 0 -> Phase 1** 先交付 MVP；  
若以“完整生产可扩展”为优先，建议一次性推进到 **Phase 2**，先完成事件回投协议再扩展执行体。
