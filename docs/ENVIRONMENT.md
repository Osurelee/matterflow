# 环境与可达性记录（M0）

依据：[实施清单](IMPLEMENTATION_PLAN.md) M0-01～M0-06。本文件记录实测事实，供后续里程碑引用；实测值随任务推进更新，未实测项不填写。

文档验收注（2026-10-12）：以下保留原实测记录。本次未重测；`/m0-02`测试页成功不代表正式`/tasks`应用通过；LaunchAgent须区分登录前后运行情况；云目录本机文件存在不代表远端副本可恢复。当前实施口径见[技术设计](TECHNICAL_DESIGN.md)第12节及[验收报告](DOCUMENT_REVIEW.md)。

- 最近更新：2026-10-12（M0-01/M0-02/M0-05 完成；M1-01 工程契约已锁定，见第 10 节；M0-03/M0-04/M0-06 待办见第 9.2 节）

- 最近更新：2026-10-12（M0-01/M0-02 已完成；M0-03～M0-06 取证完成，D1～D5 决策已定，剩余待办见第 9.2 节）

## 1. 开发环境（当前 Mac，实测）

| 项目 | 实测值 | 采集命令 |
| --- | --- | --- |
| 机型 | Mac mini (Macmini9,1)，名称 "Sure's的Mac mini" | `sysctl -n hw.model` / `scutil --get ComputerName` |
| 系统 | macOS 27.0.1（Build 26A434） | `sw_vers` |
| CPU | Apple M1，8 核，arm64 | `sysctl -n machdep.cpu.brand_string` / `hw.ncpu` / `uname -m` |
| 内存 | 16 GB | `sysctl -n hw.memsize` |
| 磁盘 | APFS 单卷 228 GiB 总量，数据卷已用 132 GiB，**可用约 69 GiB**（2026-10-12 实测） | `df -h /System/Volumes/Data` |
| Node | v24.18.0（/opt/homebrew/bin/node） | `node --version` |
| npm | 11.16.0 | `npm --version` |
| pnpm | 未安装 | `command -v pnpm` |
| git | 2.54.0 (Apple Git-157) | `git --version` |
| Docker | 29.8.2，守护进程运行中（3 容器运行） | `docker info` |
| SQLite CLI | 3.54.0（系统自带 /usr/bin/sqlite3） | `sqlite3 --version` |
| 网络接口 | 默认路由走 en1（Wi-Fi），局域网 192.168.0.103/24，网关 192.168.0.1；另有以太网口（en0 inactive）、多个 USB/雷雳以太网适配器 | `route get default` / `ifconfig en1` |

## 2. 常开条件（实测）

- 供电：`pmset -g ps` → "Now drawing from 'AC Power'"，台式主机无电池。
- 系统级睡眠设置（`pmset -g custom`，AC 档）：
  - `sleep 1`：**允许 1 分钟空闲后系统睡眠**。当前由 powerd、ChatGPT、UURemote、coreaudiod 等持有临时防睡眠断言（`pmset -g assertions` → UserIsActive 等），不是长期保证。
  - `disksleep 10`、`standby 0`、`networkoversleep 0`、`tcpkeepalive 1`、`womp 1`、`powernap 1`。
  - `autorestart 0`、`autorestartatconnect 0`：**断电后来电不会自动开机**。
- 已连续运行 4 天 18 小时（2026-10-12 实测，`uptime`），期间 Wi-Fi 常开。
- 风险结论（供 M0-04）：当前 Mac 可作为开发机；但 `sleep 1` + `autorestart 0` 意味着无人值守睡眠与断电重启均不满足"长期常开"要求。若候选为正式主机，需 `sudo pmset -a sleep 0`、`autorestart 1` 或采用 Docker/原生服务的自启动方案后复测（属 M0-04 范围，本次未执行系统设置变更）。

## 3. 正式主机候选

| 候选 | 状态 | 说明 |
| --- | --- | --- |
| 当前 Mac mini (M1) | **已确定为正式主机（2026-10-12 用户决策）** | PRD Q-01 已回写。前置：需执行系统常开设置变更（`sleep 0`、`autorestart 1`）并完成一次重启实测，命令见第 6 节（`sudo` 需你亲自执行） |
| 其他设备 | 未识别 | 未扫描网络；不作为候选，不擅自推断 |

## 4. 远程访问与可达性（M0-02 实测，2026-10-12）

方案基线：公网 Tailscale Funnel（HTTPS，自动证书），入口路径决策见 [PRD](PRD.md) v0.3。

| 项目 | 实测值 |
| --- | --- |
| Tailscale | 统一使用 Tailscale.app 自带 CLI `/Applications/Tailscale.app/Contents/MacOS/Tailscale`（1.104.1，与实际运行的网络扩展同版本）；PATH 中的 brew CLI 1.98.9 是旧副本、未再使用，版本不一致问题由此消除。已登录 lishuo0830@gmail.com，设备名 suresmac-mini（tailnet IP 100.98.78.105） |
| 公网入口 | Funnel `https://suresmac-mini.tail6bfbc0.ts.net`（标准 443）。既有占用：`/` → 127.0.0.1:5231（memos 的 nginx 代理）、`:8443` → 127.0.0.1:8648（hermes-web-ui）——均为用户既有服务，本次未修改 |
| HTTPS 证书 | Funnel 自动签发 Let's Encrypt 证书；本机 `openssl s_client` 校验 `ssl_verify_result=0`，CN/SAN = suresmac-mini.tail6bfbc0.ts.net，有效期 2026-09-18～2026-12-17 |
| M0-02 测试入口 | 临时测试页挂载于 443 的 `/m0-02` 路径：`tailscale funnel --bg --https=443 --set-path=/m0-02 http://127.0.0.1:8977`；后端为无业务数据的 Node 页，仅绑定 127.0.0.1:8977。记录完成后已删除测试页并撤销该路径映射 |
| 移动数据网络实测 | **成功**（2026-10-12，用户手机实测，页面返回 "OK m0-02 test page"） |
| 办公网络实测 | **成功**（同上） |
| 非标准端口实测 | **失败**：同样内容挂在 Funnel `:10000` 时手机打不开；改到 443 标准端口后成功 |
| 端口可用性约束 | Funnel 公网仅允许 443、8443、10000；其中 443 已被 memos、8443 已被 hermes-web-ui 占用 → 后续应用若走 Funnel，**必须共享 443**（路径路由或独立主机名），不能依赖非标准端口 |
| 应用入口决策 | **2026-10-12 用户决策：应用挂 443 子路径 `/tasks`**，即 `https://suresmac-mini.tail6bfbc0.ts.net/tasks`；memos 的 `/` 保持不变。链路：Funnel `:443 /tasks` → tailscaled（**会剥掉 `/tasks`**）→ 前缀恢复代理 `127.0.0.1:3101` → 应用 `127.0.0.1:3100`；M1-01 已实测该链路（见第 10 节） |
| 验证方法说明 | 本机对 `*.ts.net` 的解析被 MagicDNS 接管（返回 tailnet IP 100.98.78.105），因此**本机 curl 不能代表公网可达性**，公网结论只能由手机在外网实测（本次即如此） |

## 5. 浏览器与设备（M0-03 取证完成，待确认项见第 9 节）

| 项目 | 实测值 |
| --- | --- |
| 主要手机 | **待用户确认**（阻塞 M0-03 收尾）。tailnet 内可见 iOS 设备 3 台：`node`（最近上线 1 天前）、`iphone-15-pro-max`（52 天前）、`novascale-node-181d1d1e`（81 天前）——无法判定哪台是主力机；M0-02 实测所用手机未记录型号。PRD Q-02 默认方向为 iPhone Safari |
| 桌面浏览器（本机实测） | Safari 27.0.1、Google Chrome 155.0.8059.39；系统默认 https 处理程序为 **Tabbit 1.16.27.0**（`com.tabbit-ai.tabbit`）。未安装 Firefox / Edge / Brave / Arc |
| 安装入口（PWA） | Safari：文件 → 添加到程序坞；Chrome：菜单 → 投放、保存和分享 → 安装页面为应用。Tabbit 的安装入口未确认（待 M1 有应用后实测） |
| 可测试平台 | iOS（手机，M0-02 已通过）、macOS 桌面（本机 Safari/Chrome） |
| 无法/暂难测试的平台 | **Android**：tailnet 内有 1 台 android（`13t`），已离线 28 天，当前无法测试；**Windows**：未识别到任何 Windows 设备；**Linux 桌面**：仅有 `friendlywrt`（路由器，非桌面） |
| 显示条件 | 分辨率 6016×3384，单显示器；高 DPI 下布局与触控尺寸待 M1 界面完成后实测 |

## 6. 部署选择（M0-04 决策已定，待执行常开设置与重启实测）

| 项目 | 实测值 |
| --- | --- |
| 部署方式决策 | **2026-10-12 用户决策：原生 Node 服务 + launchd**，不采用 Docker 作为首版发布目标。应用只监听 `127.0.0.1:<应用端口>`，由 launchd 托管，Funnel 以 443 子路径 `/tasks` 反向代理 |
| Docker 现状（备查） | Docker 29.8.2；现有 3 个容器的重启策略：`memos`/`memos-proxy` = `always`，`rsshub` = `unless-stopped`。Docker Desktop **不在**系统登录项列表中（登录项仅有 Google Drive、GeminiAppLauncher、PasteNow、OPPO 互联、快捷计算器）；其自身设置文件受 macOS 保护（`Operation not permitted`）无法读取 |
| 原生方案可行性 | launchd 可用且已被现有服务使用：`~/Library/LaunchAgents/` 内有 `ai.hermes.gateway.plist`、`ai.openclaw.gateway.plist` 等；`brew services` 可用（`cloudflared`、`tailscale` 当前均为 none） |
| 系统级常开设置 | **尚未变更**：`sudo -n true` 需要密码，本会话无法非交互执行。`pmset` AC 档仍为 `sleep 1`、`autorestart 0`（与 M0-01 一致） |
| 重启后启动行为 | **未实测**：需你按下方命令安排一次主机重启；会中断当前会话与既有服务（memos / hermes-web-ui） |

待你执行（2026-10-12 已获授权，但 `sudo` 需密码且重启会中断服务，故不由我代执行）：

```bash
# 1) 常开设置（需要密码）
sudo pmset -a sleep 0 autorestart 1

# 2) 复核已生效（AC 档应为 sleep 0、autorestart 1）
pmset -g custom | sed -n '/AC Power/,$p'

# 3) 安排一次重启实测（会中断 memos / hermes-web-ui 与当前会话）
sudo shutdown -r +1
```

重启后需验证并回填本文件：`(a)` Docker/memos 是否自动恢复；`(b)` Funnel 映射是否仍在（`tailscale serve status`）；`(c)` M1 有应用后再验 launchd 服务是否自动拉起。未完成前 M0-04 不勾选。

## 7. 持久化与备份目录（M0-05 决策已定）

| 项目 | 实测值 |
| --- | --- |
| 持久化目录决策 | **2026-10-12 用户决策：`~/tasks/data`**（应用名于 M1-01 锁定为 `tasks`）；目录已由 M1-01 创建 |
| 本机磁盘 | 唯一内置盘 228 GiB（`diskutil` 仅 disk0/disk3）；数据卷已用 132 GiB，**可用 69 GiB**；无外接存储 |
| 备份目录决策 | **2026-10-12 用户决策：先用云同步目录**（Google Drive 优先，iCloud Drive 备选），保留沿用每日快照 + 本机 7 日 + 4 周；M1-01 已创建实际路径 `~/Library/CloudStorage/GoogleDrive-lishuo0830@gmail.com/我的云端硬盘/tasks-backup`（空目录，备份实现属 M1-06）；外接盘方案待后续评估 |
| 异机副本前提 | 云同步目录在本机仍位于同一物理卷（`df` 显示与数据卷同盘），因此必须先完成快照完整性校验与原子改名，再确认云同步完成并核对校验和，**之后才可声称具备异机副本**；同步未完成时只视为本机备份 |
| 异机在线候选 | 无：tailnet 内除本机外全部离线（iOS×3、android×1），`friendlywrt` 为路由器；故不依赖局域网异机 |
| 时间机器 | `tmutil destinationinfo` → **未配置任何目的地**（不构成备份） |

## 8. PRD 待确认问题回写（M0-06，2026-10-12 已回写部分）

| 问题 | 状态 |
| --- | --- |
| Q-01 正式主机 | **已确定：本机 Mac mini (M1, macOS) 转正**（2026-10-12 用户决策）；前置为常开设置变更 + 重启实测（第 6 节待执行） |
| Q-02 主要设备/浏览器 | 桌面端已确定：本机 Safari 27.0.1 / Chrome 155（系统默认浏览器为 Tabbit 1.16.27.0）；**主要手机仍待确认**（tailnet 内 3 台 iOS 均离线）；Android/Windows 无可测设备 |
| Q-03 关闭应用提醒 | **待答复**（PRD 保持 V1 仅站内提醒） |
| Q-04 共同使用者 | **待答复**（PRD 保持 V1 单人） |
| Q-05 小时级截止/提醒 | **待答复**（PRD 保持 V1 日期精度） |
| Q-06 备份目的地/保留 | **已确定目的地：云同步目录**（Google Drive 优先，iCloud 备选），保留沿用每日快照 + 7 日 + 4 周；异机能力以云同步完成为前提（第 7 节） |
| Q-07 远程连接稳定性 | **实测通过（初版）**：2026-10-12 M0-02 实测，移动数据与办公网络均可访问公网 443 入口；应用入口定为 `/tasks` 子路径（第 4 节）。长期稳定性待应用上线后多次复测 |

## 9. 决策清单（M0-03～M0-06）

### 9.1 已决（2026-10-12 用户确认）

| 编号 | 决策项 | 结果 |
| --- | --- | --- |
| D1 | 应用公网入口 | 共享 443 子路径 `/tasks`（机制已由 M0-02 用 `/m0-02` 实测） |
| D2 | 部署方式 | 原生 Node 服务 + launchd（Docker 不作首版发布目标） |
| D3 | 持久化目录 | `~/<应用名>/data`（与 memos 同款；应用名 M1-01 固定） |
| D4 | 备份目的地 | 云同步目录（Google Drive 优先，iCloud 备选），每日快照 + 7 日 + 4 周 |
| D5 | 正式主机 | 本机 Mac mini (M1) 转正；授权修改 `pmset` 并安排重启实测 |
| D8 | 应用名称 | **`tasks`**（2026-10-12 用户确认；同 M1-01 锁定，见第 10 节） |

### 9.2 仍待确认/配合

| 编号 | 事项 | 说明 |
| --- | --- | --- |
| D6 | 主要手机型号（Q-02 / M0-03） | tailnet 内 3 台 iOS 均离线，无法判定主力机；桌面端已定 Safari 27.0.1 / Chrome 155 |
| D7 | 执行常开设置与重启实测（M0-04） | 授权已给，但 `sudo` 需密码且重启会中断服务，请按第 6 节命令亲自执行并回填结果 |
| D9 | Q-03 / Q-04 / Q-05 口径（M0-06 回写） | 是否要系统级推送、是否有共同使用者、是否需要小时级精度——三项仍未答复，PRD 暂保持 V1 默认（仅站内 / 单人 / 日期精度） |

## 10. 应用工程契约（M1-01 锁定，2026-10-12）

| 项目 | 锁定值 |
| --- | --- |
| 应用名 / 包名 | `tasks` |
| 路径前缀 basePath | `/tasks`（构建期固定，改动需重新构建） |
| 应用端口 | `3100`（仅 `127.0.0.1`） |
| 前缀恢复代理端口 | `3101`（仅 `127.0.0.1`） |
| 数据目录 | `~/tasks/data`（已创建） |
| 备份目录 | `~/Library/CloudStorage/GoogleDrive-lishuo0830@gmail.com/我的云端硬盘/tasks-backup`（已创建空目录） |
| 会话 Cookie | `tasks_session`，`Path=/tasks`，无 `Domain`（M1-03 实现） |
| 依赖版本 | next 16.4.0、react/react-dom 19.3.0、typescript 7.0.2、@types/node 26.6.5、@types/react(-dom) 19.3.0；M1-02 增：drizzle-orm 0.45.4、better-sqlite3 13.0.3、drizzle-kit 0.31.11（dev）、@types/better-sqlite3 9.6.0（dev）——均 `--save-exact` |
| 工具链实测 | Node 24.18.0、npm 11.16.0；`typecheck`/`build` 均 exit=0；better-sqlite3 13.0.3 原生模块实测可用（SQLite 3.53.4，2026-10-12） |
| 正式数据库 | `~/tasks/data/tasks.db`（M1-02：迁移 0000 建 11 表，**同日独立复核后加固迁移 0001** 增至 schema_version=2；8 个触发器 + 单账号唯一索引；账号 owner + 空间 私人/工作/生活/成长；初始化密码暂存 `~/tasks/data/.initial-password` 600 权限，M1-03 改密后删除；`journal_mode` 当前仍为 `delete`，WAL 待应用首次连接后生效） |
| 代理前缀实测 | tailscaled `--set-path=/tasks` 会剥前缀（`/tasks/api/healthz` → `/api/healthz`）；经 `scripts/tasks-proxy.mjs` 恢复后，`/tasks`、深链接、`/tasks/api/healthz`、manifest、`/_next` 静态资源经代理全部 200，不经代理为 404 |
| 公网入口临时验证 | **2026-10-12 用户手机实测通过**（非家中网络、未开 Tailscale）：`https://suresmac-mini.tail6bfbc0.ts.net/tasks` 页面正常，客户端自检返回 `{"status":"ok","basePath":"/tasks"}`；memos `/` 与 `:8443` 不受影响。验证后映射与进程**已撤销**，应用当前不在公网可达（正式开放待 M1-03/M1-04 认证门槛） |
| 撤销后的回落行为 | `/tasks` 挂载移除后，该路径由 memos 的 `/` 承接（返回 Memos 页面），不是 404；即 `/tasks` 并非常驻保留路径，仅在实际挂载时属于本应用 |
| 运行手册 | [RUNBOOK.md](RUNBOOK.md)（安装、启动、冒烟、launchd 三态与公网开放门槛） |
