import { NextResponse } from "next/server"
import { and, desc, eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { ensureCloudTables } from "@/db/ensure-cloud-tables"
import { apiArtifactFolders, apiArtifacts, projects } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"
import { createApiAlert, recordApiLog } from "@/lib/api-observability"
import { getAppEnv } from "@/lib/env"
import { presignS3Url } from "@/lib/s3-presign"
import { getProjectArtifactKey } from "@/lib/storage-keys"

export const runtime = "nodejs"

const createSchema = z.object({
  projectId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  fileName: z.string().min(1).max(255),
  relativePath: z.string().min(1).max(1024).optional(),
  provider: z.string().min(1).max(128).optional(),
  kind: z.string().min(1).max(64).optional(),
  mimeType: z.string().min(1).max(200).optional(),
  size: z.number().int().min(0).max(10_000_000_000).optional(),
  status: z.enum(["pending", "uploaded", "failed"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  folderSource: z.enum(["manual", "canvas", "system"]).optional(),
  linkedCanvasName: z.string().min(1).max(128).optional(),
  expiresInSeconds: z.number().int().min(60).max(3600).optional(),
})

const updateSchema = z.object({
  id: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128).optional(),
  relativePath: z.string().min(1).max(1024).optional(),
  fileName: z.string().min(1).max(255).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["pending", "uploaded", "failed"]).optional(),
})

function parsePositiveInt(value: string | null, fallback: number) {
  if (!value) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.floor(parsed)
}

function parseBoolean(value: string | null, fallback: boolean) {
  if (!value) {
    return fallback
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true
  if (normalized === "0" || normalized === "false" || normalized === "no") return false
  return fallback
}

function buildBaseUrl(endpoint: string) {
  const trimmed = endpoint.trim()
  if (!trimmed) {
    throw new Error("TOS_ENDPOINT 未配置")
  }
  const withScheme = trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`
  return new URL(withScheme)
}

function createObjectUrl(endpoint: string, bucket: string, key: string) {
  const baseUrl = buildBaseUrl(endpoint)
  return new URL(`${baseUrl.origin}/${bucket}/${key}`)
}

function resolveRelativePath(objectKey: string, projectId: string, taskId: string) {
  const prefix = `projects/${projectId}/artifacts/${taskId}/`
  if (!objectKey.startsWith(prefix)) {
    return objectKey
  }
  return objectKey.slice(prefix.length)
}

async function assertProjectAccess(userId: string, projectId: string) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1)
  if (!project) {
    throw new Error("项目不存在或无权限")
  }
}

async function upsertArtifactFolder(input: {
  userId: string
  projectId: string
  name: string
  source?: "manual" | "canvas" | "system"
  linkedCanvasName?: string
}) {
  const now = new Date()
  await db
    .insert(apiArtifactFolders)
    .values({
      userId: input.userId,
      projectId: input.projectId,
      name: input.name,
      source: input.source ?? "manual",
      linkedCanvasName: input.linkedCanvasName ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [apiArtifactFolders.projectId, apiArtifactFolders.name],
      set: {
        source: input.source ?? "manual",
        linkedCanvasName: input.linkedCanvasName ?? null,
        updatedAt: now,
      },
    })
}

export async function POST(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    await recordApiLog({
      userId: user.id,
      level: "warn",
      category: "storage.artifacts",
      code: "invalid_request",
      message: "产物登记参数无效",
    })
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  const env = getAppEnv()
  if (!env.tosEndpoint || !env.tosBucket || !env.tosAccessKey || !env.tosSecretKey || !env.tosRegion) {
    await recordApiLog({
      userId: user.id,
      projectId: parsed.data.projectId,
      level: "error",
      category: "storage.artifacts",
      code: "storage_unconfigured",
      message: "对象存储未配置导致产物登记失败",
    })
    await createApiAlert({
      userId: user.id,
      projectId: parsed.data.projectId,
      alertType: "storage_failed",
      severity: "critical",
      message: "对象存储未配置，无法创建产物上传链接",
      details: { route: "/api/v1/storage/artifacts" },
    })
    return NextResponse.json({ message: "对象存储未配置" }, { status: 400 })
  }

  await ensureCloudTables()

  try {
    const input = parsed.data
    await assertProjectAccess(user.id, input.projectId)
    await upsertArtifactFolder({
      userId: user.id,
      projectId: input.projectId,
      name: input.taskId,
      source: input.folderSource,
      linkedCanvasName: input.linkedCanvasName,
    })

    const objectKey = getProjectArtifactKey(input.projectId, input.taskId, input.relativePath ?? input.fileName)
    const now = new Date()
    const [saved] = await db
      .insert(apiArtifacts)
      .values({
        userId: user.id,
        projectId: input.projectId,
        taskId: input.taskId,
        provider: input.provider ?? null,
        kind: input.kind ?? null,
        objectKey,
        fileName: input.fileName.trim(),
        mimeType: input.mimeType ?? null,
        size: input.size ?? 0,
        status: input.status ?? "pending",
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [apiArtifacts.projectId, apiArtifacts.taskId, apiArtifacts.objectKey],
        set: {
          provider: input.provider ?? null,
          kind: input.kind ?? null,
          fileName: input.fileName.trim(),
          mimeType: input.mimeType ?? null,
          size: input.size ?? 0,
          status: input.status ?? "pending",
          metadata: input.metadata ?? {},
          updatedAt: now,
        },
      })
      .returning({
        id: apiArtifacts.id,
        projectId: apiArtifacts.projectId,
        taskId: apiArtifacts.taskId,
        provider: apiArtifacts.provider,
        kind: apiArtifacts.kind,
        objectKey: apiArtifacts.objectKey,
        fileName: apiArtifacts.fileName,
        mimeType: apiArtifacts.mimeType,
        size: apiArtifacts.size,
        status: apiArtifacts.status,
        metadata: apiArtifacts.metadata,
        createdAt: apiArtifacts.createdAt,
        updatedAt: apiArtifacts.updatedAt,
      })

    const objectUrl = createObjectUrl(env.tosEndpoint, env.tosBucket, objectKey)
    const expiresInSeconds = input.expiresInSeconds ?? 900
    const upload = presignS3Url({
      method: "PUT",
      url: objectUrl,
      accessKeyId: env.tosAccessKey,
      secretAccessKey: env.tosSecretKey,
      region: env.tosRegion,
      expiresInSeconds,
      contentType: input.mimeType,
    })
    const download = presignS3Url({
      method: "GET",
      url: objectUrl,
      accessKeyId: env.tosAccessKey,
      secretAccessKey: env.tosSecretKey,
      region: env.tosRegion,
      expiresInSeconds,
    })

    return NextResponse.json({
      artifact: {
        ...saved,
        createdAt: saved.createdAt.toISOString(),
        updatedAt: saved.updatedAt.toISOString(),
      },
      upload,
      download,
    })
  } catch (error) {
    await recordApiLog({
      userId: user.id,
      projectId: parsed.data.projectId,
      level: "error",
      category: "storage.artifacts",
      code: "storage_failed",
      message: "产物登记或签名生成失败",
      details: { error: error instanceof Error ? error.message : String(error) },
    })
    await createApiAlert({
      userId: user.id,
      projectId: parsed.data.projectId,
      alertType: "storage_failed",
      severity: "critical",
      message: "产物登记或签名生成失败",
      details: { route: "/api/v1/storage/artifacts", error: error instanceof Error ? error.message : String(error) },
    })
    return NextResponse.json({ message: error instanceof Error ? error.message : "操作失败" }, { status: 400 })
  }
}

export async function GET(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const projectId = searchParams.get("projectId")?.trim() || ""
  const taskId = searchParams.get("taskId")?.trim() || undefined
  const limit = parsePositiveInt(searchParams.get("limit"), 50)
  const withUrl = parseBoolean(searchParams.get("withUrl"), true)
  const expiresInSeconds = parsePositiveInt(searchParams.get("expiresInSeconds"), 900)
  if (!projectId) {
    return NextResponse.json({ message: "projectId 不能为空" }, { status: 400 })
  }

  await ensureCloudTables()
  await assertProjectAccess(user.id, projectId)

  const where = [eq(apiArtifacts.userId, user.id), eq(apiArtifacts.projectId, projectId)]
  if (taskId) {
    where.push(eq(apiArtifacts.taskId, taskId))
  }

  const rows = await db
    .select({
      id: apiArtifacts.id,
      projectId: apiArtifacts.projectId,
      taskId: apiArtifacts.taskId,
      provider: apiArtifacts.provider,
      kind: apiArtifacts.kind,
      objectKey: apiArtifacts.objectKey,
      fileName: apiArtifacts.fileName,
      mimeType: apiArtifacts.mimeType,
      size: apiArtifacts.size,
      status: apiArtifacts.status,
      metadata: apiArtifacts.metadata,
      createdAt: apiArtifacts.createdAt,
      updatedAt: apiArtifacts.updatedAt,
    })
    .from(apiArtifacts)
    .where(and(...where))
    .orderBy(desc(apiArtifacts.createdAt))
    .limit(Math.min(limit, 200))

  const env = getAppEnv()
  const canPresign = withUrl && env.tosEndpoint && env.tosBucket && env.tosAccessKey && env.tosSecretKey && env.tosRegion

  const items = rows.map((row) => {
    let download: ReturnType<typeof presignS3Url> | null = null
    if (canPresign) {
      const objectUrl = createObjectUrl(env.tosEndpoint!, env.tosBucket!, row.objectKey)
      download = presignS3Url({
        method: "GET",
        url: objectUrl,
        accessKeyId: env.tosAccessKey!,
        secretAccessKey: env.tosSecretKey!,
        region: env.tosRegion!,
        expiresInSeconds: Math.min(Math.max(expiresInSeconds, 60), 3600),
      })
    }
    return {
      ...row,
      relativePath: resolveRelativePath(row.objectKey, row.projectId, row.taskId),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      download,
    }
  })

  return NextResponse.json({
    items,
    count: items.length,
  })
}

export async function PATCH(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  await ensureCloudTables()
  await assertProjectAccess(user.id, parsed.data.projectId)

  const [current] = await db
    .select({
      id: apiArtifacts.id,
      projectId: apiArtifacts.projectId,
      taskId: apiArtifacts.taskId,
      objectKey: apiArtifacts.objectKey,
      fileName: apiArtifacts.fileName,
      metadata: apiArtifacts.metadata,
      status: apiArtifacts.status,
      mimeType: apiArtifacts.mimeType,
      size: apiArtifacts.size,
      provider: apiArtifacts.provider,
      kind: apiArtifacts.kind,
      createdAt: apiArtifacts.createdAt,
    })
    .from(apiArtifacts)
    .where(and(eq(apiArtifacts.id, parsed.data.id), eq(apiArtifacts.userId, user.id), eq(apiArtifacts.projectId, parsed.data.projectId)))
    .limit(1)

  if (!current) {
    return NextResponse.json({ message: "资产不存在" }, { status: 404 })
  }

  const nextTaskId = parsed.data.taskId ?? current.taskId
  const nextRelativePath =
    parsed.data.relativePath ?? resolveRelativePath(current.objectKey, current.projectId, current.taskId) ?? current.fileName
  const nextFileName = parsed.data.fileName ?? current.fileName
  const now = new Date()
  await upsertArtifactFolder({
    userId: user.id,
    projectId: parsed.data.projectId,
    name: nextTaskId,
  })
  const nextObjectKey = getProjectArtifactKey(parsed.data.projectId, nextTaskId, nextRelativePath)

  const [updated] = await db
    .update(apiArtifacts)
    .set({
      taskId: nextTaskId,
      objectKey: nextObjectKey,
      fileName: nextFileName,
      metadata: parsed.data.metadata ?? current.metadata,
      status: parsed.data.status ?? current.status,
      updatedAt: now,
    })
    .where(and(eq(apiArtifacts.id, current.id), eq(apiArtifacts.userId, user.id), eq(apiArtifacts.projectId, parsed.data.projectId)))
    .returning({
      id: apiArtifacts.id,
      projectId: apiArtifacts.projectId,
      taskId: apiArtifacts.taskId,
      provider: apiArtifacts.provider,
      kind: apiArtifacts.kind,
      objectKey: apiArtifacts.objectKey,
      fileName: apiArtifacts.fileName,
      mimeType: apiArtifacts.mimeType,
      size: apiArtifacts.size,
      status: apiArtifacts.status,
      metadata: apiArtifacts.metadata,
      createdAt: apiArtifacts.createdAt,
      updatedAt: apiArtifacts.updatedAt,
    })

  return NextResponse.json({
    ...updated,
    relativePath: resolveRelativePath(updated.objectKey, updated.projectId, updated.taskId),
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  })
}

export async function DELETE(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const projectId = searchParams.get("projectId")?.trim() || ""
  const id = searchParams.get("id")?.trim() || ""
  if (!projectId || !id) {
    return NextResponse.json({ message: "projectId 和 id 不能为空" }, { status: 400 })
  }

  await ensureCloudTables()
  await assertProjectAccess(user.id, projectId)

  const deleted = await db
    .delete(apiArtifacts)
    .where(and(eq(apiArtifacts.id, id), eq(apiArtifacts.projectId, projectId), eq(apiArtifacts.userId, user.id)))
    .returning({ id: apiArtifacts.id })

  if (deleted.length === 0) {
    return NextResponse.json({ message: "资产不存在" }, { status: 404 })
  }

  return NextResponse.json({ status: "deleted", id: deleted[0].id })
}
