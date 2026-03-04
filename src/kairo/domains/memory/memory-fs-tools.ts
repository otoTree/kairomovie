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
  write(input: {
    path: string;
    userId: string;
    projectId?: string;
    content: string;
    mode: WriteMode;
  }): Promise<MemoryWriteResult>;
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
      return client.write({
        path: readString(args, "path"),
        userId: owner.userId,
        projectId: owner.projectId,
        content: readString(args, "content"),
        mode: readWriteMode(args),
      });
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
      return client.move({
        fromPath: readString(args, "fromPath"),
        toPath: readString(args, "toPath"),
        userId: owner.userId,
        projectId: owner.projectId,
      });
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
      return client.remove({
        path: readString(args, "path"),
        userId: owner.userId,
        projectId: owner.projectId,
      });
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
