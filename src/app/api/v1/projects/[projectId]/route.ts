import { and, eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/db"
import { projects, type NewProject } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"

export const runtime = "nodejs"

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(5000).nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
})

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const { projectId } = await context.params
  const [project] = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      settings: projects.settings,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, user.id)))
    .limit(1)

  if (!project) {
    return NextResponse.json({ message: "项目不存在或无权限" }, { status: 404 })
  }

  return NextResponse.json(project)
}

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = updateProjectSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  const { projectId } = await context.params
  const updates: Partial<Pick<NewProject, "name" | "description" | "settings">> = {}
  if (parsed.data.name) {
    updates.name = parsed.data.name.trim()
  }
  if (parsed.data.description !== undefined) {
    updates.description = parsed.data.description ? parsed.data.description.trim() : null
  }
  if (parsed.data.settings) {
    updates.settings = parsed.data.settings
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ message: "没有可更新的字段" }, { status: 400 })
  }

  const [updated] = await db
    .update(projects)
    .set(updates)
    .where(and(eq(projects.id, projectId), eq(projects.userId, user.id)))
    .returning({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      settings: projects.settings,
      createdAt: projects.createdAt,
    })

  if (!updated) {
    return NextResponse.json({ message: "项目不存在或无权限" }, { status: 404 })
  }

  return NextResponse.json(updated)
}
