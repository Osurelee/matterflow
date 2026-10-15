-- M4-06 bind staged audio assets to the immutable progress event they accompanied.
ALTER TABLE `task_asset_links` ADD COLUMN `progress_event_id` text REFERENCES `task_events`(`id`);
--> statement-breakpoint
CREATE INDEX `task_asset_links_progress_event_idx` ON `task_asset_links` (`progress_event_id`,`removed_at`);
--> statement-breakpoint
CREATE TRIGGER `task_asset_links_progress_owner_insert` BEFORE INSERT ON `task_asset_links` BEGIN
  SELECT CASE WHEN NEW.role='progress' AND (NEW.progress_event_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM task_events e WHERE e.id=NEW.progress_event_id AND e.task_id=NEW.task_id AND e.owner_user_id=NEW.owner_user_id AND e.type='task_progress_appended'
  )) THEN RAISE(ABORT,'progress_asset_event_mismatch') END;
  SELECT CASE WHEN NEW.role!='progress' AND NEW.progress_event_id IS NOT NULL THEN RAISE(ABORT,'progress_event_role_mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER `task_asset_links_progress_owner_update` BEFORE UPDATE OF role,progress_event_id ON `task_asset_links` BEGIN
  SELECT CASE WHEN NEW.role='progress' AND (NEW.progress_event_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM task_events e WHERE e.id=NEW.progress_event_id AND e.task_id=NEW.task_id AND e.owner_user_id=NEW.owner_user_id AND e.type='task_progress_appended'
  )) THEN RAISE(ABORT,'progress_asset_event_mismatch') END;
  SELECT CASE WHEN NEW.role!='progress' AND NEW.progress_event_id IS NOT NULL THEN RAISE(ABORT,'progress_event_role_mismatch') END;
END;
