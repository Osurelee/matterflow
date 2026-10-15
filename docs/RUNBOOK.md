| db:migrate |# tasks 启动与运维说明（M1-01 产出）

本文件是应用的运行手册：锁定契约、安装、启动、冒烟测试、部署约束。
设计依据：[技术设计](TECHNICAL_DESIGN.md) v0.4（尤其 12.2 路径契约、12.4 自启动与备份证据）。

## 1. 锁定契约（2026-10-12，M1-01）

| 项目 | 锁定值 | 说明 |
| --- | --- | --- |
| 应用名 / 包名 | `tasks` | 同时用于数据目录与 launchd 服务名 |
| 路径前缀 basePath | `/tasks` | 构建期固定；修改必须重新构建（技术设计 12.2） |
| 应用端口 | `3100` | 仅监听 `127.0.0.1`，不直接暴露 |
| 前缀恢复代理端口 | `3101` | 见第 5 节；仅监听 `127.0.0.1` |
| 数据目录 | `~/tasks/data` | 已创建 |
| 备份目录 | `~/Library/CloudStorage/GoogleDrive-lishuo0830@gmail.com/我的云端硬盘/tasks-backup` | 云同步目录；异机能力须按 12.4 独立下载校验后才成立 |
| 会话 Cookie | `tasks_session`，`Path=/tasks`，无 `Domain` | M1-03 已实现；生产 `Secure`、`HttpOnly`、`SameSite=Lax` |
| 公网入口 | `https://suresmac-mini.tail6bfbc0.ts.net/tasks` | 与既有 memos 共享 443；M1-04 有初步本机测试，但 M1 总验收仍待完成；公网接入还需过第 8 节及 M0 现场门槛，本次未改映射 |
| Node / npm | `24.18.0` / `11.16.0` | `engines.node >= 20.9.0` |
| 依赖版本 | next `16.4.0`、react/react-dom `19.3.0`、typescript `7.0.2`、@types/node `26.6.5`、@types/react(-dom) `19.3.0` | 已 `--save-exact` 精确锁定，`package-lock.json` 一并提交 |

## 2. 环境注意事项

- 本机 Studio 运行环境会带 `NODE_ENV=production`，这会让 npm 默认省略 devDependencies（`omit=dev`）。安装时使用：

  ```bash
  NODE_ENV=development npm install --include=dev
  ```

- `package.json` 的 npm scripts 已显式固定 `NODE_ENV`（dev=development、build/start=production），避免继承环境变量导致 `next dev` 行为异常。

## 3. 安装、类型检查与构建

```bash
cd "/Users/macmini/Desktop/项目/任务管理"
NODE_ENV=development npm install --include=dev   # 首次或依赖变更后
npm run typecheck                                 # tsc --noEmit
npm run build                                     # 产物在 .next/
```

## 4. 本地启动

```bash
# 开发（热更新）
npm run dev            # http://127.0.0.1:3100/tasks

# 生产（需先 build）
npm run start          # http://127.0.0.1:3100/tasks
```

## 5. 前缀恢复代理（必须，实测结论）

**实测发现（2026-10-12）**：Tailscale `serve`/`funnel` 的 `--set-path=/tasks` 会在转发前**剥掉** `/tasks`：

| 公网请求 | 应用实际收到 |
| --- | --- |
| `/tasks` | `/` |
| `/tasks/api/healthz` | `/api/healthz` |
| `/tasks/_next/static/x.js` | `/_next/static/x.js` |

而契约要求代理后仍保留 `/tasks`（应用以 `basePath=/tasks` 构建），因此必须有本地前缀恢复代理：

```bash
node scripts/tasks-proxy.mjs    # 127.0.0.1:3101 -> 127.0.0.1:3100/tasks
```

链路：`Funnel :443 /tasks` → tailscaled 剥前缀 → 代理 `:3101` 恢复 `/tasks` → 应用 `:3100`。
代理只还原路径，**不改既有根路径服务**（memos 仍由 Funnel 的 `/` 处理）。

## 6. 冒烟测试（M1-01 验收证据，2026-10-12 实测）

本地回环：

| 请求 | 预期 | 实测 |
| --- | --- | --- |
| `GET /tasks` | 200 | 200 |
| `GET /tasks/contract` | 200（深链接） | 200 |
| `GET /tasks/api/healthz` | 200 JSON | 200 `{"status":"ok","basePath":"/tasks"}` |
| `GET /tasks/manifest.webmanifest` | 200，id/start_url/scope=`/tasks/` | 符合 |
| `GET /tasks/_next/static/...` | 200 | 200 |
| `GET /` | 404（前缀隔离） | 404 |
| `GET /api/healthz`、`/contract` | 404 | 404 |

经 tailscaled（tailnet-only，不公开）端到端：`/tasks`、`/tasks/contract`、`/tasks/api/healthz`、
`/tasks/manifest.webmanifest`、`/tasks/_next/...` 全 200；
**对照实验**：同一映射直接指向 `:3100`（不经代理）时 `/tasks/api/healthz` 为 404，证明代理确有必要。

同源共存检查（**弱证据，勿据此定论**）：`/sw.js` 与 `/service-worker.js` 均返回 404，且 memos 未设置任何 Cookie、与 `tasks_session` 无命名冲突。但按路径 404 只能说明这两个常见地址不存在，**不能**证明没有其他脚本路径或历史浏览器注册过的根作用域 Service Worker；M5 实机共存验证必须读取真实 registration 的 `scope` 与 `scriptURL` 后再出结论（验收项 ACC 非阻塞项 2）。

## 7. 部署与运行状态约束（技术设计 12.4）

- 当前方案使用 **LaunchAgent（登录会话级）**：服务随用户登录启动，**不能**据此推断"重启后无人登录即运行"。
- 交付口径为"登录后启动"。重启后的三种状态（未登录 / 登录后 / 注销后）由 M0-04、M6 分别实测记录。
- 若后续确需无人登录即恢复，须另行设计 LaunchDaemon 及其 Tailscale 运行条件，不自动开启自动登录或改动磁盘加密设置。
- 常开前提：`pmset` 的 `sleep`/`autorestart` 变更需管理员授权，命令见 [ENVIRONMENT.md](ENVIRONMENT.md) 第 6 节。

## 8. 公网开放门槛（技术设计 12.2 / 12.3）

开发验证默认**只允许回环访问**。只有在完成

1. 初始化账号与登录，
2. 登录限流（账号桶 + IP 桶，代理头可信性校验），
3. 私有接口未登录 401 的负向测试（AT-19）

之后，才允许把应用接入真实公网业务入口 `/tasks`（M1-04 / AT-18）。
M0 空测试页 `/m0-02` 成功**不**代表应用安全或路径兼容已验收。

## 9. 已知限制

- 图标与 Service Worker 未实现（M5 范围）；manifest 目前只锁定 id/start_url/scope。
- 前缀恢复代理尚未纳入 launchd 托管；启动管理与重启行为需在 M0-04/M6 现场验证。
- M1-01～06本机隔离总验收已通过（A01～A04修复证据见M1_OPEN_ISSUES.md）；真实公网、手机、自启动和异机云恢复仍待M0/M6现场验收。M2-01/02 真实持久化收件箱与标题编辑已交付；M2-03～06 未完成。API 见第 11、13 节。

## 10. 数据库（M1-02，2026-10-12）

依赖（`--save-exact` 锁定）：drizzle-orm 0.45.4、better-sqlite3 13.0.3（原生模块实测可用，SQLite 3.53.4）；dev 侧 drizzle-kit 0.31.11、@types/better-sqlite3 9.6.0。

```bash
# 1) 修改 src/server/db/schema.ts 后生成迁移（产物 db/migrations/，版本化提交）
npm run db:generate

# 2) 应用迁移到正式库（默认 ~/tasks/data/tasks.db；幂等：已应用不重放）
npm run db:migrate
#    开发库需用 npm run db:migrate:dev（NODE_ENV=development，读取 .env.development）
#    可用 TASKS_DB_PATH=/tmp/test.db 覆盖目标库（测试用）

# 3) 初始化账号与默认空间（幂等；仅首次；交互输入密码 12–128 码点）
npm run db:init-account
#    开发库需用 npm run db:init-account:dev（NODE_ENV=development，读取 .env.development）
#    开发库密码重置与备份分别用 npm run db:reset-password:dev、npm run db:backup:dev
```

- 正式库现状：`~/tasks/data/tasks.db`，**schema_version=5**，迁移 `0000_watery_mentallo`、`0001_m1_02_hardening`、`0002_m3_handling`、`0003_m4_body`、`0004_m4_checklist` 已应用；账号 `owner`（单账号，库级唯一索引强制）；空间 私人(默认)/工作/生活/成长。
- 初始化密码：随机生成后存 `~/tasks/data/.initial-password`（权限 600）；用户首次登录后应立即改密并删除该文件。代码未自动读取/显示该文件，也没有改动正式密码。
- 账号初始化密码输入：交互式**隐藏回显（`*` 掩码）并要求输入两次**；`TASKS_INIT_PASSWORD` 仅在同时设置 `TASKS_ALLOW_NONINTERACTIVE_INIT=1` 时生效（仅供本机脚本/测试，避免环境变量成为"默认密码"通道）。
- 连接参数（`src/server/db/client.ts`）：`foreign_keys=ON`、`journal_mode=WAL`、`busy_timeout=5000`、`synchronous=FULL`；并发参数待 M1-05/M6 真实并发测试确认后调整。
  注意：库文件当前 `journal_mode` 仍是 `delete`——WAL 由连接设置，需应用首次通过该连接读写后才持久化生效，别把"已配置"当成"已生效"。
- 关键约束（负向实测全部被拒）：status/priority/kind 枚举 CHECK；kind=contact 必须带 contact_id；done/cancelled 时间不变量；`delegations` 每事项至多一条有效委托（`ended_at IS NULL` 部分唯一索引）；同 owner 空间名唯一；同空间项目名唯一；`mutation_requests` user+requestId 唯一。
- 加固迁移 `0001`（2026-10-12，独立复核后补充，纯附加不改表结构）新增：
  - `users_single_account_uq`：首版**库级**只允许一个账号。
  - 触发器：`task_events` **只追加**（禁止 UPDATE/DELETE）；事项引用的项目**必须同空间同 owner**（插入/更新）；`waiting_reason` 与状态一致（waiting 必有原因、非 waiting 必须清空）；默认私人空间**不可归档**。
  - 仍由服务层校验（本迁移不覆盖）：文本长度上限（M1-04）、业务日期的真实日历有效性如 2 月 30 日（M2-04）。
- 迁移前自动备份：使用 SQLite 一致性快照 `VACUUM INTO`（**包含 WAL 中已提交但未 checkpoint 的数据**），名称 `*.pre-migration-<时间戳>.bak`，并在迁移前校验备份（integrity_check + 关键表与行数一致）；**备份或校验失败即中止迁移**。旧的 `copyFileSync` 只复制主文件、会丢 WAL 数据，已废弃（验收 ACC-01）。备份任务调度属 M1-06。
- 数据库路径优先级（应用 `client.ts` 与所有脚本一致，验收 ACC-03）：`TASKS_DB_PATH` > `TASKS_DATA_DIR/tasks.db` > `~/tasks/data/tasks.db`；独立脚本和 drizzle-kit 均通过 `@next/env` 加载项目环境文件（不覆盖进程已设置值），与 Next 应用使用相同解析语义。
- 迁移清单（`db/migrations/meta/_journal.json`）中每个 tag 必须有对应 SQL 文件；缺失或"数据库已应用当前代码未知的迁移"都会**非零退出且不改库**（验收 ACC-02）。

## 11. M1-03～M1-05：认证与原子写入

认证 API（本机/公网均必须由应用校验，不信任客户端声明的用户ID）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/tasks/api/auth/login` | JSON `{username,password}`；成功设置 `tasks_session` HttpOnly Cookie |
| GET | `/tasks/api/auth/me` | 验证当前会话；未登录/失效返回 401 |
| POST | `/tasks/api/auth/logout` | 撤销当前会话并清除 Cookie |
| POST | `/tasks/api/auth/password` | 已登录后使用 `{currentPassword,newPassword}` 修改密码；旧会话全撤销，并为当前设备签发新会话 |

Cookie 为 `Path=/tasks; HttpOnly; SameSite=Lax`，生产模式加 `Secure`，不设置 `Domain`，会话有效期 30 天。数据库只保存高熵令牌的 SHA-256，不保存原始 Cookie 令牌。改密/重置递增 `users.auth_version` 并撤销全部旧会话。

登录失败统一返回“用户名或密码错误”。账号桶在 15 分钟内失败 5 次开始指数退避（最高 60 秒）；当前未配置可验证的可信反向代理 IP 链，因此 IP 桶按技术设计采用**单一代理回退桶**，15 分钟 30 次后临时返回 429。服务忽略 `X-Forwarded-For`、`X-Forwarded-Host` 和 `X-Forwarded-Proto`，不能靠伪造这些头绕过限流。生产环境必须配置 `TASKS_PUBLIC_ORIGIN`，请求 Origin 必须匹配；多个明确入口可用逗号分隔配置，开发环境还允许匹配直接请求 Origin。

```bash
npm run db:reset-password  # 本机交互式、隐藏回显、二次确认；递增版本并撤销所有会话
```

M1/M2 当前最小事项 API（与真实首页已接入；完整生命周期仍属 M2-03～06）：

- `POST /tasks/api/tasks`：必须登录且同源；输入 `requestId`、`spaceId`、`title`。以会话用户作为 owner，数据库写事项、`task_created` 事件和 request replay 记录在同一 SQLite 事务中。
- `PATCH /tasks/api/tasks/:id`：必须登录且同源；输入 `requestId`、`expectedVersion`、`title`。更新采用 compare-and-swap，旧版本返回 409；更新与 `task_updated` 追加事件和幂等记录同事务。
- 相同用户/相同 requestId/相同动作与负载返回已存响应，不重复写入；同 requestId 不同请求返回 409。事件表触发器拒绝 UPDATE/DELETE。

## 12. M1-06：本地一致性备份与恢复

```bash
npm run db:backup
# 输出默认 TASKS_BACKUP_DIR 下的 tasks-<UTC时间>.db 和 .sha256
npm run db:restore -- /path/to/verified-backup.db /path/to/new-empty-target.db
```

备份使用 SQLite `VACUUM INTO` 一致性快照，并检查 `integrity_check`、`foreign_key_check` 与关键表；文件和校验清单权限为 600。恢复先核对源 SHA-256 与数据库完整性，只创建一个**不存在**的新目标，绝不覆盖现存数据库，再校验恢复结果并为恢复件生成自己的 checksum。覆盖已有目标会拒绝。备份文件存在于 Google Drive 同步目录只证明本机快照；在另一设备独立下载、校验并完成恢复前，不得记作远端备份通过。 此命令目前只备份SQLite数据库，不包括 `TASKS_MEDIA_DIR` 中的图片、音频、普通文件或staging内容；含媒体Task不能据此视为完整备份，媒体全量包/恢复另属M8。

## 13. M2-01/02：持久化收件箱

当前首页是登录后的真实数据库界面，不再使用硬编码示例事项。桌面侧栏/手机底部栏提供“收件箱”和“全部事项”，`⌘/Ctrl+K` 聚焦快速新增。

| 方法与路径 | 用途 | 要点 |
| --- | --- | --- |
| GET `/tasks/api/tasks?view=inbox&limit=50&offset=0` | 收件箱 | 只列活跃、未整理、未归档、未删除的当前 owner 事项；默认 inbox |
| GET `/tasks/api/tasks?view=all` | 基础全部列表 | 当前 owner 未归档、未删除事项，含已整理与结束事项 |
| GET `/tasks/api/tasks/:id` | 读取详情 | 仅当前 owner 的可见事项 |
| POST `/tasks/api/tasks` | 快速新增 | `requestId`、`title` 必填；`spaceId` 可选，缺省使用本人默认私人空间；服务端设置待处理、未整理、本人负责/行动 |
| PATCH `/tasks/api/tasks/:id` | 修改标题 | 必须带 `requestId` 与 `expectedVersion`；冲突返回当前版本 |
| POST `/tasks/api/tasks/:id/process` | 完成整理 | `requestId` + `expectedVersion`；事务写入整理标记、递增版本、追加事件和幂等记录；不会删除事项 |

所有业务 API 要求有效登录、owner 从 session 取得、私有响应 no-store。事项写入发生错误时 UI 保留当前输入，不显示成功；同一个请求重试复用 requestId。验收入口：`npm run test:m2`（生产构建 + M1/M2 隔离集成回归）。M2-03 的状态流转、M2-04 日期字段、M2-05 时间线 UI、M2-06 全部失败/未保存离开体验仍未完成。
