import { NextResponse } from "next/server"
import { z } from "zod"
import { and, eq } from "drizzle-orm"
import { db } from "@/db"
import { projects } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"
import { getAppEnv } from "@/lib/env"
import { getProjectObjectKey, getUserObjectKey } from "@/lib/storage-keys"
import { presignS3Url } from "@/lib/s3-presign"

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

function buildBaseUrl(endpoint: string) {
  const trimmed = endpoint.trim()
  if (!trimmed) {
    throw new Error("TOS_ENDPOINT 未配置")
  }
  const withScheme = trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`
  return new URL(withScheme)
}

export async function POST(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  const env = getAppEnv()
  if (!env.tosEndpoint || !env.tosBucket || !env.tosAccessKey || !env.tosSecretKey || !env.tosRegion) {
    return NextResponse.json({ message: "对象存储未配置" }, { status: 400 })
  }

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

  const baseUrl = buildBaseUrl(env.tosEndpoint)
  const objectUrl = new URL(`${baseUrl.origin}/${env.tosBucket}/${key}`)

  const result = presignS3Url({
    method: input.op === "put" ? "PUT" : "GET",
    url: objectUrl,
    accessKeyId: env.tosAccessKey,
    secretAccessKey: env.tosSecretKey,
    region: env.tosRegion,
    expiresInSeconds: input.expiresInSeconds ?? 900,
    contentType: input.contentType,
  })

  return NextResponse.json({
    scope: input.scope,
    key,
    ...result,
  })
}
