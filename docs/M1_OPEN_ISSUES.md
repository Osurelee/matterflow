# M1 当前待修复清单

**状态：A01～A04已修复；`npm run test:m1`隔离总回归通过。M1本机验收通过。** `ACCEPTANCE_M1_TOTAL.md`中的A01～A04为修复前独立验收发现；对应修复已按下方记录完成并通过隔离重验。本轮修复与回归证据见下方关闭记录；真实部署/公网/异机恢复仍按M0/M6验收。

| 编号 | 等级/归属 | 当前问题 | 关闭条件 |
| --- | --- | --- | --- |
| A01 | 已修复（M1-06） | 恢复备份会恢复旧 `sessions`，可能使已撤销 token 复活 | restore 在恢复件 checksum 生成前撤销所有旧 session 并更新 auth_version；恢复服务后旧 token 401、恢复凭据可重新登录、业务/事件数据一致 |
| A02 | 已修复（M1-03/04） | 登录长度用 UTF-16 `string.length`，和初始化/改密的 Unicode 码点校验不一致；合法 80 emoji 密码可能无法登录 | 全部入口统一码点计数；覆盖 80 个非 BMP 字符往返及 128/129 码点边界 |
| A03 | 已修复（M1-05） | PATCH 标题没有拒绝已归档事项或已归档容器 | 在事务内校验 task、space、project 归档态；归档项更新返回 409 且 title/version/event/replay 记录不变；未归档修改正常 |
| A04 | 已修复（M1-01/02） | 数据命令固定 production 环境，开发模式可能读写不同 `.env.*` 数据目录 | 增加明确 dev/prod 数据命令；在隔离项目的 `.env.development` / `.env.production` 分别迁移、初始化、启动，证明每个模式只访问其配置库、无交叉污染 |

## 修复后完整重验

1. `npm run typecheck`、Drizzle 检查、生产构建。
2. 从全新临时项目与空库分别跑 dev/prod 路径模式，验证迁移、账号初始化和 app 路径一致。
3. 重跑 `npm run test:m1`，并加入 A01 session 复活、A02 Unicode、A03 archived task/container、A04 dev/prod DB 隔离反例。
4. 全部通过；M1状态及验收报告已更新。真实公网、手机、自启动和异机云恢复仍属于M0/M5/M6，不因本机M1通过而视为完成。

M2-01/02与M1的验收范围独立。

## 本轮关闭证据

- A01：`scripts/restore.mjs` 在目标库完成恢复后、生成最终 SHA-256 前，事务性递增全部用户 `auth_version` 并删除恢复快照中所有 sessions；检查完整性后 checkpoint 并切换为 DELETE journal，再校验与生成 checksum。M1 隔离套件确认旧 cookie 对恢复库返回401、旧 sessions为0、auth_version递增、账户仍可用恢复快照密码重新登录且业务事件存在。
- A04：环境加载器与 Drizzle 配置按 `NODE_ENV` 选择 dev/prod 环境文件；新增 `db:migrate:dev` 和 `db:init-account:dev`。隔离测试用独立 `.env.development` / `.env.production` 执行解析、迁移和初始化，并用相应模式应用启动及凭据登录验证数据库路径，无跨库污染。
- 总回归：`npm run test:m1` 通过，含生产构建、TypeScript构建检查、Drizzle检查、M1隔离集成测试及 dev/prod路径验证。
