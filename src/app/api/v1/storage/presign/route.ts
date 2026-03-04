import { NextResponse } from "next/server"
import { z } from "zod"
import { and, eq } from "drizzle-orm"
import { head } from "@vercel/blob"
import { db } from "@/db"
import { projects } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"
import { createApiAlert, recordApiLog } from "@/lib/api-observability"
import { getAppEnv } from "@/lib/env"
import { getProjectObjectKey, getUserObjectKey } from "@/lib/storage-keys"

export const runtime = "nodejs"

const schema = z.object({
  op: z.enum(["get", "put"]),
  scope: z.enum(["user", "project"]),
  projectId: z.string().min(1).max(128).optional(),
  path: z.string().min(1).max(1024),
  expiresInSeconds: z.number().int().min(60).max(3600).optional(),
  contentType: z.string().min(1).max(200).optional(),
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

export async function POST(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    await recordApiLog({
      userId: user.id,
      level: "warn",
      category: "storage.presign",
      code: "invalid_request",
      message: "存储预签名参数无效",
    })
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  const env = getAppEnv()
  if (!env.blobReadWriteToken) {
    await recordApiLog({
      userId: user.id,
      projectId: parsed.data.projectId ?? null,
      level: "error",
      category: "storage.presign",
      code: "storage_unconfigured",
      message: "对象存储未配置导致预签名失败",
    })
    await createApiAlert({
      userId: user.id,
      projectId: parsed.data.projectId ?? null,
      alertType: "storage_failed",
      severity: "critical",
      message: "对象存储未配置，无法生成预签名 URL",
      details: { route: "/api/v1/storage/presign" },
    })
    return NextResponse.json({ message: "对象存储未配置" }, { status: 400 })
  }

  try {
    const input = parsed.data
    if (input.scope === "project") {
      if (!input.projectId) {
        return NextResponse.json({ message: "projectId 不能为空" }, { status: 400 })
      }
      await assertProjectAccess(user.id, input.projectId)
    }

    const key =
      input.scope === "project"
        ? getProjectObjectKey(input.projectId!, input.path)
        : getUserObjectKey(user.id, input.path)

    if (input.op === "put") {
      return NextResponse.json({ message: "请改用 /api/v1/storage/artifacts/upload 上传文件" }, { status: 400 })
    }
    const object = await head(key, { token: env.blobReadWriteToken }).catch(() => null)
    if (!object) {
      throw new Error("对象不存在")
    }

    return NextResponse.json({
      scope: input.scope,
      key,
      url: object.url,
      method: "GET",
      headers: {},
    })
  } catch (error) {
    await recordApiLog({
      userId: user.id,
      projectId: parsed.data.projectId ?? null,
      level: "error",
      category: "storage.presign",
      code: "storage_failed",
      message: "生成预签名 URL 失败",
      details: { error: error instanceof Error ? error.message : String(error) },
    })
    await createApiAlert({
      userId: user.id,
      projectId: parsed.data.projectId ?? null,
      alertType: "storage_failed",
      severity: "critical",
      message: "生成预签名 URL 失败",
      details: { route: "/api/v1/storage/presign", error: error instanceof Error ? error.message : String(error) },
    })
    return NextResponse.json({ message: error instanceof Error ? error.message : "操作失败" }, { status: 400 })
  }
}
