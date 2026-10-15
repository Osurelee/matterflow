# M4-04 结构化小步骤 · 验收记录

- 任务ID与PRD版本：M4-04 / PRD v0.6 9.3/9.4、7.1；FR-22、AT-37；技术设计 v0.6 3.2
- 对应FR与AT：FR-22（勾选不改变事项、排序稳定、未勾完完成需确认）、AT-37（小步骤不进入全局任务计数、未勾完完成有确认）
- 前置条件：M4-01～03（正文契约、统一保存、正文修订与本机草稿）已交付
- 状态：已完成（不开放「提升为子事项」入口，属 M5）

## 1. 本次范围与实际改动

| 产物 | 说明 |
| --- | --- |
| `src/domain/checklist.ts` | 纯逻辑契约：文本校验（1–500 码点）、定宽排序键、上下移动、计数、未勾完确认文案、正文静态 `- [ ]` 识别与移除；零依赖 |
| `db/migrations/0004_m4_checklist.sql` | 新增 `checklist_items` 表与两个索引；`promoted_task_id` 预留 M5，恒为 NULL |
| `src/server/services/checklist.ts` | 列表 + 新增/改文本/勾选/移动/删除 5 个用例，以及「转为小步骤」事务；父事项版本与条目版本双重守卫，事件只存摘要 |
| 5 个路由 | `GET/POST /api/tasks/:id/checklist`、`PATCH /api/tasks/:id/checklist/:itemId`、`POST .../:itemId/move`、`POST .../:itemId/remove`、`POST .../checklist/import` |
| `src/server/http/structure-route.ts` | 字段校验增加 `boolean` 类型（勾选字段） |
| `src/app/page.tsx` | 详情新增「小步骤清单」面板：勾选、行内改文本、上/下移动、删除、添加、静态复选框一键转换、未勾完完成确认 |
| `scripts/test-m4-checklist.mjs` | 7 组纯逻辑契约断言，并接入 `npm run test:m4` |

### 契约要点（PRD 9.3/9.4、7.1）

1. **只有文本、勾选与排序**：没有独立日期、状态、处理方；不进入今天/搜索等任务结果，不计入任务完成数，也不会变成 Task（实测：新增 2 条小步骤后 `tasks` 行数不变）。
2. **不改变父事项**：勾选只改条目自身；事项的状态与 version 均不变（实测 version 前后都是 4）。
3. **上限与校验**：每个事项最多 100 条（超出 409 `CHECKLIST_LIMIT`）；每条 1–500 码点，去首尾空白（超长 400 `INVALID_INPUT`）。
4. **排序稳定**：排序键为定宽零填充字符串（`0000`…），移动即相邻交换并整表重算；首项上移/末项下移为无变化（`changed:false`），菜单/键盘等价动作已就绪，拖动排序留待 M5 体验增强。
5. **并发**：请求同时带父事项 `expectedVersion`（聚合级）与条目 `itemVersion`；过期分别返回 409 `VERSION_CONFLICT` / `ITEM_VERSION_CONFLICT`。条目按 `task_id + owner` 定位，跨事项或跨账号一律 404。
6. **事件只存摘要**：`task_updated` 事件的 `payload.checklist` 只有动作、条目 ID、文本长度与计数，不含条目全文。
7. **静态复选框不产生第二套状态**：正文里的 `- [ ]` / `- [x]` 仍是文本，界面提示「转为小步骤」或「保留静态文本」；转换由服务端在**一个事务内**完成——建条目 + 从正文移除这些行 + 写正文修订 + 写摘要事件，失败整体回滚，不丢文字。空内容的复选框行（`- [ ]`）不会被移除。
8. **未勾完完成需确认**：完成事项时若仍有未勾选条目，先确认「完成事项不会自动勾选它们（表示放弃这些步骤）」，取消则不发送请求；不做自动批量勾完。

## 2. 验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `node --no-warnings --experimental-strip-types scripts/test-m4-checklist.mjs` | `M4-04 checklist contract: PASS (7 checks)` |
| `node --no-warnings --experimental-strip-types scripts/test-m4-drafts.mjs` | `M4-03 draft contract: PASS (9 checks)` |
| `node --no-warnings --experimental-strip-types scripts/test-m4-body.mjs` | `M4-01 body contract: PASS (34 checks)` |
| `npm run build` | 通过（含 5 个新路由） |
| `node scripts/test-m1.mjs` | `M1 dev/prod DB path isolation: PASS`、`M1 TTY password checks: PASS`、`M4 body/content checks: PASS`、`M4 checklist checks: PASS`、`M1 isolated integration suite: PASS` |

`M4 checklist checks` 覆盖：初始空与计数、未登录 401/不存在 404、新增与排序键、勾选不改变事项状态与版本、小步骤不进入 `view=all`/`view=today` 计数且不产生 Task、幂等重放与 `REQUEST_ID_REUSED`、事件仅摘要、空文本/超长/未知字段/事项版本冲突/条目不存在/条目版本冲突/跨事项隔离、边界移动无变化与相邻交换与排序键连续、删除后重排、100 条上限（播种 100 条后新增 409）、静态复选框导入（条目内容与勾选、正文清理、版本 +1、正文修订 +1、二次导入无变化）、归档事项写入拒绝但读取正常。

### 真实浏览器实测（隔离生产进程 + 独立库）

| 步骤 | 实测结果 |
| --- | --- |
| 正文写入 `# 待办` + `- [ ] 打电话` + `- [x] 发邮件` + 正文 | 小步骤面板提示「正文里有 2 行 `- [ ]` 复选框，目前只是静态文本。」，计数 `0/0 已完成 · 不参与事项计数` |
| 点「转为小步骤」 | 生成 2 条（打电话未勾选、发邮件已勾选），计数 `1/2`，正文变为 `# 待办` + `正文保留`（复选框行已移除） |
| 添加「第三条小步骤」 | 追加到末尾，排序键连续 |
| 勾选「第三条小步骤」再看事项 | 事项 status 仍为 `todo`、version 仍为 4（勾选不影响父事项） |
| 上移「第三条小步骤」 | 顺序由 `[打电话, 发邮件, 第三条]` 变为 `[打电话, 第三条, 发邮件]` |
| 删除「第三条小步骤」（确认） | 顺序回到 `[打电话, 发邮件]`，计数 `2/2` |
| 取消勾选「发邮件」后选择「已完成」并点更新状态 | 确认文案为「还有 1 项小步骤没有勾选。完成事项不会自动勾选它们（表示放弃这些步骤），确定完成吗？」；选择取消 → 事项仍 `todo` |
| 再次点更新状态并确认 | 事项 `done`，小步骤条目保持不变 |

数据库侧复核：`checklist_items` 两条排序键 `0000/0001`、`promoted_task_id` 为 NULL、条目 version 仅因自身编辑递增；`tasks` 行数不变；`payload_json` 中的 `checklist` 摘要不含条目全文。

## 3. 尚未验证或待修复

- 「提升为子事项」入口未开放（`promoted_task_id` 恒为 NULL），属 M5。
- 拖动排序未实现（已提供上/下移动的键盘与菜单等价动作，满足 NFR-06 的可操作性）。
- 小步骤不进入搜索（PRD 9.4 明确）；M6 做搜索时如需覆盖需另行评审，本轮不预先扩大范围。
- 真机触控（44px 触控目标、长按）未实测，属 M7。

## 4. 文档是否同步

是——本文件、`TASK_LOG.md`、`IMPLEMENTATION_PLAN.md` 第 7 节 M4-04 勾选与第 1 节状态、`README.md` 当前阶段。
