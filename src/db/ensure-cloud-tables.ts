import { sql } from "drizzle-orm";
import { db } from "@/db";

let ensured = false;

export async function ensureCloudTables() {
  if (ensured) {
    return;
  }

  await db
    .execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`)
    .catch(() => null);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS api_session_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
      session_id text NOT NULL,
      role text NOT NULL,
      content text NOT NULL,
      event_type text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_session_events_user_session_time
    ON api_session_events(user_id, session_id, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_session_events_project_session_time
    ON api_session_events(project_id, session_id, created_at)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS memory_files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_key text NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
      scope text NOT NULL,
      path text NOT NULL,
      etag text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      size integer NOT NULL DEFAULT 0,
      tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_memory_files_owner_path
    ON memory_files(owner_key, path)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_memory_files_owner_updated
    ON memory_files(owner_key, updated_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_memory_files_project
    ON memory_files(project_id)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS async_tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
      type text NOT NULL,
      status task_status NOT NULL DEFAULT 'pending',
      correlation_id text NOT NULL,
      idempotency_key text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      result jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_async_tasks_user_idempotency
    ON async_tasks(user_id, idempotency_key)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_async_tasks_user_time
    ON async_tasks(user_id, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_async_tasks_correlation
    ON async_tasks(correlation_id)
  `);

  ensured = true;
}

