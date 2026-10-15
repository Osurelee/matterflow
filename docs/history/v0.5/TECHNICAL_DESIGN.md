# 通用事务管理平台 · 技术设计

版本：v0.5；日期：2026-10-12；状态：v0.5按个人分发记录调整M3设计；M1/M2已有实现，新增设计尚未实施。

业务依据：[PRD](PRD.md)。交付顺序：[实施清单](IMPLEMENTATION_PLAN.md)。本文的库、接口与表名是实施建议；初始化时验证兼容版本并锁定，不凭文档假定依赖已安装。

## 1. 架构决策

| 决策 | 首版方案 | 原因与边界 |
| --- | --- | --- |
| 应用 | Next.js + TypeScript，单个Node服务 | 同仓维护响应式界面与服务端业务；使用自托管运行方式 |
| 数据 | SQLite + Drizzle；驱动候选better-sqlite3 | 单实例、单用户先简化部署；实际主机验证原生模块构建；持久化目录 `~/<应用名>/data`（2026-10-12 决策，应用名在 M1-01 固定） |
| 界面 | React，Tailwind CSS，可选shadcn/ui | 组件与样式实现方式不改变产品规则 |
| 接口 | 同源HTTP JSON，服务端集中校验 | 浏览器不直连数据库 |
| 部署 | **原生 Node 服务 + launchd**（2026-10-12 用户决策） | 单实例、SQLite 直连 APFS，少一层 VM；Docker 不作首版发布目标，避免两套运行方式并行维护 |
| 访问 | Tailscale Funnel 公网 HTTPS `https://suresmac-mini.tail6bfbc0.ts.net/tasks` → 本机 `127.0.0.1:<应用端口>`（2026-10-12 用户决策：443 子路径，与既有 memos 共享 443） | 只作为访问层，不嵌入业务授权；实测非标准端口（10000）在手机侧不可达，故不使用；应用须支持 `basePath=/tasks`；公网暴露使应用层认证成为唯一屏障，见第6节强化要求 |
| 认证 | 一个预置账号、密码登录、服务端会话 | 首版无注册，无邮件服务依赖 |
| 同步 | 前台轮询+回前台刷新+乐观并发控制 | 不引入WebSocket或离线队列 |
| PWA | manifest、图标、安装说明；可选仅静态壳Service Worker | 安装与离线能力分开交付 |

Next.js支持Node/Docker自托管；构建时需配置持久化与运行环境，具体版本在初始化时锁定。[官方自托管文档](https://nextjs.org/docs/app/guides/self-hosting)

```mermaid
flowchart LR
  A[手机或电脑浏览器 / PWA] --> B[Tailscale Funnel 公网 HTTPS 443 /tasks]
  B --> C[Next.js Web 与 HTTP 接口]
  C --> D[身份认证 / 输入校验 / 业务服务]
  D --> E[(本机 SQLite)]
  E --> F[一致性备份与校验]
  F --> G[云同步目录中的异机副本]
```

Funnel将本机Web服务发布到公网并提供自动HTTPS证书，手机浏览器直接访问，无需运行Tailscale客户端。代价是服务可被公网探测：应用不得有默认密码、登录必须限流、私有响应no-store、会话与Cookie按第6节执行；无路径可绕过应用认证直取数据。额度与可用性以实测为准，失败时按PRD Q-07调整部署方向。[Tailscale Funnel](https://tailscale.com/docs/kb/1223/funnel)

## 2. 建议代码结构

```text
src/
  app/                   页面、路由、HTTP入口
  components/            通用和业务UI
  domain/                状态转换、日期、视图、字段规则
  server/auth/           会话、账号校验、请求来源检查
  server/services/       事项、项目、处理方记录、导出等用例
  server/db/             schema、repository、事务
  shared/                输入输出类型与验证schema
db/migrations/           版本化迁移
scripts/                 初始化账号、备份、恢复校验
tests/                   规则、接口集成、关键端到端用例
docs/                    当前设计文档与后续实测报告
```

路由层只负责认证、解析和返回；所有写入口调用同一业务服务。权限、跨空间约束与生命周期不能仅靠前端下拉框限制。事务内不执行网络请求。

## 3. 数据结构

ID使用UUID文本；事件时间为UTC时间戳，业务日期为YYYY-MM-DD文本。统一使用服务端时钟。布尔值在SQLite存0/1；枚举增加CHECK约束；连接开启foreign_keys，迁移验证外键。

### 3.1 首版表

| 表 | 关键字段 | 约束和用途 |
| --- | --- | --- |
| users | id, username, password_hash, timezone, created_at | username唯一；首版只允许初始化一个账号 |
| sessions | id_hash, user_id, expires_at, created_at | 仅存令牌哈希；支持失效和退出 |
| spaces | id, owner_user_id, name, description, is_default, archived_at, version | 同owner名称唯一；默认私人空间不可归档 |
| projects | id, owner_user_id, space_id, name, description, archived_at, version | 同空间名称唯一；空间归属一致 |
| contacts（历史预留） | 既有结构保持 | v0.5不开发管理页面或CRUD，不作为新分发记录依赖 |
| tasks | 见下表 | 唯一事项实体 |
| delegations（历史预留） | 既有结构保持 | 保留既有约束与历史，不再作为新功能的当前处理方来源 |
| task_events | id, owner_user_id, task_id, actor_user_id, type, payload_json, occurred_at, request_id | 只追加；payload带schema版本和变化字段 |
| mutation_requests | user_id, request_id, payload_hash, response_json, created_at | user_id+request_id唯一；保存成功写请求的重放结果 |
| backup_runs | id, started_at, finished_at, status, artifact_name, checksum, error_code | 运维状态；不存密码或事项正文 |

owner_user_id、actor_user_id与空间归属继续用于单人授权与历史。V2不默认增加成员体系；如未来明确要求共同使用，再另行设计。

### 3.2 tasks字段

| 分组 | 字段 |
| --- | --- |
| 标识归属 | id, owner_user_id, space_id, project_id可空 |
| 内容 | title, description, priority(none/low/medium/high), next_action, result_note |
| 状态 | status(todo/in_progress/waiting/done/cancelled), is_processed, is_watched |
| 个人处理安排（M3新增） | handling_mode(self/other，默认self), counterpart_name(默认空字符串) |
| 历史兼容字段 | responsible_kind/contact_id、action_kind/contact_id继续保留以兼容M2；新UI不暴露，不能作为新处理方式查询依据 |
| 时间安排 | planned_date, due_date, follow_up_date，均可空 |
| 原因 | waiting_reason, blocked_reason, cancellation_reason |
| 系统字段 | created_at, updated_at, completed_at, cancelled_at, archived_at, deleted_at, version |

新处理字段：handling_mode仅self/other；self时counterpart_name必须为空，other时去空白后必须为1–100码点。服务端校验并增加数据库配对约束。项目、空间、事项必须同owner，项目必须匹配space_id。旧kind/contact_id配对约束保留，仅用于历史兼容，不能要求用户为新处理方文本创建contact。

状态与字段不变量：done必须有completed_at且无cancelled_at；cancelled相反；活跃状态两者为空。waiting必须有等待原因；非waiting清空当前等待原因。done/cancelled不得有当前follow_up_date；处理方式和文本作为结束快照保留，重新打开重置self/空文本。旧委托兼容数据的结束逻辑保留至显式迁移完成。归档仅允许done/cancelled。重新打开清除取消原因、结果说明、阻塞及跟进，原值保留事件。

软删除不级联删除事件。所有正常查询默认deleted_at为空；回收站显式使用其他查询。事件中的处理方文本、标题旧值保留快照。

### 3.3 索引与查询

- tasks(owner_user_id, deleted_at, archived_at, status)。
- tasks(owner_user_id, due_date)、follow_up_date、planned_date以及project_id索引。
- task_events(task_id, occurred_at, id)。
- tasks(owner_user_id, handling_mode)供处理方式筛选；旧delegations部分唯一索引保留，不作为新分发查询依赖。
- sessions(id_hash)、mutation_requests(user_id, request_id)唯一索引。

搜索先对标题/描述做参数化包含匹配，正确转义LIKE通配符；中文不依赖英文分词。1万事项下压测未达标再引入搜索索引，不提前承诺FTS中文效果。

列表默认50条、最大100条，采用稳定排序+分页；V1可用offset分页，明确刷新后页内容可能变化。服务器计算筛选、风险标记和计数，客户端不自行实现另一套逻辑。今天视图按task_id去重。

## 4. 写入协议与一致性

业务实体写请求携带requestId；更新同时携带expectedVersion。登录、退出、改密不使用业务重放表，按会话协议处理；创建无expectedVersion。哈希包含HTTP方法、规范化资源路径与校验后的正文，避免同ID在不同动作间误重放。成功请求记录与业务变更、事件位于同一个数据库事务。

1. 认证并确认请求来源、对象归属，拒绝不允许的字段。
2. 若已存在同用户requestId且payload一致，返回原成功结果；若payload不同，返回冲突。
3. 校验expectedVersion；按id、owner、version条件更新并递增version，零行更新返回冲突。
4. 在同事务内处理处理方字段配对、状态副作用和历史事件，写成功请求结果。
5. 提交后返回完整新对象、版本和服务端时间。

创建超时后重试复用requestId，不新生成；用户改变请求内容或明确新建另一事项才使用新ID。V1成功写请求去重记录长期保留，未来清理前需制定重放期限。失败请求不记为成功。事件是审计历史而非事件溯源系统，tasks保存当前状态。

遇到版本冲突返回409和当前服务器版本；UI保留本地输入，展示差异，由用户重新加载或基于最新版本重新提交。不自动选择最后写入。网络错误或数据库忙时不显示保存成功。

## 5. 接口草案

外部接口统一位于`/tasks/api`；下表路径均相对于此前缀（例如列表为`/tasks/api/tasks`）。私有响应Cache-Control: no-store。下列为概念契约，编码时生成统一类型；接口路径可调整，语义不能偏离PRD。

| 方法与路径 | 行为 |
| --- | --- |
| POST /auth/login、POST /auth/logout、GET /auth/me | 登录、退出、当前用户 |
| POST /auth/password | 校验旧密码后改密并失效其他会话 |
| GET /tasks | view、spaceId、projectId、status、q、includeArchived、分页参数 |
| POST /tasks | 标题与可选字段；服务端补默认值 |
| GET /tasks/:id | 当前事项、处理方式和交给谁；事件独立分页 |
| PATCH /tasks/:id | 编辑一般字段；允许handlingMode/counterpartName成对更新；禁止直接改系统字段和status |
| POST /tasks/:id/transition | 目标状态、原因、结果说明、expectedVersion |
| POST /tasks/:id/process | 标记已整理 |
| POST /tasks/:id/archive、POST /tasks/:id/unarchive | 归档/取消归档 |
| DELETE /tasks/:id、POST /tasks/:id/restore | 软删除/恢复，仍需版本与requestId |
| GET /tasks/:id/events、POST /tasks/:id/progress | 查事件、追加文字进展 |
| GET/POST /spaces、/projects | 查询/创建；详情PATCH编辑、archive/unarchive动作；不提供contacts CRUD |
| GET /review、GET /trash | 完成历史、回收站查询 |
| GET /exports/json、GET /exports/csv | JSON全量业务快照；CSV使用当前筛选 |
| GET /system/backup-status | 最近备份结果；需要登录 |
| GET /healthz | 最小健康状态，不返回私有信息或路径 |

错误结构：code、message、fieldErrors、requestId；版本冲突附currentVersion和当前可读对象。输入无效400，未登录401，无权限403，不存在404，版本/业务约束冲突409，限流429，临时不可用503。对象不属于当前用户时统一404以免泄露存在性。

创建示例（字段为提案，不是可调用接口）：

```json
{
  "requestId": "客户端生成的UUID",
  "title": "联系物业维修水管"
}
```

修改处理安排示例（PATCH /tasks/:id；不自动改变状态或日期）：

```json
{
  "requestId": "另一个UUID",
  "expectedVersion": 2,
  "handlingMode": "other",
  "counterpartName": "物业（维修对接）",
  "followUpDate": "2026-10-16",
  "nextAction": "询问师傅上门时间"
}
```

## 6. 认证与数据保护

单账号由本机初始化脚本创建，交互输入密码，不在仓库提供默认密码。密码使用成熟实现的Argon2id或scrypt哈希，选择随运行环境验证并记录参数。会话使用高熵随机值、数据库仅存哈希；Cookie使用HttpOnly、Secure（HTTPS生产）、SameSite=Lax和有限期限，默认30天绝对过期。退出删除会话；本机恢复脚本可重置账号并撤销全部会话。

写接口验证Origin和同源请求；登录限制失败尝试。Tailscale网络身份不自动映射成应用身份；任何代理身份头都不能直接决定用户。服务只通过宿主机回环端口发布。纯文本内容转义展示，导出CSV处理以=、+、-、@等开头的公式注入风险。

v0.2 公网暴露强化（Funnel方案下应用层认证是唯一屏障，以下为首版必需，不是可选）：无默认密码，初始化强制交互设置；登录失败按账号+IP限流并指数退避；会话Cookie必须Secure且HttpOnly；私有接口响应Cache-Control: no-store；登录接口不区分"账号不存在/密码错误"；健康检查与静态资源不泄露版本细节。FR-01验收增加：公网可达但未登录时业务接口全部401。

JSON导出包含当前用户的空间、项目、事项（含处理字段）、事件及软删除记录；contacts/delegations只作为旧数据兼容项保留于全量导出，带schemaVersion、exportedAt与产品时区；排除账号密码、会话和mutation_requests。它用于可迁移数据，不等于可直接恢复的数据库备份。V1不提供通用JSON导入，恢复通过数据库快照。

## 7. PWA、缓存与联网状态

首版manifest提供名称、图标、start_url、display与主题色。具体浏览器是否允许安装需要实机验证；普通浏览器访问始终是基础入口。

私有页面和/api不使用共享缓存。若使用Service Worker，仅缓存带内容哈希的静态资源和通用离线提示页，禁止缓存事项JSON和登录后HTML；退出清理内存中的业务数据。首版不离线重放写操作。

联网判断不能只依赖navigator.onLine，应以实际API结果更新。手机无需Tailscale；服务端Funnel中断或应用停机时，即使手机仍能上互联网也应显示应用不可连接。前台每30秒刷新，后台暂停；回前台触发刷新但不覆盖正在编辑的本地表单。

离线存储、后台同步与推送需要独立实现且受浏览器能力影响，不能由“已安装PWA”推导可用。[MDN离线与后台操作说明](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation)

V1.1再增加IndexedDB草稿、outbox操作队列、可见的待同步/失败状态。新增去重沿用requestId；编辑带原版本；删除与编辑冲突需显式解决。详细协议另立设计后实施。

## 8. 部署、数据与运行

建议一台常开机器运行一个应用实例，一个SQLite库位于本地持久化磁盘，不放网络共享目录给多进程跨机器写入。不使用无持久磁盘的临时容器层。

运行形态（2026-10-12 用户决策）：原生 Node 服务，由 launchd 托管（`~/Library/LaunchAgents/`，本机已有同类服务），应用只监听 `127.0.0.1:<端口>`；宿主机 Tailscale Funnel 以 443 子路径 `/tasks` 反向代理为公网 HTTPS（自动证书）。Funnel 公网端口仅允许 443/8443/10000，其中 443（memos）与 8443（hermes-web-ui）已被既有服务占用，实测 10000 在手机侧不可达，因此应用**必须共享 443** 并支持 `basePath=/tasks`；Cookie 作用域、PWA `scope` 与静态资源前缀需按子路径配置。数据目录固定为 `~/<应用名>/data`（与 memos 同款），应用名在 M1-01 固定。

配置至少包含数据库路径、应用外部URL、产品时区、会话参数、备份目录。密钥通过独立配置注入，示例配置只写占位符。日志记录请求ID、动作、耗时和错误码，不记录密码、Cookie和事项正文。

SQLite可启用WAL及合理busy_timeout，通过真实并发测试确定参数。备份任务与应用分离调度，不依赖用户打开页面。对于Mac，必须验证重启、注销、睡眠后服务实际行为：即便 launchd 已注册，`pmset` 的 `sleep`/`autorestart` 不满足常开条件时仍会中断服务（现状见 ENVIRONMENT.md 第 2、6 节，变更需管理员授权）。

远程验收：移动数据和实际办公网络分别测试登录、读取、新增、修改；测试服务端Funnel中断、家中服务停机和恢复（手机侧不再需要运行Tailscale客户端）。记录设备、系统、浏览器、时间、成功率和响应时长，连接质量不由架构图替代实测。

## 9. 备份、恢复与迁移

目标为每日一次一致性快照，本机保留最近7个日备份和4个周备份。**目的地（2026-10-12 决策）：云同步目录（Google Drive 优先，iCloud Drive 备选）**。由于该目录在本机仍位于同一物理卷，必须先完成快照的完整性校验与原子改名，再等待云同步完成并核对校验和，之后才可声称具备异机副本；同步未完成时只视为本机备份。外接盘方案待后续评估。

使用SQLite Online Backup API或经过验证的数据库快照机制，不能只复制活跃数据库主文件而遗漏WAL中的内容。[SQLite备份说明](https://www.sqlite.org/backup.html)

备份过程：生成临时快照 → integrity_check → 记录schema版本和校验和 → 原子改为正式名称 → 复制异机并核对校验和 → 更新备份状态 → 成功后清理过期副本。失败保留最近有效备份，登录后的设置页显示失败与最后成功时间。

恢复流程：

1. 停止写入，保留当前库及其配套文件作为故障现场，不直接覆盖唯一副本。
2. 在临时目录校验备份完整性和schema版本，以匹配的应用版本启动。
3. 核对事项、事件、项目数量和抽样字段，检查外键、处理方式与文本配对及旧表约束。
4. 撤销恢复库中的旧会话，确认可登录并进行创建、编辑、重开。
5. 切换数据目录并重启，记录实际丢失窗口和恢复耗时。

目标RPO≤24小时、RTO≤60分钟；测试报告写实际结果，不以有备份文件代替恢复演练。

数据库升级前备份，迁移文件版本化；失败停止发布。升级回滚必须考虑schema兼容性，不能只回退应用构建产物；必要时恢复升级前快照，并明确这会丢弃快照后的写入。应用启动检查schema兼容性。

## 10. 测试与技术交付标准

| 层级 | 有价值的覆盖 |
| --- | --- |
| 领域规则 | 全部状态转换、处理安排保存与重开副作用、日期跨午夜、今天去重、排序及归档条件 |
| 数据库集成 | 外键、事务回滚、处理字段配对及旧表约束、重复请求、版本冲突、迁移和备份恢复 |
| 接口 | 未登录、越权ID、错误字段、已删除对象写入、CSV安全、私有缓存头 |
| 端到端 | 记录到完成、记录交给谁到本人跟进、删除恢复、A/B设备冲突、网络失败重试 |
| 实机 | 手机与桌面、安装入口、断连、重启、自启动、性能与异机恢复 |

先完成高风险数据规则与闭环测试，不为每个纯展示组件建立镜像测试。测试执行与结果记录在实施清单对应里程碑，尚未执行的检查不得打勾。

## 11. 尚未锁定的技术项

- Node/Next.js/Drizzle/SQLite驱动的兼容版本：初始化时验证并锁定。
- 正式主机（2026-10-12 已定：本机 Mac mini）、部署形态（已定：原生 Node + launchd）、公网入口（已定：Funnel 443 子路径 `/tasks`）、持久化目录（已定：`~/<应用名>/data`）、备份目的地（已定：云同步目录）：见 PRD v0.3 与 ENVIRONMENT.md；备份保留策略细则与外接盘评估按 Q-06 后续确认。
- 系统推送、离线同步、多成员权限：不在首版接口中伪装为可用功能。
- 附件、全文搜索、多人数据库迁移：达到真实需求或性能瓶颈后再设计，不按预估人数直接承诺容量。


## 12. 文档验收补充契约（v0.4）

### 12.1 模型与写入完整性

PRD第5.4节同样约束服务端。项目/空间归档校验、事项恢复/重开与归属校验须在同一写事务内执行，避免两个设备并发制造“归档项目下出现活跃事项”。处理方式与文本配对也须在写事务内校验，不关联联系人。

所有业务实体初始version=1；实际修改以及事项追加进展都递增version并更新updated_at；新requestId但目标状态与当前相同的转换返回409，不生成事件。业务请求重放在当前认证与归属校验之后、状态与版本校验之前判断，保证删除等动作可安全重试。客户端收到历史重放结果后重新读取当前实体，不用旧响应覆盖已知的更高版本。

除事项外，空间/项目也支持expectedVersion和requestId；其CRUD不写task_events，首版不要求其独立操作时间线。增加users.auth_version（改密/重置后递增）用于撤销会话；登录、改密不得将密码或会话令牌写入mutation_requests。

完成/取消、删除/恢复、归档操作与处理安排遵守PRD第5.4节。归档容器提供POST /spaces/:id/unarchive和/projects/:id/unarchive；归档/取消归档同样校验版本。v0.5不新增联系人及delegate/recall接口。

PATCH只接收明确白名单；字段缺省表示不改，null表示清空允许为空的字段，禁止null标题。创建时禁止客户端指定status、系统时间和版本。camelCase为HTTP字段命名，snake_case为数据库字段命名。统一成功响应为{data, requestId}，错误为{error:{code,message,fieldErrors},requestId}，冲突在error内附currentVersion/current；列表data含items、total、offset、limit。查询请求requestId可由服务端生成。

JSON全量导出各表应在同一读事务中读取，避免一份导出同时包含修改前事项和修改后事件。CSV导出全部匹配项而非仅当前分页，UTF-8并保留中文；生成过程中按一致快照处理。

M1-02 实施注（2026-10-12，独立复核后补充）：数据库层已强制——枚举 CHECK；kind 与 contact_id 配对；done/cancelled 时间不变量；每事项至多一条有效委托（部分唯一索引）；同 owner 空间名唯一、同空间项目名唯一；`mutation_requests` user+requestId 唯一；单账号唯一索引；`task_events` 只追加（触发器）；事项引用的项目同空间同 owner（触发器）；`waiting_reason` 与状态一致（触发器）；默认私人空间不可归档（触发器）。**仍由服务层校验**：文本长度上限（M1-04）、业务日期的真实日历有效性如 2 月 30 日（M2-04）。触发器与 CHECK 是兜底，不能替代服务层校验与集成测试。

### 12.2 /tasks 路由与同源共存

- Next.js构建时固定basePath=/tasks；修改该值需要重新构建。站内导航、重定向、原生fetch、图片和manifest都必须验证此前缀；不要假定原生fetch自动加前缀。[Next.js basePath](https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath)
- 代理到应用时必须保留/tasks前缀。**M1-01 实测（2026-10-12）**：Tailscale serve/funnel 的 `--set-path=/tasks` 会在转发前剥掉前缀（`/tasks/api/healthz` 实测被转发为 `/api/healthz`，`/tasks` 被转发为 `/`），因此本应用在 `127.0.0.1:3101` 增加前缀恢复代理（`scripts/tasks-proxy.mjs`）后再交给 Funnel，既有根路径服务不变。验收请求包括/tasks、深链接、/tasks/api/healthz及/tasks/_next静态资源。
- 会话Cookie使用专用名称tasks_session、Path=/tasks、无Domain属性；创建和删除Cookie参数一致。manifest的id、start_url、scope均限定/tasks/；若启用Service Worker，脚本及scope也限定/tasks/。
- 子路径共用同一origin，Cookie Path不构成应用间安全隔离。既有memos与任务应用须视为共同信任边界；Origin检查不能抵御同源应用脚本被攻破。检查根路径Service Worker是否覆盖/tasks，以及Cookie命名冲突；若已有不可信内容或无法排除的拦截，不通过公网发布门槛，另评估独立origin，不能擅改既定入口。[同源定义](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)
- 开发验证默认仅回环访问。初始化账号、登录限流、私有接口鉴权完成并通过负向测试后，才接入真实业务公网入口；M0空测试页成功不代表应用安全或路径兼容已验收。

### 12.3 公网认证的实施默认值

密码长度12–128码点，保留用户输入不隐式trim；登录请求体最多8KiB，统一失败消息。账号维度15分钟内失败5次开始退避（1、2、4…秒，上限60秒），持续失败不延长到永久锁定；IP维度15分钟30次失败返回429。限流状态持久化到auth_rate_limits（key_hash、window_start、failure_count、blocked_until），不进入业务导出。

仅从已验证的受信代理链提取IP，忽略客户端可伪造的转发头；无法证明来源时以统一代理桶限流，并始终保留账号桶。公网上线前验证伪造头不能绕过限流。参数作为本稿默认，实测调整需记录。改密原子更新密码并撤销其他会话；本机重置撤销全部会话。写接口含登录均校验配置的外部Origin，缺失/不匹配拒绝（本机脚本用数据库管理入口，不绕过HTTP规则）。

### 12.4 自启动与备份证据

LaunchAgents属于登录会话，不能据“配置了launchd”推断重启后无人登录即运行。当前方案按登录后启动交付；M0-04/M6分别记录重启后未登录、登录后、注销后三种行为。如果要求无人登录恢复，需要另行设计LaunchDaemon及Tailscale运行条件；不自动开启自动登录或修改磁盘加密设置。[Apple启动任务说明](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)

backup_runs扩展local_status、remote_status、local_verified_at、remote_verified_at、remote_object_id。云目录中文件存在、图标或本机校验和只证明本地快照。异机副本验收须通过云端独立下载/另一设备下载，比较校验和并执行恢复；尚未独立取回时remote_status=unverified，界面不得显示异机备份成功。首版允许人工记录远端验证证据，不假定云客户端有可调用的完成接口。每日调度失败或停机后，下一次启动补做一次快照；恢复指标从最后一份远端已验证快照计算，未达到24小时目标则记录未达标。


## 13. v0.5个人分发记录：迁移与实现约束

本节是用户澄清后的当前M3设计，优先于历史M1/M2验收记录中的联系人/委托规划。修改文档不等于代码已实现。

1. 新增版本化迁移，在tasks增加handling_mode（self/other，默认self）和counterpart_name（默认空）；不删除contacts/delegations，不改已执行迁移，不重置数据库。
2. 对现有self/none且无联系人关联、无有效委托的M2事项回填self/空文本，不改变状态、日期或历史。迁移前检测旧contact关联和有效委托：存在时停止自动迁移并给出统计及映射方案，先审阅再执行，不能静默丢弃或按同名自动合并。映射后旧历史和备份保留。
3. 新功能只以handling_mode/counterpart_name为当前处理安排来源；旧responsible_kind/action_kind只为兼容现有约束与M2转换代码保留。不得为了存“交给工程部门”写contacts、创建delegations或把旧action_kind强设contact。M3重开时同时重置新字段，并保留M2既有字段副作用。
4. PATCH一次提交handlingMode与counterpartName；改自己时清空文本。缺省都不提交表示不改；仅改文本时按最终handlingMode校验。使用task_updated事件记录字段旧/新值，沿用requestId/expectedVersion，不新增交接事件类型或独立交接表。
5. 记录应交给谁、改处理方、改自己均不自动改变status和日期；需要等待时使用现有transition接口，两个独立动作分别留历史。结束保留处理安排；重开清空；软删除恢复原安排；归档写入拒绝。
6. 我的事务“我要做”查handling_mode=self，“交给别人”查other；都排除结束/归档/删除。等待中与处理方式无绑定。计数不从delegations计算。
7. M3详情与接口读取返回handlingMode、counterpartName；全量导出加入新字段，不过滤已结束快照。历史文本编辑只影响当前事项。用户界面没有联系人目录、邀请或接收状态。
8. M3验收补充AT-23～27，并回归M2生命周期和幂等/冲突用例。实际schemaVersion以新增迁移和元数据为准，不在本设计凭空宣称版本已升级。
