import { createHmac, timingSafeEqual } from "crypto"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { apiEvents, projects } from "@/db/schema"
import { getAppEnv } from "@/lib/env"
import { apiError, apiOk } from "@/lib/api-response"
import { buildStandardEvent, stableStringify } from "@/lib/event-spec"

export const runtime = "nodejs"

const schema = z.object({
  projectId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  status: z.enum(["started", "updated", "completed", "failed"]),
  provider: z.string().min(1).max(128),
  kind: z.string().min(1).max(64).optional(),
  progress: z.number().min(0).max(100).optional(),
  message: z.string().max(2000).optional(),
  result: z.unknown().optional(),
  error: z.string().max(8000).optional(),
  correlationId: z.string().min(1).max(128).optional(),
  causationId: z.string().min(1).max(128).optional(),
  traceId: z.string().min(1).max(128).optional(),
  spanId: z.string().min(1).max(128).optional(),
  idempotencyKey: z.string().min(1).max(256),
})

function getHeader(headers: Headers, name: string) {
  const value = headers.get(name)
  return value?.trim() || null
}

function verifyCallbackSignature(headers: Headers, rawBody: string): boolean {
  const signatureHeader = getHeader(headers, "x-kairo-signature")
  const tsValue = getHeader(headers, "x-kairo-timestamp")
  if (!signatureHeader || !tsValue) {
    return false
  }

  const secret = getAppEnv().kairoEventSigningSecret
  if (!secret) {
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

function verifyCallbackSource(headers: Headers): boolean {
  const allowlist = process.env.KAIRO_CALLBACK_SOURCES?.trim()
  if (!allowlist) {
    return true
  }
  const source = getHeader(headers, "x-kairo-source")
  if (!source) {
    return false
  }
  const allowed = allowlist
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return allowed.includes(source)
}

export async function POST(request: Request) {
  const rawBody = await request.text().catch(() => null)
  if (!rawBody) {
    return apiError("请求参数无效", "invalid_request", 400)
  }

  if (!verifyCallbackSignature(request.headers, rawBody)) {
    return apiError("签名校验失败", "signature_invalid", 401)
  }

  if (!verifyCallbackSource(request.headers)) {
    return apiError("来源不受信任", "forbidden", 401)
  }

  const body = (() => {
    try {
      return JSON.parse(rawBody)
    } catch {
      return null
    }
  })()
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return apiError("请求参数无效", "invalid_request", 400)
  }

  const { projectId } = parsed.data
  const [project] = await db
    .select({ id: projects.id, userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  if (!project) {
    return apiError("项目不存在", "not_found", 404)
  }

  const callbackSource = getHeader(request.headers, "x-kairo-source") || parsed.data.provider
  const type = `kairo.task.${parsed.data.status}`
  const source = `callback:${callbackSource}`

  let standardEvent: ReturnType<typeof buildStandardEvent>
  try {
    standardEvent = buildStandardEvent({
      type,
      source,
      data: {
        taskId: parsed.data.taskId,
        status: parsed.data.status,
        provider: parsed.data.provider,
        kind: parsed.data.kind,
        progress: parsed.data.progress,
        message: parsed.data.message,
        result: parsed.data.result,
        error: parsed.data.error,
        projectId: parsed.data.projectId,
      },
      correlationId: parsed.data.correlationId || parsed.data.taskId,
      causationId: parsed.data.causationId ?? null,
      traceId: parsed.data.traceId ?? null,
      spanId: parsed.data.spanId ?? null,
      idempotencyKey: parsed.data.idempotencyKey,
    })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : "请求参数无效", "invalid_request", 400)
  }

  const values = {
    userId: project.userId,
    projectId: project.id,
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

  const created = await insert.onConflictDoNothing({ target: [apiEvents.userId, apiEvents.idempotencyKey] })
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
    .where(and(eq(apiEvents.userId, project.userId), eq(apiEvents.idempotencyKey, standardEvent.idempotencyKey!)))
    .limit(1)

  if (!existing) {
    return apiError("事件写入失败", "internal_error", 500)
  }

  const matches =
    existing.projectId === project.id &&
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
