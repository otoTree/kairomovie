import { createHmac, randomUUID, timingSafeEqual } from "crypto"
import { and, eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/db"
import { apiEvents, projects } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"

export const runtime = "nodejs"

const publishSchema = z.object({
  projectId: z.string().min(1).max(128).optional(),
  type: z.string().min(1).max(256),
  source: z.string().min(1).max(256).optional(),
  data: z.unknown(),
  correlationId: z.string().min(1).max(128).optional(),
  causationId: z.string().min(1).max(128).optional(),
  traceId: z.string().min(1).max(128).optional(),
  spanId: z.string().min(1).max(128).optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
})

function getHeader(headers: Headers, name: string) {
  const value = headers.get(name)
  return value?.trim() || null
}

function verifyWebhookSignature(headers: Headers, rawBody: string): boolean {
  const signatureHeader = getHeader(headers, "x-kairo-signature")
  if (!signatureHeader) {
    return true
  }

  const secret = process.env.KAIRO_EVENT_SIGNING_SECRET
  if (!secret) {
    return false
  }

  const tsValue = getHeader(headers, "x-kairo-timestamp")
  if (!tsValue) {
    return false
  }

  const ts = Number(tsValue)
  if (!Number.isFinite(ts) || ts <= 0) {
    return false
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSeconds - ts) > 300) {
    return false
  }

  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex")
  const provided = signatureHeader.startsWith("sha256=") ? signatureHeader.slice("sha256=".length) : signatureHeader
  if (!/^[0-9a-fA-F]{64}$/.test(provided)) {
    return false
  }
  const expectedBuffer = Buffer.from(expected, "hex")
  const providedBuffer = Buffer.from(provided, "hex")
  if (expectedBuffer.length !== providedBuffer.length) {
    return false
  }
  return timingSafeEqual(expectedBuffer, providedBuffer)
}

export async function POST(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const rawBody = await request.text().catch(() => null)
  if (!rawBody) {
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  if (!verifyWebhookSignature(request.headers, rawBody)) {
    return NextResponse.json({ message: "签名校验失败" }, { status: 401 })
  }

  const body = (() => {
    try {
      return JSON.parse(rawBody)
    } catch {
      return null
    }
  })()
  const parsed = publishSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ message: "请求参数无效" }, { status: 400 })
  }

  const projectId = parsed.data.projectId
  if (projectId) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, user.id)))
      .limit(1)
    if (!project) {
      return NextResponse.json({ message: "项目不存在或无权限" }, { status: 404 })
    }
  }

  const correlationId = parsed.data.correlationId || randomUUID()

  const values = {
    userId: user.id,
    projectId: projectId ?? null,
    type: parsed.data.type,
    source: parsed.data.source || `api:user:${user.id}`,
    data: parsed.data.data,
    correlationId,
    causationId: parsed.data.causationId ?? null,
    traceId: parsed.data.traceId ?? null,
    spanId: parsed.data.spanId ?? null,
    idempotencyKey: parsed.data.idempotencyKey ?? null,
  } as const

  const insert = db
    .insert(apiEvents)
    .values(values)
    .returning({ eventId: apiEvents.id, correlationId: apiEvents.correlationId })

  const created =
    parsed.data.idempotencyKey
      ? await insert.onConflictDoNothing({ target: [apiEvents.userId, apiEvents.idempotencyKey] })
      : await insert

  if (created.length > 0) {
    return NextResponse.json({
      status: "accepted",
      eventId: created[0].eventId,
      correlationId: created[0].correlationId,
    })
  }

  const [existing] = await db
    .select({ eventId: apiEvents.id, correlationId: apiEvents.correlationId })
    .from(apiEvents)
    .where(and(eq(apiEvents.userId, user.id), eq(apiEvents.idempotencyKey, parsed.data.idempotencyKey!)))
    .limit(1)

  if (!existing) {
    return NextResponse.json({ message: "事件写入失败" }, { status: 500 })
  }

  return NextResponse.json({
    status: "accepted",
    eventId: existing.eventId,
    correlationId: existing.correlationId,
  })
}
