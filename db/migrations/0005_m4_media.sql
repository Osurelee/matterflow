-- M4-05 private media staging and task attachment links. Never expose storage keys as paths.
CREATE TABLE `assets` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_user_id` text NOT NULL REFERENCES `users`(`id`),
  `upload_request_id` text NOT NULL,
  `original_name` text NOT NULL,
  `mime_type` text NOT NULL,
  `byte_size` integer NOT NULL,
  `sha256` text NOT NULL,
  `storage_key` text NOT NULL UNIQUE,
  `status` text NOT NULL DEFAULT 'ready',
  `created_at` text NOT NULL,
  `removed_at` text,
  CONSTRAINT `assets_size_ck` CHECK (`byte_size` > 0 AND `byte_size` <= 26214400),
  CONSTRAINT `assets_status_ck` CHECK (`status` IN ('ready','failed')),
  UNIQUE (`owner_user_id`,`upload_request_id`)
);
--> statement-breakpoint
CREATE INDEX `assets_owner_status_idx` ON `assets` (`owner_user_id`,`status`);
--> statement-breakpoint
CREATE TABLE `task_asset_links` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_user_id` text NOT NULL REFERENCES `users`(`id`),
  `task_id` text NOT NULL REFERENCES `tasks`(`id`),
  `asset_id` text NOT NULL REFERENCES `assets`(`id`),
  `role` text NOT NULL DEFAULT 'attachment',
  `created_at` text NOT NULL,
  `removed_at` text,
  CONSTRAINT `task_asset_links_role_ck` CHECK (`role` IN ('attachment','body','progress')),
  UNIQUE (`task_id`,`asset_id`,`role`)
);
--> statement-breakpoint
CREATE INDEX `task_asset_links_task_idx` ON `task_asset_links` (`task_id`,`removed_at`);
--> statement-breakpoint
CREATE INDEX `task_asset_links_asset_idx` ON `task_asset_links` (`asset_id`,`removed_at`);
--> statement-breakpoint
CREATE TRIGGER `task_asset_links_owner_insert` BEFORE INSERT ON `task_asset_links` BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tasks t JOIN assets a ON a.owner_user_id=t.owner_user_id WHERE t.id=NEW.task_id AND t.owner_user_id=NEW.owner_user_id AND a.id=NEW.asset_id AND a.owner_user_id=NEW.owner_user_id AND a.status='ready') THEN RAISE(ABORT,'task_asset_links_owner_mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER `task_asset_links_immutable_owner` BEFORE UPDATE OF owner_user_id,task_id,asset_id ON `task_asset_links` BEGIN
  SELECT RAISE(ABORT,'task_asset_links_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `assets_immutable_storage` BEFORE UPDATE OF owner_user_id,storage_key,byte_size,sha256,mime_type ON `assets` BEGIN
  SELECT RAISE(ABORT,'assets_storage_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `assets_no_delete` BEFORE DELETE ON `assets` BEGIN
  SELECT RAISE(ABORT,'assets_are_retained');
END;
--> statement-breakpoint
CREATE TRIGGER `task_asset_links_no_delete` BEFORE DELETE ON `task_asset_links` BEGIN
  SELECT RAISE(ABORT,'asset_links_are_retained');
END;
