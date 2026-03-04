import { randomUUID } from "crypto"
import { sql } from "drizzle-orm"
import { db } from "@/db"

type SessionMemoryItem = {
  role: "user" | "assistant" | "system" | "event"
  content: string
  eventType?: string
  metadata?: Record<string, unknown>
}

let ensured = false

async function ensureTable() {
  if (ensured) {
    return
  }
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS api_session_events (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      session_id text NOT NULL,
      role text NOT NULL,
      content text NOT NULL,
      event_type text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_session_events_user_session_time
    ON api_session_events(user_id, session_id, created_at)
  `)
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

export async function listRecentSessionMemory(userId: string, sessionId: string, limit = 20) {
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
