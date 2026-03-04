import { NextResponse } from "next/server"
import { and, desc, eq, gte, lte } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { apiEvents } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"
import { queryApiAlerts, queryApiLogs } from "@/lib/api-observability"

export const runtime = "nodejs"

const logLevelSchema = z.enum(["debug", "info", "warn", "error"])
const alertStatusSchema = z.enum(["open", "resolved"])
const alertSeveritySchema = z.enum(["warning", "critical"])

function parsePositiveInt(value: string | null, fallback: number) {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

function parseOptionalId(value: string | null) {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

function inferEventLevel(type: string): "info" | "warn" | "error" {
  const normalized = type.toLowerCase()
  if (normalized.endsWith(".failed") || normalized.includes(".error")) return "error"
  if (normalized.includes(".warning") || normalized.endsWith(".retry")) return "warn"
  return "info"
}

export async function GET(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const scope = (searchParams.get("scope") || "all").trim().toLowerCase()
  const projectId = parseOptionalId(searchParams.get("projectId"))
  const traceId = parseOptionalId(searchParams.get("traceId"))
  const correlationId = parseOptionalId(searchParams.get("correlationId"))
  const fromTime = parsePositiveInt(searchParams.get("fromTime"), 0)
  const toTime = parsePositiveInt(searchParams.get("toTime"), Date.now())
  const limit = parsePositiveInt(searchParams.get("limit"), 100)
  const parsedLevel = logLevelSchema.safeParse(searchParams.get("level"))
  const parsedStatus = alertStatusSchema.safeParse(searchParams.get("status"))
  const parsedSeverity = alertSeveritySchema.safeParse(searchParams.get("severity"))
  if (searchParams.get("level") && !parsedLevel.success) {
    return NextResponse.json({ message: "level 参数无效" }, { status: 400 })
  }
  if (searchParams.get("status") && !parsedStatus.success) {
    return NextResponse.json({ message: "status 参数无效" }, { status: 400 })
  }
  if (searchParams.get("severity") && !parsedSeverity.success) {
    return NextResponse.json({ message: "severity 参数无效" }, { status: 400 })
  }

  const includeLogs = scope === "all" || scope === "logs"
  const includeAlerts = scope === "all" || scope === "alerts"
  const includeEvents = scope === "all" || scope === "events"
  if (!includeLogs && !includeAlerts && !includeEvents) {
    return NextResponse.json({ message: "scope 参数无效" }, { status: 400 })
  }

  const [logs, alerts, events] = await Promise.all([
    includeLogs
      ? queryApiLogs({
          userId: user.id,
          projectId,
          level: parsedLevel.success ? parsedLevel.data : undefined,
          traceId,
          correlationId,
          fromTime,
          toTime,
          limit,
        })
      : Promise.resolve([]),
    includeAlerts
      ? queryApiAlerts({
          userId: user.id,
          projectId,
          status: parsedStatus.success ? parsedStatus.data : undefined,
          severity: parsedSeverity.success ? parsedSeverity.data : undefined,
          traceId,
          limit,
        })
      : Promise.resolve([]),
    includeEvents
      ? db
          .select({
            id: apiEvents.id,
            type: apiEvents.type,
            source: apiEvents.source,
            data: apiEvents.data,
            correlationId: apiEvents.correlationId,
            causationId: apiEvents.causationId,
            traceId: apiEvents.traceId,
            spanId: apiEvents.spanId,
            projectId: apiEvents.projectId,
            createdAt: apiEvents.createdAt,
          })
          .from(apiEvents)
          .where(
            and(
              eq(apiEvents.userId, user.id),
              gte(apiEvents.createdAt, new Date(fromTime)),
              lte(apiEvents.createdAt, new Date(toTime)),
              projectId ? eq(apiEvents.projectId, projectId) : undefined,
              traceId ? eq(apiEvents.traceId, traceId) : undefined,
              correlationId ? eq(apiEvents.correlationId, correlationId) : undefined
            )
          )
          .orderBy(desc(apiEvents.createdAt))
          .limit(Math.min(limit, 500))
      : Promise.resolve([]),
  ])

  return NextResponse.json({
    logs: logs.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
    })),
    alerts: alerts.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })),
    events: events.map((item) => ({
      ...item,
      level: inferEventLevel(item.type),
      createdAt: item.createdAt.toISOString(),
    })),
  })
}
