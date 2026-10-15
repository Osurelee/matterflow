-- M5-01 independent Task hierarchy and Project extension foundation.
ALTER TABLE `spaces` ADD COLUMN `structure_version` integer NOT NULL DEFAULT 1 CHECK (`structure_version` > 0);
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `parent_id` text REFERENCES `tasks`(`id`) CHECK (`parent_id` IS NULL OR `parent_id` <> `id`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `sort_key` text NOT NULL DEFAULT '0000000000000000' CHECK (length(`sort_key`) > 0);
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `structure_version` integer NOT NULL DEFAULT 1 CHECK (`structure_version` > 0);
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `deletion_batch_id` text;
--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `root_task_id` text REFERENCES `tasks`(`id`);
--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `status` text NOT NULL DEFAULT 'active' CHECK (`status` IN ('active','paused','completed','cancelled'));
--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `is_paused` integer NOT NULL DEFAULT 0 CHECK (`is_paused` IN (0,1));
--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `target_date` text;
--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `success_criteria` text NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_root_task_uq` ON `projects` (`root_task_id`) WHERE `root_task_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `tasks_parent_sort_idx` ON `tasks` (`parent_id`,`sort_key`,`id`);
--> statement-breakpoint
CREATE INDEX `tasks_structure_version_idx` ON `tasks` (`structure_version`);
--> statement-breakpoint
CREATE TABLE `m5_migration_reports` (
  `id` text PRIMARY KEY NOT NULL,
  `created_at` text NOT NULL,
  `projects_migrated` integer NOT NULL,
  `legacy_tasks_preserved` integer NOT NULL,
  `root_tasks_created` integer NOT NULL,
  `events_before` integer NOT NULL,
  `events_after` integer NOT NULL,
  `assets_before` integer NOT NULL,
  `assets_after` integer NOT NULL,
  `links_before` integer NOT NULL,
  `links_after` integer NOT NULL,
  `report_json` text NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `tasks_parent_owner_space_insert` BEFORE INSERT ON `tasks` WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tasks p WHERE p.id=NEW.parent_id AND p.owner_user_id=NEW.owner_user_id AND p.space_id=NEW.space_id AND p.id<>NEW.id) THEN RAISE(ABORT,'task_parent_owner_space_mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_parent_owner_space_update` BEFORE UPDATE OF parent_id,owner_user_id,space_id ON `tasks` WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tasks p WHERE p.id=NEW.parent_id AND p.owner_user_id=NEW.owner_user_id AND p.space_id=NEW.space_id AND p.id<>NEW.id) THEN RAISE(ABORT,'task_parent_owner_space_mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER `projects_root_owner_space_update` BEFORE UPDATE OF root_task_id ON `projects` WHEN NEW.root_task_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=NEW.root_task_id AND t.owner_user_id=NEW.owner_user_id AND t.space_id=NEW.space_id AND t.project_id=NEW.id) THEN RAISE(ABORT,'project_root_owner_space_mismatch') END;
END;
