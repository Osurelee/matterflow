# M5-04 验收记录

日期：2026-10-13；状态：代码与隔离验收完成，真实设备/正式库未验收。

## 范围

- 迁移 `0011_m5_04_structure_batches` 新增结构操作批次与成员快照。
- `POST /api/tasks/:id/move`：原子移动整棵主子树，支持跨空间、目标父级、位置和项目/空间索引重算；移动保留 Task ID、正文、状态、日期、媒体关系与历史。
- `POST /api/tasks/:id/archive`、`POST /api/tasks/:id/unarchive`、`POST/DELETE /api/tasks/:id/delete`、`POST /api/tasks/:id/restore`：软归档、软删除、批次恢复与版本/结构守卫。
- 生命周期完成/取消、重开、新建子项增加主后代及祖先可写守卫。

## 验证

```text
npm run typecheck
npx drizzle-kit check
npm run build
node scripts/test-m5-migration.mjs
node scripts/test-m5-04.mjs
npm run test:m5
```

结果：全部通过。`test-m5-04` 实际通过跨空间子树移动（2 个节点）、空间/索引/版本变化、活跃后代结束与归档拒绝、已结束子树删除、按实际批次恢复、归档守卫、`integrity_check` 与 `foreign_key_check`。`npm run test:m5` 同时复跑 M1～M4、M5-01、M5-03。

## 限制

- 迁移和测试只使用临时隔离库，正式数据库未迁移。
- M5-02 的项目分组、M5-05～09 的行动统计/引用/项目启用未包含；前端完整移动/删除/恢复交互待后续任务。
- 未进行真实手机、公网、性能预算或正式备份恢复演练；媒体全量恢复仍归 M8。
