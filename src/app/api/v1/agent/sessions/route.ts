import { and, eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { db } from "@/db"
import { projects } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"
import { listSessionSummaries } from "@/lib/session-memory"

export const runtime = "nodejs"

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
  const canvasName = searchParams.get("canvasName")?.trim() || undefined
  const rawLimit = Number(searchParams.get("limit") || 30)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 30
  if (!projectId) {
    return NextResponse.json({ message: "projectId 不能为空" }, { status: 400 })
  }
  await assertProjectAccess(user.id, projectId)
  const items = await listSessionSummaries(user.id, { projectId, canvasName, limit })
  return NextResponse.json({ items, count: items.length })
}
