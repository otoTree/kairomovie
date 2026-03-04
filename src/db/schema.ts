import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid, jsonb, pgEnum, primaryKey, uniqueIndex, index } from 'drizzle-orm/pg-core';

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
