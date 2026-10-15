# M5-07 验收记录：原事项启用项目视图

日期：2026-10-13  
状态：已完成本机隔离验收；正式库、真实设备与公网仍待后续阶段。

## 交付范围

- 新增 `GET /api/tasks/:id/enable-project` 预览与 `POST /api/tasks/:id/enable-project` 原子确认。
- 当前 Task 直接成为 Project 根目标；不复制 Task，不改变原 Task ID、正文、媒体关系或既有历史事件。
- 转换事务内创建 Project、重算当前主树的最近项目索引，再绑定唯一 `root_task_id`；原有主后代保持原父子关系。
- 支持完成标准、成果日期；项目状态由根 Task 状态映射，Project 根正文继续以 Task 为唯一来源。
- 允许嵌套项目；已有嵌套项目根及其子树不会被外层项目覆盖。
- 详情页增加“启用项目视图”预览/确认入口；结构版本冲突、同名项目和重复请求均有保护。

## 隔离验证

```text
node scripts/test-m5-07.mjs
M5-07 enable project view: PASS
```

用例覆盖：预览、结构版本冲突、原 Task ID/正文/历史/媒体关系保留、主后代项目索引重算、嵌套项目、幂等重放、重复启用不新增 Project、完整性和外键检查。

代码检查：`npm run typecheck`、`npm run build`、`npx drizzle-kit check` 与完整 `npm run test:m5` 均通过。

## 未验证项

- 正式数据库尚未执行迁移；本功能复用 M5-01 已有 Project 根字段。
- 真实手机、窄屏视觉、触摸操作与公网访问尚未验收。
- M5-08 捕获到项目视图的端到端业务链路已在 [ACCEPTANCE_M5_08.md](ACCEPTANCE_M5_08.md) 中完成隔离验收。
