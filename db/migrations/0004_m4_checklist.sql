-- M4-04 结构化小步骤（PRD 9.3/9.4、7.1；FR-22；技术设计 3.2）
--
-- 设计约束：只新增表与索引，不改已应用 SQL、不删表、不重置正式库。
--   小步骤只有文本、勾选与排序：没有独立日期/状态/处理方，不进入任务视图与计数。
--   sort_key 为定宽零填充字符串，字典序即顺序；重排时整表重算（≤100 条）。
--   promoted_task_id 预留给 M5「提升为子事项」，M4 不开放该入口，恒为 NULL。
--   条目上限 100、文本 1–500 码点由服务层校验（CHECK 只保证非空与布尔取值）。
--> statement-breakpoint
CREATE TABLE `checklist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`text` text NOT NULL,
	`is_checked` integer DEFAULT false NOT NULL,
	`sort_key` text NOT NULL,
	`promoted_task_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `checklist_items_checked_ck` CHECK (`is_checked` IN (0,1)),
	CONSTRAINT `checklist_items_text_ck` CHECK (length(trim(`text`)) > 0),
	CONSTRAINT `checklist_items_sort_key_ck` CHECK (length(`sort_key`) > 0),
	CONSTRAINT `checklist_items_owner_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`),
	CONSTRAINT `checklist_items_task_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
);
--> statement-breakpoint
CREATE INDEX `checklist_items_task_sort_idx` ON `checklist_items` (`task_id`,`sort_key`);
--> statement-breakpoint
CREATE INDEX `checklist_items_owner_idx` ON `checklist_items` (`owner_user_id`);
