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
    CREATE TABLE IF NOT EXISTS api_artifacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id text NOT NULL,
      provider text,
      kind text,
      object_key text NOT NULL,
      file_name text NOT NULL,
      mime_type text,
      size integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'pending',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_api_artifacts_project_task_key
    ON api_artifacts(project_id, task_id, object_key)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_artifacts_user_time
    ON api_artifacts(user_id, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_artifacts_project_time
    ON api_artifacts(project_id, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_artifacts_project_task
    ON api_artifacts(project_id, task_id)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS api_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
      level text NOT NULL,
      category text NOT NULL,
      message text NOT NULL,
      code text,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      correlation_id text,
      trace_id text,
      span_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_logs_user_time
    ON api_logs(user_id, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_logs_project_time
    ON api_logs(project_id, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_logs_level_time
    ON api_logs(level, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_logs_trace
    ON api_logs(trace_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_logs_correlation
    ON api_logs(correlation_id)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS api_alerts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
      alert_type text NOT NULL,
      severity text NOT NULL,
      message text NOT NULL,
      status text NOT NULL DEFAULT 'open',
      fingerprint text NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      correlation_id text,
      trace_id text,
      span_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_api_alerts_fingerprint
    ON api_alerts(fingerprint)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_alerts_status_time
    ON api_alerts(status, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_alerts_project_time
    ON api_alerts(project_id, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_api_alerts_trace
    ON api_alerts(trace_id)
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
