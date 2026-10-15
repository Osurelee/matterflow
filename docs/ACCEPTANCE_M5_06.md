# M5-06 验收记录：小步骤提升为独立事项

日期：2026-10-13  
状态：已完成本机隔离验收；正式库、真实设备与公网仍待后续阶段。

## 交付范围

- 新增 `GET /api/tasks/:id/checklist/promote` 提升预览。
- 新增 `POST /api/tasks/:id/checklist/promote` 原子确认。
- 当前事项的未提升小步骤会创建为直接主子项，继承空间和项目归属。
- 已勾选小步骤映射为 `done`，未勾选映射为 `todo`。
- 原 `checklist_items.promoted_task_id` 写入创建的Task ID，原清单保留关联，不重复创建或重复计数。
- 预览的事项内容版本、结构版本和条目关联在确认事务内重新校验；版本过期整笔拒绝，不留下半套子项。
- 详情中增加预览/确认入口，可打开已提升的独立事项。

## 隔离验证

```text
node scripts/test-m5-06.mjs
M5-06 checklist promotion: PASS
```

用例覆盖：提升预览、结构版本冲突、勾选状态映射、直接主子项创建、原清单关联、重复提升空操作、完整性和外键检查。

代码检查：`npm run typecheck`、`npm run build`、`npx drizzle-kit check` 与 `npm run test:m5` 均通过。

## 未验证项

- 正式数据库尚未执行迁移；本功能复用已有 `checklist_items.promoted_task_id` 字段。
- 真实手机操作、长清单视觉与公网访问尚未验收。
- M5-07 原事项启用项目视图与 M5-08 端到端流程已在后续验收记录中完成；本报告只记录 M5-06 的边界。
