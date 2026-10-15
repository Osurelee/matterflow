# M1 实现与内部隔离测试记录（已被独立总验收覆盖）

日期：2026-10-12。本文记录此前实现与内部测试证据，不是当前通过结论。最新独立总验收发现 A01～A04，**M1 当前仍未通过**；问题与关闭标准见 [ACCEPTANCE_M1_TOTAL.md](ACCEPTANCE_M1_TOTAL.md)。

## 结论摘要

- 本记录里的本机测试只覆盖一组场景；独立总验收增加的 A01～A04 尚未修复，不能据此称 M1 完成。
- `npm run typecheck`、`npm run build`、`drizzle-kit check` 通过。
- 在隔离库实测：匿名请求拒绝；Origin 与登录限流生效；失败写入回滚；成功事项写入和事件同事务；幂等重放不重复写；requestId 复用冲突；过期 expectedVersion 冲突；改密与退出撤销会话；WAL 未 checkpoint 的提交仍被备份并可恢复。
- 上一份独立复验报告的 R-01（env 解析器差异）和 R-02（迁移清单预检时机）已在后续代码修正并按反例复测通过，细节见 [ACCEPTANCE_M1_RECHECK.md](ACCEPTANCE_M1_RECHECK.md)。
- M0 现场条件仍未全部完成；真实公网手机、自启动、真实代理链/IP 取值和异机云备份恢复未验收。M2-03～06 仍待实现。

## 变更范围

- 认证：`src/server/auth/session.ts`、`password.ts`；新增 `/api/auth/login`、`logout`、`me`、`password`。登录仅允许已初始化 owner，无注册；Cookie 为 HttpOnly、生产 Secure、SameSite=Lax、Path=/tasks；DB 只存随机 session token 的 SHA-256。改密/重置递增 auth_version 并撤销旧会话。
- UI：`src/app/page.tsx` 提供登录、改密、退出和 M2-01/02 现代工作台；收件箱/全部列表已接真实 API 与数据库，不再用硬编码事项。
- 安全与校验：8 KiB 请求上限、密码 12–128 码点、统一成功/错误 envelope、503 存储不可用映射、Origin 校验、私有响应 no-store；owner 只从有效会话取得。
- 限流：15 分钟账号桶 5 次失败后退避，最高 60 秒；无已验证可信代理 IP 链时使用单一回退桶，15 分钟 30 次后 429；不信任转发头。
- 事务基础：事项创建、标题更新、已整理写入和事件/replay 记录处于同一事务；并发 requestId 和 expectedVersion CAS 覆盖回归；新增受保护 inbox/all/detail API。
- 运维：交互式初始化/重置密码；一致性 backup/restore、checksum 和 backup_runs 成功/失败状态；新增受保护备份状态 API。
- 环境：脚本与 Drizzle 配置复用 Next `@next/env` 规则；数据库路径优先级统一为 `TASKS_DB_PATH > TASKS_DATA_DIR/tasks.db > ~/tasks/data/tasks.db`。迁移清单与向前兼容检查在建库/DDL 前执行。

## 已执行的内部隔离测试（不覆盖 A01～A04）

| 场景 | 结果 |
| --- | --- |
| 类型检查、生产构建、Drizzle 迁移一致性检查 | 通过 |
| 空隔离库迁移 0000→0001、初始化 owner 与四默认空间 | 通过 |
| 未登录 GET /auth/me 与 POST /tasks | 均 401 |
| 错账号/密码统一提示；正确登录；生产 Cookie 属性 | 通过；确认 HttpOnly、Secure、SameSite=Lax、Path=/tasks |
| 缺少 Origin/不匹配 Origin/生产缺 TASKS_PUBLIC_ORIGIN；伪造转发头 | 均拒绝；改变伪造 `X-Forwarded-For` 不可绕过回退限流桶 |
| 账号连续失败退避及 429；回退桶达到阈值返回 429 | 通过 |
| 不存在的 space 创建事项 | 404；任务、事件、mutation_requests 计数均未改变（事务回滚） |
| 有效事项创建 + task_created 事件 + request replay 记录 | 同事务通过 |
| 相同 requestId/负载重放 | 返回既存结果，未重复新增任务/事件 |
| 同 requestId 不同负载 | 409 |
| 更新 expectedVersion=1；随后用旧版本 1 更新 | 首次更新为 v2；旧版本 409；事项标题与事件数不变 |
| 改密、旧 Cookie、退出 | 改密后旧会话 401、新会话有效；退出后当前会话 401 |
| 交互式重置脚本 | TTY 下星号掩码及二次确认；auth_version 增加、旧会话清空 |
| 迁移前备份 WAL 中已提交未 checkpoint 行 | 连接保持打开时 marker 行存在于备份；integrity/FK 检查通过 |
| 新目标恢复、恢复后再次备份恢复、覆盖已有目标、checksum 篡改 | 两代恢复通过；覆盖与篡改备份均拒绝 |
| 缺 SQL 清单项；数据库比当前迁移清单新 | 非零退出；缺 SQL 时目标目录未创建；已存在 DB 前后 SHA-256 相同 |
| `.env.local` 注释/引号/变量展开，脚本路径规则 | 通过；Drizzle 配置 `drizzle-kit check` 通过 |

## 可复查入口

- [实施清单](IMPLEMENTATION_PLAN.md) 已将 M1 状态恢复为待验收，M2-01/02 保持已通过；最新 M1 结论看 [ACCEPTANCE_M1_TOTAL.md](ACCEPTANCE_M1_TOTAL.md)。
- [运行手册](RUNBOOK.md) 第 11、12 节记录认证/API/限流/备份恢复命令及边界。
- [独立复验后续记录](ACCEPTANCE_M1_RECHECK.md) 保存 R-01/R-02 原始问题与修复复测。
- 当前实现未执行正式账号密码重置、未打开公网业务入口、未改变正式数据库。
