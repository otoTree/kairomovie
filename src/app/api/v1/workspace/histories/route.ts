import { NextResponse } from "next/server"
import { and, desc, eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { ensureCloudTables } from "@/db/ensure-cloud-tables"
import { apiCanvasHistories, projects } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"

export const runtime = "nodejs"

const nodeSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(["text", "image", "video"]),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
  text: z.string().optional(),
  src: z.string().optional(),
  title: z.string(),
  content: z.string().optional(),
})

const messageSchema = z.object({
  role: z.enum(["user", "assistant", "thought", "event"]),
  text: z.string(),
  createdAt: z.string().optional(),
})

const snapshotSchema = z.object({
  nodes: z.array(nodeSchema),
  messages: z.array(messageSchema),
  scale: z.number().finite(),
  offset: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  canvasName: z.string().max(128),
})

const createSchema = z.object({
  projectId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  snapshot: snapshotSchema,
})

const updateSchema = z.object({
  id: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  name: z.string().min(1).max(128).optional(),
  sessionId: z.string().min(1).max(128).optional(),
  snapshot: snapshotSchema.optional(),
})

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

function toHistoryPayload(
  row: {
    id: string
    name: string
    sessionId: string
    snapshot: Record<string, unknown>
    createdAt: Date
    updatedAt: Date
  },
  withSnapshot: boolean
) {
  return {
    id: row.id,
    name: row.name,
    sessionId: row.sessionId,
    snapshot: withSnapshot ? row.snapshot : undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function GET(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const projectId = searchParams.get("projectId")?.trim() || ""
  const withSnapshot = searchParams.get("withSnapshot") !== "false"
  if (!projectId) {
    return NextResponse.json({ message: "projectId 不能为空" }, { status: 400 })
  }

  await ensureCloudTables()
  await assertProjectAccess(user.id, projectId)

  const rows = await db
    .select({
      id: apiCanvasHistories.id,
      name: apiCanvasHistories.name,
      sessionId: apiCanvasHistories.sessionId,
      snapshot: apiCanvasHistories.snapshot,
      createdAt: apiCanvasHistories.createdAt,
      updatedAt: apiCanvasHistories.updatedAt,
    })
    .from(apiCanvasHistories)
    .where(and(eq(apiCanvasHistories.userId, user.id), eq(apiCanvasHistories.projectId, projectId)))
    .orderBy(desc(apiCanvasHistories.updatedAt))

  return NextResponse.json({
    items: rows.map((row) => toHistoryPayload(row, withSnapshot)),
    count: rows.length,
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
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  const input = parsed.data
  const now = new Date()
  await ensureCloudTables()
  await assertProjectAccess(user.id, input.projectId)

  const [saved] = await db
    .insert(apiCanvasHistories)
    .values({
      userId: user.id,
      projectId: input.projectId,
      name: input.name.trim(),
      sessionId: input.sessionId,
      snapshot: input.snapshot,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [apiCanvasHistories.projectId, apiCanvasHistories.name],
      set: {
        sessionId: input.sessionId,
        snapshot: input.snapshot,
        updatedAt: now,
      },
    })
    .returning({
      id: apiCanvasHistories.id,
      name: apiCanvasHistories.name,
      sessionId: apiCanvasHistories.sessionId,
      snapshot: apiCanvasHistories.snapshot,
      createdAt: apiCanvasHistories.createdAt,
      updatedAt: apiCanvasHistories.updatedAt,
    })

  return NextResponse.json(toHistoryPayload(saved, true))
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

  const input = parsed.data
  await ensureCloudTables()
  await assertProjectAccess(user.id, input.projectId)

  const [current] = await db
    .select({
      id: apiCanvasHistories.id,
      name: apiCanvasHistories.name,
      sessionId: apiCanvasHistories.sessionId,
      snapshot: apiCanvasHistories.snapshot,
    })
    .from(apiCanvasHistories)
    .where(and(eq(apiCanvasHistories.id, input.id), eq(apiCanvasHistories.userId, user.id), eq(apiCanvasHistories.projectId, input.projectId)))
    .limit(1)
  if (!current) {
    return NextResponse.json({ message: "历史记录不存在" }, { status: 404 })
  }

  const now = new Date()
  const nextName = input.name?.trim() || current.name
  try {
    const [updated] = await db
      .update(apiCanvasHistories)
      .set({
        name: nextName,
        sessionId: input.sessionId ?? current.sessionId,
        snapshot: input.snapshot ?? current.snapshot,
        updatedAt: now,
      })
      .where(and(eq(apiCanvasHistories.id, current.id), eq(apiCanvasHistories.userId, user.id), eq(apiCanvasHistories.projectId, input.projectId)))
      .returning({
        id: apiCanvasHistories.id,
        name: apiCanvasHistories.name,
        sessionId: apiCanvasHistories.sessionId,
        snapshot: apiCanvasHistories.snapshot,
        createdAt: apiCanvasHistories.createdAt,
        updatedAt: apiCanvasHistories.updatedAt,
      })

    return NextResponse.json(toHistoryPayload(updated, true))
  } catch {
    return NextResponse.json({ message: "目标历史名称已存在" }, { status: 400 })
  }
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
    .delete(apiCanvasHistories)
    .where(and(eq(apiCanvasHistories.id, id), eq(apiCanvasHistories.userId, user.id), eq(apiCanvasHistories.projectId, projectId)))
    .returning({ id: apiCanvasHistories.id })
  if (deleted.length === 0) {
    return NextResponse.json({ message: "历史记录不存在" }, { status: 404 })
  }

  return NextResponse.json({ status: "deleted", id: deleted[0].id })
}
