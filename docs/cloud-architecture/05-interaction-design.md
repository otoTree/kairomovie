# Agent 交互设计与消息结构

本文档定义了 Kairo Agent 的交互模型、消息结构和协议，并与 Kairo Runtime 的实现保持一致。

## 1. Kairo Runtime 事件协议

Kairo Agent 基于 `EventBus` 的事件驱动架构运行。所有交互都封装为 `KairoEvent` 对象。

### 1.1 事件结构 (`KairoEvent`)
所有事件都遵循 `src/kairo/domains/events/types.ts` 中定义的类似 CloudEvents 的结构：

```typescript
export interface KairoEvent<T = unknown> {
  // 事件的唯一标识符
  id: string;
  // 标准类型 URN (例如 "kairo.agent.thought", "kairo.tool.exec")
  type: string;
  // 事件来源 (例如 "agent:default", "tool:fs")
  source: string;
  // 数据规范版本
  specversion: "1.0";
  // 时间戳 (ISO 8601)
  time: string;
  // 实际负载数据
  data: T;
  // 相关性 ID，用于请求/响应模式
  correlationId?: string;
  // 因果 ID (引起此事件的事件 ID)
  causationId?: string;
  // 追踪 ID (整个请求链的全局唯一 ID)
  traceId?: string;
  // 跨度 ID (当前处理单元的唯一 ID)
  spanId?: string;
}
```

### 1.2 关键事件类型

| 事件类型 | 来源 | 描述 | 数据负载 |
| :--- | :--- | :--- | :--- |
| `kairo.user.message` | 用户/UI | 用户向 Agent 发送消息。 | `{ content: string, targetAgentId?: string }` |
| `kairo.agent.{id}.message` | 系统/路由 | 专门路由给某个 Agent 的消息。 | `{ content: string }` |
| `kairo.agent.thought` | Agent | Agent 在行动前发出的思考（推理）。 | `{ thought: string }` |
| `kairo.agent.action` | Agent | Agent 决定执行一个动作。 | `{ action: Action }` |
| `kairo.tool.result` | 工具/系统 | 工具执行的结果。 | `{ result: any }` 或 `{ error: string }` |
| `kairo.intent.started` | Agent | Agent 开始处理一个意图（计划）。 | `{ intent: string }` |
| `kairo.intent.ended` | Agent | Agent 完成一个意图（成功或失败）。 | `{ result: any }` 或 `{ error: string }` |
| `kairo.agent.render.commit` | Agent | Agent 提交 UI 更新（渲染动作）。 | `{ surfaceId: string, tree: any }` |

## 2. Agent 内部消息结构

`AgentRuntime` 将原始的 `KairoEvent` 转换为内部的 `Observation` 对象，以构建 LLM 的上下文。

### 2.1 观察 (Observation)
定义在 `src/kairo/domains/agent/observation-bus.ts` 中：

```typescript
export type Observation =
  | { type: "user_message"; text: string; ts: number }
  | { type: "system_event"; name: string; payload?: unknown; ts: number }
  | { type: "action_result"; action: any; result: any; ts: number };
```

### 2.2 提示词构建 (Prompt Construction)
`AgentRuntime` 动态构建 LLM 提示词：

1.  **系统提示词 (System Prompt)**：
    -   **身份**: "你是 Kairo (Agent {id})..."
    -   **环境**: 操作系统、当前工作目录、日期。
    -   **共享知识**: 来自 `SharedMemory` 的事实。
    -   **召回记忆**: 来自 `AgentMemory` 的相关长期记忆。
    -   **能力与工具**: 可用工具和能力的列表。
    -   **响应格式**: 严格的 JSON 指令。

2.  **用户提示词 (User Prompt)**：
    -   由最近的 `Observation` 历史构建（例如，最后 500 个字符或 token）。
    -   包含用户消息、工具结果和系统事件。

## 3. Agent 响应协议

Agent 必须响应一个包含 `thought` 和 `action` 的严格 JSON 对象。

### 3.1 JSON 输出格式

```json
{
  "thought": "你的推理过程...",
  "action": {
    "type": "say, query, render, tool_call 之一",
    ...参数
  }
}
```

### 3.2 支持的动作 (Actions)

#### `say`
向用户说话（最终响应）。
```json
{
  "type": "say",
  "content": "这是你要求的图片。"
}
```

#### `query`
向用户提出澄清问题。
```json
{
  "type": "query",
  "content": "你想要 16:9 还是 9:16 比例的图片？"
}
```

#### `render`
渲染原生 UI 组件（用于动态界面）。
```json
{
  "type": "render",
  "surfaceId": "default",
  "tree": {
    "type": "Column",
    "children": [
      { "type": "Text", "props": { "text": "正在处理..." } }
    ]
  }
}
```

#### `tool_call`
执行已注册的工具或技能 (Skill)。
```json
{
  "type": "tool_call",
  "function": {
    "name": "generate_image",
    "arguments": {
      "prompt": "赛博朋克城市",
      "ratio": "16:9"
    }
  }
}
```

## 4. 交互流程

1.  **输入**: 用户输入 "创建一个场景" -> 发出 `kairo.user.message`。
2.  **处理**:
    -   `AgentRuntime` 接收事件，转换为 `Observation`。
    -   触发 `tick()` 循环。
    -   `AgentMemory` 召回上下文。
    -   使用系统提示词 + 观察历史调用 LLM。
3.  **推理**: LLM 返回包含 `thought` 和 `action` 的 JSON。
4.  **执行**:
    -   发出 `kairo.agent.thought`。
    -   **如果动作为 `tool_call`**:
        -   发出 `kairo.agent.action`。
        -   执行工具。
        -   发出包含结果/错误的 `kairo.tool.result`。
        -   循环继续（Agent 观察结果）。
    -   **如果动作为 `say`/`query`**:
        -   发出 `kairo.agent.action`。
        -   UI 显示消息。
        -   发出 `kairo.intent.ended`。
    -   **如果动作为 `render`**:
        -   发出 `kairo.agent.action`。
        -   发出 `kairo.agent.render.commit`。
        -   UI 更新。

## 5. 工具定义 (Skills)

Agent 的能力通过 Skill 扩展。每个 Skill 注册一个或多个工具。

### 5.1 核心技能

#### `generate_script`
-   **描述**: 根据主题生成视频剧本。
-   **输入 Schema**:
    ```json
    {
      "type": "object",
      "properties": {
        "topic": { "type": "string" },
        "duration": { "type": "number", "description": "持续时间（秒）" },
        "style": { "type": "string" }
      },
      "required": ["topic"]
    }
    ```

#### `generate_image`
-   **描述**: 生成图像资产。
-   **输入 Schema**:
    ```json
    {
      "type": "object",
      "properties": {
        "prompt": { "type": "string" },
        "negative_prompt": { "type": "string" },
        "ratio": { "type": "string", "enum": ["16:9", "9:16", "1:1"] }
      },
      "required": ["prompt"]
    }
    ```

#### `update_canvas`
-   **描述**: 更新视频编辑器画布/时间轴。
-   **输入 Schema**:
    ```json
    {
      "type": "object",
      "properties": {
        "track_id": { "type": "string" },
        "asset_url": { "type": "string" },
        "start_time": { "type": "number" },
        "duration": { "type": "number" }
      },
      "required": ["track_id", "asset_url"]
    }
    ```

### 5.2 上下文感知工具

#### `get_canvas_state`
-   **描述**: 获取画布元素的当前状态。
-   **输入 Schema**: `{}` (无输入)
-   **输出**: 包含 ID、类型和位置的元素列表。

#### `read_canvas_element`
-   **描述**: 读取特定元素的详细内容（多模态）。
-   **输入 Schema**:
    ```json
    {
      "type": "object",
      "properties": {
        "element_ids": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["element_ids"]
    }
    ```

## 6. 记忆系统集成

`AgentRuntime` 与 `AgentMemory` 集成，以维持跨交互的上下文。

-   **短期记忆**: `AgentRuntime` 中的 `Observation` 缓冲区（内存中）。
-   **长期记忆**: `AgentMemory`（持久化，通常基于向量）。
-   **压缩**: 当上下文超过阈值（约 8 万字符）时，`AgentRuntime` 触发 `memory.compress()`。
-   **召回**: 在每次 LLM 推理之前调用 `memory.recall()`，将相关记忆注入系统提示词。
