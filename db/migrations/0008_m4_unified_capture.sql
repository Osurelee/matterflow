-- M4-07 unified capture provenance and atomic batch records.
ALTER TABLE `tasks` ADD COLUMN `source_url` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `source_label` text;
--> statement-breakpoint
CREATE TABLE `capture_batches` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_user_id` text NOT NULL REFERENCES `users`(`id`),
  `request_id` text NOT NULL,
  `payload_hash` text NOT NULL,
  `response_json` text NOT NULL,
  `created_at` text NOT NULL,
  UNIQUE (`owner_user_id`,`request_id`)
);
--> statement-breakpoint
CREATE INDEX `capture_batches_owner_created_idx` ON `capture_batches` (`owner_user_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `capture_batch_items` (
  `id` text PRIMARY KEY NOT NULL,
  `batch_id` text NOT NULL REFERENCES `capture_batches`(`id`),
  `owner_user_id` text NOT NULL REFERENCES `users`(`id`),
  `sequence` integer NOT NULL,
  `task_id` text NOT NULL REFERENCES `tasks`(`id`),
  `title` text NOT NULL,
  UNIQUE (`batch_id`,`sequence`),
  UNIQUE (`batch_id`,`task_id`),
  CONSTRAINT `capture_batch_items_sequence_ck` CHECK (`sequence` >= 0)
);
--> statement-breakpoint
CREATE INDEX `capture_batch_items_task_idx` ON `capture_batch_items` (`task_id`);
--> statement-breakpoint
CREATE TRIGGER `capture_batch_items_owner_insert` BEFORE INSERT ON `capture_batch_items` BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM capture_batches b JOIN tasks t ON t.id=NEW.task_id WHERE b.id=NEW.batch_id AND b.owner_user_id=NEW.owner_user_id AND t.owner_user_id=NEW.owner_user_id) THEN RAISE(ABORT,'capture_batch_owner_mismatch') END;
END;
