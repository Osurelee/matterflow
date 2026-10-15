CREATE TABLE `auth_rate_limits` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`window_start` text NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`blocked_until` text
);
--> statement-breakpoint
CREATE INDEX `auth_rate_limits_window_idx` ON `auth_rate_limits` (`window_start`);--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`artifact_name` text,
	`checksum` text,
	`error_code` text,
	`local_status` text,
	`remote_status` text,
	`local_verified_at` text,
	`remote_verified_at` text,
	`remote_object_id` text,
	CONSTRAINT "backup_runs_status_ck" CHECK("backup_runs"."status" IN ('running','success','failed')),
	CONSTRAINT "backup_runs_remote_status_ck" CHECK("backup_runs"."remote_status" IS NULL OR "backup_runs"."remote_status" IN ('unverified','verified','failed'))
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`inactive_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contacts_owner_idx` ON `contacts` (`owner_user_id`,`name`);--> statement-breakpoint
CREATE TABLE `delegations` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`delegated_by` text NOT NULL,
	`contact_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`end_reason` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delegated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delegations_task_active_uq` ON `delegations` (`task_id`) WHERE "delegations"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX `delegations_task_idx` ON `delegations` (`task_id`);--> statement-breakpoint
CREATE TABLE `mutation_requests` (
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mutation_requests_user_request_uq` ON `mutation_requests` (`user_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`space_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`archived_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_space_name_uq` ON `projects` (`space_id`,`name`);--> statement-breakpoint
CREATE INDEX `projects_owner_idx` ON `projects` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`auth_version` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`archived_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_owner_name_uq` ON `spaces` (`owner_user_id`,`name`);--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`occurred_at` text NOT NULL,
	`request_id` text,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_events_type_ck" CHECK("task_events"."type" IN ('task_created','task_updated','task_transitioned','task_processed_marked','task_delegated','task_delegation_changed','task_delegation_ended','task_recall_requested','task_archived','task_unarchived','task_deleted','task_restored','task_progress_appended'))
);
--> statement-breakpoint
CREATE INDEX `task_events_task_occurred_idx` ON `task_events` (`task_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `task_events_owner_idx` ON `task_events` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`space_id` text NOT NULL,
	`project_id` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'none' NOT NULL,
	`next_action` text DEFAULT '' NOT NULL,
	`result_note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`is_processed` integer DEFAULT false NOT NULL,
	`is_watched` integer DEFAULT false NOT NULL,
	`responsible_kind` text DEFAULT 'self' NOT NULL,
	`responsible_contact_id` text,
	`action_kind` text DEFAULT 'self' NOT NULL,
	`action_contact_id` text,
	`planned_date` text,
	`due_date` text,
	`follow_up_date` text,
	`waiting_reason` text DEFAULT '' NOT NULL,
	`blocked_reason` text DEFAULT '' NOT NULL,
	`cancellation_reason` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`cancelled_at` text,
	`archived_at` text,
	`deleted_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`responsible_contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`action_contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_status_ck" CHECK("tasks"."status" IN ('todo','in_progress','waiting','done','cancelled')),
	CONSTRAINT "tasks_priority_ck" CHECK("tasks"."priority" IN ('none','low','medium','high')),
	CONSTRAINT "tasks_responsible_kind_ck" CHECK("tasks"."responsible_kind" IN ('self','contact')),
	CONSTRAINT "tasks_action_kind_ck" CHECK("tasks"."action_kind" IN ('self','contact','none')),
	CONSTRAINT "tasks_responsible_contact_ck" CHECK(("tasks"."responsible_kind" = 'contact' AND "tasks"."responsible_contact_id" IS NOT NULL) OR ("tasks"."responsible_kind" = 'self' AND "tasks"."responsible_contact_id" IS NULL)),
	CONSTRAINT "tasks_action_contact_ck" CHECK(("tasks"."action_kind" = 'contact' AND "tasks"."action_contact_id" IS NOT NULL) OR ("tasks"."action_kind" != 'contact' AND "tasks"."action_contact_id" IS NULL)),
	CONSTRAINT "tasks_done_ts_ck" CHECK(("tasks"."status" = 'done' AND "tasks"."completed_at" IS NOT NULL AND "tasks"."cancelled_at" IS NULL) OR ("tasks"."status" != 'done' AND "tasks"."completed_at" IS NULL)),
	CONSTRAINT "tasks_cancelled_ts_ck" CHECK(("tasks"."status" = 'cancelled' AND "tasks"."cancelled_at" IS NOT NULL AND "tasks"."completed_at" IS NULL) OR ("tasks"."status" != 'cancelled' AND "tasks"."cancelled_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `tasks_owner_status_idx` ON `tasks` (`owner_user_id`,`deleted_at`,`archived_at`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_owner_due_idx` ON `tasks` (`owner_user_id`,`due_date`);--> statement-breakpoint
CREATE INDEX `tasks_owner_followup_idx` ON `tasks` (`owner_user_id`,`follow_up_date`);--> statement-breakpoint
CREATE INDEX `tasks_owner_planned_idx` ON `tasks` (`owner_user_id`,`planned_date`);--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE INDEX `tasks_space_idx` ON `tasks` (`space_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Shanghai' NOT NULL,
	`auth_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_uq` ON `users` (`username`);