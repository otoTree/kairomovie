import { NextResponse } from "next/server"
import { and, asc, eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { ensureCloudTables } from "@/db/ensure-cloud-tables"
import { apiArtifactFolders, apiArtifacts, projects } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"
import { getProjectArtifactKey } from "@/lib/storage-keys"

export const runtime = "nodejs"

const createSchema = z.object({
  projectId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  source: z.enum(["manual", "canvas", "system"]).optional(),
  linkedCanvasName: z.string().min(1).max(128).optional(),
})

const renameSchema = z.object({
  projectId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  nextName: z.string().min(1).max(128),
  linkedCanvasName: z.string().min(1).max(128).optional(),
})

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

export async function GET(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const projectId = searchParams.get("projectId")?.trim() || ""
  if (!projectId) {
    return NextResponse.json({ message: "projectId 不能为空" }, { status: 400 })
  }

  await ensureCloudTables()
  await assertProjectAccess(user.id, projectId)

  const [folders, artifactRows] = await Promise.all([
    db
      .select({
        id: apiArtifactFolders.id,
        name: apiArtifactFolders.name,
        source: apiArtifactFolders.source,
        linkedCanvasName: apiArtifactFolders.linkedCanvasName,
        createdAt: apiArtifactFolders.createdAt,
        updatedAt: apiArtifactFolders.updatedAt,
      })
      .from(apiArtifactFolders)
      .where(and(eq(apiArtifactFolders.userId, user.id), eq(apiArtifactFolders.projectId, projectId)))
      .orderBy(asc(apiArtifactFolders.name)),
    db
      .select({ taskId: apiArtifacts.taskId })
      .from(apiArtifacts)
      .where(and(eq(apiArtifacts.userId, user.id), eq(apiArtifacts.projectId, projectId))),
  ])

  const fileCountMap = new Map<string, number>()
  for (const row of artifactRows) {
    fileCountMap.set(row.taskId, (fileCountMap.get(row.taskId) ?? 0) + 1)
  }

  const folderMap = new Map<
    string,
    {
      id: string
      name: string
      source: string
      linkedCanvasName: string | null
      createdAt: string
      updatedAt: string
    }
  >()

  for (const folder of folders) {
    folderMap.set(folder.name, {
      id: folder.id,
      name: folder.name,
      source: folder.source,
      linkedCanvasName: folder.linkedCanvasName,
      createdAt: folder.createdAt.toISOString(),
      updatedAt: folder.updatedAt.toISOString(),
    })
  }

  for (const taskId of fileCountMap.keys()) {
    if (folderMap.has(taskId)) {
      continue
    }
    folderMap.set(taskId, {
      id: `virtual-${taskId}`,
      name: taskId,
      source: "legacy",
      linkedCanvasName: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    })
  }

  const items = [...folderMap.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((folder) => ({
      ...folder,
      fileCount: fileCountMap.get(folder.name) ?? 0,
    }))

  return NextResponse.json({ items, count: items.length })
}

export async function POST(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  const input = parsed.data
  const now = new Date()

  await ensureCloudTables()
  await assertProjectAccess(user.id, input.projectId)

  const [saved] = await db
    .insert(apiArtifactFolders)
    .values({
      userId: user.id,
      projectId: input.projectId,
      name: input.name.trim(),
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
    .returning({
      id: apiArtifactFolders.id,
      name: apiArtifactFolders.name,
      source: apiArtifactFolders.source,
      linkedCanvasName: apiArtifactFolders.linkedCanvasName,
      createdAt: apiArtifactFolders.createdAt,
      updatedAt: apiArtifactFolders.updatedAt,
    })

  return NextResponse.json({
    ...saved,
    createdAt: saved.createdAt.toISOString(),
    updatedAt: saved.updatedAt.toISOString(),
  })
}

export async function PATCH(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = renameSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  const input = parsed.data
  const now = new Date()

  await ensureCloudTables()
  await assertProjectAccess(user.id, input.projectId)

  const currentName = input.name.trim()
  const nextName = input.nextName.trim()

  if (currentName === nextName) {
    return NextResponse.json({ status: "ok", name: nextName })
  }

  const existing = await db
    .select({ id: apiArtifactFolders.id })
    .from(apiArtifactFolders)
    .where(and(eq(apiArtifactFolders.projectId, input.projectId), eq(apiArtifactFolders.name, nextName)))
    .limit(1)
  if (existing.length > 0) {
    return NextResponse.json({ message: "目标文件夹名称已存在" }, { status: 400 })
  }

  await db
    .update(apiArtifactFolders)
    .set({
      name: nextName,
      linkedCanvasName: input.linkedCanvasName ?? nextName,
      updatedAt: now,
    })
    .where(and(eq(apiArtifactFolders.userId, user.id), eq(apiArtifactFolders.projectId, input.projectId), eq(apiArtifactFolders.name, currentName)))

  const files = await db
    .select({
      id: apiArtifacts.id,
      objectKey: apiArtifacts.objectKey,
      projectId: apiArtifacts.projectId,
      taskId: apiArtifacts.taskId,
    })
    .from(apiArtifacts)
    .where(and(eq(apiArtifacts.userId, user.id), eq(apiArtifacts.projectId, input.projectId), eq(apiArtifacts.taskId, currentName)))

  for (const file of files) {
    const relativePath = resolveRelativePath(file.objectKey, file.projectId, file.taskId)
    const objectKey = getProjectArtifactKey(file.projectId, nextName, relativePath)
    await db
      .update(apiArtifacts)
      .set({
        taskId: nextName,
        objectKey,
        updatedAt: now,
      })
      .where(and(eq(apiArtifacts.id, file.id), eq(apiArtifacts.userId, user.id), eq(apiArtifacts.projectId, input.projectId)))
  }

  return NextResponse.json({ status: "renamed", name: nextName, movedCount: files.length })
}

export async function DELETE(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const projectId = searchParams.get("projectId")?.trim() || ""
  const name = searchParams.get("name")?.trim() || ""
  if (!projectId || !name) {
    return NextResponse.json({ message: "projectId 和 name 不能为空" }, { status: 400 })
  }

  await ensureCloudTables()
  await assertProjectAccess(user.id, projectId)

  const deletedFiles = await db
    .delete(apiArtifacts)
    .where(and(eq(apiArtifacts.userId, user.id), eq(apiArtifacts.projectId, projectId), eq(apiArtifacts.taskId, name)))
    .returning({ id: apiArtifacts.id })

  await db
    .delete(apiArtifactFolders)
    .where(and(eq(apiArtifactFolders.userId, user.id), eq(apiArtifactFolders.projectId, projectId), eq(apiArtifactFolders.name, name)))

  return NextResponse.json({ status: "deleted", name, deletedFiles: deletedFiles.length })
}
