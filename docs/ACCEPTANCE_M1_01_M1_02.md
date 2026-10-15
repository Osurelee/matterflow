# M1-01 / M1-02 独立验收

> 注：本文件前文记录的是最初 M1-01/M1-02 验收时结论。后续独立复验的 R-01/R-02 和本次 M1 全量实现状态以 [ACCEPTANCE_M1_FULL.md](ACCEPTANCE_M1_FULL.md) 为最新汇总；公网与 M0 现场项仍未验收。
日期：2026-10-12。范围为当前工程初始化与数据库基础；不将尚未实施的M1-03登录、M1-05业务事务当作本阶段缺陷。

## 结论

本地构建与路径检查通过，M1-02整体暂不通过。以下三个缺陷应修复并复验，再作为可靠的后续开发基础。本次仅审查和测试，没有修改业务代码、正式数据库或公网映射；数据库测试在独立临时目录执行。

## 阻塞问题

### ACC-01 · P1：迁移备份漏掉WAL中已提交的数据

位置：scripts/migrate.mjs:85–87。脚本对打开中的数据库执行copyFileSync，仅复制主文件；应用连接已明确启用WAL。

复现：在隔离库应用0000，开启WAL并保持连接，提交acceptance_marker表和一行数据，再运行迁移到0001。原库可查到1行；自动生成的备份连acceptance_marker表都没有，但备份integrity_check返回ok。这意味着需要回滚时会丢失已提交数据，结构完整性检查不能证明数据完整。

修复验收：采用SQLite一致性备份API并等待完成，校验备份后才迁移；保持WAL连接与未checkpoint的已提交写入，备份恢复后仍可读到这些数据。备份失败必须中止迁移。

### ACC-02 · P2：迁移SQL缺失被静默跳过

位置：scripts/migrate.mjs:46–51。listMigrations通过existsSync过滤清单中缺失的文件。

复现：在隔离迁移清单增加0002_missing，但不提供SQL文件。脚本退出码0，输出nothing to apply (already at latest)，schema_version=2。部署漏文件时会被错误判定可用，实际数据库缺少新结构。

修复验收：执行前校验清单中所有文件存在；缺失文件以非零状态退出且不改库。补充已应用迁移与当前清单一致性检查，避免旧构建把新数据库当作兼容版本。

### ACC-03 · P2：应用与迁移/账号初始化使用不同数据目录规则

位置：src/server/db/client.ts:17–18；scripts/migrate.mjs:28；scripts/init-account.mjs:30；drizzle.config.ts中的数据库路径配置。

静态确认：应用支持TASKS_DATA_DIR，两个脚本及Drizzle配置在未提供TASKS_DB_PATH时始终回落到~/tasks/data/tasks.db。同时.env.example指导复制为.env.local，但独立Node脚本没有加载该文件。只修改示例中的数据目录后，应用可能打开新空库，迁移和账号仍写入旧库。

修复验收：统一配置来源和优先级（显式TASKS_DB_PATH优先，其次TASKS_DATA_DIR，最后默认目录），明确所有命令的.env.local加载方式。在隔离目录仅配置TASKS_DATA_DIR，迁移、初始化和应用必须使用同一文件，默认正式目录不发生写入。

## 非阻塞后续项

- src/server/db/schema.ts:287仍导出SCHEMA_VERSION='1'，实际迁移元数据为2；当前常量尚未被使用，接入导出/版本校验前必须统一版本来源。
- RUNBOOK由两个常见SW路径404推断“未注册根Service Worker”，证据不足；可能有其他脚本路径或历史浏览器注册。M5真实浏览器共存检查应读取实际registration的scope及scriptURL，再出结论。
- 现有日志记录了临时公网验证；本次未复测该链路，只复验回环生产实例。主要手机、真实自启动和远端备份恢复保持未验证状态。

## 本次已执行的验证

| 检查 | 结果 |
| --- | --- |
| npm run typecheck | 通过 |
| npm run build | 通过 |
| 隔离生产进程/tasks、/tasks/contract | 均200 |
| /tasks/api/healthz、/tasks/manifest.webmanifest | 均200 |
| /、/api/healthz | 均404 |
| 隔离空库迁移、0000→0001升级、幂等复跑 | 正常路径退出0 |
| WAL未checkpoint数据的迁移前备份 | 不通过，缺少已提交表和数据 |
| 清单包含缺失SQL文件 | 不通过，错误退出0且报告最新版 |

隔离证据目录：`/var/folders/5x/wlmx2qm507l8sf717kdys1q00000gn/T/tasks-acceptance-bGGSLK`（临时目录可能被系统清理）。测试库仅含人工构造数据，无正式账号或密码。生产冒烟进程使用临时3199端口，验证后已停止。

---

## 复验附录（修复方，2026-10-12）

ACC-01/02/03 已修复，并由修复方按上述原复现场景独立复验。本节不修改前面的验收结论，只追加证据。

| 项 | 修复内容 | 复验结果 |
| --- | --- | --- |
| ACC-01 | `scripts/migrate.mjs` 迁移前备份改用 `VACUUM INTO` 一致性快照，并在迁移前校验备份（integrity_check + 关键表存在性与行数一致）；备份或校验失败即中止迁移并删除不可靠备份 | 按原场景（保持 WAL 连接打开、提交未 checkpoint 数据、库中存在待应用迁移）复验：**备份中检出 `acceptance_marker` 表及 1 行数据 ✅**，backup integrity ok；修复前同一场景备份连该表都没有 |
| ACC-02 | 清单校验：`_journal.json` 中每个 tag 必须有 SQL 文件，缺失即非零退出且不改库；另新增"已应用迁移必须是当前清单前缀"检查，防止旧构建把更新的数据库当作兼容版本 | 清单加入 `0002_missing` 但不放文件 → **退出码 1、库文件哈希未变 ✅**；库升到 v3 后代码退回 v2 → **退出码 1 并报"数据库已应用当前代码未知的迁移" ✅** |
| ACC-03 | 新增 `scripts/lib/env.mjs` 统一路径优先级 `TASKS_DB_PATH > TASKS_DATA_DIR/tasks.db > ~/tasks/data/tasks.db`，并显式加载 `.env.local`/`.env`（不覆盖已有环境变量）；`migrate.mjs`、`init-account.mjs`、`drizzle.config.ts` 全部改用该规则 | 仅设 `TASKS_DATA_DIR` 时迁移与账号初始化写入**同一文件** ✅；同时提供两个变量时 `TASKS_DB_PATH` 优先且未落到 `TASKS_DATA_DIR` ✅；仅靠 `.env.local` 也生效 ✅；隔离测试期间**正式库哈希未变** ✅ |
| 非阻塞 1 | `src/server/db/schema.ts` 的 `SCHEMA_VERSION` 由 `'1'` 更正为 `'2'`，并注明必须与 `app_meta.schema_version`（= 清单条数）同步 | 与库内 `schema_version=2` 一致 ✅ |
| 非阻塞 2 | RUNBOOK 第 6 节把"memos 未注册根 Service Worker"改标为**弱证据**，要求 M5 读取真实 registration 的 `scope`/`scriptURL` 后再定论 | 文档已更正 ✅ |

补充说明：

- 修复方即本工程的另一个会话；未改动 `0000_watery_mentallo.sql` 与 `schema.ts` 的表结构，未改动正式库数据。
- 复验期间正式库 `schema_version` 仍为 2、文件哈希未变；所有隔离测试均在 `/tmp` 下进行并已清理。
- 非阻塞项 3（主要手机、真实自启动、远端备份恢复）与本次修复无关，仍保持未验证状态。
