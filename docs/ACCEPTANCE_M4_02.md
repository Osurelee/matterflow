# M4-02 统一正文/安排保存与内容说明编辑器 · 验收记录

- 任务ID与PRD版本：M4-02 / PRD v0.6、技术设计 v0.6、实施清单 v0.6
- 对应FR与AT：FR-17、FR-18（可视/源编辑、预览、旧纯文本兼容、一次保存一次版本）、FR-19（修订摘要）；AT-28、AT-29、AT-31，并复用 AT-23/AT-24/AT-26 的日期与归档守卫
- 前置条件：M4-01 契约与迁移已交付（`description_format`/`description_plain`/`task_body_revisions`）
- 状态：已完成

## 1. 本次范围与实际改动

| 产物 | 说明 |
| --- | --- |
| `src/server/services/mutations.ts` | 新增 `saveTaskContentMutation`：标题 + 正文 + 安排在同一次请求中保存，只递增一次版本、只追加一条 `task_updated` 事件；正文变化时追加一条 `task_body_revisions` |
| `src/app/api/tasks/[id]/content/route.ts` | `PATCH /api/tasks/:id/content`，请求体上限 128 KiB，未知字段拒绝 |
| `src/app/api/tasks/[id]/body-revisions/route.ts` | `GET /api/tasks/:id/body-revisions`，只读、时间倒序、游标分页（默认 20，上限 50） |
| `src/server/http/request.ts` | `readJsonBody(request, maxBytes)`，默认 8 KiB 不变，正文路由显式使用 `BODY_JSON_LIMIT = 128 KiB` |
| `src/server/services/task-queries.ts` | 详情返回 `descriptionFormat`；新增 `listTaskBodyRevisions` |
| `src/app/page.tsx`、`page.module.css` | 详情新增「内容说明」面板：Markdown 源 / 预览切换、格式工具栏（粗体/斜体/删除线/一～三级标题/两种列表/引用/行内代码/链接）、`n/20000` 码点计数、`- [ ]` 复选框与超子集语法提示、正文历史列表与「复制到编辑区」 |
| `scripts/test-m1.mjs` | 新增 `runM4Checks`，在隔离库里跑通正文与统一保存的全部用例 |

接口契约（`PATCH /api/tasks/:id/content`，字段全部可选，未提供的保持原值，日期用 `null` 清空）：
`requestId`(UUID)、`expectedVersion`、`title`、`description`、`descriptionFormat`(`plaintext`|`markdown_v1`)、`convertFromPlaintext`、`priority`、`plannedDate`、`dueDate`、`followUpDate`、`nextAction`、`blockedReason`。

设计取舍（岗位交接需知）：

1. **命名偏差**：技术设计原文写「`PATCH /tasks/:id` 统一正文/安排」，实现为独立路径 `/api/tasks/:id/content`，避免改动既有仅标题 PATCH 的语义与既有测试；标题仍可在同一请求里一起提交，因此「一次保存一次版本」的语义未被削弱。
2. **格式归属**：客户端只在显式「转换为 Markdown 正文」之后才提交 `markdown_v1`；plaintext 任务在编辑器里始终按纯文本对待，不会因为编辑区叫「Markdown 源」就被静默解释或静默转义。
3. **`convertFromPlaintext`**：仅当服务端当前格式为 `plaintext` 且目标为 `markdown_v1` 时才生效；不传该标志时服务端绝不改写用户原文（浏览器实测中确认了这一点）。
4. **相同正文不产生新版本**：内容与格式都没变化时不递增版本、不追加修订。

## 2. 服务端行为要点

- 事务内先做归属/归档/版本检查：事项不存在 404 `TASK_NOT_FOUND`；事项归档 409 `TASK_ARCHIVED`；空间或项目归档 409 `CONTAINER_ARCHIVED`；`expectedVersion` 过期 409 `VERSION_CONFLICT`（附 `currentVersion` 与 `current`）。
- 标题按码点 1～200；正文按码点 ≤ 20,000（`BODY_MAX_CODE_POINTS`）；`nextAction` ≤ 500、`blockedReason` ≤ 1000；`plannedDate` 不得晚于 `dueDate`（400 `INVALID_DATE`）；已结束事项不得新增跟进日期（400 `INVALID_INPUT` + `fieldErrors.followUpDate`）。
- 幂等：同 `requestId` 同语义重放返回原响应并带 `Idempotency-Replayed: true`；同 `requestId` 不同语义 409 `REQUEST_ID_REUSED`；任何失败都不落修订、不改正文、不写事件。
- 事件只保存摘要（`changes.description` 为码点长度、`body.revisionId/format/length`），正文全文只存在实体与修订表里（AT-31）。

## 3. 验证

### 3.1 命令

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过（含新路由与静态探针页） |
| `node scripts/test-m1.mjs` | `M4 body/content checks: PASS` 且 M1 全部回归通过 |

`runM4Checks` 覆盖：默认格式与空正文；未登录 401 / 不存在 404；统一保存后版本只 +1、修订 1 条、事件 1 条且不含全文；`description_plain` 派生正确；重放不重复写入；`requestId` 换正文被拒；无变化保存不递增版本；版本冲突不落修订；日期范围、优先级、未知字段的 400；20,001 码点 400 与 140 KB 请求体 413；危险链接/HTML 原样保存并被标记；`- [ ]` 只提示；纯文本 → markdown_v1 升级转义且派生文本等于原文；修订第一版仍是原纯文本；历史倒序分页含格式与来源版本；结束事项可改正文但不可新增跟进日期；归档事项写入被拒且无副作用；非受信 Origin 403。

### 3.2 真实浏览器（隔离生产进程，独立库，不改动正式数据）

流程：登录 → 新建事项 → 打开详情 → 「内容说明」面板 → 输入正文 → 切换预览 → 保存 → 打开正文历史。
实测结论：

1. Markdown 正文渲染正确：`## 背景` 渲染为二级标题、`**核实**` 为粗体、`[来源](https://…)` 为链接、`- 第一步/- 第二步` 为无序列表；计数显示 `71/20000 字符`。
2. 保存后状态显示「正文与安排已保存」，正文历史出现「第 2 版」条目，正文与安排一次提交即生效（版本 +1）。
3. 纯文本任务打开时只显示「转换为 Markdown 正文」与纯文本编辑区（无 Markdown 工具栏/预览），点击转换后编辑区变为转义后的源文本 `\# 这不是标题` / `\*这不是斜体\*` / `\- 这不是列表`，并出现源/预览切换与工具栏。
4. 转换后保存，数据库结果：`tasks.description_format='markdown_v1'`、`description` 为转义源文本、`description_plain='# 这不是标题\n*这不是斜体*\n- 这不是列表'`（与原文一致，未被误解析）；`task_body_revisions` 两条（`task_version=2` 仍为 `plaintext` 原文，`task_version=3` 为 `markdown_v1`）；`task_updated` 事件只带 `changes.description={from:8,to:27}` 与 `body` 摘要（`revisionId/format/length/plainLength/hasUnsupportedSyntax=false`）。
5. 记录到的一处实现缺陷与修复：初版编辑器在纯文本任务上直接提供 Markdown 源/预览，导致用户输入的 Markdown 被按 `plaintext` 保存（浏览器实测发现）。已改为「plaintext 任务必须先显式转换」，转换动作由共同子集的 `escapePlaintextToMarkdown` 完成，服务端另有 `convertFromPlaintext` 兜底校验。

## 4. 尚未验证或待修复

- 本机草稿、恢复、冲突提示、退出清理、未保存离开（M4-03）；目前只有既有「未保存离开提示」覆盖标题/安排/正文。
- 结构化小步骤（M4-04）；当前 `- [ ]` 只提示、按静态文本保留。
- 图片/文件/录音（M4-05/M4-06）与统一捕获（M4-07）未实现；`asset:` 引用只渲染占位。
- 真机与窄屏实测、离线队列（M7/M9）；正文修订尚未纳入导出与全量备份（M6/M8）。
- 明文正文仍按 8 KiB 读取的旧路由(`PATCH /api/tasks/:id`，仅标题)保持不变，未扩大其体积上限。

## 5. 文档是否同步

是——`ACCEPTANCE_M4_01.md`、本文件、`TASK_LOG.md`、`IMPLEMENTATION_PLAN.md`（第 7 节 M4-01/M4-02 勾选与第 1 节状态）、`README.md`。
## 6. v0.6.1 增量复验（2026-10-13）

PRD/技术设计 v0.6.1 将此前“源编辑 + 标记工具栏 + 只读预览”明确降级为过渡实现，并要求正文优先详情、安排折叠、顶部单一保存与真正可视编辑。本次已补齐：

- 新增 `src/components/RichBodyEditor.tsx`：默认“可视编辑”，使用 `contenteditable` 内容区与共同 Markdown 子集 DOM↔Markdown 转换；粗体、斜体、删除线、H1～H3、列表、引用、代码块、链接直接作用于可视编辑区。Markdown 源与预览保留为次级模式。
- 详情首屏改为紧凑操作栏 → 标题 → 正文；创建时间、整理状态、版本收入“更多信息”；“安排”折叠，正文、小步骤/进展顺序保持在前；桌面/窄屏样式补充顶部固定操作与 180px 级正文编辑区。
- 顶部常驻“保存”提交标题、正文、优先级、日期、下一步、阻塞原因；移除正文/标题/安排三个竞争保存按钮。归属、处理方式、状态、小步骤、进展仍保持独立动作。
- `PATCH /api/tasks/:id` 现在是统一正文/安排入口，复用既有 `saveTaskContentMutation`；旧 title-only 请求兼容，`/api/tasks/:id/content` 旧路径保留。M4 隔离测试主路径已切换为统一入口。

### 增量验证

- `npm run typecheck`：通过。
- 隔离生产构建：通过，新统一路由 `/api/tasks/[id]` 正常生成。
- `node scripts/test-m1.mjs`：`M4 body checks: PASS`、`M4 checklist checks: PASS`、M1 全回归 PASS。
- 隔离生产浏览器：打开详情可见顶部“保存”、正文区域默认可视编辑、`Markdown 源/预览` 次级切换、默认折叠“安排”；旧 plaintext 先显式转换后出现可视编辑区；可视区输入文字后切到 Markdown 源可以读回正文；小步骤与进展位于正文之后。

### 本次尚未覆盖

图片/文件/页面录音与附件入口仍由 M4-05/M4-06 实现；`contenteditable` 的目标手机光标、系统键盘、外部富文本粘贴细节属 M7 真机验收；不以本次桌面隔离验证冒充媒体或真机交付。

本任务状态：**已完成 v0.6.1 代码范围；媒体与真机门槛待后续阶段**。
