-- M5-03: database-level cycle guard for the Task adjacency list.
CREATE TRIGGER tasks_parent_cycle_insert BEFORE INSERT ON tasks WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT CASE WHEN NEW.parent_id=NEW.id OR EXISTS (WITH RECURSIVE ancestors(id) AS (SELECT NEW.parent_id UNION ALL SELECT t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.id WHERE t.parent_id IS NOT NULL) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE(ABORT,'task_parent_cycle') END;
END;
--> statement-breakpoint
CREATE TRIGGER tasks_parent_cycle_update BEFORE UPDATE OF parent_id ON tasks WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT CASE WHEN NEW.parent_id=NEW.id OR EXISTS (WITH RECURSIVE ancestors(id) AS (SELECT NEW.parent_id UNION ALL SELECT t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.id WHERE t.parent_id IS NOT NULL) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE(ABORT,'task_parent_cycle') END;
END;
