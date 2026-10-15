-- M4-06 audio metadata: preserve measured duration without trusting filename or client-provided codec.
ALTER TABLE `assets` ADD COLUMN `duration_ms` integer CHECK (`duration_ms` IS NULL OR (`duration_ms` >= 0 AND `duration_ms` <= 300000));
--> statement-breakpoint
CREATE TRIGGER `assets_duration_update_guard` BEFORE UPDATE OF duration_ms ON `assets` WHEN NEW.duration_ms IS NOT OLD.duration_ms BEGIN
  SELECT CASE WHEN NEW.duration_ms IS NOT NULL AND (NEW.duration_ms < 0 OR NEW.duration_ms > 300000) THEN RAISE(ABORT,'invalid_asset_duration') END;
END;
