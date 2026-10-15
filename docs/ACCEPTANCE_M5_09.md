# M5-09 验收记录：跨位置引用

日期：2026-10-13  
状态：已完成本机隔离验收；正式库、真实设备与公网仍待后续阶段。

## 交付范围

- 新增 `task_references` 关系表：来源事项和目标事项仍是同一个 Task，不复制标题、正文、媒体或历史。
- 新增 `GET /api/tasks/:id/references` 与 `GET /api/tasks/:id/referenced-by` 双向读取。
- 新增 `POST /api/tasks/:id/references` 创建引用，以及 `POST /api/tasks/:id/references/:refId/remove` 软移除引用。
- 引用创建要求来源事项结构版本匹配、目标同一账号且未删除；允许目标已归档但不允许目标已删除。
- 有效来源/目标配对唯一；重复创建返回已有关系，不递归展开目标主树。
- 删除引用只写 `removed_at` 并递增来源事项结构版本；目标事项不会被删除或改变。
- 事项详情接入紧凑引用区，可打开原事项；被删除目标保留“事项已删除”占位。

## 隔离验证

```text
node scripts/test-m5-09.mjs
M5-09 task references: PASS
```

用例覆盖：创建、双向读取、重复保护、自引用拒绝、软移除、结构版本与引用版本、数据库完整性和外键检查。

代码检查：`npm run typecheck`、`npm run build`、`npx drizzle-kit check` 与 `npm run test:m5` 均通过。

## 未验证项

- 正式数据库尚未执行迁移；当前迁移仅在隔离数据库验证。
- 真实手机引用选择器、跨空间长列表、窄屏视觉和公网访问尚未验收。
- 删除/恢复目标事项的完整前端流程与M6导出/M8完整恢复仍待后续阶段。
