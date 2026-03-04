import { NextResponse } from "next/server"
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm"
import { db } from "@/db"
import { apiEvents } from "@/db/schema"
import { getAuthUserFromAuthorizationHeader } from "@/lib/api-auth"

export const runtime = "nodejs"

function parsePositiveInt(value: string | null, fallback: number) {
  if (!value) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.floor(parsed)
}

export async function GET(request: Request) {
  const user = await getAuthUserFromAuthorizationHeader(request.headers.get("authorization"))
  if (!user) {
    return NextResponse.json({ message: "未授权" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const correlationId = searchParams.get("correlationId") || undefined
  const projectId = searchParams.get("projectId") || undefined
  const fromTime = parsePositiveInt(searchParams.get("fromTime"), 0)
  const toTime = parsePositiveInt(searchParams.get("toTime"), Date.now())
  const limit = parsePositiveInt(searchParams.get("limit"), 100)
  const types = searchParams.getAll("type")
  const sources = searchParams.getAll("source")

  const where = [
    eq(apiEvents.userId, user.id),
    gte(apiEvents.createdAt, new Date(fromTime)),
    lte(apiEvents.createdAt, new Date(toTime)),
  ]
  if (correlationId) {
    where.push(eq(apiEvents.correlationId, correlationId))
  }
  if (projectId) {
    where.push(eq(apiEvents.projectId, projectId))
  }
  if (types.length > 0) {
    where.push(inArray(apiEvents.type, types))
  }
  if (sources.length > 0) {
    where.push(inArray(apiEvents.source, sources))
  }

  const events = await db
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
    .where(and(...where))
    .orderBy(desc(apiEvents.createdAt))
    .limit(Math.min(limit, 500))

  return NextResponse.json({
    items: events,
    count: events.length,
  })
}
