import { createHash } from "crypto";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import type { MemoryFsClient, MemoryFileInfo, MemoryReadResult, MemorySearchHit, MemoryWriteResult } from "./memory-fs-tools";

const DEFAULT_BASE_PATH = path.join(process.cwd(), "data", "memory-fs");
const INDEX_FILE_NAME = ".kairo-memory-index.json";

type MemoryIndex = {
  version: 1;
  updatedAt: string;
  files: Record<
    string,
    {
      version: number;
      etag: string;
      updatedAt: string;
      tags?: string[];
      size: number;
    }
  >;
};

type Scope = "user" | "project";

function normalizeRelativePath(inputPath: string) {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    throw new Error("path 不能为空");
  }
  const normalized = path.posix.normalize(trimmed.replaceAll("\\", "/"));
  if (normalized.startsWith("/") || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("path 非法");
  }
  if (normalized.startsWith("..")) {
    throw new Error("path 非法");
  }
  return normalized;
}

function ensureDirExists(dirPath: string) {
  if (!existsSync(dirPath)) {
    return fs.mkdir(dirPath, { recursive: true });
  }
  return Promise.resolve();
}

function computeEtagFromContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function makeOwnerBase(basePath: string, scope: Scope, userId: string, projectId?: string) {
  if (!userId.trim()) {
    throw new Error("userId 不能为空");
  }
  if (scope === "project" && (!projectId || !projectId.trim())) {
    throw new Error("projectId 不能为空");
  }
  const ownerBase =
    scope === "user"
      ? path.join(basePath, "users", userId)
      : path.join(basePath, "projects", projectId!);
  return ownerBase;
}

async function loadIndex(ownerBase: string): Promise<MemoryIndex> {
  await ensureDirExists(ownerBase);
  const indexPath = path.join(ownerBase, INDEX_FILE_NAME);
  if (!existsSync(indexPath)) {
    const fresh: MemoryIndex = { version: 1, updatedAt: new Date().toISOString(), files: {} };
    await fs.writeFile(indexPath, JSON.stringify(fresh, null, 2), "utf-8");
    return fresh;
  }
  const raw = await fs.readFile(indexPath, "utf-8");
  const parsed = JSON.parse(raw) as MemoryIndex;
  if (!parsed || parsed.version !== 1 || typeof parsed.files !== "object") {
    const fresh: MemoryIndex = { version: 1, updatedAt: new Date().toISOString(), files: {} };
    await fs.writeFile(indexPath, JSON.stringify(fresh, null, 2), "utf-8");
    return fresh;
  }
  return parsed;
}

async function saveIndex(ownerBase: string, index: MemoryIndex) {
  index.updatedAt = new Date().toISOString();
  const indexPath = path.join(ownerBase, INDEX_FILE_NAME);
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8");
}

async function walkFiles(dirPath: string, baseDir: string, out: string[]) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const absolute = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(absolute, baseDir, out);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const rel = path.relative(baseDir, absolute);
    out.push(rel.split(path.sep).join("/"));
  }
}

function sliceText(content: string, offset: number, limit: number): MemoryReadResult {
  const safeOffset = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 4096;
  const sliced = content.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + sliced.length;
  const eof = nextOffset >= content.length;
  return {
    path: "",
    content: sliced,
    offset: safeOffset,
    limit: safeLimit,
    eof,
    nextOffset: eof ? undefined : nextOffset,
  };
}

export class LocalMemoryFsClient implements MemoryFsClient {
  private readonly basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath || process.env.KAIRO_MEMORY_FS_PATH || DEFAULT_BASE_PATH;
  }

  async list(input: { scope: Scope; userId: string; projectId?: string; prefix?: string }): Promise<{ files: MemoryFileInfo[] }> {
    const ownerBase = makeOwnerBase(this.basePath, input.scope, input.userId, input.projectId);
    await ensureDirExists(ownerBase);
    const index = await loadIndex(ownerBase);
    const all: string[] = [];
    await walkFiles(ownerBase, ownerBase, all);

    const normalizedPrefix = input.prefix ? normalizeRelativePath(input.prefix) : undefined;
    const filtered = normalizedPrefix ? all.filter((p) => p.startsWith(normalizedPrefix)) : all;

    const files: MemoryFileInfo[] = [];
    for (const relPath of filtered) {
      const absolute = path.join(ownerBase, relPath.split("/").join(path.sep));
      const stat = await fs.stat(absolute).catch(() => null);
      if (!stat || !stat.isFile()) {
        continue;
      }
      const meta = index.files[relPath];
      files.push({
        path: relPath,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        etag: meta?.etag,
        version: meta?.version,
        tags: meta?.tags,
      });
    }
    files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { files };
  }

  async read(input: { path: string; userId: string; projectId?: string; offset?: number; limit?: number }): Promise<MemoryReadResult> {
    const scope: Scope = input.projectId ? "project" : "user";
    const ownerBase = makeOwnerBase(this.basePath, scope, input.userId, input.projectId);
    const relPath = normalizeRelativePath(input.path);
    const absolute = path.join(ownerBase, relPath.split("/").join(path.sep));
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new Error("文件不存在");
    }
    const content = await fs.readFile(absolute, "utf-8");
    const result = sliceText(content, input.offset ?? 0, input.limit ?? 4096);
    result.path = relPath;
    return result;
  }

  async write(input: { path: string; userId: string; projectId?: string; content: string; mode: "overwrite" | "append" }): Promise<MemoryWriteResult> {
    const scope: Scope = input.projectId ? "project" : "user";
    const ownerBase = makeOwnerBase(this.basePath, scope, input.userId, input.projectId);
    const relPath = normalizeRelativePath(input.path);
    const absolute = path.join(ownerBase, relPath.split("/").join(path.sep));
    await ensureDirExists(path.dirname(absolute));

    if (input.mode === "append") {
      await fs.appendFile(absolute, input.content, "utf-8");
    } else {
      await fs.writeFile(absolute, input.content, "utf-8");
    }

    const finalContent = await fs.readFile(absolute, "utf-8");
    const etag = computeEtagFromContent(finalContent);
    const stat = await fs.stat(absolute);

    const index = await loadIndex(ownerBase);
    const current = index.files[relPath];
    const version = (current?.version ?? 0) + 1;
    index.files[relPath] = {
      version,
      etag,
      updatedAt: new Date().toISOString(),
      tags: current?.tags,
      size: stat.size,
    };
    await saveIndex(ownerBase, index);

    return { path: relPath, etag, version, size: stat.size };
  }

  async move(input: { fromPath: string; toPath: string; userId: string; projectId?: string }): Promise<{ success: boolean; fromPath: string; toPath: string }> {
    const scope: Scope = input.projectId ? "project" : "user";
    const ownerBase = makeOwnerBase(this.basePath, scope, input.userId, input.projectId);
    const fromRel = normalizeRelativePath(input.fromPath);
    const toRel = normalizeRelativePath(input.toPath);
    const fromAbs = path.join(ownerBase, fromRel.split("/").join(path.sep));
    const toAbs = path.join(ownerBase, toRel.split("/").join(path.sep));
    await ensureDirExists(path.dirname(toAbs));

    const stat = await fs.stat(fromAbs).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new Error("源文件不存在");
    }
    await fs.rename(fromAbs, toAbs);

    const index = await loadIndex(ownerBase);
    const existing = index.files[fromRel];
    if (existing) {
      index.files[toRel] = { ...existing, updatedAt: new Date().toISOString() };
      delete index.files[fromRel];
      await saveIndex(ownerBase, index);
    }

    return { success: true, fromPath: fromRel, toPath: toRel };
  }

  async remove(input: { path: string; userId: string; projectId?: string }): Promise<{ success: boolean; path: string }> {
    const scope: Scope = input.projectId ? "project" : "user";
    const ownerBase = makeOwnerBase(this.basePath, scope, input.userId, input.projectId);
    const relPath = normalizeRelativePath(input.path);
    const absolute = path.join(ownerBase, relPath.split("/").join(path.sep));
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat || !stat.isFile()) {
      return { success: false, path: relPath };
    }
    await fs.unlink(absolute);

    const index = await loadIndex(ownerBase);
    if (index.files[relPath]) {
      delete index.files[relPath];
      await saveIndex(ownerBase, index);
    }

    return { success: true, path: relPath };
  }

  async search(input: {
    scope: Scope;
    keyword: string;
    userId: string;
    projectId?: string;
    tags?: string[];
    limit?: number;
  }): Promise<{ hits: MemorySearchHit[] }> {
    const ownerBase = makeOwnerBase(this.basePath, input.scope, input.userId, input.projectId);
    await ensureDirExists(ownerBase);
    const keyword = input.keyword.trim();
    if (!keyword) {
      throw new Error("keyword 不能为空");
    }
    const maxHits = Number.isFinite(input.limit) && (input.limit as number) > 0 ? Math.min(Math.floor(input.limit as number), 50) : 10;
    const maxFileBytes = 1024 * 1024;
    const all: string[] = [];
    await walkFiles(ownerBase, ownerBase, all);

    const hits: MemorySearchHit[] = [];
    for (const relPath of all) {
      if (hits.length >= maxHits) {
        break;
      }
      const absolute = path.join(ownerBase, relPath.split("/").join(path.sep));
      const stat = await fs.stat(absolute).catch(() => null);
      if (!stat || !stat.isFile()) {
        continue;
      }
      if (stat.size > maxFileBytes) {
        continue;
      }
      const content = await fs.readFile(absolute, "utf-8").catch(() => null);
      if (content === null) {
        continue;
      }
      const index = content.toLowerCase().indexOf(keyword.toLowerCase());
      if (index < 0) {
        continue;
      }
      const start = Math.max(0, index - 40);
      const end = Math.min(content.length, index + keyword.length + 80);
      const snippet = content.slice(start, end);
      hits.push({
        path: relPath,
        snippet,
        score: 1,
        offset: index,
      });
    }
    return { hits };
  }
}

