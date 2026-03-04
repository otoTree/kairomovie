CREATE TYPE "public"."task_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"input_prompt" text NOT NULL,
	"result_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"project_id" uuid,
	"alert_type" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"fingerprint" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" text,
	"trace_id" text,
	"span_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"provider" text,
	"kind" text,
	"object_key" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text,
	"size" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"causation_id" text,
	"trace_id" text,
	"span_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"project_id" uuid,
	"level" text NOT NULL,
	"category" text NOT NULL,
	"message" text NOT NULL,
	"code" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" text,
	"trace_id" text,
	"span_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_session_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"event_type" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "async_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"type" text NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"correlation_id" text NOT NULL,
	"idempotency_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"scope" text NOT NULL,
	"path" text NOT NULL,
	"etag" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_state" (
	"task_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_state_task_id_key_pk" PRIMARY KEY("task_id","key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_alerts" ADD CONSTRAINT "api_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_alerts" ADD CONSTRAINT "api_alerts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_artifacts" ADD CONSTRAINT "api_artifacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_artifacts" ADD CONSTRAINT "api_artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_events" ADD CONSTRAINT "api_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_events" ADD CONSTRAINT "api_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_logs" ADD CONSTRAINT "api_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_logs" ADD CONSTRAINT "api_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_session_events" ADD CONSTRAINT "api_session_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_session_events" ADD CONSTRAINT "api_session_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "async_tasks" ADD CONSTRAINT "async_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "async_tasks" ADD CONSTRAINT "async_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_files" ADD CONSTRAINT "memory_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_files" ADD CONSTRAINT "memory_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_provider_configs" ADD CONSTRAINT "project_provider_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_state" ADD CONSTRAINT "system_state_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_api_alerts_fingerprint" ON "api_alerts" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "idx_api_alerts_status_time" ON "api_alerts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_api_alerts_project_time" ON "api_alerts" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_api_alerts_trace" ON "api_alerts" USING btree ("trace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_api_artifacts_project_task_key" ON "api_artifacts" USING btree ("project_id","task_id","object_key");--> statement-breakpoint
CREATE INDEX "idx_api_artifacts_user_time" ON "api_artifacts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_api_artifacts_project_time" ON "api_artifacts" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_api_artifacts_project_task" ON "api_artifacts" USING btree ("project_id","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_api_events_user_idempotency" ON "api_events" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_api_events_user_time" ON "api_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_api_events_project_time" ON "api_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_api_events_type" ON "api_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_api_events_correlation" ON "api_events" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "idx_api_logs_user_time" ON "api_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_api_logs_project_time" ON "api_logs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_api_logs_level_time" ON "api_logs" USING btree ("level","created_at");--> statement-breakpoint
CREATE INDEX "idx_api_logs_trace" ON "api_logs" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "idx_api_logs_correlation" ON "api_logs" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "idx_api_session_events_user_session_time" ON "api_session_events" USING btree ("user_id","session_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_api_session_events_project_session_time" ON "api_session_events" USING btree ("project_id","session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_async_tasks_user_idempotency" ON "async_tasks" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_async_tasks_user_time" ON "async_tasks" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_async_tasks_correlation" ON "async_tasks" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_memory_files_owner_path" ON "memory_files" USING btree ("owner_key","path");--> statement-breakpoint
CREATE INDEX "idx_memory_files_owner_updated" ON "memory_files" USING btree ("owner_key","updated_at");--> statement-breakpoint
CREATE INDEX "idx_memory_files_project" ON "memory_files" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_provider" ON "project_provider_configs" USING btree ("project_id","provider");--> statement-breakpoint
CREATE INDEX "idx_project_provider_project" ON "project_provider_configs" USING btree ("project_id");