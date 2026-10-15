-- M5-04 atomic structure operation snapshots for subtree moves and soft delete/restore.
CREATE TABLE `structure_batches` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_user_id` text NOT NULL REFERENCES `users`(`id`),
  `operation` text NOT NULL CHECK (`operation` IN ('move','delete','restore','archive','unarchive')),
  `root_task_id` text NOT NULL REFERENCES `tasks`(`id`),
  `source_parent_id` text,
  `target_parent_id` text,
  `source_space_id` text NOT NULL REFERENCES `spaces`(`id`),
  `target_space_id` text,
  `created_at` text NOT NULL,
  `request_id` text NOT NULL,
  `summary_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `structure_batch_members` (
  `batch_id` text NOT NULL REFERENCES `structure_batches`(`id`),
  `task_id` text NOT NULL REFERENCES `tasks`(`id`),
  `depth` integer NOT NULL CHECK (`depth` >= 0),
  `old_parent_id` text,
  `old_space_id` text NOT NULL REFERENCES `spaces`(`id`),
  `old_project_id` text,
  `old_sort_key` text NOT NULL,
  `old_version` integer NOT NULL,
  `old_structure_version` integer NOT NULL,
  `old_archived_at` text,
  `old_deleted_at` text,
  `old_deletion_batch_id` text,
  PRIMARY KEY (`batch_id`, `task_id`)
);
--> statement-breakpoint
CREATE INDEX `structure_batches_owner_created_idx` ON `structure_batches` (`owner_user_id`, `created_at`, `id`);
--> statement-breakpoint
CREATE INDEX `structure_batches_root_idx` ON `structure_batches` (`root_task_id`, `created_at`, `id`);
--> statement-breakpoint
CREATE INDEX `structure_batch_members_task_idx` ON `structure_batch_members` (`task_id`, `batch_id`);
