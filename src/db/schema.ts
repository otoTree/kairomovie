import { sql } from 'drizzle-orm';
import { integer, pgEnum, pgTable, text, timestamp, uuid, jsonb, primaryKey, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const taskStatusEnum = pgEnum('task_status', ['pending', 'running', 'completed', 'failed']);

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const projectProviderConfigs = pgTable(
  'project_provider_configs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    config: jsonb('config').$type<unknown>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uniq_project_provider').on(table.projectId, table.provider),
    index('idx_project_provider_project').on(table.projectId),
  ]
);

export const apiEvents = pgTable(
  'api_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    source: text('source').notNull(),
    data: jsonb('data').$type<unknown>().notNull().default(sql`'{}'::jsonb`),
    correlationId: text('correlation_id').notNull(),
    causationId: text('causation_id'),
    traceId: text('trace_id'),
    spanId: text('span_id'),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uniq_api_events_user_idempotency').on(table.userId, table.idempotencyKey),
    index('idx_api_events_user_time').on(table.userId, table.createdAt),
    index('idx_api_events_project_time').on(table.projectId, table.createdAt),
    index('idx_api_events_type').on(table.type),
    index('idx_api_events_correlation').on(table.correlationId),
  ]
);

export const apiSessionEvents = pgTable(
  'api_session_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    eventType: text('event_type'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_api_session_events_user_session_time').on(table.userId, table.sessionId, table.createdAt),
    index('idx_api_session_events_project_session_time').on(table.projectId, table.sessionId, table.createdAt),
  ]
);

export const apiLogs = pgTable(
  'api_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    level: text('level').notNull(),
    category: text('category').notNull(),
    message: text('message').notNull(),
    code: text('code'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    correlationId: text('correlation_id'),
    traceId: text('trace_id'),
    spanId: text('span_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_api_logs_user_time').on(table.userId, table.createdAt),
    index('idx_api_logs_project_time').on(table.projectId, table.createdAt),
    index('idx_api_logs_level_time').on(table.level, table.createdAt),
    index('idx_api_logs_trace').on(table.traceId),
    index('idx_api_logs_correlation').on(table.correlationId),
  ]
);

export const apiAlerts = pgTable(
  'api_alerts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    alertType: text('alert_type').notNull(),
    severity: text('severity').notNull(),
    message: text('message').notNull(),
    status: text('status').notNull().default('open'),
    fingerprint: text('fingerprint').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    correlationId: text('correlation_id'),
    traceId: text('trace_id'),
    spanId: text('span_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uniq_api_alerts_fingerprint').on(table.fingerprint),
    index('idx_api_alerts_status_time').on(table.status, table.createdAt),
    index('idx_api_alerts_project_time').on(table.projectId, table.createdAt),
    index('idx_api_alerts_trace').on(table.traceId),
  ]
);

export const memoryFiles = pgTable(
  'memory_files',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerKey: text('owner_key').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    path: text('path').notNull(),
    etag: text('etag').notNull(),
    version: integer('version').notNull().default(1),
    size: integer('size').notNull().default(0),
    tags: jsonb('tags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uniq_memory_files_owner_path').on(table.ownerKey, table.path),
    index('idx_memory_files_owner_updated').on(table.ownerKey, table.updatedAt),
    index('idx_memory_files_project').on(table.projectId),
  ]
);

export const apiArtifacts = pgTable(
  'api_artifacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    provider: text('provider'),
    kind: text('kind'),
    objectKey: text('object_key').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type'),
    size: integer('size').notNull().default(0),
    status: text('status').notNull().default('pending'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uniq_api_artifacts_project_task_key').on(table.projectId, table.taskId, table.objectKey),
    index('idx_api_artifacts_user_time').on(table.userId, table.createdAt),
    index('idx_api_artifacts_project_time').on(table.projectId, table.createdAt),
    index('idx_api_artifacts_project_task').on(table.projectId, table.taskId),
  ]
);

export const asyncTasks = pgTable(
  'async_tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    status: taskStatusEnum('status').default('pending').notNull(),
    correlationId: text('correlation_id').notNull(),
    idempotencyKey: text('idempotency_key'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    result: jsonb('result').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uniq_async_tasks_user_idempotency').on(table.userId, table.idempotencyKey),
    index('idx_async_tasks_user_time').on(table.userId, table.createdAt),
    index('idx_async_tasks_correlation').on(table.correlationId),
  ]
);

export const agentTasks = pgTable('agent_tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  status: taskStatusEnum('status').default('pending').notNull(),
  inputPrompt: text('input_prompt').notNull(),
  resultSummary: text('result_summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const events = pgTable('events', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: uuid('task_id')
    .notNull()
    .references(() => agentTasks.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  source: text('source').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const systemState = pgTable(
  'system_state',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.key] })]
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
