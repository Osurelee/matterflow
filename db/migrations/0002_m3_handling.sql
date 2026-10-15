-- M3-03 个人分发记录字段（PRD v0.6 5.2/10.2，技术设计 3.2/13）
--
-- 设计约束：不改已应用 SQL、不删表、不重置正式库；仅新增列、约束与索引。
--   handling_mode：self/other，默认 self；counterpart_name：默认空字符串。
--   other 必须填写交给谁；self 必须为空——由 CHECK（枚举）与触发器（配对）强制。
--   v0.6 不开发联系人管理，此为自由文本，不关联 contacts 或账号。
-- 迁移前需先检查历史 contact 关联与有效 delegation（由 scripts/migrate.mjs 预检执行）。
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `handling_mode` TEXT NOT NULL DEFAULT 'self' CHECK (`handling_mode` IN ('self','other'));
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `counterpart_name` TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE INDEX `tasks_owner_handling_idx` ON `tasks` (`owner_user_id`,`handling_mode`);
--> statement-breakpoint
CREATE TRIGGER `tasks_handling_pair_guard_ins` BEFORE INSERT ON `tasks`
WHEN (NEW.`handling_mode` = 'self' AND NEW.`counterpart_name` <> '')
  OR (NEW.`handling_mode` = 'other' AND trim(NEW.`counterpart_name`) = '')
BEGIN
  SELECT RAISE(ABORT, '处理方式与交给谁不匹配：self 必须为空，other 必须填写');
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_handling_pair_guard_upd` BEFORE UPDATE OF `handling_mode`, `counterpart_name` ON `tasks`
WHEN (NEW.`handling_mode` = 'self' AND NEW.`counterpart_name` <> '')
  OR (NEW.`handling_mode` = 'other' AND trim(NEW.`counterpart_name`) = '')
BEGIN
  SELECT RAISE(ABORT, '处理方式与交给谁不匹配：self 必须为空，other 必须填写');
END;
