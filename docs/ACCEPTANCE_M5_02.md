# M5-02 项目分组与未分组区验收

日期：2026-10-13。状态：代码与隔离验收完成；正式数据库、真实设备和公网发布仍未执行。

## 交付范围

- 新迁移 `0012_m5_02_project_sections`：`project_sections`、`tasks.section_id`、项目/排序索引。
- 分组名称同项目唯一；服务层校验与 SQLite 触发器同时保证 owner、project 和直接子项关系。
- `GET/POST /api/projects/:id/sections`、`PATCH /api/projects/:id/sections/:sectionId`、`POST /api/projects/:id/sections/reorder`。
- `POST /api/tasks/:id/section` 支持加入分组或设为 `null` 的未分组区。
- 任务归属/父级/跨空间移动会清理失效 `section_id`；更深层子项不能被安排到项目分组。
- 项目视图显示分组标记，支持创建分组和上下排序；详情安排区提供分组选择与未分组选项。

## 验证

- `node scripts/test-m5-02.mjs`：通过。覆盖项目根直接子项归组、未分组、深层子项服务拒绝、重复名称、改名、排序、任务版本/事件，以及绕过服务的 SQL 触发器拒绝。
- `npm run test:m5`：通过，包含 M1～M4 回归、M5-01 旧项目根迁移、M5-03 树操作和 M5-04 移动/生命周期回归。
- `npm run typecheck`、`npx drizzle-kit check`、`npm run build`：通过。
- 测试库 `integrity_check` 与 `foreign_key_check`：通过；正式库未迁移。

## 明确边界

- 未分组是 `section_id IS NULL` 的查询区，不创建伪分组记录。
- 项目分组只组织项目根的直接主子项；嵌套项目和更深层主子项继续按主树/最近项目规则处理，不复制祖先分组。
- 当前项目页使用按钮上下移和原生选择框完成菜单/键盘可达操作；完整拖拽、折叠、项目进度统计和引用规则分别留给 M5-05/M5-09。
