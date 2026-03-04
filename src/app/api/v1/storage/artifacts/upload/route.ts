import { and, eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { db } from "@/db"
import { apiArtifacts } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"
import { getAppEnv } from "@/lib/env"

export const runtime = "nodejs"

function buildBaseUrl(endpoint: string) {
  const trimmed = endpoint.trim()
  if (!trimmed) {
    throw new Error("TOS_ENDPOINT 未配置")
  }
  const withScheme = trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`
  return new URL(withScheme)
}

function parseUploadHeaders(input: FormDataEntryValue | null) {
  if (typeof input !== "string" || !input.trim()) {
    return {}
  }
  const parsed = JSON.parse(input) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {}
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      headers[key] = value
    }
  }
  return headers
}

export async function POST(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const formData = await request.formData().catch(() => null)
  if (!formData) {
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  const projectId = formData.get("projectId")
  const artifactId = formData.get("artifactId")
  const uploadUrl = formData.get("uploadUrl")
  const uploadHeadersRaw = formData.get("uploadHeaders")
  const file = formData.get("file")

  if (typeof projectId !== "string" || !projectId.trim()) {
    return NextResponse.json({ message: "projectId 不能为空" }, { status: 400 })
  }
  if (typeof artifactId !== "string" || !artifactId.trim()) {
    return NextResponse.json({ message: "artifactId 不能为空" }, { status: 400 })
  }
  if (typeof uploadUrl !== "string" || !uploadUrl.trim()) {
    return NextResponse.json({ message: "uploadUrl 不能为空" }, { status: 400 })
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ message: "file 不能为空" }, { status: 400 })
  }

  const env = getAppEnv()
  if (!env.tosEndpoint || !env.tosBucket) {
    return NextResponse.json({ message: "对象存储未配置" }, { status: 400 })
  }

  const [artifact] = await db
    .select({
      id: apiArtifacts.id,
      objectKey: apiArtifacts.objectKey,
    })
    .from(apiArtifacts)
    .where(and(eq(apiArtifacts.id, artifactId), eq(apiArtifacts.projectId, projectId), eq(apiArtifacts.userId, user.id)))
    .limit(1)

  if (!artifact) {
    return NextResponse.json({ message: "文件不存在或无权限" }, { status: 404 })
  }

  let target: URL
  try {
    target = new URL(uploadUrl)
  } catch {
    return NextResponse.json({ message: "uploadUrl 非法" }, { status: 400 })
  }

  const tosBase = buildBaseUrl(env.tosEndpoint)
  if (target.protocol !== "https:" || target.host !== tosBase.host) {
    return NextResponse.json({ message: "uploadUrl 不受信任" }, { status: 400 })
  }

  const bucketPrefix = `/${env.tosBucket}/`
  if (!target.pathname.startsWith(bucketPrefix)) {
    return NextResponse.json({ message: "uploadUrl 与文件不匹配" }, { status: 400 })
  }
  const keyPath = target.pathname
    .slice(bucketPrefix.length)
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/")
  if (keyPath !== artifact.objectKey) {
    return NextResponse.json({ message: "uploadUrl 与文件不匹配" }, { status: 400 })
  }

  const uploadHeaders = parseUploadHeaders(uploadHeadersRaw)
  const body = Buffer.from(await file.arrayBuffer())
  const uploaded = await fetch(target, {
    method: "PUT",
    headers: uploadHeaders,
    body,
  })

  if (!uploaded.ok) {
    return NextResponse.json({ message: `对象存储上传失败(${uploaded.status})` }, { status: 400 })
  }

  return NextResponse.json({ ok: true })
}
