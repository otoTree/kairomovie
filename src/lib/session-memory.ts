import { randomUUID } from "crypto"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { db } from "@/db"
import { apiEvents } from "@/db/schema"
import { ensureCloudTables } from "@/db/ensure-cloud-tables"

type SessionMemoryItem = {
  role: "user" | "assistant" | "system" | "event"
  content: string
  eventType?: string
  metadata?: Record<string, unknown>
}

let ensured = false

const SESSION_MEMORY_EVENT_TYPES = ["kairo.user.message", "kairo.agent.action", "kairo.session.event", "kairo.session.system"] as const

async function ensureTable() {
  if (ensured) {
    return
  }
  await ensureCloudTables()
  ensured = true
}

export async function appendSessionMemory(userId: string, sessionId: string, item: SessionMemoryItem) {
  await ensureTable()
  await db.execute(sql`
    INSERT INTO api_session_events (
      id, user_id, session_id, role, content, event_type, metadata
    ) VALUES (
      ${randomUUID()},
      ${userId},
      ${sessionId},
      ${item.role},
      ${item.content},
      ${item.eventType ?? null},
      ${JSON.stringify(item.metadata ?? {})}::jsonb
    )
  `)
}

export async function appendSessionMemoryEvent(
  userId: string,
  sessionId: string,
  item: SessionMemoryItem,
  context?: {
    correlationId?: string
    causationId?: string | null
    traceId?: string | null
    spanId?: string | null
  }
) {
  const finalType = item.eventType || "kairo.session.event"
  const correlationId = context?.correlationId || randomUUID()
  const traceId = context?.traceId || correlationId
  const spanId = context?.spanId || randomUUID()
  const created = await db
    .insert(apiEvents)
    .values({
      userId,
      projectId: null,
      type: finalType,
      source: `api:user:${userId}`,
      data: {
        sessionId,
        role: item.role,
        content: item.content,
        metadata: item.metadata ?? {},
      },
      correlationId,
      causationId: context?.causationId || null,
      traceId,
      spanId,
      idempotencyKey: null,
    })
    .returning({
      eventId: apiEvents.id,
      correlationId: apiEvents.correlationId,
      traceId: apiEvents.traceId,
      spanId: apiEvents.spanId,
    })
  return created[0]!
}

function extractTextFromApiEvent(type: string, data: unknown) {
  if (typeof data !== "object" || data === null) {
    return ""
  }
  const record = data as Record<string, unknown>
  if (type === "kairo.user.message") {
    const content = record.content ?? record.prompt
    return typeof content === "string" ? content : ""
  }
  if (type === "kairo.agent.action") {
    const action = record.action
    if (typeof action === "object" && action !== null) {
      const content = (action as Record<string, unknown>).content
      if (typeof content === "string") {
        return content
      }
    }
    const content = record.content
    return typeof content === "string" ? content : ""
  }
  const content = record.content
  return typeof content === "string" ? content : ""
}

function extractRoleFromApiEvent(type: string, data: unknown): SessionMemoryItem["role"] {
  if (type === "kairo.user.message") return "user"
  if (type === "kairo.agent.action") return "assistant"
  if (type === "kairo.session.system") return "system"
  if (typeof data === "object" && data !== null) {
    const role = (data as Record<string, unknown>).role
    if (role === "user" || role === "assistant" || role === "system" || role === "event") {
      return role
    }
  }
  return "event"
}

async function listRecentSessionMemoryFromApiEvents(userId: string, sessionId: string, limit = 20) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 20
  const rows = await db
    .select({
      type: apiEvents.type,
      data: apiEvents.data,
      createdAt: apiEvents.createdAt,
    })
    .from(apiEvents)
    .where(
      and(
        eq(apiEvents.userId, userId),
        inArray(apiEvents.type, SESSION_MEMORY_EVENT_TYPES as unknown as string[]),
        sql`${apiEvents.data} ->> 'sessionId' = ${sessionId}`
      )
    )
    .orderBy(desc(apiEvents.createdAt))
    .limit(safeLimit)

  return rows
    .reverse()
    .map((row) => ({
      role: extractRoleFromApiEvent(String(row.type), row.data),
      content: extractTextFromApiEvent(String(row.type), row.data),
      eventType: String(row.type),
      metadata: (typeof row.data === "object" && row.data !== null
        ? ((row.data as Record<string, unknown>).metadata as Record<string, unknown> | undefined)
        : undefined) ?? {},
      createdAt: row.createdAt ? String(row.createdAt) : "",
    }))
    .filter((item) => item.content.length > 0)
}

export async function listRecentSessionMemory(userId: string, sessionId: string, limit = 20) {
  const fromEvents = await listRecentSessionMemoryFromApiEvents(userId, sessionId, limit)
  if (fromEvents.length > 0) {
    return fromEvents
  }

  await ensureTable()
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20
  const result = await db.execute(sql`
    SELECT role, content, event_type, metadata, created_at
    FROM api_session_events
    WHERE user_id = ${userId} AND session_id = ${sessionId}
    ORDER BY created_at DESC
    LIMIT ${safeLimit}
  `)

  const rows = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []
  return rows.reverse().map((row) => ({
    role: String(row.role ?? "event"),
    content: String(row.content ?? ""),
    eventType: row.event_type ? String(row.event_type) : undefined,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    createdAt: row.created_at ? String(row.created_at) : "",
  }))
}
