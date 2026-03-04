import type { AgentPlugin } from "../agent/agent.plugin";

type MemoryScope = "user" | "project";
type WriteMode = "overwrite" | "append";

export type MemoryFileInfo = {
  path: string;
  size: number;
  updatedAt: string;
  etag?: string;
  version?: number;
  tags?: string[];
};

export type MemoryFileVersionInfo = {
  version: number;
  etag: string;
  size: number;
  updatedAt: string;
};

export type MemoryReadResult = {
  path: string;
  content: string;
  offset: number;
  limit: number;
  eof: boolean;
  nextOffset?: number;
};

export type MemoryWriteResult = {
  path: string;
  etag: string;
  version: number;
  size: number;
};

export type MemorySearchHit = {
  path: string;
  snippet: string;
  score: number;
  offset?: number;
};

export interface MemoryFsClient {
  list(input: {
    scope: MemoryScope;
    userId: string;
    projectId?: string;
    prefix?: string;
  }): Promise<{ files: MemoryFileInfo[] }>;
  read(input: {
    path: string;
    userId: string;
    projectId?: string;
    offset?: number;
    limit?: number;
  }): Promise<MemoryReadResult>;
  listVersions(input: {
    path: string;
    userId: string;
    projectId?: string;
  }): Promise<{ path: string; versions: MemoryFileVersionInfo[] }>;
  readVersion(input: {
    path: string;
    version: number;
    userId: string;
    projectId?: string;
    offset?: number;
    limit?: number;
  }): Promise<MemoryReadResult & { version: number; etag: string }>;
  write(input: {
    path: string;
    userId: string;
    projectId?: string;
    content: string;
    mode: WriteMode;
  }): Promise<MemoryWriteResult>;
  rollback(input: {
    path: string;
    toVersion: number;
    userId: string;
    projectId?: string;
  }): Promise<{ success: boolean; path: string; toVersion: number; version: number; etag: string; size: number }>;
  move(input: {
    fromPath: string;
    toPath: string;
    userId: string;
    projectId?: string;
  }): Promise<{ success: boolean; fromPath: string; toPath: string }>;
  remove(input: {
    path: string;
    userId: string;
    projectId?: string;
  }): Promise<{ success: boolean; path: string }>;
  search(input: {
    scope: MemoryScope;
    keyword: string;
    userId: string;
    projectId?: string;
    tags?: string[];
    limit?: number;
  }): Promise<{ hits: MemorySearchHit[] }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`参数 ${key} 无效`);
  }
  return value.trim();
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`参数 ${key} 无效`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`参数 ${key} 无效`);
  }
  return Math.floor(value);
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`参数 ${key} 无效`);
  }
  return value;
}

function readPositiveInt(record: Record<string, unknown>, key: string): number {
  const value = readNumber(record, key);
  if (value <= 0) {
    throw new Error(`参数 ${key} 无效`);
  }
  return Math.floor(value);
}

function readOptionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`参数 ${key} 无效`);
  }
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function readScope(record: Record<string, unknown>): MemoryScope {
  const scope = readString(record, "scope");
  if (scope !== "user" && scope !== "project") {
    throw new Error("参数 scope 无效");
  }
  return scope;
}

function readWriteMode(record: Record<string, unknown>): WriteMode {
  const mode = readOptionalString(record, "mode") || "overwrite";
  if (mode !== "overwrite" && mode !== "append") {
    throw new Error("参数 mode 无效");
  }
  return mode;
}

function parseOwner(record: Record<string, unknown>) {
  const userId = readString(record, "userId");
  const projectId = readOptionalString(record, "projectId");
  return { userId, projectId };
}

export function registerMemoryFsTools(agent: AgentPlugin, client: MemoryFsClient) {
  agent.registerSystemTool(
    {
      name: "memory_fs_list",
      description: "列出用户或项目记忆文件",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["user", "project"] },
          userId: { type: "string" },
          projectId: { type: "string" },
          prefix: { type: "string" },
        },
        required: ["scope", "userId"],
      },
    },
    async (args: unknown) => {
      if (!isRecord(args)) {
        throw new Error("参数格式无效");
      }
      const scope = readScope(args);
      const owner = parseOwner(args);
      return client.list({
        scope,
        userId: owner.userId,
        projectId: owner.projectId,
        prefix: readOptionalString(args, "prefix"),
      });
    }
  );

  agent.registerSystemTool(
    {
      name: "memory_fs_read",
      description: "读取记忆文件内容，支持分段",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          userId: { type: "string" },
          projectId: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path", "userId"],
      },
    },
    async (args: unknown) => {
      if (!isRecord(args)) {
        throw new Error("参数格式无效");
      }
      const owner = parseOwner(args);
      return client.read({
        path: readString(args, "path"),
        userId: owner.userId,
        projectId: owner.projectId,
        offset: readOptionalNumber(args, "offset"),
        limit: readOptionalNumber(args, "limit"),
      });
    }
  );

  agent.registerSystemTool(
    {
      name: "memory_fs_versions",
      description: "列出记忆文件历史版本",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          userId: { type: "string" },
          projectId: { type: "string" },
        },
        required: ["path", "userId"],
      },
    },
    async (args: unknown) => {
      if (!isRecord(args)) {
        throw new Error("参数格式无效");
      }
      const owner = parseOwner(args);
      return client.listVersions({
        path: readString(args, "path"),
        userId: owner.userId,
        projectId: owner.projectId,
      });
    }
  );

  agent.registerSystemTool(
    {
      name: "memory_fs_read_version",
      description: "读取记忆文件指定版本内容，支持分段",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          version: { type: "number" },
          userId: { type: "string" },
          projectId: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path", "version", "userId"],
      },
    },
    async (args: unknown) => {
      if (!isRecord(args)) {
        throw new Error("参数格式无效");
      }
      const owner = parseOwner(args);
      return client.readVersion({
        path: readString(args, "path"),
        version: readPositiveInt(args, "version"),
        userId: owner.userId,
        projectId: owner.projectId,
        offset: readOptionalNumber(args, "offset"),
        limit: readOptionalNumber(args, "limit"),
      });
    }
  );

  agent.registerSystemTool(
    {
      name: "memory_fs_write",
      description: "写入或追加记忆文件内容",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          userId: { type: "string" },
          projectId: { type: "string" },
          content: { type: "string" },
          mode: { type: "string", enum: ["overwrite", "append"] },
        },
        required: ["path", "userId", "content"],
      },
    },
    async (args: unknown) => {
      if (!isRecord(args)) {
        throw new Error("参数格式无效");
      }
      const owner = parseOwner(args);
      const mode = readWriteMode(args);
      const result = await client.write({
        path: readString(args, "path"),
        userId: owner.userId,
        projectId: owner.projectId,
        content: readString(args, "content"),
        mode,
      });
      await agent.globalBus.publish({
        type: "kairo.memory_fs.write",
        source: "memory-fs-tools",
        data: {
          scope: owner.projectId ? "project" : "user",
          userId: owner.userId,
          projectId: owner.projectId,
          path: result.path,
          etag: result.etag,
          version: result.version,
          size: result.size,
          mode,
        },
      });
      return result;
    }
  );

  agent.registerSystemTool(
    {
      name: "memory_fs_rollback",
      description: "将记忆文件回滚到指定历史版本（会生成一个新版本）",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          toVersion: { type: "number" },
          userId: { type: "string" },
          projectId: { type: "string" },
        },
        required: ["path", "toVersion", "userId"],
      },
    },
    async (args: unknown) => {
      if (!isRecord(args)) {
        throw new Error("参数格式无效");
      }
      const owner = parseOwner(args);
      const result = await client.rollback({
        path: readString(args, "path"),
        toVersion: readPositiveInt(args, "toVersion"),
        userId: owner.userId,
        projectId: owner.projectId,
      });
      if (result.success) {
        await agent.globalBus.publish({
          type: "kairo.memory_fs.rollback",
          source: "memory-fs-tools",
          data: {
            scope: owner.projectId ? "project" : "user",
            userId: owner.userId,
            projectId: owner.projectId,
            path: result.path,
            toVersion: result.toVersion,
            version: result.version,
            etag: result.etag,
            size: result.size,
          },
        });
      }
      return result;
    }
  );

  agent.registerSystemTool(
    {
      name: "memory_fs_move",
      description: "移动或重命名记忆文件",
      inputSchema: {
        type: "object",
        properties: {
          fromPath: { type: "string" },
          toPath: { type: "string" },
          userId: { type: "string" },
          projectId: { type: "string" },
        },
        required: ["fromPath", "toPath", "userId"],
      },
    },
    async (args: unknown) => {
      if (!isRecord(args)) {
        throw new Error("参数格式无效");
      }
      const owner = parseOwner(args);
      const result = await client.move({
        fromPath: readString(args, "fromPath"),
        toPath: readString(args, "toPath"),
        userId: owner.userId,
        projectId: owner.projectId,
      });
      if (result.success) {
        await agent.globalBus.publish({
          type: "kairo.memory_fs.move",
          source: "memory-fs-tools",
          data: {
            scope: owner.projectId ? "project" : "user",
            userId: owner.userId,
            projectId: owner.projectId,
            fromPath: result.fromPath,
            toPath: result.toPath,
          },
        });
      }
      return result;
    }
  );

  agent.registerSystemTool(
    {
      name: "memory_fs_delete",
      description: "删除记忆文件",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          userId: { type: "string" },
          projectId: { type: "string" },
        },
        required: ["path", "userId"],
      },
    },
    async (args: unknown) => {
      if (!isRecord(args)) {
        throw new Error("参数格式无效");
      }
      const owner = parseOwner(args);
      const result = await client.remove({
        path: readString(args, "path"),
        userId: owner.userId,
        projectId: owner.projectId,
      });
      if (result.success) {
        await agent.globalBus.publish({
          type: "kairo.memory_fs.delete",
          source: "memory-fs-tools",
          data: {
            scope: owner.projectId ? "project" : "user",
            userId: owner.userId,
            projectId: owner.projectId,
            path: result.path,
          },
        });
      }
      return result;
    }
  );

  agent.registerSystemTool(
    {
      name: "memory_fs_search_indexed",
      description: "按关键词搜索记忆文件索引",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["user", "project"] },
          keyword: { type: "string" },
          userId: { type: "string" },
          projectId: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          limit: { type: "number" },
        },
        required: ["scope", "keyword", "userId"],
      },
    },
    async (args: unknown) => {
      if (!isRecord(args)) {
        throw new Error("参数格式无效");
      }
      const scope = readScope(args);
      const owner = parseOwner(args);
      return client.search({
        scope,
        keyword: readString(args, "keyword"),
        userId: owner.userId,
        projectId: owner.projectId,
        tags: readOptionalStringArray(args, "tags"),
        limit: readOptionalNumber(args, "limit"),
      });
    }
  );
}
