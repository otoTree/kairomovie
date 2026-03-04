import { createHash } from "crypto"
import { and, desc, eq, gte, lte } from "drizzle-orm"
import { db } from "@/db"
import { ensureCloudTables } from "@/db/ensure-cloud-tables"
import { apiAlerts, apiLogs } from "@/db/schema"

export type ApiLogLevel = "debug" | "info" | "warn" | "error"

type CreateApiLogInput = {
  userId?: string | null
  projectId?: string | null
  level: ApiLogLevel
  category: string
  message: string
  code?: string
  details?: Record<string, unknown>
  correlationId?: string | null
  traceId?: string | null
  spanId?: string | null
}

type CreateApiAlertInput = {
  userId?: string | null
  projectId?: string | null
  alertType: string
  severity: "warning" | "critical"
  message: string
  details?: Record<string, unknown>
  correlationId?: string | null
  traceId?: string | null
  spanId?: string | null
}

export async function recordApiLog(input: CreateApiLogInput) {
  await ensureCloudTables()
  await db.insert(apiLogs).values({
    userId: input.userId ?? null,
    projectId: input.projectId ?? null,
    level: input.level,
    category: input.category,
    message: input.message,
    code: input.code ?? null,
    details: input.details ?? {},
    correlationId: input.correlationId ?? null,
    traceId: input.traceId ?? null,
    spanId: input.spanId ?? null,
  })
}

export async function createApiAlert(input: CreateApiAlertInput) {
  await ensureCloudTables()
  const fingerprintSeed = [
    input.alertType,
    input.userId ?? "",
    input.projectId ?? "",
    input.correlationId ?? "",
    input.message,
  ].join("|")
  const fingerprint = createHash("sha256").update(fingerprintSeed).digest("hex")
  const now = new Date()
  const [saved] = await db
    .insert(apiAlerts)
    .values({
      userId: input.userId ?? null,
      projectId: input.projectId ?? null,
      alertType: input.alertType,
      severity: input.severity,
      message: input.message,
      status: "open",
      fingerprint,
      details: input.details ?? {},
      correlationId: input.correlationId ?? null,
      traceId: input.traceId ?? null,
      spanId: input.spanId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [apiAlerts.fingerprint],
      set: {
        severity: input.severity,
        message: input.message,
        details: input.details ?? {},
        correlationId: input.correlationId ?? null,
        traceId: input.traceId ?? null,
        spanId: input.spanId ?? null,
        status: "open",
        updatedAt: now,
      },
    })
    .returning({
      id: apiAlerts.id,
      alertType: apiAlerts.alertType,
      severity: apiAlerts.severity,
      status: apiAlerts.status,
      message: apiAlerts.message,
      fingerprint: apiAlerts.fingerprint,
      details: apiAlerts.details,
      correlationId: apiAlerts.correlationId,
      traceId: apiAlerts.traceId,
      spanId: apiAlerts.spanId,
      createdAt: apiAlerts.createdAt,
      updatedAt: apiAlerts.updatedAt,
    })
  return saved
}

function parsePositiveInt(value: string | null, fallback: number) {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

export async function queryApiLogs(params: {
  userId: string
  projectId?: string
  level?: ApiLogLevel
  traceId?: string
  correlationId?: string
  fromTime?: number
  toTime?: number
  limit?: number
}) {
  await ensureCloudTables()
  const where = [
    eq(apiLogs.userId, params.userId),
    gte(apiLogs.createdAt, new Date(params.fromTime ?? 0)),
    lte(apiLogs.createdAt, new Date(params.toTime ?? Date.now())),
  ]
  if (params.projectId) where.push(eq(apiLogs.projectId, params.projectId))
  if (params.level) where.push(eq(apiLogs.level, params.level))
  if (params.traceId) where.push(eq(apiLogs.traceId, params.traceId))
  if (params.correlationId) where.push(eq(apiLogs.correlationId, params.correlationId))
  const rows = await db
    .select({
      id: apiLogs.id,
      level: apiLogs.level,
      category: apiLogs.category,
      message: apiLogs.message,
      code: apiLogs.code,
      details: apiLogs.details,
      projectId: apiLogs.projectId,
      correlationId: apiLogs.correlationId,
      traceId: apiLogs.traceId,
      spanId: apiLogs.spanId,
      createdAt: apiLogs.createdAt,
    })
    .from(apiLogs)
    .where(and(...where))
    .orderBy(desc(apiLogs.createdAt))
    .limit(Math.min(parsePositiveInt(String(params.limit ?? 100), 100), 500))
  return rows
}

export async function queryApiAlerts(params: {
  userId: string
  projectId?: string
  status?: "open" | "resolved"
  severity?: "warning" | "critical"
  traceId?: string
  limit?: number
}) {
  await ensureCloudTables()
  const where = [eq(apiAlerts.userId, params.userId)]
  if (params.projectId) where.push(eq(apiAlerts.projectId, params.projectId))
  if (params.status) where.push(eq(apiAlerts.status, params.status))
  if (params.severity) where.push(eq(apiAlerts.severity, params.severity))
  if (params.traceId) where.push(eq(apiAlerts.traceId, params.traceId))
  const rows = await db
    .select({
      id: apiAlerts.id,
      alertType: apiAlerts.alertType,
      severity: apiAlerts.severity,
      status: apiAlerts.status,
      message: apiAlerts.message,
      fingerprint: apiAlerts.fingerprint,
      details: apiAlerts.details,
      projectId: apiAlerts.projectId,
      correlationId: apiAlerts.correlationId,
      traceId: apiAlerts.traceId,
      spanId: apiAlerts.spanId,
      createdAt: apiAlerts.createdAt,
      updatedAt: apiAlerts.updatedAt,
    })
    .from(apiAlerts)
    .where(and(...where))
    .orderBy(desc(apiAlerts.createdAt))
    .limit(Math.min(parsePositiveInt(String(params.limit ?? 100), 100), 500))
  return rows
}
