import { and, eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/db"
import { projectProviderConfigs, projects } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"

export const runtime = "nodejs"

const upsertSchema = z.object({
  provider: z.string().min(1).max(128),
  config: z.unknown(),
})

async function assertProjectAccess(userId: string, projectId: string) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1)
  return Boolean(project)
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const { projectId } = await context.params
  if (!(await assertProjectAccess(user.id, projectId))) {
    return NextResponse.json({ message: "项目不存在或无权限" }, { status: 404 })
  }

  const rows = await db
    .select({
      provider: projectProviderConfigs.provider,
      config: projectProviderConfigs.config,
      updatedAt: projectProviderConfigs.updatedAt,
    })
    .from(projectProviderConfigs)
    .where(eq(projectProviderConfigs.projectId, projectId))

  return NextResponse.json({ items: rows, count: rows.length })
}

export async function PUT(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = upsertSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  const { projectId } = await context.params
  if (!(await assertProjectAccess(user.id, projectId))) {
    return NextResponse.json({ message: "项目不存在或无权限" }, { status: 404 })
  }

  const now = new Date()
  const [saved] = await db
    .insert(projectProviderConfigs)
    .values({
      projectId,
      provider: parsed.data.provider,
      config: parsed.data.config,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projectProviderConfigs.projectId, projectProviderConfigs.provider],
      set: {
        config: parsed.data.config,
        updatedAt: now,
      },
    })
    .returning({
      provider: projectProviderConfigs.provider,
      config: projectProviderConfigs.config,
      updatedAt: projectProviderConfigs.updatedAt,
    })

  return NextResponse.json(saved)
}

