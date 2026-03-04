# 存储架构 (火山引擎 TOS)

本文档概述了使用火山引擎 TOS (兼容腾讯云对象存储/S3) 进行云端存储的策略。

## 概述

Agent 需要持久化存储以下内容：
-   用户上传的素材（图像、剧本）。
-   中间生成产物（音频片段、帧序列）。
-   最终视频输出。
-   日志和调试数据（可选）。

## 存储接口

我们将抽象存储层以支持本地开发和云端部署。

```typescript
export interface StorageProvider {
  /**
   * 上传文件到存储。
   */
  put(key: string, data: Buffer | ReadableStream, options?: UploadOptions): Promise<UploadResult>;

  /**
   * 从存储下载文件。
   */
  get(key: string): Promise<Buffer>;

  /**
   * 获取用于临时访问的签名 URL 或公共 URL（如果适用）。
   */
  getUrl(key: string, expiresIn?: number): Promise<string>;

  /**
   * 删除文件。
   */
  delete(key: string): Promise<void>;

  /**
   * 列出带有前缀的文件。
   */
  list(prefix: string): Promise<string[]>;
}
```

## 火山引擎 TOS 实现

我们将使用官方 SDK（或 S3 兼容 SDK）实现 `VolcengineTOSProvider`。

### 配置
需要的环境变量：
-   `TOS_ENDPOINT`: 区域端点（例如 `tos-cn-beijing.volces.com`）。
-   `TOS_ACCESS_KEY`: AK (Access Key)。
-   `TOS_SECRET_KEY`: SK (Secret Key)。
-   `TOS_BUCKET`: 目标 Bucket 名称。

### 目录结构

为了确保隔离和组织性，我们将使用以下 Bucket 键结构：

```
/
├── users/
│   └── {user_id}/
│       └── avatar.png
├── projects/
│   └── {project_id}/
│       ├── assets/            # 原始用户上传
│       │   ├── script.txt
│       │   └── reference.jpg
│       └── artifacts/         # Agent 生成产物
│           └── {task_id}/
│               ├── draft_01.mp4
│               └── final_output.mp4
└── temp/                      # 临时文件
```

## 与 Agent 运行时集成

`AgentRuntime` 目前可能依赖于本地文件路径。我们需要：
1.  **注入存储提供者**: 将 Provider 传递给 Agent 上下文。
2.  **虚拟文件系统**: 如果 Skill 期望本地文件，我们可能需要一个临时的本地工作区 (`/tmp/agent/{task_id}`)，并在任务开始和结束时与 TOS 同步。
    -   *执行前*: 从 TOS 下载必要的素材到本地临时目录。
    -   *执行中*: Skill 读/写本地临时文件。
    -   *执行后*: 将结果从本地临时目录上传到 TOS。

## 安全性

-   **预签名 URL**: 使用预签名 URL 进行客户端上传/下载，以避免流量经过后端。
-   **Bucket 策略**: 限制公共访问；仅允许 Agent 服务和后端服务直接访问 Bucket。
