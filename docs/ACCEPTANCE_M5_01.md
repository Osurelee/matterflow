# M5-01 独立事项基础模型与旧项目迁移验收

日期：2026-10-13；状态：已完成（隔离迁移与服务兼容验收）。依据M5规格v0.6.2第1/2/6节、AT-47，并回归M1～M4。

## 模型与迁移

- 新迁移 `0009_m5_01_independent_items`，schema_version=10：spaces.structure_version；tasks.parent_id、sort_key、structure_version、deletion_batch_id；projects.root_task_id（唯一）、status、is_paused、target_date、success_criteria；`m5_migration_reports`审计报告表。任务父边带owner/space/self触发器，Project root绑定带owner/space/project触发器。
- 每个旧Project新增唯一根Task，Task ID为新UUID；原Project ID、原Task IDs均保留。根标题/正文取Project name/description，description为plaintext并生成首修订；根关联原project_id，项目原事项接为根的直接主子项并按创建顺序生成sort_key。Project root同步space/owner和archived_at；旧Project没有status列，根与Project迁移为active，完成状态不从归档标记猜测。
- 旧任务只更新parent_id/sort_key/structure_version；不修改标题/正文/状态/内容version/原日期/附件链接/正文修订/历史事件。每个新根写一条带`migration.kind=legacy_project_root`和sourceProjectId的task_created事件，不伪造原Task历史。
- 数据报告记录迁移Project/root ID映射、旧Task行数、事件/资产/附件关联数量；迁移后外键/integrity校验。项目统计排除root；Project读标题/正文取root，更新Project名称/正文同步root Task；从root编辑标题/正文或流转状态同步Project兼容镜像，归档/取消归档同步root标记。

## 只读预检和安全性

迁移在任何mkdir/数据库写/备份/DDL前检查：旧核心表/列、foreign_key_check、owner/space一致、项目名称/正文长度、已归档项目不存在活跃事项、迁移字段未被未知代码预先添加。发现冲突即停并报原因；不猜测覆盖。通过预检后复用迁移器既有一致性数据库备份，再将DDL与数据转换放在同一事务。

## 验证证据

- `npm run test:m5`：通过；包含`npm run test:m4`生产构建及M1～M4隔离总回归，加`test-m5-migration.mjs`旧库兼容测试。
- 旧库测试以0000～0008迁移构造fixture，覆盖两个Project（含归档项目）、多个已完成/活跃子Task、无Project根事项、正文修订/事件/图片asset链接；迁移后核对原ID/内容/状态/version/历史/媒体关系不变，root连接/状态/归档标记正确，迁移事件与报告正确，foreign_key/integrity通过。
- 故障fixture：已归档Project仍含活跃Task时，预检非零退出；比较数据库SHA-256完全不变，且无迁移备份文件/DDL副作用。
- Project根兼容隔离HTTP测试：读取Project root/status/统计；Task列表DTO显示根标记；Project API更新同步root，root统一PATCH同步Project标题，root完成后Project status映射completed，项目归档/取消归档同步root archived_at。
- UI验证：生产构建/TypeScript通过；未执行桌面/手机手工浏览器视觉验收。
- `npx drizzle-kit check`、生产构建、TypeScript/M1～M4回归通过。
- 正式数据库未迁移；迁移备份仍只包含SQLite，不含`TASKS_MEDIA_DIR`二进制（完整媒体备份归M8）。

## 后续边界

M5-01只建立模型/迁移与Project root兼容入口，不代表任意深度树服务、移动/防环/祖先后代生命周期、分组、引用、enable-project UI或101层验收完成；按M5-02～09逐项实现。M4-06麦克风实机验收仍未执行，图音闭环补测不得由本迁移报告替代。
