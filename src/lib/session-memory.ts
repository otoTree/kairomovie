import { randomUUID } from "crypto"
import { and, desc, eq, sql } from "drizzle-orm"
import { db } from "@/db"
import { apiEvents } from "@/db/schema"
import { ensureCloudTables } from "@/db/ensure-cloud-tables"
import { getProjectObjectKey, getUserObjectKey } from "@/lib/storage-keys"
import { createStorageProvider } from "@/lib/storage-provider"

export type SessionMemoryItem = {
  role: "user" | "assistant" | "thought" | "system" | "event"
  content: string
  eventType?: string
  metadata?: Record<string, unknown>
  createdAt?: string
}

let ensured = false

async function ensureTable() {
  if (ensured) {
    return
  }
  await ensureCloudTables()
  ensured = true
}

export async function appendSessionMemory(userId: string, sessionId: string, item: SessionMemoryItem, projectId?: string | null) {
  await ensureTable()
  await db.execute(sql`
    INSERT INTO api_session_events (
      id, user_id, project_id, session_id, role, content, event_type, metadata
    ) VALUES (
      ${randomUUID()},
      ${userId},
      ${projectId ?? null},
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
    projectId?: string | null
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
      projectId: context?.projectId ?? null,
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
  const toText = (value: unknown) => {
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    if (value === null || value === undefined) return ""
    try {
      return JSON.stringify(value)
    } catch {
      return ""
    }
  }
  const extractActionMessage = (action: Record<string, unknown>) => {
    const candidates = [action.content, action.message, action.text, action.reply, action.response]
    for (const candidate of candidates) {
      const text = toText(candidate)
      if (text) return text
    }
    return ""
  }
  if (type === "kairo.user.message") {
    const content = record.content ?? record.prompt
    return typeof content === "string" ? content : ""
  }
  if (type === "kairo.agent.thought") {
    return toText(record.thought)
  }
  if (type === "kairo.agent.action") {
    const action = record.action
    if (typeof action === "object" && action !== null) {
      const actionRecord = action as Record<string, unknown>
      const actionType = toText(actionRecord.type)
      const content = extractActionMessage(actionRecord)
      if ((actionType === "say" || actionType === "query" || actionType === "speak" || actionType === "reply") && content) {
        return content
      }
      if (content && (!actionType || actionType === "message")) {
        return content
      }
      if (actionType) return `动作: ${actionType}`
    }
    const content = record.content
    return typeof content === "string" ? content : ""
  }
  if (type === "kairo.tool.result") {
    const error = toText(record.error)
    if (error) return `工具错误: ${error}`
    const result = toText(record.result)
    if (result) return `工具结果: ${result}`
    return ""
  }
  if (type === "kairo.intent.started") {
    const intent = toText(record.intent)
    return intent ? `开始处理: ${intent}` : ""
  }
  if (type === "kairo.intent.ended") {
    const error = toText(record.error)
    if (error) return `处理失败: ${error}`
    const result = toText(record.result)
    if (result) return `处理完成: ${result}`
    return "处理完成"
  }
  if (type === "kairo.session.context") {
    return ""
  }
  const content = record.content
  return toText(content)
}

function extractRoleFromApiEvent(type: string, data: unknown): SessionMemoryItem["role"] {
  if (type === "kairo.user.message") return "user"
  if (type === "kairo.agent.thought") return "thought"
  if (type === "kairo.agent.action") {
    if (typeof data === "object" && data !== null) {
      const action = (data as Record<string, unknown>).action
      if (typeof action === "object" && action !== null) {
        const actionType = (action as Record<string, unknown>).type
        if (actionType === "say" || actionType === "query" || actionType === "speak" || actionType === "reply") {
          return "assistant"
        }
        const actionRecord = action as Record<string, unknown>
        const hasMessage =
          typeof actionRecord.content === "string" ||
          typeof actionRecord.message === "string" ||
          typeof actionRecord.text === "string" ||
          typeof actionRecord.reply === "string" ||
          typeof actionRecord.response === "string"
        if (hasMessage && (actionType === undefined || actionType === null || actionType === "message")) {
          return "assistant"
        }
      }
    }
    return "event"
  }
  if (type === "kairo.session.system") return "system"
  if (typeof data === "object" && data !== null) {
    const role = (data as Record<string, unknown>).role
    if (role === "user" || role === "assistant" || role === "thought" || role === "system" || role === "event") {
      return role
    }
  }
  return "event"
}

function toSessionRole(value: unknown): SessionMemoryItem["role"] {
  if (value === "user" || value === "assistant" || value === "thought" || value === "system" || value === "event") {
    return value
  }
  return "event"
}

function toSafeSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "default"
}

function toSessionMemoryMarkdown(sessionId: string, items: SessionMemoryItem[]) {
  const lines: string[] = [`# 会话记忆`, ``, `- sessionId: ${sessionId}`, `- exportedAt: ${new Date().toISOString()}`, ``]
  for (const item of items) {
    const roleLabel = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : item.role
    const createdLine = item.createdAt ? ` (${item.createdAt})` : ""
    lines.push(`## ${roleLabel}${createdLine}`)
    lines.push("")
    lines.push(item.content || "")
    lines.push("")
  }
  return lines.join("\n")
}

async function listRecentSessionMemoryFromApiEvents(userId: string, sessionId: string, limit = 20, projectId?: string) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 20
  const where = [
    eq(apiEvents.userId, userId),
    sql`${apiEvents.data} ->> 'sessionId' = ${sessionId}`,
  ]
  if (projectId) {
    where.push(eq(apiEvents.projectId, projectId))
  }
  const rows = await db
    .select({
      type: apiEvents.type,
      data: apiEvents.data,
      createdAt: apiEvents.createdAt,
    })
    .from(apiEvents)
    .where(and(...where))
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

export async function listRecentSessionMemory(userId: string, sessionId: string, limit = 20, projectId?: string) {
  const fromEvents = await listRecentSessionMemoryFromApiEvents(userId, sessionId, limit, projectId)
  if (fromEvents.length > 0) {
    return fromEvents
  }

  await ensureTable()
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 20
  const result = projectId
    ? await db.execute(sql`
        SELECT role, content, event_type, metadata, created_at
        FROM api_session_events
        WHERE user_id = ${userId} AND project_id = ${projectId} AND session_id = ${sessionId}
        ORDER BY created_at DESC
        LIMIT ${safeLimit}
      `)
    : await db.execute(sql`
        SELECT role, content, event_type, metadata, created_at
        FROM api_session_events
        WHERE user_id = ${userId} AND session_id = ${sessionId}
        ORDER BY created_at DESC
        LIMIT ${safeLimit}
      `)

  const rows = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []
  return rows.reverse().map((row) => ({
    role: toSessionRole(row.role),
    content: String(row.content ?? ""),
    eventType: row.event_type ? String(row.event_type) : undefined,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    createdAt: row.created_at ? String(row.created_at) : "",
  }))
}

export async function listSessionSummaries(userId: string, params: { projectId?: string; canvasName?: string; limit?: number }) {
  const safeLimit = Number.isFinite(params.limit) && (params.limit ?? 0) > 0 ? Math.min(Math.floor(params.limit!), 100) : 20
  const hasProject = Boolean(params.projectId)
  const hasCanvas = Boolean(params.canvasName && params.canvasName.trim())
  const result = await db.execute(sql`
    SELECT
      data ->> 'sessionId' AS session_id,
      MAX(created_at) AS last_at,
      COUNT(*)::int AS message_count,
      (ARRAY_AGG(COALESCE(data ->> 'content', '') ORDER BY created_at DESC))[1] AS last_message
    FROM api_events
    WHERE user_id = ${userId}
      AND type IN ('kairo.user.message', 'kairo.agent.action')
      AND (${hasProject} = false OR project_id = ${params.projectId ?? null})
      AND (${hasCanvas} = false OR data -> 'metadata' ->> 'canvasName' = ${params.canvasName?.trim() ?? ""})
      AND COALESCE(data ->> 'sessionId', '') <> ''
    GROUP BY data ->> 'sessionId'
    ORDER BY MAX(created_at) DESC
    LIMIT ${safeLimit}
  `)
  const rows = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []
  return rows.map((row) => ({
    sessionId: String(row.session_id ?? ""),
    lastAt: row.last_at ? String(row.last_at) : "",
    messageCount: Number(row.message_count ?? 0),
    lastMessage: String(row.last_message ?? ""),
  }))
}

export async function syncSessionMemoryMarkdown(input: {
  userId: string
  sessionId: string
  projectId?: string
  canvasName?: string
  limit?: number
}) {
  const items = await listRecentSessionMemory(input.userId, input.sessionId, input.limit ?? 500, input.projectId)
  const markdown = toSessionMemoryMarkdown(input.sessionId, items)
  const storage = createStorageProvider()
  const canvasSegment = input.canvasName ? `${toSafeSegment(input.canvasName)}/` : ""
  const relativePath = `sessions/${canvasSegment}${toSafeSegment(input.sessionId)}.md`
  const key = input.projectId
    ? getProjectObjectKey(input.projectId, relativePath)
    : getUserObjectKey(input.userId, relativePath)
  await storage.put({
    key,
    body: markdown,
    contentType: "text/markdown; charset=utf-8",
  })
  const url = await storage.getUrl(key).catch(() => null)
  return {
    key,
    url: url?.url ?? "",
    count: items.length,
  }
}
