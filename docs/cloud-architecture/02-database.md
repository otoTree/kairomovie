# 数据库架构设计 (PostgreSQL)

本文档详细说明了支持云端多租户架构所需的数据库 Schema 变更。

## 概述

我们将从 SQLite 迁移到 PostgreSQL。Schema 必须支持多用户和多项目，确保数据隔离和可扩展性。

## 核心表结构

### 1. 用户表 (`users`)
存储用户账户信息。

| 列名 | 类型 | 约束 | 描述 |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY` | 唯一用户标识符。 |
| `email` | `VARCHAR(255)` | `UNIQUE, NOT NULL` | 用户电子邮件地址。 |
| `password_hash` | `VARCHAR` | `NOT NULL` | 哈希密码（如果使用本地认证）。 |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | 账户创建时间。 |
| `updated_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | 最后更新时间。 |

### 2. 项目表 (`projects`)
对 Agent 任务和资源进行分组。

| 列名 | 类型 | 约束 | 描述 |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY` | 唯一项目标识符。 |
| `user_id` | `UUID` | `FOREIGN KEY (users.id)` | 项目所有者。 |
| `name` | `VARCHAR(100)` | `NOT NULL` | 项目名称。 |
| `description` | `TEXT` | | 项目描述。 |
| `settings` | `JSONB` | | 项目特定设置（例如，默认模型）。 |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | |

### 3. Agent 任务表 (`agent_tasks`)
代表 Agent 的工作单元（替代本地执行的临时性质）。

| 列名 | 类型 | 约束 | 描述 |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY` | 唯一任务标识符。 |
| `project_id` | `UUID` | `FOREIGN KEY (projects.id)` | 关联项目。 |
| `status` | `VARCHAR(20)` | `CHECK (status IN ('pending', 'running', 'completed', 'failed'))` | 当前状态。 |
| `input_prompt` | `TEXT` | `NOT NULL` | 用户的初始指令。 |
| `result_summary` | `TEXT` | | 最终输出摘要。 |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | |
| `started_at` | `TIMESTAMPTZ` | | Worker 获取任务的时间。 |
| `completed_at` | `TIMESTAMPTZ` | | 任务完成时间。 |

### 4. 事件表 (`events`) - *已修改*
存储用于审计和调试的事件日志。增加了 `task_id` 用于关联。

| 列名 | 类型 | 约束 | 描述 |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY` | 唯一事件标识符。 |
| `task_id` | `UUID` | `FOREIGN KEY (agent_tasks.id)` | 关联任务。 |
| `type` | `VARCHAR(100)` | `NOT NULL` | 事件类型。 |
| `source` | `VARCHAR(100)` | `NOT NULL` | 生成事件的组件。 |
| `payload` | `JSONB` | `NOT NULL` | 结构化事件数据。 |
| `metadata` | `JSONB` | | 额外上下文。 |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | |

### 5. 系统状态表 (`system_state`) - *已修改*
存储键值状态，作用域限定为任务。

| 列名 | 类型 | 约束 | 描述 |
| :--- | :--- | :--- | :--- |
| `task_id` | `UUID` | `FOREIGN KEY (agent_tasks.id)` | 关联任务。 |
| `key` | `VARCHAR(255)` | `NOT NULL` | 状态键。 |
| `value` | `JSONB` | `NOT NULL` | 状态值。 |
| `updated_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | |
| `PRIMARY KEY` | `(task_id, key)` | | 复合主键。 |

### 6. Agent 记忆表 (`agent_memory`) - *新增*
存储长期记忆项（知识库）。

| 列名 | 类型 | 约束 | 描述 |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PRIMARY KEY` | 唯一记忆 ID。 |
| `project_id` | `UUID` | `FOREIGN KEY (projects.id)` | 记忆的作用域。 |
| `content` | `TEXT` | `NOT NULL` | 文本内容。 |
| `embedding` | `VECTOR(1536)` | | OpenAI 嵌入向量（需要 `pgvector`）。 |
| `metadata` | `JSONB` | | 来源、标签等。 |
| `created_at` | `TIMESTAMPTZ` | `DEFAULT NOW()` | |

## 迁移步骤

1.  **安装 PostgreSQL**: 确保可用 PG 14+ 版本。
2.  **安装 pgvector**: 启用向量扩展以支持记忆功能。
3.  **更新 Kysely Dialect**: 将 `BunSqliteDialect` 切换为 `PostgresDialect`。
4.  **运行迁移**: 创建上述定义的新表。
