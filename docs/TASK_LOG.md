# 任务记录

按实施清单第 11 节模板逐任务记录。状态定义：未开始 / 进行中 / 待验证 / 已完成。

阅读说明：以下条目为各任务当时的记录，后续决策见ENVIRONMENT.md及v0.4主文档；历史“尚未决策”不作为当前阻塞。2026-10-12文档验收与修订见[验收报告](DOCUMENT_REVIEW.md)，本次未将任何应用开发或部署验证任务标记完成。

---

## 任务：UX-生命周期操作首个前端切片

- 对应设计：`FRONTEND_REDESIGN_PRD.md` 的 P-05/P-07/P-10、4.1/4.3，以及 C-09 的草稿保护；业务守卫沿用 M5-04。
- 实际改动：详情顶部新增“更多”菜单，接入归档和“移入回收站”操作；低频动作不挤占正文工作区。操作前可选择保存正文/安排后继续，或保留本机草稿后继续；存在未提交进展、录音、附件或独立归属操作时会先阻止，避免静默丢失。
- 影响范围：根据事项树直接子项数量提供“当前事项 / 整个主子树”选择；提交携带事项版本、结构版本、scope和新的requestId，服务端继续负责全部后代结束守卫与原子性。成功后退出详情、刷新当前列表并显示实际结果。
- 尚未覆盖：回收站列表、取消归档和恢复入口仍待M6-04的查询/回顾页面；当前切片不制造一个无法定位已删除事项的假恢复按钮。
- 验证：`npm run typecheck`、`npm run build`、`npm run test:m5`全部通过；后者包含M4/M5全套隔离回归。
- 状态：已完成（前端首个生命周期操作切片；回收站完整闭环待M6-04）。

---

## 任务：M0-01

- 对应需求：FR-14、FR-16 背景项；Q-01（正式主机）、Q-06（备份容量基础）、Q-02/Q-07 关联
- 目标：形成一份基于实测的环境记录，覆盖开发环境、正式主机候选、系统、CPU 架构、可用磁盘和常开条件，后续里程碑可直接引用
- 前置条件：无（实施清单首项任务）
- 实际改动：
  - 新建 `docs/ENVIRONMENT.md`：开发环境事实（机型/系统/CPU/内存/磁盘/工具链/网络）、常开条件实测（pmset/uptime/供电）、正式主机候选、M0-02～M0-06 占位待实测表
  - 新建本任务记录文件 `docs/TASK_LOG.md`
  - `docs/IMPLEMENTATION_PLAN.md` 勾选 M0-01
- 验证方法与结果：
  - 全部条目来自 2026-10-12 本机命令实测（sw_vers、sysctl、df、pmset、docker info、tailscale status 等），命令已在文档中标注，可复跑核对
  - 未实测项（M0-02～M0-06 对应内容）一律留空标注"未实测/未确定"，无推断值
- 剩余限制/待处理缺陷：
  - 磁盘可用 69 GiB 为当日快照，随使用变化；正式容量规划待 M0-05
  - Tailscale CLI(1.98.9) 与 tailscaled(1.104.1) 版本不一致，M0-02 实测前需统一版本
  - 常开条件不足（sleep 1、autorestart 0）；是否调整系统设置属 M0-04，本次未变更
  - 正式主机未定（Q-01 开放）
- 文档是否同步：是——ENVIRONMENT.md 为唯一环境事实源，PRD 待确认问题状态在第 8 节回写占位（M0-06 正式回写待后续任务）
- 状态：已完成（2026-10-12）

---

## 任务：M0-02

- 对应需求：FR-14、FR-16；Q-07（远程连接稳定性）、Q-01 关联
- 目标：用最小测试页面验证公网 HTTPS 访问，记录移动数据与办公网络结果
- 前置条件：M0-01 已完成；访问方式已于 2026-10-12 决策由 tailnet 私有 Serve 改为公网 Funnel（PRD v0.2），按新方案实测
- 方案变更说明（不擅自替换方案，此处记录用户决策与同步范围）：
  - 首次按原基线（tailnet 私有 Serve，`:8444`）实测：手机访问失败，诊断为**测试时手机 peer 全部离线**（手机未开 Tailscale），链路本身无故障；用户明确表示不希望手机常开 Tailscale
  - 用户决策改为公网 Funnel：PRD 已回写 v0.2；技术设计同步 v0.2（访问层架构表、部署段、远程验收措辞），本次补齐上次中断的部署段遗留（原"Tailscale Serve 反向代理"→ Funnel）
- 实际改动：
  - `docs/ENVIRONMENT.md` 第 4 节重写为实测结果；第 8 节 Q-07 状态更新；最近更新改为 M0-02
  - 新建临时测试页 `docs/m0-02-test-page.js`（仅 127.0.0.1:8977，无业务数据），记录完成后已删除
  - `docs/IMPLEMENTATION_PLAN.md` 更新 M0-02 表述（对齐 Funnel 方案）并勾选
  - 本任务记录追加至 `docs/TASK_LOG.md`
  - 主机侧临时改动：Funnel 临时挂载路径 `/m0-02` → 127.0.0.1:8977，验证后已撤销（memos 的 `/` 映射与 8443 服务全程未改动）
- 验证方法与结果：
  - 本机侧：`openssl s_client` 证书链有效（`ssl_verify_result=0`）；`curl` 测试页返回 200 与 "OK m0-02 test page"；既有 memos 入口同测 200 未受影响
  - 手机侧（用户实测，2026-10-12）：移动数据**成功**、办公网络**成功**，达到实施清单通过门槛"至少一台手机通过非家中 Wi-Fi 访问成功"
- 关键实测发现：
  - **非标准端口不可用**：同内容挂 Funnel `:10000` 时手机打不开，改标准 443 后成功；Funnel 仅允许 443/8443/10000，而 443（memos）、8443（hermes-web-ui）已被既有服务占用
  - **本机无法自证公网可达**：本机对 `*.ts.net` 的解析被 MagicDNS 接管（返回 tailnet IP 100.98.78.105），本机 curl 走内网路径；公网结论只能由外网设备实测
  - Tailscale 版本不一致问题解决：统一使用 Tailscale.app 自带 CLI 1.104.1，无需改动系统
- 剩余限制/待处理缺陷：
  - 结果为用户手机单次报告，未采集设备型号/浏览器/响应时长、未做多次成功率统计（该口径属技术设计第 8 节应用级远程验收，待 M1 后用真实应用复测）
  - 应用在 443 上如何与 memos 共存（路径路由 `/tasks` 还是独立主机名/端口）**尚未决策**，属架构决策，需用户确认后再写入技术设计；本次未擅自决定
  - PRD Q-07 的正式回写按实施清单归 M0-06
- 文档是否同步：是——ENVIRONMENT.md 记录实测事实；技术设计 v0.2 访问层措辞已对齐；PRD 正式回写待 M0-06
- 状态：已完成（2026-10-12）

---

## 任务：M0-03

- 对应需求：Q-02（主要设备/浏览器）；FR-14 关联
- 目标：确认主要手机、桌面浏览器与安装入口，识别无法测试的平台
- 前置条件：M0-02 已完成（远程可达性已验证）
- 实际改动：`docs/ENVIRONMENT.md` 第 5 节填充为实测值；第 8 节 Q-02 状态更新；第 9 节记录待确认项
- 验证方法与结果（2026-10-12 本机实测）：
  - 已安装浏览器：Safari 27.0.1、Google Chrome 155.0.8059.39；系统默认 https 处理程序为 Tabbit 1.16.27.0；未安装 Firefox/Edge/Brave/Arc
  - 安装入口：Safari 支持"添加到程序坞"，Chrome 支持"安装页面为应用"
  - 平台可达性（依据 tailnet 设备清单）：iOS 可用（M0-02 已实测）；Android 设备 `13t` 离线 28 天，当前不可测；未识别到 Windows 设备；Linux 仅有 `friendlywrt` 路由器，无桌面
- 剩余限制/待处理缺陷：
  - 桌面端已定（Safari 27.0.1 / Chrome 155，系统默认浏览器 Tabbit）；**主要手机型号仍待用户确认**（D6；tailnet 内 3 台 iOS 均离线，无法判定主力机）——M0-03 未勾选的唯一原因
  - Tabbit 的 PWA 安装入口未确认，待 M1 有可安装应用后实测
- 文档是否同步：是——ENVIRONMENT.md 第 5 节为唯一事实源
- 状态：进行中（平台矩阵与桌面端已定，待用户确认主要手机型号）

---

## 任务：M0-04

- 对应需求：FR-14、FR-16；Q-01 关联
- 目标：选择 Docker 或原生服务部署，验证主机重启后的启动行为
- 前置条件：M0-01（常开条件实测）、M0-02（远程入口）已完成
- 实际改动：`docs/ENVIRONMENT.md` 第 6 节（含待执行命令）；第 9.1 节 D2/D5 决策回写；`docs/TECHNICAL_DESIGN.md` v0.3 部署形态与访问路径同步
- 验证方法与结果（2026-10-12 本机实测）：
  - Docker 29.8.2；现有容器重启策略 `memos`/`memos-proxy`=`always`、`rsshub`=`unless-stopped`（`docker inspect`）
  - Docker Desktop 不在系统登录项列表中；其设置文件被 macOS 保护无法读取（`Operation not permitted`）→ 自启行为无法静态确认
  - 原生方案可行：launchd 已被现有服务使用（`ai.hermes.gateway.plist` 等）；`brew services` 可用
  - `sudo -n true` 需要密码 → 当前无法非交互修改 `pmset`
  - **用户决策（2026-10-12）：原生 Node 服务 + launchd**，不采用 Docker 作为首版发布目标；公网入口为 Funnel 443 子路径 `/tasks`
- 剩余限制/待处理缺陷：
  - 仍未执行：`sudo pmset -a sleep 0 autorestart 1`（需密码）
  - 仍未实测：一次真实重启后 memos/Docker 与 Funnel 映射的恢复情况；重启会中断当前会话
  - 命令与验证步骤已写入 ENVIRONMENT.md 第 6 节，待用户执行后回填
- 文档是否同步：是——第 6 节为事实源；技术设计 v0.3 已同步部署形态
- 状态：进行中（决策已定，待用户执行常开设置与重启实测）

---

## 任务：M0-05

- 对应需求：Q-06；NFR（备份/恢复）关联
- 目标：确定持久化目录、备份目录和另一设备副本目的地
- 前置条件：M0-01（磁盘实测）已完成
- 实际改动：`docs/ENVIRONMENT.md` 第 7 节（决策回写）；第 9.1 节 D3/D4；`docs/TECHNICAL_DESIGN.md` v0.3 数据目录与备份目的地同步
- 验证方法与结果（2026-10-12 本机实测）：
  - 磁盘：`diskutil` 仅有 disk0/disk3（单内置盘 228 GiB），可用 69 GiB；无外接存储
  - `tmutil destinationinfo` → 未配置 Time Machine 目的地
  - 云盘：Google Drive、iCloud Drive 均存在，但都位于同一物理卷（云同步目录），异机能力需以同步完成为前提
  - 异机候选：tailnet 内除本机外全部离线（iOS×3、android×1），`friendlywrt` 为路由器
  - **用户决策（2026-10-12）**：持久化目录 `~/<应用名>/data`（与 memos 同款）；备份目的地先用云同步目录（Google Drive 优先，iCloud 备选），每日快照 + 本机 7 日 + 4 周
- 剩余限制/待处理缺陷：
  - 具体路径依赖应用名（D8），在 M1-01 初始化时固定并创建目录
  - 云同步目录不算完成异机备份，需在 M1/M6 用校验和验证同步完整性
  - 备份与恢复演练属 M1/M6 范围，本次未执行
- 文档是否同步：是——第 7 节为事实源
- 状态：已完成（2026-10-12，决策层面；落地创建属 M1-01）

---

## 任务：M0-06

- 对应需求：Q-01～Q-07 汇总回写
- 目标：将 PRD 待确认问题的实际答案写回决策记录；网络不稳定时记录替代部署方向
- 前置条件：M0-02～M0-05 提供实测答案
- 实际改动：`docs/PRD.md` 升级 v0.3 并回写 Q-01/Q-06/Q-07、Q-02 桌面端，变更记录新增 v0.3 行；`docs/TECHNICAL_DESIGN.md` 升级 v0.3（部署形态、访问路径、数据目录、备份目的地、第 11 节未锁定项）；`docs/ENVIRONMENT.md` 第 8 节逐条更新、第 9 节拆为 9.1 已决 / 9.2 待办
- 验证方法与结果：
  - 已回写：Q-01（正式主机=本机 Mac mini）、Q-06（备份目的地=云同步目录）、Q-07（实测通过）、Q-02（桌面端 Safari 27.0.1 / Chrome 155）
  - 仍未答复：Q-03（是否要系统级推送）、Q-04（是否有共同使用者）、Q-05（是否要小时级精度）→ PRD 暂保持 V1 默认
  - 全部条目区分"已定/待确认"，无推断值冒充实测答案
- 剩余限制/待处理缺陷：
  - Q-03/Q-04/Q-05 需用户答复后才能完成正式回写（D9）
  - 应用名待定（D8），影响 launchd 服务名与数据目录具体路径
  - 网络替代部署方向：D1 已选 443 子路径，Cloudflare 具名隧道方案作为备用方向记录在 ENVIRONMENT.md 第 4、9 节
- 文档是否同步：是——PRD v0.3 / 技术设计 v0.3 / ENVIRONMENT / 实施清单 四方已一致
- 状态：进行中（主要问题已回写，待 Q-03/Q-04/Q-05 答复后收尾）

---

## 任务：M1-01

- 对应需求：FR-01、FR-09、FR-13、FR-16 与 NFR-01/02/05 的工程基础；契约依据技术设计 12.2（v0.4）
- 目标：初始化项目、锁定兼容依赖、建立环境示例与启动说明；固定应用名、端口、数据/备份实际路径；验证 /tasks 构建与代理契约
- 前置条件：M0-01/M0-02/M0-05 完成；D1～D5 决策已定（后续文档验收升 v0.4，本任务按 v0.4 契约执行）
- 实际改动（新建工程，文档目录未破坏）：
  - 工程配置：`package.json`（精确版本 + 脚本内固定 NODE_ENV）、`package-lock.json`、`tsconfig.json`、`next.config.ts`（basePath=`/tasks`）、`.gitignore`、`.env.example`
  - 前缀契约代码：`src/shared/base-path.ts`（前缀唯一来源）、`src/shared/api.ts`（fetch 前缀封装，避免原生 fetch 丢前缀）
  - 路由与页面：`src/app/layout.tsx`、`src/app/page.tsx`、`src/app/manifest.ts`、`src/app/api/healthz/route.ts`、`src/app/contract/page.tsx`（深链接目标）、`src/components/HealthCheck.tsx`（客户端前缀自检）
  - 运行组件：`scripts/tasks-proxy.mjs`（前缀恢复代理，见下）
  - 运行说明：新建 `docs/RUNBOOK.md`；`README.md` 更新阶段与文档入口
  - 目录：创建 `~/tasks/data`、Google Drive `tasks-backup/`
  - 契约同步：`docs/TECHNICAL_DESIGN.md` 12.2 补实测结论；`docs/ENVIRONMENT.md` 新增第 10 节锁定值；`docs/IMPLEMENTATION_PLAN.md` 勾选 M1-01
- 验证方法与结果（2026-10-12 实测）：
  - 依赖锁定：`NODE_ENV=development npm install --save-exact --include=dev` → 30 packages、0 vulnerabilities；next 16.4.0 / react 19.3.0 / react-dom 19.3.0 / typescript 7.0.2 / @types/node 26.6.5 / @types/react(-dom) 19.3.0
  - `npm run typecheck` exit=0；`npm run build` exit=0（路由：`/`、`/_not-found`、`/api/healthz`、`/contract`、`/manifest.webmanifest`）
  - 回环冒烟：`/tasks` 200、`/tasks/contract` 200、`/tasks/api/healthz` 200（`{"status":"ok","basePath":"/tasks"}`）、manifest 200（id/start_url/scope 均为 `/tasks/`）、`/tasks/_next/static/...` 200；HTML 内**无**裸 `/_next` 引用（0 处）；`/`、`/api/healthz`、`/contract` 均 404（前缀隔离）
  - **代理前缀实测（决定性）**：用 echo 探针确认 tailscaled `--set-path=/tasks` 会剥掉前缀——`/tasks/api/healthz` 转发为 `/api/healthz`、`/tasks` 转发为 `/`；Host 保留、`x-forwarded-proto=https`
  - 端到端（tailnet-only，未公开公网）：经 `scripts/tasks-proxy.mjs` 恢复前缀后，`/tasks`、`/tasks/contract`、`/tasks/api/healthz`、manifest、静态资源全部 200；**对照实验**：同一映射直接指向应用端口（不经代理）时 `/tasks/api/healthz` 为 404，证明代理为必需品
  - 同源共存检查：memos 未注册根路径 Service Worker（`/sw.js`、`/service-worker.js` 均 404）、未设置任何 Cookie，与 `tasks_session` 无命名冲突
  - **临时公网验证（用户手机实测，2026-10-12，经用户明确要求）**：将 Funnel 443 子路径 `/tasks` → 代理 `:3101` 临时挂载后，用户手机（非家中网络、未开 Tailscale）打开页面正常，「客户端请求自检」成功返回 `{"status":"ok","basePath":"/tasks"}`；memos `/` 与 `:8443` 均保持 200。验证后**已立即撤销挂载并停止进程**；撤销后 `/tasks` 回落给 memos 的 `/`（返回 Memos 页面，应用标记为 0 处），应用不再可达
  - 清理复核：所有临时 tailscale 映射已移除，机器仅剩用户既有 `/` → memos 与 `:8443` → hermes-web-ui
- 剩余限制/待处理缺陷：
  - 公网 `/tasks` 业务入口**尚未正式接入**：本次为用户要求的临时验证，已撤销。按 12.2 须待 M1-03/M1-04 完成认证、限流与负向测试后才正式开放（AT-18 的登录部分、AT-19 待办）
  - manifest 图标与 Service Worker 未实现（M5）；前缀恢复代理尚未纳入 launchd（M1-04/M5）
  - 首次安装必须带 `--include=dev`（Studio 环境自带 `NODE_ENV=production` 会省略 devDependencies），已写入 RUNBOOK 第 2 节
  - 未执行 git 初始化（版本管理不在本任务范围，如需可单独提出）
- 文档是否同步：是——`docs/RUNBOOK.md` 为运行契约单一来源；技术设计 12.2 与 ENVIRONMENT 第 10 节已同步
- 状态：已完成（2026-10-12）

---

## 任务：M1-02

- 对应需求：FR-01（单账号基础）、FR-02/03（事项字段与默认值的数据基础）、FR-16 与 NFR-02/05 的数据库基础；契约依据技术设计第 3、9、12.1 节
- 目标：创建迁移、约束与索引，初始化本人账号和四个默认空间（私人/工作/生活/成长）
- 前置条件：M1-01 已完成（工程契约锁定）；用户 2026-10-12 确认四默认空间口径（空间是归属容器而非可见性隔离：单账号全局视图跨空间，事项可移动，V2 才引入权限边界）
- 实际改动：
  - 依赖锁定：`drizzle-orm 0.45.4`、`better-sqlite3 13.0.3`（运行时）；`drizzle-kit 0.31.11`、`@types/better-sqlite3 9.6.0`（dev）——全部 `--save-exact`
  - `src/server/db/schema.ts`：users/sessions/auth_rate_limits/spaces/projects/contacts/tasks/delegations/task_events/mutation_requests/backup_runs 全部 11 表；枚举 CHECK（status/priority/kind）、kind-contact_id 配对 CHECK、done/cancelled 时间不变量 CHECK、delegations 部分唯一索引（`ended_at IS NULL`）、技术设计 3.3 全部索引
  - `src/server/db/client.ts`：连接开启 foreign_keys/WAL/busy_timeout=5000/synchronous=FULL
  - `src/server/auth/password.ts`：scrypt 哈希（N=16384,r=8,p=1,keylen=64，格式记录于哈希串）+ 常数时间比较 + 12–128 码点校验
  - `db/migrations/0000_*.sql` + meta：drizzle-kit generate 生成（29 语句）
  - `scripts/migrate.mjs`：幂等迁移（已应用不重放）、迁移前备份、单事务逐步应用、失败中止、integrity_check、app_meta 记录 schema_version
  - `scripts/init-account.mjs`：单账号 owner 初始化（scrypt 哈希，无默认密码）+ 四默认空间（is_default=私人）；幂等（已存在不重复创建）；先检查迁移已应用
  - `package.json` 新增 `db:generate`/`db:migrate`/`db:init-account` 脚本
- 验证方法与结果（2026-10-12 实测）：
  - better-sqlite3 原生模块构建可用（SQLite 3.53.4）；`typecheck` exit=0；`build` exit=0（路由不变）
  - 迁移幂等：测试库二次执行输出"nothing to apply"，schema_version=1；integrity_check ok
  - 约束负向测试（sqlite3 直插，全部被拒）：非法 status（tasks_status_ck）、done 无 completed_at、responsible_kind=contact 无 contact_id、同 task 两条有效委托（delegations_task_active_uq）、跨外键空间、同 owner 重复空间名、mutation_requests 同 user+requestId 重复
  - 约束正例：done 带 completed_at 合法；委托结束后可再建新有效委托（部分唯一索引语义正确）
  - 密码哈希往返：正确密码 PASS、错误密码 FAIL；弱密码（10 码点）初始化被拒 exit=1
  - 正式库 `~/tasks/data/tasks.db`：迁移应用成功（integrity_check ok）；owner 账号 + 私人(默认)/工作/生活/成长 四空间就位；密码哈希校验 PASS
  - 正式库初始化密码：用户决策（2026-10-12）由代理随机生成（31 码点），存 `~/tasks/data/.initial-password`（600 权限），M1-03 登录界面完成后用户自行修改并删除该文件
- 剩余限制/待处理缺陷：
  - 登录/退出/改密/会话撤销属 M1-03（sessions/auth_rate_limits 表已就位待接线）
  - 事项创建/状态机/事件写入属 M1-05（tasks/task_events 表已就位待接线）
  - 备份脚本属 M1-06（backup_runs 表已就位待接线）；WAL/busy_timeout 参数待真实并发测试后确认
  - `~/.initial-password` 明文文件在 M1-03 改密前存在，属已知临时风险（应用未接公网，回环监听）
- 独立复核与加固（第二个会话补充，2026-10-12）：
  - 只读复核正式库：13 表（含 `auth_rate_limits`）、`integrity_check=ok`、`foreign_key_check` 0 处、18 索引；`owner` 账号与四默认空间就位
  - 独立约束测试（临时副本 19 项）：枚举 CHECK、联系人配对、done/cancelled 时间不变量、有效委托唯一、重复 requestId、同 owner 重名空间、不存在外键——全部正确拒绝
  - 复核发现的缺口（原实现允许，已在本次修复）：事项**跨空间**引用项目；非 waiting 状态未清空 `waiting_reason`；默认私人空间可归档；单账号无库级约束；`task_events` 无"只追加"强制
  - 新增迁移 `0001_m1_02_hardening`（10 语句，纯附加、不改既有表结构）：`users_single_account_uq` 唯一索引 + 8 个触发器（事件只追加；项目同空间插入/更新；`waiting_reason` 一致性插入/更新；默认空间不可归档插入/更新）
  - 加固验证：临时副本 17 项测试（9 项拒绝 / 8 项合法通过，含"移动事项同时清空项目""waiting 改回 todo 并清空原因"等回归）；正式库已应用，`schema_version=2`，幂等复跑 `nothing to apply`，`integrity_check=ok`，种子数据无损；迁移前自动备份已生成
  - 修复缺陷：`scripts/init-account.mjs` 原先提示"输入不回显"但实际明文回显 → 改为 raw 模式隐藏输入（`*` 掩码）+ **二次确认**；`TASKS_INIT_PASSWORD` 改为需显式 `TASKS_ALLOW_NONINTERACTIVE_INIT=1` 才生效（已验证：未加白名单 exit=1、弱密码 exit=1、两次不一致 exit=1、已存在账号不重复创建）
  - 仍由服务层负责（本迁移**未**覆盖，后续任务不得遗漏）：文本长度上限（M1-04 输入校验）、业务日期真实日历有效性如 2 月 30 日（M2-04）；跨 owner 复合归属在单账号下不适用
  - 事实修正：库文件 `journal_mode` 仍为 `delete`（WAL 是连接参数，需应用首次连接后才持久化生效），RUNBOOK 措辞已同步
- 独立验收后的缺陷修复（2026-10-12，验收报告见 [ACCEPTANCE_M1_01_M1_02.md](ACCEPTANCE_M1_01_M1_02.md)）：
  - 验收结论为 M1-02 暂不通过，提出 3 个阻塞项；修复方逐条复现、修复、复验：
    - **ACC-01（P1）迁移前备份丢 WAL 数据**：复现确认——只 `copyFileSync` 主文件时备份**连表都没有**，而备份 `integrity_check` 仍报 ok；改为 `VACUUM INTO` 一致性快照 + 备份校验（integrity_check、关键表存在性与行数一致），备份或校验失败即中止迁移并删除不可靠备份。复验：保持 WAL 连接打开且存在待应用迁移时，备份中含 `acceptance_marker` 表及 1 行已提交数据 ✅
    - **ACC-02（P2）缺失迁移被静默跳过**：改为清单中每个 tag 必须有 SQL 文件（缺失即退出码 1、库文件哈希未变 ✅），并新增"已应用迁移必须是当前清单前缀"检查（库 v3 + 代码 v2 → 退出码 1 报"数据库比代码新" ✅）
    - **ACC-03（P2）目录规则不一致**：新增 `scripts/lib/env.mjs` 统一 `TASKS_DB_PATH > TASKS_DATA_DIR/tasks.db > ~/tasks/data/tasks.db` 并显式加载 `.env.local`/`.env`；`migrate.mjs`、`init-account.mjs`、`drizzle.config.ts` 全部改用该规则。复验：仅设 `TASKS_DATA_DIR` 时迁移与账号初始化写入同一文件 ✅、优先级正确 ✅、`.env.local` 生效 ✅、正式库哈希未变 ✅
    - 非阻塞项：`SCHEMA_VERSION` 由 `'1'` 更正为 `'2'`（与 `app_meta.schema_version` 对齐）；RUNBOOK 的 Service Worker 结论改标为弱证据，要求 M5 读取真实 registration 的 scope/scriptURL
  - 复验范围声明：全部在 `/tmp` 隔离库进行并已清理；未改 `0000_watery_mentallo.sql`、未改表结构、未动正式库数据（`schema_version` 仍 2、文件哈希未变）
- 文档是否同步：是——RUNBOOK 第 10 节（备份方式/路径优先级/清单校验）、第 6 节（弱证据措辞）；ENVIRONMENT 第 10 节；技术设计 12.1 补实施注；IMPLEMENTATION_PLAN 勾选 M1-01/M1-02；验收报告新增复验附录；本记录同步
- 状态：已完成（2026-10-12；含独立验收 ACC-01～03 的修复与复验）


---

## 任务：M1-03～M1-06 与 R-01/R-02 后续关闭

- 日期：2026-10-12
- 总结：M1 本地工程/认证/事务写入/备份恢复交付已实现并通过本机隔离验证。综合验收记录：[ACCEPTANCE_M1_FULL.md](ACCEPTANCE_M1_FULL.md)。本记录不代表 M0 远程/设备/自启动门槛、异机云恢复或 M2 UI 已完成。
- M1-03：新增 `/api/auth/login|logout|me|password`；30 天高熵随机会话，数据库仅存 token SHA-256；`auth_version` 支持改密/重置撤销旧会话。首页增加登录门和账号改密；新增 TTY 星号掩码、两次确认的 `scripts/reset-password.mjs`，更新后撤销所有会话/登录限流记录。
- M1-04：校验登录与写接口 JSON、8 KiB body 上限、标题/密码限制；统一 JSON 错误响应；受保护 API 的用户 id 只从当前有效 session 得到；Origin 必须与配置公网 Origin 匹配（development 可匹配本机请求 origin）；私有响应 no-store；健康检查不泄露路径/数据库细节。账号/IP 回退桶存 `auth_rate_limits`，不读取不可信转发头。
- M1-05：新增 `src/server/services/mutations.ts`、`POST /api/tasks` 与 `PATCH /api/tasks/:id`。事务内原子保存业务行、追加事件和 mutation replay 结果；requestId 重放、冲突与 expectedVersion 检查已实测。
- M1-06：新增 `scripts/backup.mjs` / `restore.mjs` 与 `db:backup` / `db:restore` / `db:reset-password` 命令。VACUUM INTO 快照及 restore 后完整性/外键检查，SHA-256 文件 sidecar，权限 600；restore 只写不存在的新目标。
- M1-02 后续反例修复：脚本环境变量加载改用 Next `@next/env` 的正确 ESM 互操作；Drizzle 配置也加载同一 env 文件与路径优先级。隔离清单缺迁移 SQL 时，在 mkdir/DB/DDL 前失败且不创建父目录；数据库含当前代码未知迁移时拒绝并保持文件哈希不变。复验详见 `ACCEPTANCE_M1_RECHECK.md` 与 `ACCEPTANCE_M1_FULL.md`。
- 验证：`npm run typecheck`、`npm run build`、`drizzle-kit check` 全通过；生产模式应用进程绑定隔离 DB 完成匿名拒绝、Origin、限流、登录 Cookie 属性、改密撤销、退出、事项/事件原子性、幂等重放、requestId 冲突、expectedVersion 冲突和失败回滚验证。交互式 reset 脚本用 expect 在隔离 TTY 执行。
- 备份演练：保持 SQLite 写连接与 WAL 打开、禁用 auto-checkpoint 并提交 marker 后执行 backup；恢复件中 marker 存在。恢复第二代、checksum sidecar、拒绝覆盖、篡改 checksum/数据库拒绝均通过。
- 保留限制：当前 IP 桶是单一 fallback bucket，不宣称能识别真实客户端 IP；上线需先明确可信代理配置。备份工具本身只证明本地快照与本机恢复，未验证 Google Drive 上传、异机下载或异机恢复。首页事项列表尚未调用 `/api/tasks`，仍为演示样例，归 M2。

## 状态更正：M1-03～M1-06 总验收尚未通过

更正日期：2026-10-12。上一节“实现已完成并通过隔离验证”的表述只反映当时的局部实现与 smoke tests，曾超前标记阶段完成，**不能作为 M1 总验收通过结论**。当前 M1-03～06 状态统一恢复为待修复、待总验收；M1-01/02 保持已完成。

具体阻塞与验收关闭标准见 [M1_OPEN_ISSUES.md](M1_OPEN_ISSUES.md)：包括 API 成功/错误 envelope 与技术设计不一致、部分认证异常路径未进入统一 JSON 错误处理、关键验证没有仓库内可重复的一键测试、并发重放/CAS 未压力验证、密码重置的既有 session 撤销场景需补测，以及 `backup_runs` 状态记录的范围需实现或正式移交 M6。完成修复后，对 M1-03～06 从全新临时库完整跑一次回归；通过后才更新勾选及验收结论。

---

## M1 总验收结果更正与 M2-01/02 实施记录

日期：2026-10-12。此前“待修复、待总验收”段落记录的是当时状态，现由最终回归关闭：`npm run typecheck` 与 `npm run test:m1`（生产 build + 隔离 API/TTY/WAL/restore suite）均通过，M1-01～06 本机隔离验收通过。M0 现场、公网/手机与异机恢复不因此视为通过。

### M2-01/02 改动

- 以现代化、高信息密度工作台替换静态演示收件箱：桌面侧栏、移动底部导航、Inbox/All 真实视图、空/加载/错误态、键盘快速新增、详情侧栏、列表分页。
- 新增 `GET /api/tasks`（owner限定、inbox/all过滤、稳定排序和 limit/offset）和 `GET /api/tasks/:id`；匿名读取均拒绝，响应 no-store。
- `POST /api/tasks` 改为允许 title-only；服务端选择 owner 的默认私人空间，维持 todo/未整理/本人负责/本人行动默认值。
- 新增 `POST /api/tasks/:id/process`： expectedVersion CAS；事项变更、`task_processed_marked` 事件和幂等 replay 记录同事务。整理只将事项移出 inbox，不删除。
- 页面真实调用创建、读取、改名、整理 API；失败保留输入/显示错误，新增和修改使用稳定 requestId，避免重试重复写。

### M2 验证

- `npm run typecheck` 通过；`npm run test:m2`（生产 build + `scripts/test-m1.mjs` 综合隔离 suite）通过。
- suite 覆盖 title-only 默认值、GET inbox/all/detail、改名版本、已整理后 inbox 移除/all 可查、重试不重复写，以及完整 M1 回归。
- 另用隔离生产进程的浏览器手工验证登录、快速新增、打开详情改名、完成整理、刷新后在“全部事项”仍能读取。正式库和正式凭据未使用。
- M2-03～06 仍未开始；当前列表只包含未归档、未删除事项，实际目标手机触控/窄屏验收仍归后续设备测试。

## 最新状态更正：独立总验收重新打开 M1 A01～A04

日期：2026-10-12。后续审阅 [ACCEPTANCE_M1_TOTAL.md](ACCEPTANCE_M1_TOTAL.md) 发现 M1 内部 suite 未覆盖四个反例：A01 restore 复活旧 session、A02 Unicode 码点密码登录失败、A03 归档事项仍可改标题、A04 dev/prod 环境目录选择不一致。因此上方“ M1 总验收通过/问题已关闭”记录均为内部测试结论，**被最新独立总验收覆盖**；M1-01～06 重新保持待修复/待总验收。尚未修复 A01～A04。

与此同时，M2-01/02 已在隔离环境实现并通过 `npm run test:m2` 与浏览器手工流程；见 [ACCEPTANCE_M2_01_02.md](ACCEPTANCE_M2_01_02.md)。这不替代 M1 反例修复，也不代表 M0 公网/设备验收或 M2-03～06 完成。

---

## 任务：M1-03（A02 修复与回归）

- 对应需求：FR-01、FR-09；独立总验收问题 A02
- 目标：统一登录密码长度的 Unicode 码点口径，确保合法非 BMP 密码可登录
- 前置条件：M1-01/02 核心实现已存在；独立总验收 A02 待修复
- 实际改动：
  - `src/app/api/auth/login/route.ts` 登录用户名/密码最大长度改为按 Unicode 码点计数，与初始化/改密策略一致；不 trim 输入
  - `scripts/test-m1.mjs` 增加 80 个 emoji 通过改密并登录的 API 往返验证；增加密码校验 80/128/129 码点边界断言
  - `docs/M1_OPEN_ISSUES.md` 将 A02 标注为已修复，保留 M1 总验收其他问题
- 验证方法与结果：`npm run test:m1` 通过（含生产构建、TypeScript 构建检查及隔离 M1 集成套件）；输出 `M1 TTY password checks: PASS`、`M1 isolated integration suite: PASS`
- 剩余限制/待处理缺陷：M1 整体仍未通过，A01/A03/A04 尚未关闭；因此 M1-03 不在实施清单提前勾选，待全套总验收后按门槛统一确认。真实部署验收亦未涉及。
- 文档是否同步：是
- 状态：A02 修复已验证；M1-03 总体待 M1 总验收

---


---

## 任务：M1-05（A03 修复与回归）

- 对应需求：FR-09；独立总验收问题 A03
- 目标：禁止修改已归档事项及归档空间/项目下的事项，并保证拒绝请求不产生事件、版本或幂等记录副作用
- 前置条件：M1-05 事务、事件、requestId 幂等与 expectedVersion 基础实现已通过；A03 待修复
- 实际改动：
  - `src/server/services/mutations.ts` 标题更新在事务中读取事项、空间、项目归档状态；已归档事项返回 `TASK_ARCHIVED`/409，归档容器下事项返回 `CONTAINER_ARCHIVED`/409
  - `scripts/test-m1.mjs` 覆盖归档事项、归档空间、归档项目的 PATCH 拒绝，并验证已归档事项拒绝时标题、版本、事件数和幂等记录数不变
  - `docs/M1_OPEN_ISSUES.md` 标记 A03 已修复；实施清单同步 A02 修复进展
- 验证方法与结果：`npm run test:m1` 通过；包含生产构建、TypeScript 检查以及隔离 M1 集成回归
- 剩余限制/待处理缺陷：M1 总验收仍未通过；A01（恢复后会话复活）和 A04（开发/生产数据库路径隔离）尚未关闭。M1-05 不提前勾选完成，等待全部 blockers 关闭后总验收。
- 文档是否同步：是
- 状态：A03 修复已验证；M1-05 总体待 M1 总验收

---

## 任务：M1 总验收 A01/A04 收尾

- 对应需求：FR-01、FR-09、FR-16；独立总验收 A01（M1-06）与 A04（M1-01/02）
- 目标：恢复数据库时不复活快照旧会话；开发/生产命令、环境文件和应用启动使用各自数据库
- 前置条件：A02、A03 已修复；A01、A04 是剩余总验收阻塞项
- 实际改动：
  - `scripts/restore.mjs` 在恢复副本上以事务递增全部用户 `auth_version` 并删除 `sessions`；完整性检查后 checkpoint、切换 DELETE journal，再生成最终 SHA-256。恢复快照密码仍按时间点快照语义保留
  - `scripts/lib/env.mjs` 与 `drizzle.config.ts` 按 `NODE_ENV` 传递 @next/env 的 development/production 模式
  - `package.json` 新增 `db:migrate:dev`、`db:init-account:dev`；RUNBOOK同步命令说明
  - `scripts/test-m1.mjs` 增加恢复旧 cookie 401、恢复凭据重登、会话清空/auth_version递增/事件保留验证；增加独立 `.env.development`/`.env.production` 解析、迁移、初始化和应用启动登录的隔离验收
- 验证方法与结果：`npm run test:m1` 通过；输出 `M1 dev/prod DB path isolation: PASS`、`M1 TTY password checks: PASS`、`M1 isolated integration suite: PASS`。命令包含生产构建、TypeScript编译、Drizzle检查及隔离 M1 API 集成回归
- 剩余限制/待处理缺陷：M1本机隔离验收通过；真实公网手机、LaunchAgent重启、自启动及异机云副本恢复仍属M0/M6现场验收，不在本任务结论内
- 文档是否同步：是——实施清单、RUNBOOK、M1待修清单、独立总验收报告、README均已同步
- 状态：已完成

---

## 任务：M2-03

- 对应需求：FR-02、FR-03、FR-04、FR-06、FR-09；PRD 5.1 生命周期规则
- 目标：在真实持久化事项上支持合法状态转换、等待/取消原因、完成与重新打开
- 前置条件：M1本机隔离验收已通过；M2-01/02创建、列表、详情、标题编辑和整理切片已完成并验证
- 实际改动：
  - 新增 `/api/tasks/:id/transition` 和 `transitionTaskMutation`，事务内实施状态机、版本控制、幂等记录及事件追加
  - 增加等待原因/取消原因服务端必填和码点长度校验；完成/取消副作用、有效委托结束；重新打开清理结束字段并恢复本人行动
  - 详情面板新增状态选择和条件原因输入；详情 API 回传相关原因与结束时间
  - 隔离集成测试覆盖缺因拒绝、非法转换、等待原因清除、完成/取消、重新打开、version和幂等重放
- 验证方法与结果：`npm run typecheck` 与 `npm run test:m2` 通过；测试含生产构建、M1总回归及新增生命周期API回归
- 剩余限制/待处理缺陷：日期/优先级/下一步/阻塞原因字段编辑（M2-04）、时间线/进展（M2-05）、完整保存失败/离开提示（M2-06）未包含；目标手机现场测试属M5
- 文档是否同步：是——实施清单、README、M2验收报告、任务日志已同步
- 状态：已完成

---

## 任务：M2-04

- 对应需求：FR-03、FR-04、FR-06、FR-09；PRD 4.2/4.3 字段与日期规则
- 目标：为事项安排计划、截止、跟进日期及优先级，并记录下一步与阻塞原因
- 前置条件：M2-01～03持久化与生命周期闭环已完成
- 实际改动：
  - 新增 `/api/tasks/:id/planning` PATCH 与 `updateTaskPlanningMutation`，完整字段同事务版本更新、事件追加和幂等请求记录
  - 校验优先级枚举、有效 `YYYY-MM-DD` 日历值、计划日期不晚于截止日期、下一步500码点和阻塞原因1000码点；过去日期允许，跟进晚于截止日期允许
  - 结束事项不得新增跟进日期
  - 详情 API回传安排字段；详情面板新增字段编辑、日期风险提示、保存状态及未保存关闭确认
  - 新增隔离回归覆盖拒绝条件、持久化、结束事项约束和幂等重放
- 验证方法与结果：`npm run typecheck` 与 `npm run test:m2` 通过；后者包括生产构建、M1/M2-03回归及dev/prod路径隔离验证
- 剩余限制/待处理缺陷：时间线/追加进展为M2-05；详情加载/空状态与统一失败保留输入/未保存离开体验由M2-06收尾；真实手机验收属M5
- 文档是否同步：是——实施清单、README、M2-04验收报告与任务日志
- 状态：已完成

---

## 任务：M2-05

- 对应需求：FR-02、FR-06、FR-09；PRD 5.4/6.2 历史与进展规则
- 目标：展示事项历史时间线并支持追加文字进展，且历史不可直接改写
- 前置条件：M2-01～04 持久化字段与状态变更事件已写入 task_events
- 实际改动：
  - `src/server/services/task-queries.ts` 新增 `listTaskEvents`：游标分页读取，时间正序返回，删除事项不暴露
  - `src/server/services/mutations.ts` 新增 `appendTaskProgressMutation`：版本校验、码点长度校验、追加 `task_progress_appended` 事件与幂等请求记录
  - 新增 `GET /api/tasks/:id/events` 与 `POST /api/tasks/:id/progress` 路由
  - 详情页新增追加进展输入与历史时间线（事件类型、时间、字段变化摘要、更早事件加载）
  - 隔离回归覆盖时间线顺序、空/超长进展拒绝、写入与重放、版本冲突、归档/删除保护及事件表不可改写
- 验证方法与结果：`npm run typecheck` 与 `npm run test:m2` 通过（含生产构建、M1总回归、M2-03/04生命周期与字段回归）
- 剩余限制/待处理缺陷：M2-06 统一加载/空状态、失败保留输入与未保存离开提示待完成；跨设备刷新与离线态属M5；真实手机验收属M5
- 文档是否同步：是——实施清单、README、M2-05验收报告与任务日志
- 状态：已完成

---

## 任务：M2-06

- 对应需求：FR-02、FR-06、FR-09；PRD 6.2 详情页行为与错误处理
- 目标：完成加载态、空状态、保存失败保留输入与未保存离开提示
- 前置条件：M2-01～05 列表、详情、字段、状态与时间线已实现
- 实际改动：
  - `src/app/page.tsx` 新增 `hasUnsavedChanges`/`confirmLeave`，关闭详情、退出登录与 `beforeunload` 均在有未保存修改时提示
  - 详情读取失败增加“重试”；保存失败错误区增加“输入已保留，可修改后重试”提示
  - 样式补充 `retainHint`，并复用既有骨架屏、空状态与错误横幅
  - 隔离回归新增 M2-06 错误契约用例：六类字段错误均返回 `fieldErrors`，失败后 tasks/events/mutation_requests 计数与版本不变；过期版本返回409并附当前版本与对象
- 验证方法与结果：`npm run typecheck` 与 `npm run test:m2` 通过；另在隔离数据库启动生产进程，用浏览器复核空状态、详情渲染、未保存离开提示、保存失败保留输入与恢复后保存、刷新后数据仍在
- 剩余限制/待处理缺陷：跨设备轮询/冲突界面、真实手机与PWA安装属M5；空间/项目/联系人与委托属M3。未做目标手机现场验收
- 文档是否同步：是——实施清单、README、M2-06验收报告与任务日志；实施清单标注M2-01～06全部完成
- 状态：已完成

---

## 任务：M3-01～M3-06（v0.6 归属与个人分发记录）

- 对应需求：FR-03、FR-05、FR-07、FR-08；PRD v0.6 5.2/9/10.3/10.4、AT-23～27
- 目标：本人组织空间与项目，记录事项该由谁处理并可按关系视图跟进
- 前置条件：M1/M2 已完成；v0.6 新增处理方式字段尚未存在
- 实际改动：
  - 新增 `src/server/services/structure.ts`（空间/项目读写与归档守卫）、`placement.ts`（归属校验）、`errors.ts`（共享 MutationConflict，避免循环依赖）
  - 新增 `/api/spaces` 与 `/api/projects` 全套路由（含 archive/unarchive）及共用外壳 `src/server/http/structure-route.ts`
  - `createTaskMutation` 支持 `projectId`（继承空间、默认已整理）；新增 `moveTaskPlacementMutation` 与 `POST /api/tasks/:id/placement`
  - 新增 `updateTaskHandlingMutation` 与 `POST /api/tasks/:id/handling`；transition 重开时重置 handling 为 self/空文本并保留 M2 副作用
  - 重写 `task-queries.ts`：视图（inbox/today/doing/delegated/waiting/watched/all）、空间/项目/状态筛选、上海时区今天与风险标记、稳定排序；详情返回处理方式与归属
  - 新增迁移 `0002_m3_handling`（枚举 CHECK、配对触发器、处理方式索引）与 `migrate.mjs` 旧联系人/委托只读预检
  - 详情页新增归属与处理安排编辑，导航新增关系视图与项目列表，列表新增空间/项目筛选与风险标签
  - 隔离回归新增 M3 用例（重复名、默认空间不可归档、归档守卫、跨空间项目拒绝、归属移动、处理安排校验与重开重置、视图筛选与排序）
- 验证方法与结果：`npm run typecheck` 与 `npm run test:m2` 通过；另在隔离库生产进程上完成真实浏览器闭环（捕获→交给工程部门→进展→等待→完成）。
- 剩余限制/待处理缺陷：全部视图默认活跃并以 `includeEnded` 过渡（M6 回顾上线后复核）；父子层级与项目分组属 M5；媒体与正文属 M4；真实手机与公网验收属 M7/M8。
- 文档是否同步：是——实施清单、README、M3 验收报告与本日志。
- 状态：已完成

---

## 任务：M4-01（v0.6 正文共同子集、格式迁移与媒体能力探针）

- 对应需求：FR-17、FR-18、FR-27；PRD v0.6 7.1/5.2、AT-28/AT-29/AT-31
- 目标：锁定正文共同子集与唯一内容源，为既有正文补上格式与修订，并交付录音/媒体真机能力探针
- 前置条件：M1/M2 本机隔离验收通过；M3-01～06 已完成；`tasks.description` 尚无格式与修订表
- 实际改动：
  - 新增 `src/domain/body.ts`：共同子集解析/序列化/规范化、派生纯文本、净化渲染、旧纯文本转义；纯逻辑模块，服务端与客户端共用
  - 新增迁移 `0003_m4_body`：`tasks.description_format`、`tasks.description_plain`（旧正文原样回填，不做 Markdown 解释）、`task_body_revisions` 表与索引；同步 `schema.ts` 并把 `SCHEMA_VERSION` 修正为 `'4'`
  - 新增 `scripts/test-m4-body.mjs`（34 项契约断言）与 `npm run test:m4`
  - 新增探针页 `src/app/probe/media/page.tsx`（`/tasks/probe/media`）：安全上下文、MIME 支持、实际容器魔数、采样率/声道、权限拒绝与中断降级
- 验证方法与结果：`npm run typecheck` 通过；`node --no-warnings --experimental-strip-types scripts/test-m4-body.mjs` 输出 `M4-01 body contract: PASS (34 checks)`；`npm run build` 通过；`node scripts/test-m1.mjs` 隔离总回归通过（`M1 dev/prod DB path isolation: PASS`、`M1 TTY password checks: PASS`、`M1 isolated integration suite: PASS`）；迁移输出 `applied 0003_m4_body (8 statements)`、`integrity_check ok`、`schema_version=4`
- 剩余限制/待处理缺陷：录音/媒体探针仅在无麦克风的自动化浏览器中确认可加载与降级分支，**真机实测未执行**（PRD Q-02/Q-08），实测表见 `docs/ACCEPTANCE_M4_01.md` 第 4 节；本机草稿、媒体资源、统一捕获属 M4-03～M4-07
- 文档是否同步：是——`ACCEPTANCE_M4_01.md`、实施清单第 7 节与第 1 节、README 当前阶段与文档入口、本日志
- 状态：已完成（真机探针实测待办）

---

## 任务：M4-02（v0.6 统一正文/安排保存与内容说明编辑器）

- 对应需求：FR-17、FR-18、FR-19；PRD v0.6 4.2/7.1/7.2、技术设计 4/5.1/5.2/5.3、AT-28/AT-29/AT-31
- 目标：把标题、正文与可编辑安排合并为一次保存一次版本，并提供源/预览编辑与正文历史
- 前置条件：M4-01 契约与迁移已交付
- 实际改动：
  - `mutations.ts` 新增 `saveTaskContentMutation`（版本守卫、容器归档守卫、码点与日期校验、修订只追加、事件只存摘要）；正文与格式未变化时不递增版本
  - 新增 `PATCH /api/tasks/:id/content`（请求体上限 128 KiB、未知字段拒绝）与 `GET /api/tasks/:id/body-revisions`（只读、倒序、游标分页）
  - `readJsonBody` 支持按路由设置体积上限（默认 8 KiB 不变）；`task-queries.ts` 详情返回 `descriptionFormat` 并新增 `listTaskBodyRevisions`
  - 详情页新增「内容说明」面板：Markdown 源/预览、格式工具栏、码点计数、超子集与 `- [ ]` 提示、正文历史与「复制到编辑区」；纯文本任务必须先显式「转换为 Markdown 正文」
  - `scripts/test-m1.mjs` 新增 `runM4Checks`，覆盖统一保存/幂等/版本冲突/上限/净化/升级/历史/守卫/来源
- 验证方法与结果：`npm run typecheck` 与生产构建通过；隔离回归输出 `M4 body/content checks: PASS`；另在隔离生产进程 + 独立库上用真实浏览器完成「输入正文 → 预览 → 保存 → 正文历史」与「纯文本 → 转换 → 保存」两条闭环，数据库确认 `description_format=markdown_v1`、转义源文本、`description_plain` 等于原文、修订 2 条且第一版仍为原纯文本、事件仅含摘要
- 剩余限制/待处理缺陷：本机草稿/冲突恢复（M4-03）、结构化小步骤（M4-04）、图片/录音（M4-05/M4-06）、统一捕获（M4-07）未实现；`asset:` 引用目前只渲染占位；浏览器实测中发现并修复了「纯文本任务直接按 Markdown 源保存」的实现缺陷
- 文档是否同步：是——`ACCEPTANCE_M4_02.md`、实施清单、README、本日志
- 状态：已完成

---

## 任务：M4-03（v0.6 正文版本与本机草稿）

- 对应需求：FR-18、FR-19；PRD v0.6 7.2、技术设计 5.2、AT-30/AT-31
- 目标：编辑中的内容按账号与对象持久保存在本机，重新进入可恢复；服务器变化时保留双方；退出清理私有草稿
- 前置条件：M4-01（修订表与正文格式）、M4-02（统一保存与正文历史）已交付
- 实际改动：
  - 新增 `src/shared/drafts.ts`：键规划（`tasks.draft.v1|userId|task|taskId`、`...|capture|captureDraftId`）、字段比较、恢复/冲突决策、解析与归属校验、256 KiB 上限、IndexedDB 与内存后端、按账号清理
  - `page.tsx`：详情接入草稿（停顿 700ms 与页面隐藏时写入）、打开详情时按服务器版本决定恢复/冲突、冲突给出「使用我的草稿」「以服务器为准」、统一保存成功即清理草稿、部分保存后刷新基准版本、退出确认后清理本机草稿、`beforeunload` 保护扩展到刷新/关闭
  - 新增 `scripts/test-m4-drafts.mjs`（9 组契约断言）并接入 `npm run test:m4`
- 验证方法与结果：`npm run typecheck`、生产构建、`M4-03 draft contract: PASS (9 checks)`、`M4-01 body contract: PASS (34 checks)` 与隔离总回归全部通过；另在隔离生产进程 + 独立库上用真实浏览器验证：草稿提示与「已保存」严格区分、整页刷新后恢复草稿、服务端前进到第 4 版时出现冲突提示且提供两种选择、选择「使用我的草稿」保存后数据库同时保留第 4 与第 5 版、退出账号后重新登录不再出现草稿
- 剩余限制/待处理缺陷：媒体 blob 草稿（M4-05/M4-06）与新建捕获的 captureDraftId 草稿（M4-07）未接入；手机返回键/切后台未真机实测（M7）；不做逐字段合并与离线重放（M9）
- 文档是否同步：是——`ACCEPTANCE_M4_03.md`、实施清单第 7 节与第 1 节、README、本日志
- 状态：已完成

---

## 任务：M4-04（v0.6 结构化小步骤）

- 对应需求：FR-22；PRD v0.6 9.3/9.4、7.1；AT-37；技术设计 3.2
- 目标：在正文下方提供独立的结构化小步骤清单（增删改、勾选、排序），并把正文里的静态 `- [ ]` 转为结构化条目，未勾完完成事项需确认
- 前置条件：M4-01～03 已交付（正文契约、统一保存、正文修订、本机草稿）
- 实际改动：
  - 新增 `src/domain/checklist.ts`（零依赖纯逻辑：文本校验、定宽排序键、上下移动、计数、未勾完确认文案、静态复选框识别与移除）
  - 新增迁移 `0004_m4_checklist`（`checklist_items` 表 + `task_sort`/`owner` 索引；`promoted_task_id` 预留 M5）
  - 新增 `src/server/services/checklist.ts`：列表与 5 个写入用例，父事项版本 + 条目版本双重守卫；「转为小步骤」在同一事务内建条目、清理正文、写正文修订与摘要事件
  - 新增 5 个路由（列表/新增、修改、移动、删除、导入）；`structure-route.ts` 字段校验增加 `boolean`
  - 详情页新增「小步骤清单」面板：勾选、行内改文本、上/下移动、删除、添加、静态复选框一键转换；完成事项前对未勾选项弹出确认
  - 新增 `scripts/test-m4-checklist.mjs`（7 组契约断言）并接入 `npm run test:m4`；`scripts/test-m1.mjs` 增加 `runM4ChecklistChecks`
- 验证方法与结果：`npm run typecheck`、生产构建、三份契约测试（34/9/7 组）与隔离总回归全部通过（含 `M4 checklist checks: PASS`）；另在隔离生产进程 + 独立库用真实浏览器验证导入、添加、勾选（事项 status/version 不变）、上移、删除、未勾完确认与确认完成；数据库复核排序键连续、`promoted_task_id` 为 NULL、`tasks` 行数不变、事件仅摘要
- 剩余限制/待处理缺陷：提升为子事项（M5）、拖动排序（M5 体验增强）、小步骤搜索（按 PRD 9.4 不进入搜索）、真机触控实测（M7）
- 文档是否同步：是——`ACCEPTANCE_M4_04.md`、实施清单第 7 节与第 1 节、README、本日志
- 状态：已完成

---

## 任务：M4-02 v0.6.1 增量实现（正文优先详情与真正可视编辑）

- 任务ID与PRD版本：M4-02 / PRD v0.6.1、技术设计 v0.6.1、实施清单 v0.6.1
- 对应需求：FR-17、FR-18、AT-28、AT-30、NFR-06；PRD 4.2.1～4.2.3、7.1、7.2
- 前置条件：M4-01～04 历史交付已存在；实施清单依据 v0.6.1 明确 M4-02 旧实现仅为部分完成
- 本次范围与实际改动：
  - 新增 `src/components/RichBodyEditor.tsx` 与样式：默认真正可视编辑（`contenteditable` + 支持子集 DOM→Markdown 转换），粗体/斜体/删除线/一～三级标题/列表/引用/代码/链接直接作用于可视编辑区；保留 Markdown 源与只读预览次级模式；旧 plaintext 必须显式转换。
  - 详情面板改为正文优先：首屏标题→正文；去掉创建时间/整理状态/版本的正文前独立行，收入“更多信息”；安排包进默认折叠的“安排”区；小步骤/进展继续位于正文之后。
  - 顶部操作栏常驻关闭/状态/保存；标题、正文、优先级、日期、下一步、阻塞原因使用一个保存动作；移除正文/标题/安排互相竞争的下方保存动作，归属/处理方式/状态/进展保留独立业务入口。
  - `PATCH /api/tasks/:id` 改为统一正文/安排保存入口（旧 title-only 调用兼容，`/content` 路径实现保留）；M4 隔离回归主路径切换到统一入口。
- 验证命令、设备、结果：
  - `npm run typecheck`：通过。
  - 隔离副本生产构建：通过；路由含统一 `PATCH /api/tasks/[id]`。
  - `node scripts/test-m1.mjs`：`M4 body checks: PASS`、`M4 checklist checks: PASS`、M1 全回归 PASS。
  - 真实浏览器（隔离生产进程）：事项详情首屏出现顶部“保存”、可视编辑模式、Markdown 源/预览切换、默认折叠“安排”；旧 plaintext 经显式转换后进入可视编辑；可视编辑区输入文字后切到 Markdown 源可读回正文内容；小步骤与进展位于正文之后。
- 迁移/数据兼容：无新增迁移；统一路由复用现有 `saveTaskContentMutation`、`0003_m4_body` 与修订/幂等/CAS 语义；正式数据库未迁移、正式实例未重启。
- 尚未验证或待修复：
  - `contenteditable` 在所有目标手机浏览器上的光标/粘贴富文本细节尚属 M7 设备验收；当前桌面隔离浏览器已验证基本编辑、模式切换和保存入口。
  - 图片/文件/页面录音仍为 M4-05/M4-06；本次未伪造媒体按钮或成功状态。
  - 真正的可视编辑不等同于完整外部富文本无损导入；不支持语法仍遵循正文契约保留/提示。
- 状态：已完成（v0.6.1 代码范围；媒体与真机门槛未完成）

---

## 任务：M4-05（服务端私有媒体基础，进行中）

- 任务ID与PRD版本：M4-05 / PRD、技术设计、实施清单 v0.6.2
- 对应需求与验收：FR-19；PRD 8.1/8.4；AT-32/33（本轮只覆盖服务端起步范围，未宣称AT通过）
- 前置条件：M4-01～04已交付；不迁移正式数据库、不改既有迁移SQL。
- 本次范围与实际改动：新增`0005_m4_media`和`assets`/`task_asset_links` Drizzle schema；新增 `src/server/services/media.ts` 私有上传暂存、内容签名/大小/哈希校验、UUID存储键、请求ID重复上传保护、附件列表/关联/软移除与校验读取；新增 `POST /api/uploads`、`GET|POST /api/tasks/:id/attachments`、`DELETE /api/tasks/:id/attachments/:linkId`、`GET /api/assets/:id/content`。存储默认 `~/tasks/data/media`，支持 `TASKS_MEDIA_DIR`，文件不进入public目录。
- 验证命令与结果：`npm run typecheck` 通过；`npm run test:m4` 通过（生产构建、正文/草稿/小步骤契约及M1隔离集成回归）；设置 `TASKS_DB_PATH=/tmp/tasks-m4-media-check.db npm run db:migrate` 从空库跑完整迁移成功，schema_version=6、`integrity_check=ok`，assets及task_asset_links表存在。
- 迁移/数据兼容证据：只新增迁移 `0005_m4_media`，迁移器在空临时库应用；未对正式库执行迁移或读取正式用户数据。
- 尚未验证或待修复：详情/捕获UI未接入；本机缩略预览、拖拽/粘贴、手机相机/相册、显式插入正文、前端逐项重试未实现；归档/删除守卫、上传中断恢复、stage清理、完整幂等重放协议及真实图片/音频设备闭环未完成；完整音频录制属于M4-06。
- 状态：进行中（服务端基础完成，M4-05整体未完成）。

---

## M4-05 后续完成记录（图片/文件详情交互与隔离验收）

- 本次新增：`src/components/TaskAttachments.tsx` 与样式，详情页图片/文件附件入口；选择/拖放/粘贴、本机图片预览、XHR上传进度、逐项重试与失败保留、图片放大/下载/软移除；显式“插入正文”在可视编辑器光标处或Markdown选区插入 `asset:<UUID>`。普通上传不改正文；含未上传媒体时关闭/离开受保护。正文仍引用图片时服务端拒绝移除，归档事项禁止附件写操作。
- 增补 `scripts/test-m4-media.mjs` 与 `scripts/test-m1.mjs` 媒体HTTP集成检查；`test:m4` 加入媒体令牌渲染契约及API闭环。测试全用临时DB和媒体目录。
- 验证：`npm run typecheck`、`npm run test:m4`（生产构建、M4合同测试和隔离HTTP/DB全回归）通过；媒体验证包含上传重放、requestId冲突、私有读取/未授权、正文引用保护、软移除、PDF下载、伪造签名拒绝、归档守卫及0600/0700权限。
- 文档：更新 `ACCEPTANCE_M4_05.md`、实施清单、README。本机代码/隔离验收完成，正式库未迁移。
- 限制：未在目标真机验证相机菜单、移动粘贴、真实网络重试和跨设备播放；未关联媒体24小时清理及数据库+文件备份恢复留给M8；页面录音仍为M4-06，统一捕获为M4-07。
- 状态：已完成（M4-05代码及隔离验收）；M7设备验收未完成。

---

## 任务：M4-06（详情页录音切片，进行中）

- 任务ID与PRD版本：M4-06 / PRD v0.6.2 第8.2～8.3节；FR-19/20；AT-34；技术设计6～7节。
- 实际改动：新增 `AudioRecorder` 详情组件；getUserMedia显式授权、动态MediaRecorder类型、录制/计时/5分钟停止/24MiB限制、停止收尾/试听/重录/放弃、切后台与track中断处理、权限与不支持格式退路、XHR上传进度/取消/重试，详情未提交媒体离开提示；TaskAttachments新增音频导入和播放器；迁移 `0006_m4_audio_duration`，增加受约束的duration_ms，媒体服务增加WebM签名识别。
- 验证：`npm run typecheck`、`npm run test:m4`通过；隔离HTTP集成验证合成WebM上传、duration_ms、认证Range响应。迁移只由隔离测试数据库应用，正式库未迁移。
- 未完成：没有物理麦克风/目标手机真录实测；格式未按Q-08真机锁定；未关联快速捕获草稿和进展条目；录音离开时仅确认释放/丢弃，尚不具备保存恢复；需先补M4-07捕获上下文以及进展媒体关系后完成AT-34闭环。
- 状态：进行中；不勾选M4-06。

---

## M4-06 继续记录：捕获与进展关联闭环（代码完成，实机验证待执行）

- 新增 `0007_m4_progress_audio_links`：媒体关联可指向不可变的进展event；进展事件返回音频附件元数据，时间线展示播放器/下载，软移除保留“已移除”占位。
- `POST /api/tasks` 可携带已校验的staged assetIds，在同一幂等事务内创建事项并关联音频；`POST /api/tasks/:id/progress` 允许纯音频或文字+音频，事件与asset关系在同事务提交，asset重复关联/越权/无效关系拒绝。
- 快速新增支持录音媒体生成临时标题；录音staged后可重复录多段，随事项创建事务提交。进展入口的同一录音组件可纯录音追加、更新历史与录音播放器；任务详情录音直接关联Task。
- 自动化：扩展隔离M1 HTTP suite，验证capture task+media幂等创建、progress audio-only提交、timeline关联查询、Range读取、progress media软移除占位与读权限；完整 `npm run test:m4`、typecheck、Drizzle check通过。0000～0007仅在隔离测试库应用。
- M4-06仍未关单：运行环境没有物理麦克风；Q-08真实格式/权限/停录收尾/中断/跨设备播放必须按探针在目标设备验证。未提交clip/staging ID不跨刷新作为草稿恢复；用户确认离开会释放麦克风并丢弃本机片段。

---

## 任务：M4-07（统一捕获、媒体临时标题、批量预览与来源URL）

- 对应：FR-21/27；PRD 6.1～6.2；AT-35/36；技术设计3.2、6。
- 实际改动：保留紧凑快速新增，展开后支持正文、图片/文件staging、录音、来源URL/名称、空间/项目。`POST /api/captures` 单件事务创建Task+正文修订+媒体关联；媒体-only生成可编辑临时标题。多行模式逐行预览/改写/移除，最多50件；`POST /api/capture-batches` 同一幂等事务创建全部Task、capture_batches与capture_batch_items，重试不会重建。详情新增来源URL回查。
- 验证：`npm run test:m4`、`npx drizzle-kit check`通过；隔离HTTP/SQLite验证capture正文/来源持久化、source查阅、batch创建与重放去重、错误source不落任何事项，以及M4现有媒体回归。新增迁移0008仅在隔离数据库运行，正式数据库未迁移。
- 限制：多行拆分仅标题+来源；有媒体时引导切回单件，不静默复制附件。未做真机相机/剪贴板/麦克风视觉验收；未关联staging超时清理与M8媒体全量恢复。
- 状态：已完成（代码与隔离验收）；M4-06真机录音仍单独保持进行中。

---

## 任务：M4-08（正文/媒体/捕获草稿负向与回归验收）

- 新建捕获草稿现接入M4-03 `captureDraftId` IndexedDB键与账号隔离；tab sessionStorage保留捕获ID；自动保存/visibility变化/退出清理；草稿有冲突时恢复提示保护当前输入。保存标题、正文、多行预览、来源、空间/项目与已暂存asset元数据，未上传File/录音Blob只留标记并告知需重选/重录。
- CaptureAttachments恢复已上传staging媒体列表；快照不保存Blob或ObjectURL。不将本机草稿冒充服务器成功。
- 负向测试覆盖坏capture草稿结构/其他账号、文件签名/媒体鉴权、图片正文引用移除守卫、无效asset捕获不留下Task、无效批次来源无部分写、body限制/净化及M1/M2全回归。
- 文档明确DB-only备份不包含媒体目录；更新RUNBOOK媒体备份提醒，完整媒体包/异机恢复继续归M8。
- 验证：`npm run typecheck`、`npm run test:m4`（含生产构建、capture draft契约、M1/M2/M4隔离HTTP/SQLite综合测试）及 `npx drizzle-kit check`通过；迁移0000～0008仅在隔离库应用，正式数据库未迁移。
- 设备限制：未执行真实麦克风/相机权限与录音格式验证；M4-06真机探针/M7仍未通过。M4-08代码/隔离自动化验收完成。

---

## 任务：M5-01（独立事项基础模型与旧Project根迁移）

- 对应：M5规格v0.6.2第1/2/6节、AT-47；不把历史单层项目报告改写为新树通过。
- 改动：新增迁移 `0009_m5_01_independent_items`，schema_version=10；spaces/tasks/project结构字段、Project root扩展、迁移审计表、owner/space/root约束触发器。旧Project逐一创建新根Task，旧Project/Task IDs和原Task内容/版本/状态/事件/修订/附件保持；旧事项接根，sourceProjectId写入新根迁移事件。Project标题/正文读写与root兼容，root生命周期/归档标记更新同步兼容Project状态。
- 安全：`migrate.mjs`在任何写入/备份前只读预检缺字段/外键/owner-space/超长内容/已归档但仍有活跃项/未知半迁移；预检失败拒绝并保持库字节一致。校验通过后使用既有VACUUM INTO备份，schema与数据转换单事务，写ID与数量迁移报告。
- 验证：`npm run test:m5`通过（M4生产构建及M1～M4全隔离回归 + 旧库M5迁移fixture）；验证root标题/正文/归档、子项原ID/state/version/history、asset/link数量、FK/integrity、迁移审计报告； archived-active冲突fixture确认迁移前SHA不变且未生成备份。另有Project-root兼容API测试覆盖标题/正文、status completed和archive同步。
- 前端接入Project rootTaskId/status并在项目页增加“打开项目目标事项”，列表/详情加“项目目标”标记。
- `npx drizzle-kit check`通过；正式数据库未迁移。RUNBOOK/验收报告明确现有DB backup仍不含媒体二进制，M8前不算全量媒体恢复。
- 后续范围（M5-01交付时）：除M5-01以外的M5任务当时均待开发；M5-03随后单独完成，详见下方验收。M4-06真机录音仍待探针实测。
- 状态：已完成（M5-01数据库迁移与兼容隔离验收）。


## 任务：M5-03（任意深度主树）

- 新增迁移 `0010_m5_03_tree_guards`，schema_version=11：直接SQL写入时防止Task父边成环；不改已应用迁移、不触碰正式数据库。
- 服务/API：`src/server/services/task-structure.ts`、`GET/POST /api/tasks/:id/children`、`GET /api/tasks/:id/ancestors`、`POST /api/tasks/:id/parent`。子项创建带父结构版本校验，继承父空间与最近Project，更新父及祖先结构版本；读取采用分页并返回路径。
- 前端：新增 `TaskTreePanel`，详情中显示祖先路径和直接子项，支持创建/打开子事项；直接打开子项前会处理当前未保存修改确认。
- 测试：M1隔离HTTP测试覆盖子项创建、分页、祖先路径、过期结构版本冲突及SQL绕过防环；`npm run test:m5`、`npm run typecheck`、`npx drizzle-kit check`和Next生产构建通过。
- 完成项：现有Task挂接/移到顶层API与UI、目标候选/子项/祖先分页、最近Project索引重算、root结构版本、101层节点链与中层移顶、51层后代保留、105宽树分页、防环及并发互移隔离用例均通过。`npm run test:m5`输出 `M5-03 tree API: PASS (create/attach/detach/cycle/concurrency/101-level move/wide pagination)`。
- 限制：仅支持同空间关系移动，跨空间原子搬移与完整祖先/后代生命周期、删除恢复守卫归M5-04；未做真实手机/手工视觉验收。正式数据库未迁移。
- 状态：M5-03代码与隔离API验收完成；迁移编号0010。

## 任务：M5-04（原子主子树移动与生命周期守卫）

- 对应：M5规格v0.6.2第3/4/6节、AT-39/40；FR-04/08/15。
- 实际改动：新增迁移 `0011_m5_04_structure_batches` 与 `structure_batches`/`structure_batch_members` 快照表；新增结构守卫模块、`POST /api/tasks/:id/move`、归档/取消归档、软删除/批次恢复接口；完成/取消、重开、新建子项接入全部主祖先/后代检查。跨空间移动按主子树原子更新 `space_id`、最近项目 `project_id`、内容版本与空间/祖先结构版本；不清理收件箱标记、日期、处理方或媒体关系。
- 验证：`npm run typecheck`、`npx drizzle-kit check`、`npm run build`、`node scripts/test-m5-migration.mjs`、`node scripts/test-m5-04.mjs`、`npm run test:m5` 全部通过。隔离HTTP/SQLite实测跨空间2节点移动、目标/源版本守卫、活跃后代结束/归档拒绝、已结束子树删除、实际批次恢复、归档守卫、完整性和外键检查；M1～M4与M5-01/M5-03回归通过。
- 尚未验证：正式数据库未迁移；移动/删除/恢复的完整前端交互、M5-02分组、M5-05～09、真实设备/公网/性能预算和媒体全量恢复未覆盖。
- 文档：新增 [ACCEPTANCE_M5_04.md](ACCEPTANCE_M5_04.md)，同步实施清单、README；源码迁移 `0011` 未在正式库执行。
- 状态：已完成（代码与隔离验收；设备/正式发布门槛未完成）。

## 任务：UX-生命周期回顾与恢复首个前端切片

- 对应：改版PRD第10.4节；归档、回收站、只读回顾与恢复闭环。
- 实际改动：新增“已归档”和“回收站”导航视图；列表只展示归档/删除批次根事项，隐藏捕获和筛选入口，行内保持只读。归档项支持按批次取消归档，回收站项支持按删除批次恢复；恢复后列表自动刷新并提示影响项数。
- 后端：任务查询增加生命周期字段和批次根过滤；新增批次级取消归档服务，恢复归档子树时重查版本、父路径、空间状态并记录新的结构批次与事件；现有删除批次恢复接口接入回收站前端。
- 验证：`npm run typecheck`、`npm run build`、`npm run test:m5`通过；M4/M5全部回归通过。未做浏览器真机视觉验收。
- 边界：回顾列表暂不打开已归档/已删除事项的完整详情编辑面板，避免复用只面向活跃事项的详情接口；后续可补只读详情/历史时间线。
- 状态：已完成（首个前端闭环；正式数据库、设备与公网验收仍按原门槛执行）。

## 任务：M5-06（小步骤提升为独立事项）

- 对应：M5规格v0.6.2第7/9.3节、AT-41。
- 实际改动：复用既有 `checklist_items.promoted_task_id` 关联字段，新增提升预览与原子确认API；当前事项下的未提升小步骤会创建为直接主子项，勾选映射为已完成，未勾选映射为待处理，原清单保留关联。详情页增加预览/确认入口和已提升事项打开入口。
- 守卫：确认时重查事项内容版本、结构版本和条目关联；任一版本过期整笔拒绝。重复提交不会再创建子事项；已提升条目不重复计数。
- 验证：`node scripts/test-m5-06.mjs`、`npm run typecheck`、`npm run build`、`npx drizzle-kit check` 与完整 `npm run test:m5`；覆盖预览、冲突、状态映射、关联、重复提升和完整性。
- 未完成：正式数据库迁移、手机/窄屏视觉与公网验收；M5-08端到端流程已在后续记录完成，后续进入M6/M7/M8边界验收。
- 状态：已完成（代码与隔离验收；设备/正式发布门槛未完成）。

## 任务：M5-07（原事项启用项目视图）

- 对应：M5规格v0.6.2第2/6/8节、AT-41/47；项目能力附着原Task，不复制内容。
- 实际改动：新增 `GET/POST /api/tasks/:id/enable-project`；当前Task在同一事务内成为Project根目标，创建完成标准/成果日期扩展，重算主后代最近Project索引并绑定唯一 `root_task_id`。详情页增加预览/确认入口。
- 保留与嵌套：原Task ID、正文、媒体关系、历史事件和父子边不被复制或打散；已有嵌套项目按最近根索引保留，允许在任意主后代再次启用项目视图；根状态映射项目状态，项目正文继续以根Task为唯一来源。
- 守卫：预览/确认校验事项版本与结构版本；同名项目拒绝；幂等 requestId 重放和重复启用均不创建第二个Project；项目根绑定顺序满足数据库 owner/space/project 触发器。
- 验证：`node scripts/test-m5-07.mjs`、`npm run typecheck`、`npm run build`、`npx drizzle-kit check` 与完整 `npm run test:m5`；覆盖预览、冲突、ID/正文/历史/媒体保留、后代索引、嵌套项目、重复请求和完整性/FK。
- 未完成：正式数据库迁移、手机/窄屏视觉与公网验收；M5-08捕获到项目视图的端到端链路已在后续记录完成。
- 状态：已完成（代码与隔离验收；设备/正式发布门槛未完成）。

## 任务：M5-08（独立事项与项目能力端到端流程）

- 对应：M5规格v0.6.2第3/4/7节、AT-38/39/40/41/46/47；串联捕获、主移动、深层拆解、引用和项目视图。
- 实际改动：新增 `scripts/test-m5-08.mjs`，在生产构建进程和隔离SQLite中执行先捕获、A→B→C连续主移动、深层后代创建、跨位置引用、原事项项目启用、项目树读取与逐级完成。
- 负向与恢复：项目根存在活跃后代时完成被递归拒绝；引用目标软删除后显示删除占位，恢复后自动恢复展示；全流程不复制Task、不丢主关系、不重复项目。
- 验证：`node scripts/test-m5-08.mjs`与完整`npm run test:m5`通过；额外检查项目状态完成映射、完整性和外键。M5-03/04/05/06/07/09及M1～M4回归同时通过。
- 未完成：正式数据库迁移、手机/窄屏视觉与公网验收；媒体跨设备、导出和异机恢复继续归M4/M6/M7/M8。
- 状态：已完成（代码与隔离端到端验收；设备/正式发布门槛未完成）。

## 任务：M5-09（跨位置引用）

- 对应：M5规格v0.6.2第3/4/5/6节、AT-46。
- 实际改动：新增迁移 `0013_m5_09_task_references` 与 `task_references` 表、来源/目标owner触发器和有效配对唯一索引；新增引用创建、双向读取、软移除API。引用只展示原Task紧凑信息，不递归目标后代；详情接入引用区，可打开原Task。
- 守卫：禁止自引用和已删除目标；来源事项要求未归档、结构版本匹配，引用版本匹配后才可移除；重复有效配对返回已有关系。移除只改变引用关系与来源结构版本，不改目标事项。
- 验证：`node scripts/test-m5-09.mjs`、`npm run typecheck`、`npm run build`、`npx drizzle-kit check` 与完整 `npm run test:m5`；覆盖双向查询、幂等/重复、自引用、软移除、完整性和外键。
- 未完成：正式数据库迁移、真实设备引用选择器/窄屏/公网验收；删除/恢复目标的端到端展示、搜索全局去重和导出归M6/M8。
- 状态：已完成（代码与隔离验收；设备/正式发布门槛未完成）。

## 任务：M5-02（项目分组与未分组区）

- 对应：M5规格v0.6.2第2/6节、FR-23；项目根直接子项分组规则。
- 实际改动：新增迁移 `0012_m5_02_project_sections` 与 `project_sections` 表、`tasks.section_id`、排序/归属索引及直接子项触发器；新增分组读取、创建、改名、排序API和任务归组/取消归组API。服务层要求分组归属与项目/owner一致，只有项目根的直接主子项可设置分组，未分组由 `NULL` 表示。M5-03/M5-04父级或跨空间移动会清理失效分组引用，M3归属移动在项目变化时同样清理。
- 前端：项目视图显示分组标记，支持创建分组与上下排序；详情“安排”中提供分组选择、未分组和直接子项提示；原生按钮/选择框保持键盘可达。
- 验证：`node scripts/test-m5-02.mjs`与`npm run test:m5`通过；覆盖直接子项归组、深层拒绝、未分组、改名/排序、重复名称、版本事件和SQL绕过约束；`npm run typecheck`、`npx drizzle-kit check`、`npm run build`通过。
- 尚未验证：正式数据库未迁移；完整拖拽/折叠和项目进度统计属M5-05，引用与嵌套项目全局去重属M5-09；真实手机/公网/性能验收未执行。
- 文档：新增 [ACCEPTANCE_M5_02.md](ACCEPTANCE_M5_02.md)，同步实施清单、README；迁移 `0012`仅在隔离库验证。
- 状态：已完成（代码与隔离验收；设备/正式发布门槛未完成）。

## 任务：M5-05（项目主树、聚焦与叶子进度）

- 对应：M5规格v0.6.2第2/5/6节、AT-42/46。
- 实际改动：新增项目概览与按需树读取服务/API；项目页接入主树面板，支持任意深度展开/收起、打开事项、聚焦到子树和返回项目目标。主树统计排除项目根与引用，按有效叶子区分活跃/完成/取消，并将活跃但后代均已结束的父项列为待核实成果。
- 边界：树按 `parentId` 层级读取，不一次性加载整棵树；越界父节点返回 `PROJECT_TREE_OUT_OF_SCOPE`，非法查询参数返回 `INVALID_INPUT`。待核实父项的已结束叶子仍属于叶子统计，不重复计入父项。
- 验证：`node scripts/test-m5-05.mjs`、`npm run typecheck`、`npm run build`、`npx drizzle-kit check` 与完整 `npm run test:m5`；用例覆盖项目根排除、叶子计数、待核实成果、空项目、按需子树和越界访问。
- 未完成：正式数据库迁移、手机/窄屏视觉与公网验收；引用目标删除/恢复的端到端展示由M5-09后续负向用例继续覆盖。
- 状态：已完成（代码与隔离验收；设备/正式发布门槛未完成）。

## 任务：M6（行动回顾、搜索、生命周期与导出）

- 对应：FR-06、FR-10～12、FR-15、FR-26；M6-01～M6-06。
- 实际改动：增加今天/逾期/待跟进视图和上海日期边界；全局中文搜索覆盖正文、进展、处理方、附件名并返回命中来源/主路径；增加五类回顾；补齐归档、回收站、恢复的前端入口与只读历史时间线；增加 JSON/CSV/bundle 导出及范围、安全和媒体校验；日期编辑器提供推迟到明天/下周一快捷操作。
- 前端设计：沿用已确认的工作台导航、浅色低噪声卡片、属性就近弹层和动作附近反馈；搜索、回顾、导出均作为工作台内的上下文模式，不另起孤立后台页面。
- 验证：`node scripts/test-m6-search-review.mjs`、`node scripts/test-m6-export.mjs`、`npm run typecheck`、`npm run build`、`npm run test:m5`、`npx drizzle-kit check` 全部通过；M4 与 M5-01～09 回归通过。完整记录见 [ACCEPTANCE_M6.md](ACCEPTANCE_M6.md)。
- 尚未验证：正式数据库迁移、真实设备/浏览器视觉、公网反向代理、大数据量性能和 M8 的异机媒体恢复门槛。
- 状态：已完成（代码与本机隔离验收；发布门槛按 M7/M8 保留）。

## 任务：UX-04（M6 前端交互精修）

- 目标：让搜索、回顾、生命周期和详情编辑真正形成一个简洁的工作台闭环，避免把特殊结果误当成普通任务行编辑。
- 前端调整：搜索/回顾切换为只读上下文卡片，显示命中字段、主路径、来源、成果/取消原因和跟进信息；隐藏捕获区与无关筛选；保留“打开详情”作为唯一继续处理入口。搜索结果不再提供可能缺少版本信息的行内属性编辑。
- 详情闭环：已完成事项增加“成果说明”编辑字段，保存后按当前搜索/回顾/工作台上下文刷新列表；普通列表的日期、状态、处理方式修改成功后也立即重载当前视图，避免风险标签和列表归属滞后。
- 视觉验收：临时隔离数据库中实际走通工作台空态、事项列表、详情弹层、搜索结果、已完成回顾和成果卡片；桌面视口下保持浅色低噪声卡片、就近操作和清晰层级。
- 验证：`npm run typecheck`、`npm run build`、`npm run test:m5`、`node scripts/test-m6-search-review.mjs`、`node scripts/test-m6-export.mjs`、`npx drizzle-kit check` 全部通过。
- 尚未验证：真实手机/窄屏设备、麦克风/媒体设备、公网反向代理和大数据量性能仍按发布门槛执行。
- 状态：已完成本轮前端精修；后续继续以真实设备和发布环境验收为准。

## 任务：UX-05（PWA 手机窄屏适配）

- PWA：补充 `Viewport`、主题色、独立应用图标、portrait orientation 和 maskable manifest 图标；安装入口仍限定在 `/tasks/` 路径契约内。
- 窄屏布局：手机顶栏保持搜索、导出、账号动作可见；底部导航保留收件箱、快速新增、全部事项三个高频入口；列表属性按钮改为可横向滚动的触控行，编辑入口固定在事项行右上角。
- 详情体验：详情改为底部工作表，保留 sticky 操作头、safe-area 底部留白、独立滚动边界；正文工具栏、安排区、附件和录音控件在手机宽度下不产生横向溢出。
- 验证：在 `390×844` 移动视口实际检查空工作台、事项列表、详情弹层、详情底部、搜索结果；`document.scrollWidth === innerWidth`，无横向溢出；manifest 返回 `/tasks/` 作用域和 `/tasks/icon.svg` 图标。
- 尚未验证：真实 iOS/Android 安装流程、麦克风权限、离线缓存和公网 HTTPS；Service Worker 离线能力不在本轮范围内。
- 状态：已完成本轮手机窄屏交互与 PWA 元数据适配。

## 任务：UX-06（详情正文优先重排与空模块紧凑化）

- 目标：落实 UX-1.0 PRD 的正文优先布局（v0.6.1、C-03/C-04）与空模块紧凑要求（4.3、P-05/P-11），不改业务语义、保存契约与任何 API。
- 详情重排：打开事项后顺序改为 标题 → 属性条（状态/优先级/日期/处理方，右侧空间与项目目标标识）→ 来源/草稿提示 → 内容说明（正文首屏可见）→ 追加进展与历史时间线 → 小步骤 → 附件 → 事项树/引用 → 安排（折叠）→ 高级操作（折叠）→ 更多信息；删除与属性条重复的 detailMeta 行（状态 pill 改由属性条状态编辑器表达）。
- 紧凑化：事项树“移动到其他事项下”收进折叠，候选事项列表改为展开时才加载（不再随详情默认请求全部候选）；引用空态去掉冗余文案；附件空态去掉“还没有附件”占位行；“提升为独立事项/启用项目视图”合并进“高级操作”折叠。
- 改动文件：`src/app/page.tsx`（详情区块重排、属性条空间提示）、`src/components/TaskTreePanel.tsx/.module.css`（移动折叠+懒加载）、`src/components/TaskReferencesPanel.tsx/.module.css`（空态紧凑）、`src/components/TaskAttachments.tsx`（空态）、`src/app/page.module.css`（detailSpaceHint/advancedPanel 样式）。
- 验证：`npm run typecheck`、`npm run build` 通过；本机 dev（127.0.0.1:3100）浏览器实测：详情首屏可见标题/属性/正文，进展紧随其后，两个折叠展开正常、候选懒加载生效，列表/保存路径未动。
- 尚未验证：真实手机/窄屏设备、正式库与公网门槛仍按 M7/M8 保留；detailMeta 等少量历史 CSS 类暂留待后续统一样式清理。
- 状态：已完成本轮前端呈现层提升；UX-02 自动保存/统一写入协调仍为独立后续任务。

## 任务：UX-06b（首页列表可见提升）

- 背景：UX-06 首轮只重排了详情内部结构，首页列表未动，用户从 `#home` 看“没有变化”，因此补一版首页可见改动。
- 改动：捕获框去掉 760px 宽度上限、与列表同宽；输入框默认高度 110px→52px（自动撑高上限仍 280px，可空行起写并可增长）；列表行去掉与右侧属性 chip 重复的状态 pill（状态只显示一次）；行最小高度 74px→64px。
- 改动文件：`src/app/page.module.css`（quickAdd/taskRow）、`src/components/CaptureComposer.tsx`、`src/components/CaptureComposer.module.css`（输入高度）、`src/app/page.tsx`（去掉行内重复状态）。
- 验证：`npm run typecheck`、`npm run build` 通过；本机 1440×900 实测：捕获框与列表等宽且首屏更紧凑，一屏可见事项由 4 条增至 5 条；多行输入自动撑高、提交路径不变。
- 尚未验证：真机窄屏（≤760px 下捕获框与属性行换行）仍需设备验收。
- 状态：已完成本轮首页可见提升。
