import fs from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { del, head, list as listBlob, put } from "@vercel/blob"

const IS_SERVERLESS_RUNTIME = process.env.VERCEL === "1" || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME)
const DEFAULT_LOCAL_OBJECT_STORAGE_PATH = IS_SERVERLESS_RUNTIME
  ? path.join("/tmp", "kairo", "data", "object-storage")
  : path.join(process.cwd(), "data", "object-storage")

export type StoragePutInput = {
  key: string
  body: Uint8Array | string
  contentType?: string
}

export type StorageGetResult = {
  key: string
  body: Uint8Array
  contentType?: string
}

export interface StorageProvider {
  put(input: StoragePutInput): Promise<{ key: string; size: number }>
  get(key: string): Promise<StorageGetResult>
  delete(key: string): Promise<{ key: string; deleted: boolean }>
  list(prefix: string): Promise<{ keys: string[] }>
  getUrl(key: string): Promise<{ key: string; url: string }>
}

function normalizeKey(key: string) {
  const trimmed = key.trim()
  if (!trimmed) {
    throw new Error("key 不能为空")
  }
  const normalized = path.posix.normalize(trimmed.replaceAll("\\", "/"))
  if (normalized.startsWith("/") || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("key 非法")
  }
  return normalized
}

async function ensureDirExists(dirPath: string) {
  if (!existsSync(dirPath)) {
    await fs.mkdir(dirPath, { recursive: true })
  }
}

export class LocalFsStorageProvider implements StorageProvider {
  private readonly basePath: string

  constructor(basePath?: string) {
    this.basePath = basePath || process.env.KAIRO_LOCAL_OBJECT_STORAGE_PATH || DEFAULT_LOCAL_OBJECT_STORAGE_PATH
  }

  private resolveKey(key: string) {
    const clean = normalizeKey(key)
    const absolute = path.join(this.basePath, clean.split("/").join(path.sep))
    return { clean, absolute }
  }

  async put(input: StoragePutInput) {
    const { clean, absolute } = this.resolveKey(input.key)
    await ensureDirExists(path.dirname(absolute))
    const data = typeof input.body === "string" ? Buffer.from(input.body, "utf-8") : Buffer.from(input.body)
    await fs.writeFile(absolute, data)
    return { key: clean, size: data.byteLength }
  }

  async get(key: string): Promise<StorageGetResult> {
    const { clean, absolute } = this.resolveKey(key)
    const stat = await fs.stat(absolute).catch(() => null)
    if (!stat || !stat.isFile()) {
      throw new Error("对象不存在")
    }
    const body = await fs.readFile(absolute)
    return { key: clean, body }
  }

  async delete(key: string) {
    const { clean, absolute } = this.resolveKey(key)
    const stat = await fs.stat(absolute).catch(() => null)
    if (!stat || !stat.isFile()) {
      return { key: clean, deleted: false }
    }
    await fs.unlink(absolute)
    return { key: clean, deleted: true }
  }

  async list(prefix: string) {
    const cleanPrefix = normalizeKey(prefix)
    const root = path.join(this.basePath, cleanPrefix.split("/").join(path.sep))
    const keys: string[] = []

    const walk = async (dirPath: string) => {
      const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue
        const abs = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          await walk(abs)
          continue
        }
        if (!entry.isFile()) continue
        const rel = path.relative(this.basePath, abs).split(path.sep).join("/")
        keys.push(rel)
      }
    }

    await walk(root)
    keys.sort()
    return { keys }
  }

  async getUrl(key: string) {
    const { clean, absolute } = this.resolveKey(key)
    return { key: clean, url: pathToFileURL(absolute).toString() }
  }
}

export class VercelBlobStorageProvider implements StorageProvider {
  private readonly token: string

  constructor(token?: string) {
    const resolved = token?.trim() || process.env.BLOB_READ_WRITE_TOKEN?.trim()
    if (!resolved) {
      throw new Error("BLOB_READ_WRITE_TOKEN 未配置")
    }
    this.token = resolved
  }

  async put(input: StoragePutInput) {
    const clean = normalizeKey(input.key)
    const data = typeof input.body === "string" ? Buffer.from(input.body, "utf-8") : Buffer.from(input.body)
    await put(clean, data, {
      token: this.token,
      access: "public",
      addRandomSuffix: false,
      contentType: input.contentType,
    })
    return { key: clean, size: data.byteLength }
  }

  async get(key: string): Promise<StorageGetResult> {
    const clean = normalizeKey(key)
    const object = await head(clean, { token: this.token }).catch(() => null)
    if (!object) {
      throw new Error("对象不存在")
    }
    const response = await fetch(object.url)
    if (!response.ok) {
      throw new Error("对象读取失败")
    }
    const body = new Uint8Array(await response.arrayBuffer())
    return { key: clean, body, contentType: object.contentType }
  }

  async delete(key: string) {
    const clean = normalizeKey(key)
    try {
      await del(clean, { token: this.token })
      return { key: clean, deleted: true }
    } catch {
      return { key: clean, deleted: false }
    }
  }

  async list(prefix: string) {
    const cleanPrefix = normalizeKey(prefix)
    const listed = await listBlob({ prefix: cleanPrefix, token: this.token, limit: 1000 })
    const keys = listed.blobs.map((item) => item.pathname).sort()
    return { keys }
  }

  async getUrl(key: string) {
    const clean = normalizeKey(key)
    const object = await head(clean, { token: this.token }).catch(() => null)
    if (!object) {
      throw new Error("对象不存在")
    }
    return { key: clean, url: object.url }
  }
}

export function createStorageProvider(): StorageProvider {
  if (process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    return new VercelBlobStorageProvider()
  }
  return new LocalFsStorageProvider()
}
