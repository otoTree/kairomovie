# ToAPIs 集成与可配置工具设计

本文档详述了如何将 ToAPIs (OpenAI 兼容网关) 集成到 Kairo Agent 中，并设计一套可配置的工具系统，使用户能够灵活选择使用的模型和供应商。

## 1. 集成目标

-   **统一接入**: 使用 ToAPIs 作为主要的 LLM 和多模态服务网关，通过替换 BaseURL 快速接入 GPT-5, Claude, Gemini, Sora 等模型。
-   **工具化**: 将 API 能力（文生图、文生视频、TTS/STT）封装为 Agent 可调用的标准工具 (Tools)。
-   **可配置性**: 允许用户或管理员在项目级别配置使用的模型、API Key 和参数，而无需修改代码。

## 2. 配置系统设计

为了支持“API 可配置”，我们需要在数据库中存储配置信息，并在 Agent 运行时动态注入。

### 2.1 数据库 Schema 扩展

在 `projects` 表的 `settings` 字段中增加 `provider_config`：

```json
// projects.settings (JSONB)
{
  "provider_config": {
    "base_url": "https://toapis.com/v1",
    "api_key": "sk-...", // 建议加密存储或引用 vault
    "models": {
      "chat": "gpt-4o",           // 默认对话模型
      "reasoning": "gpt-5",       // 复杂推理模型
      "image": "gpt-4o-image",    // 文生图模型
      "video": "sora-2",          // 文生视频模型
      "audio_input": "whisper-1", // 语音转文字
      "audio_output": "tts-1"     // 文字转语音
    }
  }
}
```

### 2.2 配置注入流程

1.  **初始化**: Agent 启动时，读取当前项目的配置。
2.  **客户端实例化**: 使用配置的 `base_url` 和 `api_key` 初始化 OpenAI SDK 客户端。
3.  **工具注册**: 注册工具时，将配置的 `models` 映射绑定到工具的执行上下文中。

## 3. 工具定义 (Tool Definitions)

基于 ToAPIs 提供的能力，我们将封装以下核心工具。

### 3.1 视频生成工具 (`generate_video`)

封装 OpenAI Sora2 和 Google VEO3。

-   **工具名**: `generate_video`
-   **描述**: 根据文本描述生成视频片段。
-   **参数**:
    -   `prompt` (string): 视频描述。
    -   `model` (string, optional): 指定模型 (如 `sora-2`, `veo-3`)，默认使用项目配置。
    -   `duration` (number): 视频时长。
-   **实现逻辑**:
    1.  调用 ToAPIs 视频生成端点。
    2.  **异步处理**: 由于视频生成耗时，API 通常返回任务 ID。
    3.  **轮询/Webhook**: Agent 挂起或启动后台任务轮询状态，直到生成完成。
    4.  **结果返回**: 返回视频 URL (TOS 链接)。

### 3.2 图像生成工具 (`generate_image`)

封装 GPT-4o Image 和 Gemini Image。

-   **工具名**: `generate_image`
-   **描述**: 根据文本生成图像。
-   **参数**:
    -   `prompt` (string): 图像描述。
    -   `size` (string): 分辨率 (如 "1024x1024")。
    -   `quality` (string): "standard" 或 "hd"。
-   **实现逻辑**:
    1.  调用 `client.images.generate`。
    2.  获取 URL。
    3.  (可选) 将图片转存至私有 TOS 以确保持久化。

### 3.3 语音合成工具 (`text_to_speech`)

封装 OpenAI TTS。

-   **工具名**: `text_to_speech`
-   **描述**: 将文本转换为语音音频。
-   **参数**:
    -   `text` (string): 文本内容。
    -   `voice` (string): 声音预设 (如 "alloy", "echo")。
-   **实现逻辑**:
    1.  调用 `client.audio.speech.create`。
    2.  获取二进制流。
    3.  上传至 TOS 并返回 URL。

## 4. 适配器模式实现

为了保证代码的整洁和可维护性，我们使用适配器模式来封装 ToAPIs 的调用。

```typescript
// src/kairo/domains/ai/providers/toapis.ts

import OpenAI from 'openai';

export class ToAPIsProvider {
  private client: OpenAI;
  private config: ProjectConfig;

  constructor(config: ProjectConfig) {
    this.client = new OpenAI({
      baseURL: config.base_url || "https://toapis.com/v1",
      apiKey: config.api_key
    });
    this.config = config;
  }

  // 通用工具处理器
  async generateVideo(prompt: string) {
    const model = this.config.models.video || 'sora-2';
    // 实现视频生成逻辑...
  }
  
  async generateImage(prompt: string) {
     const model = this.config.models.image || 'gpt-4o-image';
     // 实现图像生成逻辑...
  }
}
```

## 5. 前端配置界面

在项目设置页提供 "AI 模型配置" 面板：

-   **API 网关**: 输入框 (默认 `https://toapis.com/v1`)。
-   **API Key**: 密码输入框。
-   **模型映射**: 下拉菜单选择各能力对应的模型。
    -   *聊天模型*: [GPT-5, GPT-4o, Claude 3.5 Sonnet, ...]
    -   *图像模型*: [GPT-4o Image, Gemini Image, ...]
    -   *视频模型*: [Sora 2, VEO 3, ...]

## 6. 优势总结

通过此设计，Kairo 获得了：
1.  **零代码迁移**: 切换模型只需在 UI 上更改配置。
2.  **多模型混合**: 可以在同一个项目中使用 GPT-5 进行推理，Sora 进行视频生成，Gemini 进行图片生成，发挥各家之长。
3.  **未来兼容**: 新出的模型只要兼容 OpenAI 接口，即可立即被系统识别和使用。
