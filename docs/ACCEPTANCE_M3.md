# M3 归属与个人分发记录验收

版本依据：PRD v0.6（FR-03/05/07/08、10.2～10.4、AT-23～27）。验证方式：`npm run typecheck`、`npm run test:m2`（生产构建 + 隔离集成套件），并在隔离数据库的生产进程上做真实浏览器闭环复核。未操作正式数据库或公网映射。

## 交付

- **M3-01 空间与项目**：`GET/POST /api/spaces`、`PATCH /api/spaces/:id`、`POST /api/spaces/:id/archive|unarchive`；`GET/POST /api/projects`、`PATCH /api/projects/:id`、`POST /api/projects/:id/archive|unarchive`。名称去空白 1–80 码点、同 owner 空间名唯一、同空间项目名唯一、描述 ≤5,000 码点；默认私人空间不可归档；空间归档要求无未删除事项且无未归档项目；项目归档只计算未删除的活跃事项；取消项目归档要求所属空间未归档。
- **M3-02 归属与项目概览**：`POST /api/tasks` 支持 `projectId`（继承项目空间、默认已整理）；新增 `POST /api/tasks/:id/placement` 一次提交空间/项目（项目必须同空间）并可切换整理标记；`GET /api/projects` 返回活跃/完成/取消/已删除计数。
- **M3-03 迁移**：新增 `0002_m3_handling`（handling_mode 枚举 CHECK、counterpart_name、处理方式索引、配对触发器）；`scripts/migrate.mjs` 在写入前只读预检历史 contact 关联与 delegation，发现即停止并输出映射报告，需显式 `TASKS_ALLOW_LEGACY_CONTACT_MIGRATION=1` 才继续。旧 kind/contact 字段保留兼容，不作为新分发来源。
- **M3-04 处理安排**：`POST /api/tasks/:id/handling` 成对更新处理方式与交给谁；other 必填 1–100 码点、self 清空文本；不改变状态与日期；结束事项拒绝、已归档拒绝、重开自动重置为 self/空；变更写入 `task_updated` 事件。
- **M3-05 视图与筛选**：`GET /api/tasks` 支持 `inbox/today/doing/delegated/waiting/watched/all`，可叠加 `spaceId`、`projectId`、`status`、`includeEnded`；今天按上海时区判定并返回 overdue/followUpDue/plannedDue 风险标记；排序为优先级高→低→无、三类日期最早值升序（空值最后）、创建时间、ID；收件箱按创建时间倒序。
- **界面**：左侧导航新增今天/我要做/交给别人/等待中/我关注的/全部与项目列表；列表支持空间、项目筛选与风险标签；详情新增「归属」（空间/项目选择）与「处理安排」（自己处理/交给别人＋交给谁）。

## 验收用例

AT-23 标题创建默认 self/空文本、other 无文本拒绝且不写库；AT-24 切换处理方式保持状态与日期、等待可无对接方；AT-25 两个同名「物业A」事项只改其中一个，另一个不变且历史保留 A→B；AT-26 完成保留处理安排快照、重开重置 self/空文本、归档写入 409；AT-27 同 requestId 重试无重复事件、旧版本 409、迁移后既有字段与事件不丢。

## 验证结果

- `npm run typecheck` 通过。
- `npm run test:m2` 通过：包含 M1/M2 既有回归、dev/prod 数据库路径隔离，以及本次 M3 空间/项目、归属移动、处理安排、视图筛选与排序的隔离用例。
- 真实浏览器复核（隔离库、生产进程）：在「工作」空间捕获事项 → 详情设「交给别人／工程部门」→ 追加进展 → 等待中并填写等待原因 → 本人完成；完成后活跃视图为空、`includeEnded` 可见、处理安排快照保留。

## 未包含 / 后续

- 父子层级、项目分组与进度分母属 M5；正文、媒体与清单属 M4；搜索、提醒、回顾与导出属 M6。
- 全部视图现默认只列活跃事项，并保留 `includeEnded` 开关作为 M6 回顾上线前的过渡；M6 交付回顾后需复核该开关的保留必要性。
- 真实目标手机、公网 `/tasks` 与启动行为仍属 M7/M8 现场验收。
