import { createHmac, randomUUID, timingSafeEqual } from "crypto"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { apiEvents, projects } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"
import { getAppEnv } from "@/lib/env"
import { apiError, apiOk } from "@/lib/api-response"
import { buildStandardEvent, stableStringify } from "@/lib/event-spec"

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

  const secret = getAppEnv().kairoEventSigningSecret
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
    return apiError("未授权", "unauthorized", 401)
  }

  const rawBody = await request.text().catch(() => null)
  if (!rawBody) {
    return apiError("请求参数无效", "invalid_request", 400)
  }

  if (!verifyWebhookSignature(request.headers, rawBody)) {
    return apiError("签名校验失败", "signature_invalid", 401)
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
    return apiError("请求参数无效", "invalid_request", 400)
  }

  const projectId = parsed.data.projectId
  if (projectId) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, user.id)))
      .limit(1)
    if (!project) {
      return apiError("项目不存在或无权限", "not_found", 404)
    }
  }

  let standardEvent: ReturnType<typeof buildStandardEvent>
  try {
    standardEvent = buildStandardEvent({
      type: parsed.data.type,
      source: parsed.data.source || `api:user:${user.id}`,
      data: parsed.data.data,
      correlationId: parsed.data.correlationId || randomUUID(),
      causationId: parsed.data.causationId ?? null,
      traceId: parsed.data.traceId ?? null,
      spanId: parsed.data.spanId ?? null,
      idempotencyKey: parsed.data.idempotencyKey ?? null,
    })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "请求参数无效", "invalid_request", 400)
  }

  const values = {
    userId: user.id,
    projectId: projectId ?? null,
    type: standardEvent.type,
    source: standardEvent.source,
    data: standardEvent.data,
    correlationId: standardEvent.correlationId,
    causationId: standardEvent.causationId,
    traceId: standardEvent.traceId,
    spanId: standardEvent.spanId,
    idempotencyKey: standardEvent.idempotencyKey,
  } as const

  const insert = db
    .insert(apiEvents)
    .values(values)
    .returning({ eventId: apiEvents.id, correlationId: apiEvents.correlationId })

  const created =
    standardEvent.idempotencyKey
      ? await insert.onConflictDoNothing({ target: [apiEvents.userId, apiEvents.idempotencyKey] })
      : await insert

  if (created.length > 0) {
    return apiOk({
      status: "accepted",
      eventId: created[0].eventId,
      correlationId: created[0].correlationId,
    })
  }

  const [existing] = await db
    .select({
      eventId: apiEvents.id,
      correlationId: apiEvents.correlationId,
      type: apiEvents.type,
      source: apiEvents.source,
      data: apiEvents.data,
      projectId: apiEvents.projectId,
    })
    .from(apiEvents)
    .where(and(eq(apiEvents.userId, user.id), eq(apiEvents.idempotencyKey, standardEvent.idempotencyKey!)))
    .limit(1)

  if (!existing) {
    return apiError("事件写入失败", "internal_error", 500)
  }

  const matches =
    existing.projectId === (projectId ?? null) &&
    existing.type === values.type &&
    existing.source === values.source &&
    stableStringify(existing.data) === stableStringify(values.data)

  if (!matches) {
    return apiError("幂等键冲突", "conflict", 409)
  }

  return apiOk({
    status: "accepted",
    idempotency: "replayed",
    eventId: existing.eventId,
    correlationId: existing.correlationId,
  })
}
