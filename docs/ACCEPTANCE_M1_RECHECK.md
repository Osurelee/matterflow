# M1-01 / M1-02 修复复验

> 注：以上是该次复验时的历史结论；R-01/R-02 已在后续修复并重跑反例，M1 最新实现和本机验收结论见 [ACCEPTANCE_M1_FULL.md](ACCEPTANCE_M1_FULL.md)。远程发布门槛仍未通过。
日期：2026-10-12。结论：ACC-01通过；ACC-02、ACC-03部分通过，仍有两个P2问题，整体验收暂不通过。

本次独立运行构建、类型检查及隔离数据库测试；未修改业务代码、正式数据库或公网配置。原报告及修复方记录保留，当前独立复验结果以本文为准。

## 已通过

- npm run typecheck、npm run build退出0。
- 空库迁移、0000→0001升级、重复执行正常。
- 保持WAL连接、关闭自动checkpoint、提交marker表及1行数据后执行迁移，VACUUM INTO生成的备份可以读到该行；ACC-01关闭。
- 迁移清单缺少SQL时退出1，不再错误报告最新版。
- 仅在.env.local配置普通TASKS_DATA_DIR时，迁移和初始化使用同一测试库，得到1账号和4默认空间。
- SCHEMA_VERSION已调整为2。

## 待修复

### R-01 / ACC-03 · P2：自制env解析器与Next.js不一致

位置：scripts/lib/env.mjs:35–51。解析器将等号之后的整段当作值，不处理行尾注释，且没有与Next.js统一环境文件优先级和变量展开规则。

实际复现：隔离工程.env.local写入`TASKS_DATA_DIR=/tmp/example # database directory`。脚本解析为`/tmp/example # database directory/tasks.db`；通过应用使用的@next/env解析，结果为`/tmp/example/tasks.db`。两者再次指向不同库。因此基本目录案例通过不等于ACC-03完整关闭。

修复验收：脚本与应用使用相同环境加载器及加载模式，并共享路径规则；覆盖普通值、引号、行尾注释、变量引用、环境专用文件及进程环境优先级。所有案例的解析结果必须相同。无需通过限制用户不写合法env语法来绕过问题。

### R-02 / ACC-02 · P2：清单预检发生在数据库写入之后

位置：scripts/migrate.mjs:126–137。脚本先创建目录、打开数据库并执行两个CREATE TABLE，再调用readMigrationTags。

实际复现：目标文件原本不存在，在清单加入不存在的0002_missing。退出码确实为1，但目标数据库已经创建，且包含app_meta、__drizzle_migrations_applied、sqlite_sequence三张表。错误信息“数据库未被修改”不成立，也不满足上次要求的失败前置校验。

修复验收：在mkdir、Database构造及任何DDL之前校验完整迁移清单；缺失文件时，新目标文件及目录不应被创建，已有数据库内容与schema均不改变。已应用迁移兼容性检查应先只读检查，之后才进入必要写入。

## 证据与范围

隔离测试目录：`/var/folders/5x/wlmx2qm507l8sf717kdys1q00000gn/T/tasks-recheck-aVI8Hu`。测试账号使用人工测试密码，不涉及正式凭据。该目录可能被系统清理。

认证、限流、真实公网、自启动、云恢复属于后续交付，本次未验收。两项P2修复后复跑对应反例及迁移基本回归即可，不需要重复无关部署检查。

## 后续修复复验记录（M1 全量实现前置复核）

日期：2026-10-12。针对本报告 R-01/R-02 和新增 M1-03～M1-06 交付进行隔离复验；测试库、密码与会话均为临时数据，未触碰正式数据库。

### R-01 / ACC-03：环境来源一致

- `scripts/lib/env.mjs` 与 `drizzle.config.ts` 使用 Next 自带 `@next/env`；应用运行由 Next 加载同一环境文件规则，数据库路径优先级统一为 `TASKS_DB_PATH > TASKS_DATA_DIR/tasks.db > ~/tasks/data/tasks.db`。
- 在隔离工程 `.env.local` 中测试 `$BASE_DIR` 展开、引号与行尾注释，解析到 `/tmp/env-base/data/tasks.db`；`drizzle-kit check` 读取配置通过。
- 应用数据库客户端与脚本对空值的 fallback 使用一致的 `||` 语义；默认目录统一使用系统 homedir。

### R-02 / ACC-02：迁移前置检查

- 隔离工程迁移清单添加 `0002_missing`、目标 DB 与父目录均不存在：迁移以非零退出，父目录与数据库文件均未创建。
- 隔离数据库应用到 schema v2 后，临时回退当前清单至 v1：迁移拒绝“数据库已应用当前代码未知的迁移”；前后 SHA-256 相同。

### M1-03～M1-06 隔离实测概要

- 登录/登出/当前会话/改密 API 通过；未登录读取和写入均为 401；无 Origin 或伪造转发头不能绕过来源校验；账号失败计数触发退避与 429。
- 登录 Cookie 在生产响应具有 HttpOnly、Secure、SameSite=Lax、Path=/tasks；改密递增 auth_version、撤销旧会话并为当前客户端重签；退出后会话失效。
- 事项新增的数据库行、`task_created` 事件及 mutation_requests 在同一事务；重放同 requestId 不重复写入；同 ID 不同负载返回 409。更新采用 expectedVersion；过期版本返回 409，标题和事件均不改变。失败请求不留下部分数据。
- 交互式密码重置脚本在隔离 TTY 测试通过：密码输入以星号掩码、二次确认、auth_version 增加、旧会话清空。
- `VACUUM INTO` 备份在连接保持打开且有未 checkpoint 的 WAL 已提交数据时仍包含 marker；备份 integrity/FK 检查通过。恢复库行数/事件关联可读；覆盖已有恢复目标拒绝；源 checksum 错误拒绝。

完整执行时间、构建哈希及最新回归结果以本报告尾部的“M1 总验收”追加记录为准。本附录不覆盖远端云副本独立下载验证、真实公网手机访问、自启动或 M2 业务 UI。
