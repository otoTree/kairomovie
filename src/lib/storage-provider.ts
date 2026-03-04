import fs from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { pathToFileURL } from "url"

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
    this.basePath = basePath || process.env.KAIRO_LOCAL_OBJECT_STORAGE_PATH || path.join(process.cwd(), "data", "object-storage")
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

