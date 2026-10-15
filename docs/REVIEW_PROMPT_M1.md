# M1 独立验收委托说明（当前：A01～A04 待修复）

M1-01～06 的内部隔离 suite 通过了其已覆盖用例，但最新 [独立总验收](ACCEPTANCE_M1_TOTAL.md) 发现 A01～A04，M1 仍未通过。请优先核查并复现这四个反例；关闭后重新跑 `npm run test:m1`，再决定是否勾选 M1。M2-01/02 已另行通过本机验收。

1. [M1 总验收记录](ACCEPTANCE_M1_FULL.md)
2. [M1 缺陷关闭记录](M1_OPEN_ISSUES.md)
3. [M2-01/02 验收记录](ACCEPTANCE_M2_01_02.md)
4. [实施清单](IMPLEMENTATION_PLAN.md)
5. [技术设计](TECHNICAL_DESIGN.md) 第 4～6、12 节；[运行手册](RUNBOOK.md) 第 11～12 节

重点检查认证 session/Origin/限流、响应 envelope、owner scope、事务与并发 replay/CAS、事件不可变性、默认私人空间、WAL backup/restore、backup_runs 状态，以及本机测试覆盖是否符合 PRD。可复跑 `npm run typecheck`、`npm run test:m1`、`npm run test:m2`。

动态测试仅可用临时 TASKS_DB_PATH、临时端口和测试账号；不要读取或打印 `.env.local`/`.initial-password`，不要操作正式库/密码，不访问或修改公网映射、Funnel 或 launchd。当前可信代理 IP 链、目标手机、自启动、PWA scope 和异机云恢复仍未现场验收；本机测试通过不代表公网发布通过。

请报告通过项、阻塞项（P0/P1/P2）、复现命令和建议。若发现缺陷，再重新打开对应清单；不要仅因文档标记“通过”而跳过代码验证。
