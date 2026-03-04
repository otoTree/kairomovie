import { and, eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { put } from "@vercel/blob"
import { db } from "@/db"
import { apiArtifacts } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"
import { getAppEnv } from "@/lib/env"

export const runtime = "nodejs"

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
  const file = formData.get("file")

  if (typeof projectId !== "string" || !projectId.trim()) {
    return NextResponse.json({ message: "projectId 不能为空" }, { status: 400 })
  }
  if (typeof artifactId !== "string" || !artifactId.trim()) {
    return NextResponse.json({ message: "artifactId 不能为空" }, { status: 400 })
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ message: "file 不能为空" }, { status: 400 })
  }

  const env = getAppEnv()
  if (!env.blobReadWriteToken) {
    return NextResponse.json({ message: "对象存储未配置" }, { status: 400 })
  }

  const [artifact] = await db
    .select({
      id: apiArtifacts.id,
      objectKey: apiArtifacts.objectKey,
      metadata: apiArtifacts.metadata,
      mimeType: apiArtifacts.mimeType,
    })
    .from(apiArtifacts)
    .where(and(eq(apiArtifacts.id, artifactId), eq(apiArtifacts.projectId, projectId), eq(apiArtifacts.userId, user.id)))
    .limit(1)

  if (!artifact) {
    return NextResponse.json({ message: "文件不存在或无权限" }, { status: 404 })
  }

  const uploaded = await put(artifact.objectKey, file, {
    token: env.blobReadWriteToken,
    access: "public",
    addRandomSuffix: false,
    contentType: file.type || artifact.mimeType || "application/octet-stream",
  })

  const currentMetadata =
    artifact.metadata && typeof artifact.metadata === "object" && !Array.isArray(artifact.metadata)
      ? (artifact.metadata as Record<string, unknown>)
      : {}
  const mergedMetadata = {
    ...currentMetadata,
    blobUrl: uploaded.url,
  }

  await db
    .update(apiArtifacts)
    .set({
      metadata: mergedMetadata,
      updatedAt: new Date(),
    })
    .where(and(eq(apiArtifacts.id, artifactId), eq(apiArtifacts.projectId, projectId), eq(apiArtifacts.userId, user.id)))

  return NextResponse.json({ ok: true })
}
