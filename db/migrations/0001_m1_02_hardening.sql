-- M1-02 加固迁移（独立复核后补充；不改动既有表结构，全部为附加约束）
--
-- 背景：0000 迁移已建好 11 张业务表与枚举 CHECK、有效委托部分唯一索引。
-- 本次补充技术设计第 3 节中「数据库层可零风险强制」的不变量：
--   1. 首版只允许一个账号（3.1）
--   2. task_events 只追加（3.1）——用触发器阻止 UPDATE/DELETE
--   3. 事项引用的项目必须同空间同 owner（3.2，文档允许复合外键或事务内校验，此处额外用触发器兜底）
--   4. 等待原因与状态一致（3.2：waiting 必有原因；非 waiting 必须清空）
--   5. 默认私人空间不可归档（PRD 第 152 行）
--
-- 说明：仍由服务层负责校验的项（不在本迁移内，见 TASK_LOG「服务层待落实约束」）：
--   文本长度上限、业务日期的真实日历有效性（如 2 月 30 日）、跨 owner 的复合归属（单账号下不适用）。

--> statement-breakpoint
CREATE UNIQUE INDEX `users_single_account_uq` ON `users` ((1));
--> statement-breakpoint
CREATE TRIGGER `task_events_no_update` BEFORE UPDATE ON `task_events`
BEGIN
  SELECT RAISE(ABORT, 'task_events 只追加：禁止更新历史事件');
END;
--> statement-breakpoint
CREATE TRIGGER `task_events_no_delete` BEFORE DELETE ON `task_events`
BEGIN
  SELECT RAISE(ABORT, 'task_events 只追加：禁止删除历史事件');
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_project_space_guard_ins` BEFORE INSERT ON `tasks`
WHEN NEW.`project_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `projects` p
  WHERE p.`id` = NEW.`project_id`
    AND p.`space_id` = NEW.`space_id`
    AND p.`owner_user_id` = NEW.`owner_user_id`
)
BEGIN
  SELECT RAISE(ABORT, '事项引用的项目必须属于同一空间与同一 owner');
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_project_space_guard_upd` BEFORE UPDATE OF `project_id`, `space_id`, `owner_user_id` ON `tasks`
WHEN NEW.`project_id` IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM `projects` p
  WHERE p.`id` = NEW.`project_id`
    AND p.`space_id` = NEW.`space_id`
    AND p.`owner_user_id` = NEW.`owner_user_id`
)
BEGIN
  SELECT RAISE(ABORT, '事项引用的项目必须属于同一空间与同一 owner');
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_waiting_reason_guard_ins` BEFORE INSERT ON `tasks`
WHEN (NEW.`status` = 'waiting' AND (NEW.`waiting_reason` IS NULL OR trim(NEW.`waiting_reason`) = ''))
  OR (NEW.`status` <> 'waiting' AND NEW.`waiting_reason` IS NOT NULL AND NEW.`waiting_reason` <> '')
BEGIN
  SELECT RAISE(ABORT, '等待中必须有等待原因；非等待中必须清空等待原因');
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_waiting_reason_guard_upd` BEFORE UPDATE OF `status`, `waiting_reason` ON `tasks`
WHEN (NEW.`status` = 'waiting' AND (NEW.`waiting_reason` IS NULL OR trim(NEW.`waiting_reason`) = ''))
  OR (NEW.`status` <> 'waiting' AND NEW.`waiting_reason` IS NOT NULL AND NEW.`waiting_reason` <> '')
BEGIN
  SELECT RAISE(ABORT, '等待中必须有等待原因；非等待中必须清空等待原因');
END;
--> statement-breakpoint
CREATE TRIGGER `spaces_default_archive_guard_ins` BEFORE INSERT ON `spaces`
WHEN NEW.`is_default` = 1 AND NEW.`archived_at` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, '默认私人空间不可归档');
END;
--> statement-breakpoint
CREATE TRIGGER `spaces_default_archive_guard_upd` BEFORE UPDATE OF `archived_at`, `is_default` ON `spaces`
WHEN NEW.`is_default` = 1 AND NEW.`archived_at` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, '默认私人空间不可归档');
END;
