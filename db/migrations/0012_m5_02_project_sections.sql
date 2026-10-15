-- M5-02 optional project sections. A section is only an organization label for
-- a project's direct children; deeper descendants must remain ungrouped.
CREATE TABLE `project_sections` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_user_id` text NOT NULL REFERENCES `users`(`id`),
  `project_id` text NOT NULL REFERENCES `projects`(`id`),
  `name` text NOT NULL,
  `sort_key` text NOT NULL DEFAULT '0000000000000000' CHECK (length(`sort_key`) > 0),
  `version` integer NOT NULL DEFAULT 1 CHECK (`version` > 0),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `section_id` text REFERENCES `project_sections`(`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_sections_project_name_uq` ON `project_sections` (`project_id`, `name`);
--> statement-breakpoint
CREATE INDEX `project_sections_project_sort_idx` ON `project_sections` (`project_id`, `sort_key`, `id`);
--> statement-breakpoint
CREATE INDEX `project_sections_owner_idx` ON `project_sections` (`owner_user_id`, `project_id`);
--> statement-breakpoint
CREATE INDEX `tasks_project_section_sort_idx` ON `tasks` (`project_id`, `section_id`, `sort_key`, `id`);
--> statement-breakpoint
CREATE TRIGGER `project_sections_owner_project_insert` BEFORE INSERT ON `project_sections`
WHEN NOT EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.owner_user_id=NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT,'project_section_owner_project_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER `project_sections_owner_project_update` BEFORE UPDATE OF project_id,owner_user_id ON `project_sections`
WHEN NOT EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.owner_user_id=NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT,'project_section_owner_project_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER `tasks_section_direct_project_child_insert` BEFORE INSERT ON `tasks`
WHEN NEW.section_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM project_sections s
    INNER JOIN projects p ON p.id=s.project_id
    WHERE s.id=NEW.section_id
      AND s.owner_user_id=NEW.owner_user_id
      AND s.project_id=NEW.project_id
      AND p.owner_user_id=NEW.owner_user_id
      AND p.root_task_id=NEW.parent_id
  ) THEN RAISE(ABORT,'task_section_not_direct_project_child') END;
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_section_direct_project_child_update` BEFORE UPDATE OF section_id,project_id,parent_id,owner_user_id ON `tasks`
WHEN NEW.section_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM project_sections s
    INNER JOIN projects p ON p.id=s.project_id
    WHERE s.id=NEW.section_id
      AND s.owner_user_id=NEW.owner_user_id
      AND s.project_id=NEW.project_id
      AND p.owner_user_id=NEW.owner_user_id
      AND p.root_task_id=NEW.parent_id
  ) THEN RAISE(ABORT,'task_section_not_direct_project_child') END;
END;
