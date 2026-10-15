-- M4-01 正文格式、搜索派生值与正文修订（PRD v0.6 7.1/7.2，技术设计 3.2/5.1/5.2）
--
-- 设计约束（技术设计 3.3）：不改已应用 SQL、不删表、不重置正式库；只新增列/表/索引。
--   description_format：plaintext（M4 之前写入的旧正文） / markdown_v1（共同子集源文本）。
--   description_plain：由 src/domain/body.ts 派生的搜索文本，不是第二份可编辑正文。
--   task_body_revisions：正文修订只追加；task_version 记录修订来源的事项版本。
-- 旧数据兼容：既有 description 一律保持 plaintext 并把原文本回填为 description_plain，
-- 不做 Markdown 解释；升级为 markdown_v1 必须先经 escapePlaintextToMarkdown（AT-28）。
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `description_format` TEXT NOT NULL DEFAULT 'plaintext' CHECK (`description_format` IN ('plaintext','markdown_v1'));
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `description_plain` TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE `tasks` SET `description_plain` = `description` WHERE `description` <> '';
--> statement-breakpoint
CREATE INDEX `tasks_owner_description_format_idx` ON `tasks` (`owner_user_id`,`description_format`);
--> statement-breakpoint
CREATE TABLE `task_body_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`format` text NOT NULL,
	`content` text NOT NULL,
	`content_plain` text NOT NULL DEFAULT '',
	`task_version` integer NOT NULL,
	`request_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT `task_body_revisions_format_ck` CHECK (`format` IN ('plaintext','markdown_v1')),
	CONSTRAINT `task_body_revisions_owner_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`),
	CONSTRAINT `task_body_revisions_task_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_body_revisions_task_version_uq` ON `task_body_revisions` (`task_id`,`task_version`);
--> statement-breakpoint
CREATE INDEX `task_body_revisions_task_created_idx` ON `task_body_revisions` (`task_id`,`created_at`,`id`);
