-- M5-09 references: a second location for the same Task without duplicating content.
CREATE TABLE `task_references` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_user_id` text NOT NULL REFERENCES `users`(`id`),
  `source_task_id` text NOT NULL REFERENCES `tasks`(`id`),
  `target_task_id` text NOT NULL REFERENCES `tasks`(`id`),
  `sort_key` text NOT NULL DEFAULT '0000000000000000' CHECK (length(`sort_key`) > 0),
  `version` integer NOT NULL DEFAULT 1 CHECK (`version` > 0),
  `removed_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CHECK (`source_task_id` <> `target_task_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_references_active_pair_uq` ON `task_references` (`source_task_id`, `target_task_id`) WHERE `removed_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `task_references_source_idx` ON `task_references` (`owner_user_id`, `source_task_id`, `removed_at`, `sort_key`, `id`);
--> statement-breakpoint
CREATE INDEX `task_references_target_idx` ON `task_references` (`owner_user_id`, `target_task_id`, `removed_at`, `sort_key`, `id`);
--> statement-breakpoint
CREATE TRIGGER `task_references_owner_insert` BEFORE INSERT ON `task_references`
WHEN NOT EXISTS (
  SELECT 1 FROM tasks s JOIN tasks t ON t.owner_user_id=s.owner_user_id
  WHERE s.id=NEW.source_task_id AND t.id=NEW.target_task_id AND s.owner_user_id=NEW.owner_user_id
)
BEGIN SELECT RAISE(ABORT,'task_reference_owner_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER `task_references_owner_update` BEFORE UPDATE OF owner_user_id,source_task_id,target_task_id ON `task_references`
WHEN NOT EXISTS (
  SELECT 1 FROM tasks s JOIN tasks t ON t.owner_user_id=s.owner_user_id
  WHERE s.id=NEW.source_task_id AND t.id=NEW.target_task_id AND s.owner_user_id=NEW.owner_user_id
)
BEGIN SELECT RAISE(ABORT,'task_reference_owner_mismatch'); END;
