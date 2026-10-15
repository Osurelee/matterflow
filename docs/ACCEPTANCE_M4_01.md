# M4-01 正文共同子集、格式迁移与媒体能力探针 · 验收记录

- 任务ID与PRD版本：M4-01 / PRD v0.6、技术设计 v0.6、实施清单 v0.6
- 对应FR与AT：FR-17、FR-18（正文定义与保存）、FR-27（正文搜索派生）；AT-28（共同格式可视/源往返、未知格式保留、旧星号不误解析）、AT-29（正文 20,000 码点与请求体限额、恶意 HTML/链接净化）、AT-31（正文修订可查，更新事件仅摘要）
- 前置条件：M1/M2 本机隔离验收通过；M3-01～06 已完成（`tasks.description` 为唯一内容源，尚无格式与修订）；迁移 `0002_m3_handling` 已应用
- 状态：已完成（真机录音能力探针仅交付工具与实测表，**未在目标手机执行**，见下）

## 1. 本次范围与实际改动

| 产物 | 说明 |
| --- | --- |
| `src/domain/body.ts` | 共同子集唯一实现：解析/序列化/规范化/派生纯文本/净化渲染/旧纯文本转义。服务端与客户端共用，不依赖框架与数据库 |
| `db/migrations/0003_m4_body.sql` | 新增 `tasks.description_format`、`tasks.description_plain`、`task_body_revisions` 表与索引 |
| `src/server/db/schema.ts` | 同步 drizzle 定义；`SCHEMA_VERSION` 由 `'2'` 修正为 `'4'`（与 `app_meta.schema_version`=迁移条数口径一致） |
| `scripts/test-m4-body.mjs` | 契约与往返测试（34 项断言），纯逻辑、不连库 |
| `src/app/probe/media/page.tsx` | 录音/媒体能力探针页（`/tasks/probe/media`），只探测浏览器能力，不读写事项数据 |
| `package.json` | 新增 `npm run test:m4` |

共同子集（PRD 7.1）落地为：段落、一～三级标题、粗体、斜体、删除线、无序/有序列表、引用、行内代码与围栏代码块、`[文本](链接)`、`![说明](asset:UUID)` 本机资源引用。

关键数据规则：

1. `tasks.description` 仍是唯一内容源，`description_format` 取 `plaintext` / `markdown_v1`；`description_plain` 由服务端派生，**只用于搜索，不反向编辑**。
2. 超出子集的语法（四级以上标题、表格、任意 HTML、缩进嵌套列表、未闭合围栏）保留为 `raw` 块并标记 `hasUnsupportedSyntax`，源模式往返不丢内容，渲染时只做转义。
3. 旧纯文本升级必须显式经过 `escapePlaintextToMarkdown`：行首块级标记与行内特殊字符先转义，因此旧文本里的 `#`、`*`、`-`、`1.` 不会被误解析（AT-28）。
4. 渲染只输出本模块生成的标签，文本全部转义；链接只允许 `http/https/mailto`，`javascript:`/`data:`/相对路径被降级为纯文本提示；外部图片不内联预览，只作为链接（AT-29）。

## 2. 迁移与数据兼容证据

- `0003_m4_body.sql` 只新增列/表/索引，未修改 `0000`～`0002` 的任何语句；`ALTER TABLE ... ADD COLUMN` 带非空默认值，旧行回填 `plaintext`，并用 `UPDATE ... SET description_plain = description WHERE description <> ''` 把旧正文原样写入派生列，**不做 Markdown 解释**。
- `task_body_revisions` 对 `(task_id, task_version)` 唯一；修订只追加，`task_version` 记录来源事项版本。
- 迁移前一致性备份与清单预检沿用 `scripts/migrate.mjs` 既有逻辑（缺 SQL 文件即在任何写入前失败）；本次执行输出 `migrate: applied 0003_m4_body (8 statements)`、`integrity_check ok`、`schema_version=4`。
- 混合库回归：`scripts/test-m1.mjs` 仍在同一隔离库上先跑 M1/M2/M3 全部用例（默认值、状态机、委托、视图、恢复撤销会话、dev/prod 路径隔离），再跑 M4 用例，未出现旧数据被改写。

## 3. 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（`tsc --noEmit`，无输出） |
| `node --no-warnings --experimental-strip-types scripts/test-m4-body.mjs` | `M4-01 body contract: PASS (34 checks)` |
| `npm run build`（生产构建） | 通过，新增路由 `/api/tasks/[id]/content`、`/api/tasks/[id]/body-revisions` 与静态页 `/probe/media` |
| `node scripts/test-m1.mjs`（隔离总回归） | `M1 dev/prod DB path isolation: PASS`、`M1 TTY password checks: PASS`、`M4 body/content checks: PASS`、`M1 isolated integration suite: PASS` |
| 真实浏览器（隔离生产进程 + 独立库） | 见 `ACCEPTANCE_M4_02.md` 第 3 节 |

契约测试覆盖：24 组样本的规范化稳定性与 AST 幂等、块分隔与列表符号标准化、反斜杠转义保真、未闭合围栏与表格/四级标题保留、派生纯文本、净化渲染（`<script>` 转义、`javascript:` 拒绝、外部图片不内联）、`asset:` 令牌白名单、旧纯文本升级后仍为段落且派生文本等于原文、20,000 码点边界。

限制（已在测试中显式约定，不是遗漏）：块之间的分隔空行会被规范化为一个空行；无序列表符号统一为 `-`；强调统一序列化为 `*`；行内代码内容不含反引号。这些属于「源模式 ↔ 可视模式」的规范化，不改变可见文本与派生搜索文本。

## 4. 录音/媒体真机能力探针

工具：`src/app/probe/media/page.tsx`（正式入口 `/tasks/probe/media`，静态页，不读写任何事项数据）。
采集项：安全上下文、`navigator.mediaDevices`/`getUserMedia`/`MediaRecorder` 是否存在、`MediaRecorder.isTypeSupported` 候选 MIME 列表、音频输入设备数、实际录制的字节数/耗时/`blob.type`/容器魔数（`OggS`、`0x1A45DFA3`、`RIFF....WAVE`、`ftyp`）、`getSettings()` 的采样率与声道、权限拒绝的错误名（`NotAllowedError` 等）、录制中 track 结束（中断）是否仍能取回已产生的数据。

**真机实测尚未执行**：本次执行环境为无麦克风的自动化浏览器，只能确认页面可加载、探测分支与降级提示存在。请在目标手机上打开该页执行「开始完整检测」后把报告粘贴到下表；在填表之前，不得在任何文档中声称录音格式、大小与中断行为已验证（PRD Q-02/Q-08、实施清单第 12 节「真机」层）。

| 字段 | 实测值（待填） |
| --- | --- |
| 设备与系统 / 浏览器 | |
| 安全上下文（HTTPS） | |
| 支持 MIME（按序） | |
| 实际容器 / mime / 采样率 / 声道 / 码率 | |
| 3 秒录音字节数 | |
| 权限拒绝错误名 | |
| 中断（track 结束）后是否仍收到数据 | |
| 结论：可采用的默认格式与上限 | |

M4-06 锁定录音格式后，本探针页应从生产构建中删除；删除前需在 `TASK_LOG.md` 记录。

## 5. 尚未验证或待修复

- 真机录音探针未执行（上表）。
- 本机草稿（IndexedDB）与冲突恢复属 M4-03，未实现。
- 正文内图片/录音引用（`asset:`）目前只渲染为占位，真实资源上传与私有读取属 M4-05/M4-06；存档/导出（M6/M8）尚未覆盖正文修订。
- 未覆盖目标手机触控与窄屏实测（M7）。

## 6. 文档是否同步

是——本文件、`ACCEPTANCE_M4_02.md`、`TASK_LOG.md`、`IMPLEMENTATION_PLAN.md` 第 7 节勾选与第 1 节状态、`README.md` 当前阶段与文档入口表。
