import { and, eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client"
import { db } from "@/db"
import { apiArtifacts } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"
import { getAppEnv } from "@/lib/env"

export const runtime = "nodejs"

type UploadClientPayload = {
  projectId: string
  artifactId: string
}

type UploadTokenPayload = UploadClientPayload & {
  userId: string
}

function parseUploadClientPayload(raw: string | null): UploadClientPayload | null {
  if (!raw) {
    return null
  }
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== "object") {
    return null
  }
  const record = parsed as Record<string, unknown>
  const projectId = typeof record.projectId === "string" ? record.projectId.trim() : ""
  const artifactId = typeof record.artifactId === "string" ? record.artifactId.trim() : ""
  if (!projectId || !artifactId) {
    return null
  }
  return { projectId, artifactId }
}

function parseUploadTokenPayload(raw: string | null | undefined): UploadTokenPayload | null {
  if (!raw) {
    return null
  }
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== "object") {
    return null
  }
  const record = parsed as Record<string, unknown>
  const userId = typeof record.userId === "string" ? record.userId.trim() : ""
  const projectId = typeof record.projectId === "string" ? record.projectId.trim() : ""
  const artifactId = typeof record.artifactId === "string" ? record.artifactId.trim() : ""
  if (!userId || !projectId || !artifactId) {
    return null
  }
  return { userId, projectId, artifactId }
}

export async function POST(request: Request) {
  const env = getAppEnv()
  if (!env.blobReadWriteToken) {
    return NextResponse.json({ message: "对象存储未配置" }, { status: 400 })
  }

  const body = (await request.json().catch(() => null)) as HandleUploadBody | null
  if (!body) {
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  try {
    const jsonResponse = await handleUpload({
      token: env.blobReadWriteToken,
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
        if (!user) {
          throw new Error("未授权")
        }
        const payload = parseUploadClientPayload(clientPayload)
        if (!payload) {
          throw new Error("请求参数无效")
        }

        const [artifact] = await db
          .select({
            id: apiArtifacts.id,
            objectKey: apiArtifacts.objectKey,
            mimeType: apiArtifacts.mimeType,
          })
          .from(apiArtifacts)
          .where(
            and(
              eq(apiArtifacts.id, payload.artifactId),
              eq(apiArtifacts.projectId, payload.projectId),
              eq(apiArtifacts.userId, user.id)
            )
          )
          .limit(1)

        if (!artifact) {
          throw new Error("文件不存在或无权限")
        }
        if (pathname !== artifact.objectKey) {
          throw new Error("上传路径不匹配")
        }

        return {
          addRandomSuffix: false,
          allowOverwrite: true,
          maximumSizeInBytes: 1024 * 1024 * 1024,
          tokenPayload: JSON.stringify({
            userId: user.id,
            projectId: payload.projectId,
            artifactId: payload.artifactId,
          }),
          allowedContentTypes: artifact.mimeType ? [artifact.mimeType] : undefined,
        }
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const payload = parseUploadTokenPayload(tokenPayload)
        if (!payload) {
          throw new Error("上传回调参数无效")
        }

        const [artifact] = await db
          .select({
            id: apiArtifacts.id,
            metadata: apiArtifacts.metadata,
            mimeType: apiArtifacts.mimeType,
          })
          .from(apiArtifacts)
          .where(
            and(
              eq(apiArtifacts.id, payload.artifactId),
              eq(apiArtifacts.projectId, payload.projectId),
              eq(apiArtifacts.userId, payload.userId)
            )
          )
          .limit(1)

        if (!artifact) {
          throw new Error("文件不存在或无权限")
        }

        const currentMetadata =
          artifact.metadata && typeof artifact.metadata === "object" && !Array.isArray(artifact.metadata)
            ? (artifact.metadata as Record<string, unknown>)
            : {}
        const mergedMetadata = {
          ...currentMetadata,
          blobUrl: blob.url,
        }

        await db
          .update(apiArtifacts)
          .set({
            metadata: mergedMetadata,
            mimeType: blob.contentType || artifact.mimeType,
            status: "uploaded",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(apiArtifacts.id, payload.artifactId),
              eq(apiArtifacts.projectId, payload.projectId),
              eq(apiArtifacts.userId, payload.userId)
            )
          )
      },
    })

    return NextResponse.json(jsonResponse)
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "上传失败" }, { status: 400 })
  }
}
