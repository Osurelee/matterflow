# 通用事务管理平台 · 技术设计

版本：v0.6.2；日期：2026-10-13。依据：[PRD](PRD.md)、[研究报告](COMPETITIVE_RESEARCH.md)、[实施清单](IMPLEMENTATION_PLAN.md)。交付状态以实施清单为准；本次只修订独立事项、任意深度层级与引用契约，不修改运行代码或正式数据库。

前端改版依据：[UX-1.0 PRD](FRONTEND_REDESIGN_PRD.md)，待开发。其中心详情和自动保存目标覆盖本稿第4/5节中的常规手动保存交互；requestId、expectedVersion、事务、正文唯一来源与草稿隔离继续生效。UX-02实现前须细化同Task写入协调、输入/响应快照、失败/冲突及有限补偿撤销协议，UX-01须细化稳定事项链接和来源上下文；不能只隐藏保存按钮或仅增加debounce。具体协议及验证随对应切片回写，本文不将新增目标描述为已实现。

## 1. 架构与已锁定运行契约

Next.js/TypeScript单实例，SQLite/Drizzle，原生Node与launchd，宿主机Funnel在443的/tasks路径接入本机服务。应用端口3100、前缀恢复代理3101，仅回环监听，主数据目录~/tasks/data。真实公网、重启和设备验收另有发布门槛。

/tasks为构建期basePath；Funnel现有路径映射剥前缀，本机代理恢复。资源、fetch、重定向、Cookie、manifest和Service Worker必须一致。Cookie tasks_session，Path=/tasks、无Domain；PWA scope=/tasks/。同origin的memos共享信任边界，路径不等于安全隔离。[Next.js basePath](https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath)

准确安装、启动、依赖版本与dev/prod脚本以[RUNBOOK](RUNBOOK.md)和package-lock为准，不在设计中编造新版本。LaunchAgent属于登录会话，不能声称重启无人登录即运行。[Apple启动任务](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)

## 2. 分层与不变量

```text
src/app/                 页面与同源HTTP路由
src/components/          捕获、详情、编辑器、附件、项目等组件
src/domain/              状态/日期/层级/正文契约
src/server/auth/         账号、session与来源检查
src/server/services/     所有业务用例、事务与版本守卫
src/server/db/           schema、queries、repository
src/server/media/        分阶段文件暂存、校验、鉴权读取
src/shared/              DTO、校验、请求/响应契约
scripts/                 迁移、初始化、备份、恢复
```

浏览器不直连数据库。权限、容器可写、层级与状态守卫均在服务端。事件只追加，当前数据保存在实体，不改成事件溯源。事务内不发外部网络请求；文件IO不能假装和SQLite天然同事务。

## 3. 数据模型与迁移

### 3.1 既有实体

保留users、sessions、auth_rate_limits、spaces、projects、tasks、task_events、mutation_requests、backup_runs及元数据。旧contacts/delegations和kind/contact字段为历史兼容保留，不开发联系人管理，不作为新分发查询依据。

### 3.2 分阶段新增

| 阶段 | 实体/字段 | 关键约束 |
| --- | --- | --- |
| M3 | tasks.handling_mode、counterpart_name | self/other；self为空、other文本1–100码点；无contact依赖 |
| M4 | tasks.description_format、description_plain；task_body_revisions | 现有description继续内容源；plaintext/markdown_v1；修订只追加、来源task version |
| M4 | checklist_items | id、task_id、text、is_checked、sort_key、promoted_task_id、version；最多100条 |
| M4 | assets、task_asset_links、upload_requests | owner、存储键、SHA-256、MIME、大小、时长、状态；唯一上传请求与唯一关联 |
| M4 | capture_batches、source_url/source_label | 批量requestId、批内序号及结果可重放；来源仅URL，不抓取网页 |
| M5 | project_sections | project_id、name、sort_key、version；归属唯一，不是另一个Task |
| M5 | tasks.parent_id、section_id、sort_key、structure_version、deletion_batch_id | 主树同owner/space，单主父级、无循环、无业务深度上限；最近项目为派生索引 |
| M5 | task_references、structure_batches、spaces.structure_version | 引用同一Task，唯一有效来源/目标；删除恢复批次实际集合；根排序版本守卫 |
| M5 | projects.root_task_id、is_paused、target_date、success_criteria | 唯一根Task扩展；标题/正文来自根Task，项目状态与根生命周期一致；保留旧Project ID |
| M8 | backup_runs媒体清单字段 | 快照schema、文件数/字节、清单checksum、local/remote验证状态 |

ID用UUID，事件UTC时间戳、业务日期YYYY-MM-DD。新增字段经迁移逐步进入服务，不提前假定列存在。默认空值与NULL必须明确。

### 3.3 旧数据兼容

不改已应用SQL，不删表、不重置正式库。M3先检查旧contact关联/有效delegation；普通M2 self/none回填self/空文本。如有旧关联，输出映射报告后显式迁移，不能按同名合并或静默丢弃。

M4旧description保持plaintext，切编辑器时转义原文本并生成初版revision；不能把原有星号/HTML直接解释为富文本。M5按[M5开发规格](M5_INDEPENDENT_ITEMS_DESIGN.md)迁移：旧Project绑定新建根Task，原事项接到根下，旧ID/状态/正文/事件/媒体保留并校验；无项目旧事项保持根事项。事件/对象ID与历史报告保留。

迁移预检在任何mkdir/写库之前；未知已应用迁移只读拒绝。升级前一致快照，备份失败不继续。应用启动检查schema兼容性。迁移增加事件枚举/约束时需完整回归，不凭类型定义推定数据库CHECK已支持。

## 4. 写入、并发与权限协议

实体写请求requestId；更新expectedVersion；稳定哈希包含method、规范化资源路径、校验后的语义正文。HTTP camelCase、DB snake_case。认证接口不把密码/session放业务重放表。

认证和对象归属先检查，幂等成功结果先于版本/状态守卫重放。新请求在BEGIN IMMEDIATE事务内检查对象/容器/层级及version，提交实体、事件、修订和重放记录。实际变更递增version；进展也递增。失败全部回滚；客户端重放结果不能覆盖已知更高版本，应重新读实体。

正文和安排统一保存一次版本，不由多个表单各持旧版本连续覆盖。状态转换/进展独立请求，处理未保存稿的产品流程见PRD。结构写入锁父/子关联及源/目标项目，用版本守卫避免移动与归档竞争。

成功{data,requestId}；错误{error:{code,message,fieldErrors,currentVersion?,current?},requestId}。400输入、401未登录、403来源、404无对象、409版本/业务冲突、413过大、429限流、503暂时不可用。私有响应no-store。

## 5. 正文、编辑器、草稿与搜索

### 5.1 唯一内容源

description是canonical文本，description_format区分旧plaintext与markdown_v1；description_plain由服务端安全解析生成，只作为搜索派生值，不反向编辑。Markdown共同支持子集以PRD第7节为准；展示HTML派生并净化，不把任意HTML保存为另一份正文。

默认真正的可视编辑与Markdown源模式之间通过一个内容模型转换；仅向textarea插入Markdown标记的工具栏不满足可视编辑要求。布局与独立动作的未保存稿保护遵循PRD 4.2，标题/正文/日期统一保存，归属与处理方式仍保留独立事务入口。未知语法保留源模式，切换不得静默丢格式。附件引用使用asset ID令牌，渲染时走私有读取接口；禁止任意脚本URL、直接访问本机路径、未经确认下载远端图片。

### 5.2 正文版本与本机草稿

task_body_revisions记录正文内容、format、task version、created_at；每次正文保存与事件同事务。清单有独立结构，修改清单也校验父task version并留下摘要；不能把正文中的静态勾选语法当成第二套互动状态。

IndexedDB本机草稿键包含userId及draftId；编辑事项另有taskId/baseVersion，新建捕获使用captureDraftId而非空taskId，防止多份记录相互覆盖；保留正文、安排、未完成上传标识，录音blob按实际可用容量保存。恢复需登录并比较服务器版本；失败时保留本地稿，退出账号确认后清理。草稿不是离线写队列，不自动重放任务修改。

### 5.3 输入限制与搜索

旧8KiB通用JSON上限不足以承载20,000码点正文，M4按路由设置：登录≤8KiB，正文JSON≤128KiB、语义正文≤20,000码点；上传走multipart/流，不走同一JSON入口。读完整体前限制传输体积，再校验语义。

搜索先参数化包含匹配，覆盖标题/description_plain、处理方、progress文字和附件名；事件JSON不直接当全文搜索。权限与删除/归档过滤在查询层统一。媒体OCR/音频全文搜索不承诺。若压测失败再选择索引与中文方案。

## 6. 媒体上传、读取与生命周期

### 6.1 可恢复两阶段协议

1. 带uploadRequestId上传到私有staging，服务端校验真实类型、大小、checksum，生成asset ID；不是公开文件URL。
2. 创建/保存事项时在数据库事务中关联assets、更新正文引用/事件和重放结果；只有ready asset可关联且属于本人。
3. 文件写入先临时名再原子改名，失败保留可重试状态；关联失败有可识别孤立asset，不返回完整成功。captureRequestId稳定，不能靠重试复制事项。
4. 未关联staging超过24小时可清理；首版不实现服务器草稿租约，本机草稿尽量保留原blob，过期需重新上传；已提交/有历史引用的资产首版不自动物理删除。草稿依赖过期时提示重新上传，不能显示仍已保存。

不得给前端返回任意磁盘路径。存储目录~/tasks/data/media及staging，存储键随机，用户文件名仅展示。validate类型时不只相信扩展名；SVG/HTML不内联执行。

### 6.2 权限读取和移除

GET /assets/:id/content校验session/owner/关联状态；音频Range与缩略图相同授权。图片/音频可内联，其他类型下载，设置no-store与安全Content-Type。soft removed关联在当前详情不展示正文内容，历史留占位。

移除引用/附件校验task version、可写状态；正文删除引用不会删除asset。进展引用移除后不得改写进展原文，只给可审计占位。删除Task保存其links和files供恢复；归档只读守卫同样限制附件。

## 7. 录音与后续转写

录音入口是页面内“录制语音”，直接取得麦克风音频，无需用户先准备录音文件；导入已有音频为独立补充入口。详情、快速捕获及进展使用统一录音组件与PRD 8.3状态机，音频blob进入现有私有staging/关联协议。已有事项可独立关联；未保存的捕获或进展先持有待提交asset，随对应创建/追加事务关联，失败保留草稿且不生成伪成功进展。

getUserMedia仅由明确点击触发，HTTPS/localhost环境检测、权限拒绝有退路。[MDN麦克风接口](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

MediaRecorder运行时选择支持MIME，实际类型随asset记录；每次录音最长5分钟且受字节限制，终止要取得最终dataavailable并释放tracks。停止、异常、中断、退出均区分，未取得blob不生成成功记录。[MDN MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)

首版格式方案在M4-01/M4-06真机探针锁定；若不同平台不能播放同格式，要增加明确的转码步骤或只提供已验证格式导入，不能仅靠扩展名通过。上传音频可作为降级。

M9才设计transcriptions/jobs及provider；需明确本机/外部服务、传输、费用和失败重试。转写稿独立于正文，人工选择插入/追加，任务提取预览后提交，不后台静默改状态。

## 8. 层级、清单与项目统计

完整契约与分项验收见[M5开发规格](M5_INDEPENDENT_ITEMS_DESIGN.md)，为本阶段实现依据。

Task内容独立，主parent邻接关系任意深度，同owner/space，单主父级无循环；项目根/最近项目与分组规则见规格第2节。引用为单独关系，不递归渲染目标树，不改叶子定义、主项目进度或完成守卫。现有projects保持兼容记录，通过root_task_id附着原Task项目能力。

SQLite递归CTE查完整主祖先/后代，迭代或分页读取，不在JS栈递归整树。BEGIN IMMEDIATE下校验内容version及父/根space结构version，重查环、可写容器和后代集合，更新关系/项目索引/事件/重放同事务；数据约束防直接SQL绕过。服务返回资源预算错误时整笔回滚，不伪装业务层数上限。

完成/取消校验全部未删除主后代；重开/恢复活跃Task校验所有主祖先。整批删除/恢复使用实际影响集合，不复活先前已删事项或引用目标。项目根状态统一映射Project状态，暂停独立；项目结项不跳过中间待核实成果。统计主后代叶子与全局Task ID去重。启用项目不换Task ID、不打散树；旧项目迁移新增根Task且保留所有旧ID，不重写原事件。

## 9. 接口增量草案

外部统一/tasks/api，下表为相对此前缀的路径。编码生成DTO，路线可调整但语义不变；首版不创建contacts/delegate/recall接口。

| 阶段 | 路径/行为 |
| --- | --- |
| M3 | /spaces、/projects CRUD与archive/unarchive；PATCH /tasks/:id更新处理方/归属 |
| M4 | PATCH /tasks/:id统一正文/安排；GET /tasks/:id/body-revisions；/tasks/:id/checklist CRUD/排序 |
| M4 | POST /uploads；GET /uploads/:requestId状态；GET /assets/:id/content；/tasks/:id/attachments挂载/软移除 |
| M4 | POST /captures文字/媒体统一创建；POST /capture-batches多行预览确认；来源字段保存 |
| M5 | /projects/:id/sections；/tasks/:id/children/ancestors；/tasks/:id/move；/checklist/:id/promote |
| M5 | /tasks/:id/enable-project预览/确认；/projects/:id/transition；GET /projects/:id/overview |
| M5 | /tasks/:id/references及referenced-by；创建/软移除引用；接口及版本载荷见M5开发规格 |
| M6 | /review、/trash、/exports/json、/exports/csv、/exports/bundle |
| M7 | 统一刷新、冲突读取，不新增旁路数据源 |
| M8 | /system/backup-status；备份恢复由本机脚本，不开公网恢复接口 |

待开发接口不是现有API保证。读取分页50/最大100，稳定排序；进展按时间展示、可取更早记录；批量首版≤50条，事务内整批提交/去重；任一条校验失败全批不写入，返回逐条fieldErrors与稳定序号。

## 10. 认证、运行与缓存

保留单账号强密码/Unicode码点校验、哈希session、30天绝对有效期、Origin校验、生产Secure/HttpOnly/SameSite=Lax。仅受信代理链可提供IP，否则按统一代理桶及账号桶限流。未登录私有读写及媒体401，日志不含正文/令牌。

dev/prod由显式脚本模式选择，与Next环境加载一致；不因为编辑器调用而打开公网调试旁路。私有页面和数据不共享缓存。Service Worker只缓存静态壳，退出清理内存/草稿，检查同origin根SW是否干扰/tasks。

多端前台每30秒刷新，回前台/写后立即刷新，不覆盖未保存稿。手机有互联网但Funnel不可用时仍报应用不可连接。上传/下载单独状态，不能用navigator.onLine证明保存成功。

## 11. 数据与媒体的备份、导出、恢复

已有M1数据库备份只证明文字库；添加assets后需要升级完整包。方案：短暂阻止媒体挂载/移除，取得SQLite一致快照与被引用asset清单，再按不变内容存储复制文件和checksum，完成包校验后原子发布包名。不能备份时删除仍被快照引用的文件。

清单包括schemaVersion、app版本、生成时间、数据库checksum、每asset存储键/大小/checksum。正文所有引用可解析，missing file即完整备份失败；不替换上一有效包。云目录本机存在仅local verified，远端要独立下载及恢复。

恢复到新目录，先校验DB/FK/schema与全部文件，再撤销sessions/递增auth_version、更新恢复件校验和，启动核对层级/正文/清单/媒体/事件；原库留作故障现场，不覆盖唯一副本。RPO/RTO用实测，不以checksum通过代替可使用。

JSON排除密码/session与操作重放表，含全部业务对象、事件、正文修订、清单、主层级、项目根扩展、引用关系、结构批次及媒体元数据（含归档/删除）；CSV为当前筛选全部匹配项；bundle同范围另含二进制与manifest。staging和本机草稿不导出，README说明每种格式范围。导出读一致快照，CSV处理公式前缀。每日任务与补做在M8实现，不依赖用户开页面。

## 12. 测试与阶段交付

| 层级 | 有价值的验证 |
| --- | --- |
| 正文/领域 | 子集往返、未知格式保留、旧纯文本、安全链接、日期与父子守卫 |
| 数据库 | 迁移预检、WAL快照、版本/幂等/回滚、归属与层级、资产链接一致 |
| API | 未登录媒体、非法字段/大小、重复上传/捕获、Range鉴权、归档写保护 |
| UI | 窄屏详情、键盘、失败草稿恢复、版本冲突、清单升级预览 |
| 真机 | 麦克风授权/中断、实际录音格式与播放、PWA安装、远程网络 |
| 运维 | DB+媒体恢复、云独立取回、schema升级与回滚、自启动登录前后 |

M1/M2现有测试保留，M3/M4/M5等新增测试不可简单复用旧命令名称作为已覆盖证明。本次只更新设计，不运行功能测试宣称新增能力通过。

## 13. 版本与来源

v0.5正文及模型基线归档在docs/history/v0.5；旧ID到新阶段见SCOPE_MAPPING。竞品事实见COMPETITIVE_RESEARCH，本设计是本项目取舍。实际库版本随迁移更新，不根据PRD版本直接改schemaVersion。
